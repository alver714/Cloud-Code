import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Api } from 'grammy';
import { loadConfig } from './config.js';
import { ClaudeEngine } from './engines/claude.js';
import { CodexEngine } from './engines/codex.js';
import type { EngineKind } from './engines/types.js';
import { SessionManager, type WindowReader } from './sessions/manager.js';
import { SessionStore } from './sessions/store.js';
import { UsageAccounting } from './usage/accounting.js';
import { readClaudeLimits, readCodexLimits } from './usage/limits.js';
import { createBot, setupBot, BOT_COMMANDS } from './bot/bot.js';
import { TopicStreamer } from './bot/streamer.js';
import { truncate } from './bot/format.js';

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

  const manager = new SessionManager(
    store,
    {
      claude: new ClaudeEngine({
        effort: cfg.defaultEffortClaude,
        maxBudgetUsd: cfg.maxBudgetUsdClaude,
      }),
      codex: new CodexEngine(),
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
    },
  );

  setupBot(bot, { cfg, store, manager, accounting });

  await recoverAfterRestart(store, bot.api);

  const shutdown = async (signal: string) => {
    console.log(`[main] ${signal} — stopping`);
    manager.cancelAll();
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
    if (s.status !== 'running' && s.runningPid === undefined) continue;

    if (s.runningPid !== undefined) {
      await reapEnginePid(s.runningPid);
    }
    s.status = 'idle';
    s.runningPid = undefined;
    await store.upsert(s);

    try {
      await api.sendMessage(
        s.chatId,
        '♻️ Бот перезапускался — прошлый запуск был прерван. Контекст разговора сохранён, просто отправь следующий промпт.',
        { message_thread_id: s.topicId },
      );
    } catch (err) {
      console.error(`[recover] notify failed for topic ${s.topicId}:`, err);
    }
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
