import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InlineKeyboard, type Api } from 'grammy';
import { loadConfig } from './config.js';
import { ClaudeEngine } from './engines/claude.js';
import { CodexEngine } from './engines/codex.js';
import { CodexAppServerEngine } from './engines/codex-appserver.js';
import { AppServerClient } from './engines/appserver.js';
import type { Engine, EngineKind } from './engines/types.js';
import { makeModelExtractor } from './memory/extract.js';
import { MemoryStore } from './memory/store.js';
import { goalRestartNotice, SessionManager, type WindowReader } from './sessions/manager.js';
import { SessionStore } from './sessions/store.js';
import { watchCi } from './system/ci.js';
import { PreviewManager } from './system/preview.js';
import { readDisk, readEgress, readMemory } from './system/resources.js';
import { UsageAccounting } from './usage/accounting.js';
import { readClaudeLimits, readCodexLimits } from './usage/limits.js';
import { createBot, setupBot, BOT_COMMANDS } from './bot/bot.js';
import { consumeUpdateMarker, shortSha } from './system/selfupdate.js';
import { TopicStreamer } from './bot/streamer.js';
import { truncate } from './bot/format.js';
import { sanitizedChildEnv } from './util/childEnv.js';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const cfg = loadConfig();

  await fs.mkdir(cfg.workspacesDir, { recursive: true });
  // raw engine logs can contain file contents the agent read — keep them private
  await fs.mkdir(cfg.logsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(cfg.sessionsFile), { recursive: true });

  const store = new SessionStore(cfg.sessionsFile);
  await store.load();

  // Per-day spend totals live next to sessions.json.
  const accounting = new UsageAccounting(
    path.join(path.dirname(cfg.sessionsFile), 'usage-stats.json'),
  );
  await accounting.load();

  // Durable cross-session bot memory lives next to sessions.json.
  const memoryStore = new MemoryStore(path.join(path.dirname(cfg.sessionsFile), 'memory.json'));
  await memoryStore.load();

  // A4: the memory extractor runs in this NEUTRAL empty dir, never in the repo
  // workdir — a poisoned repo's CLAUDE.md/AGENTS.md must not steer the trusted
  // extraction pass. Under tmpdir (not WORKSPACES_DIR) so /cleanup ignores it.
  const memExtractDir = path.join(os.tmpdir(), 'coding-bot-mem-extract');
  await fs.mkdir(memExtractDir, { recursive: true });

  const bot = createBot(cfg.telegramBotToken);

  // Pre-flight gate reads each engine's 5h subscription window (null = fail-open).
  const readWindow: WindowReader = async (engine: EngineKind) => {
    if (engine === 'claude') {
      if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) return null; // token in Keychain locally
      const limits = await readClaudeLimits();
      const w = limits?.windows.find((x) => x.key === 'five_hour') ?? limits?.windows[0];
      return w ? { usedPercent: w.utilization * 100, resetsAt: w.resetsAt } : null;
    }
    const limits = await readCodexLimits();
    return limits?.primary
      ? { usedPercent: limits.primary.usedPercent, resetsAt: limits.primary.resetsAt }
      : null;
  };

  // app-server transport: one shared long-lived `codex app-server` for every
  // codex run (live token usage + native interrupt). Lazy-spawned on first use.
  const appServerClient =
    cfg.codexTransport === 'app-server' ? new AppServerClient() : undefined;
  const codexEngine: Engine = appServerClient
    ? new CodexAppServerEngine(appServerClient)
    : new CodexEngine();
  if (appServerClient) console.log('[main] codex transport: app-server (shared)');

  const manager = new SessionManager(
    store,
    {
      claude: new ClaudeEngine({
        effort: cfg.defaultEffortClaude,
        maxBudgetUsd: cfg.maxBudgetUsdClaude,
      }),
      codex: codexEngine,
    },
    (session, prompt) =>
      new TopicStreamer(
        bot.api,
        session.chatId,
        session.topicId,
        truncate(prompt.replace(/\s+/g, ' ').trim(), 64),
        session.verbose ?? false,
      ),
    {
      logsDir: cfg.logsDir,
      maxConcurrentRuns: cfg.maxConcurrentRuns,
      defaultModels: cfg.defaultModels,
      guard: {
        softTokens: cfg.guardSoftTokens,
        hardTokens: cfg.guardHardTokens,
        maxSteps: cfg.guardMaxSteps,
      },
      preflightPct: cfg.guardPreflightPct,
      readWindow,
      accounting,
      // Loop-level /goal messages (🎯/🏁/⚠️) go straight to the session's topic.
      notifyTopic: async (session, text, silent) => {
        await bot.api
          .sendMessage(session.chatId, text, {
            message_thread_id: session.topicId,
            parse_mode: 'HTML',
            ...(silent && { disable_notification: true }),
          })
          .catch((err) =>
            console.error(`[goal] notify failed for topic ${session.topicId}:`, err),
          );
      },
      // After the agent pushes, watch CI and report the outcome with a fix button.
      onPush: (session) => {
        const key = `${session.chatId}:${session.topicId}`;
        if (ciWatchers.has(key)) return;
        ciWatchers.add(key);
        // /branch on: watch only the session's branch so a foreign run isn't
        // misattributed. Without a branch — the previous behavior (newest repo run).
        const branch = session.useBranch ? `topic-${session.topicId}` : undefined;
        void watchCi(session.workdir, (run) => {
          const ok = run.conclusion === 'success';
          const text = ok
            ? `✅ CI green: ${run.title || run.branch}`
            : `❌ CI failed (${run.conclusion ?? run.status}): ${run.title}\n${run.url}`;
          void bot.api
            .sendMessage(session.chatId, text, {
              message_thread_id: session.topicId,
              ...(ok
                ? { disable_notification: true }
                : {
                    reply_markup: new InlineKeyboard().text(
                      '🔧 Fix it',
                      `cifix:${session.topicId}`,
                    ),
                  }),
            })
            .catch((err) => console.error('[ci] notify failed:', err));
        }, { branch }).finally(() => ciWatchers.delete(key));
      },
      // The agent announced a local server — offer a one-tap preview
      // (if a preview isn't already running for this session).
      onPortAnnounced: (session, port) => {
        if (preview.status(`${session.chatId}:${session.topicId}`)) return;
        void bot.api
          .sendMessage(session.chatId, `The agent started a server on port ${port} — open it?`, {
            message_thread_id: session.topicId,
            disable_notification: true,
            reply_markup: new InlineKeyboard().text(`🌐 Preview on :${port}`, `preview:${port}`),
          })
          .catch((err) => console.error('[preview] announce failed:', err));
      },
      resource: {
        enabled: cfg.resourceGuard,
        diskPath: cfg.workspacesDir,
        minFreeMemMb: cfg.minFreeMemMb,
        diskBlockPct: cfg.diskBlockPct,
        egressFreeMb: cfg.egressFreeMb,
        egressWarnPct: cfg.egressWarnPct,
        readMemory,
        readDisk,
        readEgress,
      },
      // Cross-session memory: Haiku when Claude credentials are connected,
      // otherwise GPT-5.4 mini through the Codex CLI's own auth.
      memory: {
        enabled: cfg.botMemory,
        store: memoryStore,
        extract: makeModelExtractor(new ClaudeEngine(), {
          model: 'haiku',
          env: sanitizedChildEnv({ keepClaude: true }),
          neutralCwd: memExtractDir,
          fallback: {
            engine: new CodexEngine(),
            model: 'gpt-5.4-mini',
            env: sanitizedChildEnv({ keepCodex: true }),
          },
        }),
      },
    },
  );

  // Public VM IP (GCP metadata; on Mac / outside GCP — no direct access).
  const externalIp = await execFileAsync(
    'curl',
    [
      '-s',
      '-m',
      '3',
      '-H',
      'Metadata-Flavor: Google',
      'http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip',
    ],
    { timeout: 5000 },
  )
    .then(({ stdout }) => (/^\d+\.\d+\.\d+\.\d+$/.test(stdout.trim()) ? stdout.trim() : undefined))
    .catch(() => undefined);
  if (externalIp) console.log(`[main] direct preview enabled on ${externalIp}:8300-8399`);

  const preview = new PreviewManager(
    cfg.previewTtlMinutes * 60_000,
    externalIp ? { externalIp, portBase: 8300, portCount: 100 } : undefined,
  );
  /** One CI watcher per session at a time. */
  const ciWatchers = new Set<string>();

  setupBot(bot, {
    cfg,
    store,
    manager,
    accounting,
    preview,
    memory: { store: memoryStore, enabled: cfg.botMemory },
  });

  await recoverAfterRestart(store, bot.api);
  await announceUpdate(bot.api);

  const shutdown = async (signal: string) => {
    console.log(`[main] ${signal} — stopping`);
    preview.stopAll();
    manager.cancelAll();
    // A hung app-server must not block a clean shutdown — cap the wait.
    if (appServerClient) {
      await Promise.race([
        appServerClient.shutdown().catch((err) => {
          console.error('[main] app-server shutdown failed:', err);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    await bot.stop();
  };
  process.once('SIGINT', () => void shutdown('SIGINT').catch(console.error));
  process.once('SIGTERM', () => void shutdown('SIGTERM').catch(console.error));

  await bot.api.setMyCommands(BOT_COMMANDS);
  console.log('[main] starting long polling');
  await bot.start({
    onStart: (me) => console.log(`[main] running as @${me.username}`),
  });
}

/**
 * The bot died mid-run: engine children are detached, so they may still be
 * alive. Reap them (only if the PID still looks like an engine process),
 * mark sessions idle and tell the owner the conversation is resumable.
 */
async function recoverAfterRestart(store: SessionStore, api: Api): Promise<void> {
  for (const s of store.all()) {
    const notice = goalRestartNotice(s);
    if (notice === null) continue;

    if (s.runningPid !== undefined) {
      await reapEnginePid(s.runningPid);
    }
    s.status = 'idle';
    s.runningPid = undefined;
    await store.upsert(s);

    try {
      if (notice === 'goal-resume') {
        // An autonomous /goal loop was interrupted — it does NOT auto-resume
        // after a restart; offer a one-tap continue (or /goal continue).
        await api.sendMessage(
          s.chatId,
          '♻️ The goal loop was interrupted by a restart. Context is saved — continue the iterations?',
          {
            message_thread_id: s.topicId,
            reply_markup: new InlineKeyboard().text('▶️ Continue the goal', `goalresume:${s.topicId}`),
          },
        );
      } else {
        await api.sendMessage(
          s.chatId,
          '♻️ The bot was restarted — the previous run was interrupted. The conversation context is saved, just send the next prompt.',
          { message_thread_id: s.topicId },
        );
      }
    } catch (err) {
      console.error(`[recover] notify failed for topic ${s.topicId}:`, err);
    }
  }
}

/**
 * A prior /update staged a new build and self-exited to restart. If the marker
 * left behind survived the restart, confirm success in the topic that issued it,
 * then it's consumed (read+deleted) so we only report once. Fail-silent.
 */
async function announceUpdate(api: Api): Promise<void> {
  const marker = await consumeUpdateMarker();
  if (!marker || marker.chatId === undefined) return;
  const prefix = marker.from ? `${shortSha(marker.from)}→` : '';
  try {
    await api.sendMessage(
      marker.chatId,
      `✅ Updated to ${prefix}${shortSha(marker.to)} and back online.`,
      marker.topicId !== undefined ? { message_thread_id: marker.topicId } : {},
    );
  } catch (err) {
    console.error('[update] confirmation failed:', err);
  }
}

async function reapEnginePid(pid: number): Promise<void> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'ppid=,command='], {
      timeout: 5000,
    });
    const line = stdout.trim();
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) return; // process already gone
    const ppid = Number(m[1]);
    const cmd = m[2]!.trim();
    // Only reap if it still looks like an engine AND was orphaned to init (pid 1).
    // A live PID reused by an unrelated process keeps its real parent, so this
    // guards against killing something that merely inherited the recorded pid.
    if (!/\b(claude|codex)\b/.test(cmd) || ppid !== 1) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
    console.log(`[recover] killed orphaned engine pid ${pid} (${cmd.slice(0, 80)})`);
  } catch {
    /* process already gone */
  }
}

main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
