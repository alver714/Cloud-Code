import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { InlineKeyboard, InputFile, type Bot, type Context } from 'grammy';
import type { Config } from '../config.js';
import { isValidEffort, validEfforts } from '../engines/effort.js';
import { CLAUDE_MODELS, CODEX_MODELS, resolveModel } from '../engines/models.js';
import type { EngineKind } from '../engines/types.js';
import {
  cloneRepo,
  createRepo,
  gitCommitAll,
  gitDiff,
  gitStatusShort,
  initChatWorkdir,
  isValidNewRepoName,
  isValidRepo,
  listRepos,
  repoShort,
  workdirName,
} from '../github/gh.js';
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryFact, type MemoryStore } from '../memory/store.js';
import { parseBudget } from '../sessions/guard.js';
import { COMPACT_HEADER } from '../sessions/manager.js';
import type { SessionManager, SubmitResult } from '../sessions/manager.js';
import type { GoalStatus } from '../sessions/types.js';
import type { SessionStore } from '../sessions/store.js';
import type { Session } from '../sessions/types.js';
import {
  deleteWorkspaces,
  findOrphanWorkspaces,
  humanBytes,
  type OrphanWorkspace,
} from '../system/cleanup.js';
import { latestRun } from '../system/ci.js';
import { parsePreviewArgs, PreviewManager } from '../system/preview.js';
import {
  computeUpdateCheck,
  getCurrentVersion,
  getLatestVersion,
  isUnderSystemd,
  runUpdate,
  shortSha,
} from '../system/selfupdate.js';
import { sessionKey } from '../sessions/types.js';
import { readResourceStatus, type ResourceStatus } from '../system/resources.js';
import type { DayTotals, UsageAccounting } from '../usage/accounting.js';
import {
  readClaudeLimits,
  readCodexLimits,
  type ClaudeLimits,
  type ClaudeWindow,
  type CodexLimits,
  type CodexWindow,
} from '../usage/limits.js';
import {
  chunkHtmlBlocks,
  escapeHtml,
  formatTok,
  renderMarkdownish,
  truncate,
  truncateHtml,
} from './format.js';
import { sanitizedChildEnv } from '../util/childEnv.js';
import { buildTopicTitle, modelTitle } from './topic-title.js';

const execFileAsync = promisify(execFile);

/** Subdirectory names of `dir` (skills live one dir each); tolerant of a missing dir. */
async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Bot secrets must never reach a subprocess. Engine tokens are kept so
 * `<engine> mcp list` can auth for both engines.
 */
function subprocessEnv(): NodeJS.ProcessEnv {
  return sanitizedChildEnv({ keepClaude: true, keepCodex: true });
}

/** `<engine> mcp list`, trimmed; null on any failure (per-engine tolerated). */
async function mcpList(engine: 'claude' | 'codex'): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(engine, ['mcp', 'list'], {
      timeout: 15_000,
      env: subprocessEnv(),
    });
    return (stdout.trim() || stderr.trim()) || '(no servers)';
  } catch {
    return null;
  }
}

export interface BotDeps {
  cfg: Config;
  store: SessionStore;
  manager: SessionManager;
  accounting: UsageAccounting;
  preview: PreviewManager;
  /** Cross-session bot memory (durable facts). `enabled` mirrors BOT_MEMORY. */
  memory: { store: MemoryStore; enabled: boolean };
}

/**
 * /repos inline keyboards reference repos by index into this cache.
 * Keyed by `${chatId}:${keyboardMessageId}` so a stale keyboard can't resolve
 * an index against a newer /repos list (which would clone the wrong repo).
 */
const repoCache = new Map<string, string[]>();
const REPO_CACHE_MAX = 50;

function rememberRepos(key: string, repos: string[]): void {
  repoCache.set(key, repos);
  while (repoCache.size > REPO_CACHE_MAX) {
    const oldest = repoCache.keys().next().value;
    if (oldest === undefined) break;
    repoCache.delete(oldest);
  }
}

/**
 * /cleanup keyboards reference the orphan list by `${chatId}:${keyboardMessageId}`
 * so a stale button can't delete against a newer scan.
 */
const cleanupCache = new Map<string, OrphanWorkspace[]>();
const CLEANUP_CACHE_MAX = 50;

// Telegram Bot API rejects local document uploads above 50 MB.
const FILE_SEND_MAX_BYTES = 50 * 1024 * 1024;

function rememberCleanup(key: string, orphans: OrphanWorkspace[]): void {
  cleanupCache.set(key, orphans);
  while (cleanupCache.size > CLEANUP_CACHE_MAX) {
    const oldest = cleanupCache.keys().next().value;
    if (oldest === undefined) break;
    cleanupCache.delete(oldest);
  }
}

export const HELP = `🤖 <b>Cloud Code</b> — agentic development straight from Telegram

Topic = an agent session (Claude Code or Codex) with its own repository. You write a prompt — the agent works autonomously, progress streams into the topic. Topics are independent and run in parallel.

<b>🚀 Start</b>
/new owner/repo — session for an existing repository
/create name — new GitHub repository from scratch
/chat — just chat with the agent (no repository)
/repos — pick a repository with buttons

<b>🏃 Every day</b>
/status — what's happening · /stop — stop
/preview — live link to your web app
/goal text — autonomous loop until the goal is achieved
/usage — subscription limits and server state

<b>🧠 Conversation memory — what's the difference</b>
/reset — forget everything and start over
/compact — squeeze history into a recap and keep the gist
/fork — branch the conversation into a new topic, the original stays intact

<b>💡 Examples</b>
<code>/new alver714/f1news</code> → "add a dark theme and push"
<code>/goal fix CI; goal achieved when the run is green</code>
<code>/preview 5173 npm run dev</code>

Unknown /commands go to the engine as a prompt (Claude Code custom slash commands work).

📚 Full list of 30+ commands: /help all`;

export const HELP_FULL = `📚 <b>All Cloud Code commands</b>

<b>Sessions</b>
/new owner/repo [claude|codex] — session for an existing repo
/create name [private|public] [claude|codex] — new repository + session
/chat [claude|codex] — chat without a repository
/repos — pick a repository with buttons
/sessions — all sessions with statuses
/fork — branch the conversation into a new topic

<b>Runs and autonomy</b>
/goal [text|continue|off] — autonomous loop until the goal; the agent finishes with a JSON verdict, "stuck" — only after 3 repeats; /goal continue resumes after a stop/limit
/note <text> — a note to the agent for the next run (alias /btw)
/review [base <branch>|commit <sha>|focus] — code review with P0–P3 priorities
/init — create agent instructions (CLAUDE.md / AGENTS.md)
/stop — stop the run + clear the queue

<b>Session settings</b>
/engine claude|codex — engine (history carries over as a recap)
/model [name|default] — model; context is preserved within the engine
/effort [low…max|default] — reasoning effort
/branch on|off — the agent works in branch topic-N, main only via PR
/budget [500k|off|default] — cap on "work tokens" per run
/verbose [on|off] — verbose/compact output

<b>Memory and context</b>
/reset (/clear) — new conversation, files stay
/compact — the model writes a checkpoint recap (/compact fast — fast, no spend)
/context — the model's context window and how full it is
/export — the entire session history as a Markdown file
/memories — the bot's durable memory: facts about you/your projects across sessions (add &lt;text&gt; · forget &lt;id|all&gt;)

<b>Checking the result</b>
/preview [port] [command] — dev server + public link (stop|status)
/ci — status of the last CI run (after a push the bot watches on its own)
/status — session state + git status
/commit &lt;message&gt; — stage all changes and create a local commit
/diff — current git diff
/file &lt;path&gt; — send a file from the workspace as a document

<b>System</b>
/usage — subscription limits + bot usage + server
/update [check] — pull the latest bot code from GitHub, build, and restart
/cleanup — delete unused workspaces
/memory — show the repository's instructions file (CLAUDE.md / AGENTS.md)
/memories — the bot's durable memory across sessions (separate from /memory)
/skills — available skills · /mcp — MCP servers`;

export function getTopicId(ctx: Context): number | undefined {
  const msg = ctx.msg;
  return msg?.is_topic_message ? msg.message_thread_id : undefined;
}

export function reply(ctx: Context, text: string, extra: Record<string, unknown> = {}) {
  return ctx.reply(text, {
    parse_mode: 'HTML',
    message_thread_id: getTopicId(ctx),
    ...extra,
  });
}

function statusGlyph(s: Session): string {
  switch (s.status) {
    case 'running':
      return '🟢';
    case 'error':
      return '🔴';
    default:
      return '⚪';
  }
}

function requireSession(ctx: Context, deps: BotDeps): Session | undefined {
  const topicId = getTopicId(ctx);
  if (!ctx.chat || topicId === undefined) {
    void reply(ctx, 'This command works inside a session topic.').catch(() => undefined);
    return undefined;
  }
  const session = deps.store.get(ctx.chat.id, topicId);
  if (!session) {
    void reply(ctx, 'This topic is not bound to a repository — /repos or /new owner/repo.').catch(
      () => undefined,
    );
    return undefined;
  }
  return session;
}

/**
 * Submit a bot-crafted prompt (e.g. /review, /init) through the normal run
 * path: streamer, guards and queueing all apply. The queue ack is silent;
 * pre-flight blocks get a short informational reply (no force keyboard — the
 * user can re-run or send the request as a normal prompt to get the 🚀 flow).
 */
async function submitAgentPrompt(
  ctx: Context,
  deps: BotDeps,
  session: Session,
  prompt: string,
): Promise<void> {
  const res = await deps.manager.submitPrompt(session, prompt);
  if (res.status === 'queued') {
    await reply(ctx, `⏸ Accepted, queued (#${res.position}). Stop everything: /stop`, {
      disable_notification: true,
    });
  } else {
    await submitBlockedReply(ctx, res);
  }
}

/** Short informational reply for a pre-flight-blocked submit (no force keyboard). */
async function submitBlockedReply(ctx: Context, res: SubmitResult): Promise<void> {
  if (res.status === 'limit-blocked') {
    await reply(
      ctx,
      `⚠️ The subscription window is ${Math.round(res.usedPercent)}% full — retry later or send the request as a normal prompt (you can force it there).`,
    );
  } else if (res.status === 'egress-blocked') {
    await reply(ctx, `🌐 VM outbound traffic is near the limit (${res.usedPct}%) — retry later.`);
  } else if (res.status === 'resource-blocked') {
    await reply(
      ctx,
      res.reason === 'memory'
        ? `⏳ Low memory on the VM (${res.detail} MB left) — wait for the current run to finish.`
        : `💾 Disk is almost full (${res.detail}%) — clean up workspaces: /cleanup`,
    );
  }
}

const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  stack: 'Stack',
  convention: 'Conventions',
  preference: 'Preferences',
  context: 'Context',
  other: 'Other',
};

/** Short, user-facing handle for a fact (matched by prefix on /memories forget). */
function shortFactId(id: string): string {
  return id.slice(0, 8);
}

/** Render the memory list grouped by category with usage counts (HTML blocks). */
function renderMemories(facts: MemoryFact[]): string[] {
  if (facts.length === 0) {
    return [
      '🧠 <b>Bot memory</b>\n\nEmpty for now. Facts accumulate automatically after runs; ' +
        'add manually: <code>/memories add &lt;text&gt;</code>.',
    ];
  }
  const blocks: string[] = [`🧠 <b>Bot memory</b> — ${facts.length} fact(s)`];
  for (const cat of MEMORY_CATEGORIES) {
    const group = facts
      .filter((f) => f.category === cat)
      .sort((a, b) => b.usageCount - a.usageCount);
    if (group.length === 0) continue;
    const lines = [`<b>${MEMORY_CATEGORY_LABELS[cat]}</b>`];
    for (const f of group) {
      lines.push(`• ${escapeHtml(f.text)} — <code>${shortFactId(f.id)}</code> ×${f.usageCount}`);
    }
    blocks.push(lines.join('\n'));
  }
  blocks.push('<i>Forget: /memories forget &lt;id|all&gt;</i>');
  return chunkHtmlBlocks(blocks);
}

export async function sendRepoKeyboard(ctx: Context, title: string): Promise<void> {
  if (!ctx.chat) return;
  try {
    const repos = await listRepos(30);
    if (repos.length === 0) {
      await reply(ctx, 'gh returned no repositories. Check <code>gh auth status</code>.');
      return;
    }
    const kb = new InlineKeyboard();
    repos.forEach((r, i) => kb.text(r, `repo:${i}`).row());
    kb.text('💬 Just chat (no repository)', 'chat:new').row();
    const sent = await reply(ctx, title, { reply_markup: kb });
    rememberRepos(`${ctx.chat.id}:${sent.message_id}`, repos);
  } catch (err) {
    await reply(ctx, `❌ Couldn't fetch the repository list:\n<pre>${truncateHtml(escapeHtml(String(err)), 800)}</pre>`);
  }
}

/**
 * Creates (or binds) a session: in General — creates a new forum topic;
 * inside an unbound topic — binds that topic. Then clones the repo.
 */
export async function startSessionFlow(
  ctx: Context,
  deps: BotDeps,
  repo: string,
  engine: EngineKind,
): Promise<void> {
  const { cfg, store } = deps;
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;

  let topicId = getTopicId(ctx);
  if (topicId !== undefined && store.get(chatId, topicId)) {
    await reply(ctx, `This topic is already bound to <code>${escapeHtml(store.get(chatId, topicId)!.repoUrl)}</code>.`);
    return;
  }

  let name = `${repoShort(repo)} · ${engine}`;
  if (topicId === undefined) {
    if (ctx.chat.type !== 'supergroup') {
      await reply(ctx, 'I need a forum supergroup with Topics enabled, where I am an admin with the "Manage Topics" permission.');
      return;
    }
    try {
      const topic = await ctx.api.createForumTopic(chatId, name);
      topicId = topic.message_thread_id;
    } catch (err) {
      await reply(
        ctx,
        `❌ Couldn't create the topic — check that Topics are enabled in the group and I have the "Manage Topics" permission.\n<pre>${truncateHtml(escapeHtml(String(err)), 500)}</pre>`,
      );
      return;
    }
  }

  const note = await ctx.api.sendMessage(chatId, `⏳ Cloning <code>${escapeHtml(repo)}</code>…`, {
    message_thread_id: topicId,
    parse_mode: 'HTML',
  });

  const workdir = path.join(cfg.workspacesDir, workdirName(repo, topicId));
  let cloneResult: 'cloned' | 'reused';
  try {
    cloneResult = await cloneRepo(repo, workdir);
  } catch (err) {
    await ctx.api.editMessageText(
      chatId,
      note.message_id,
      `❌ Cloning <code>${escapeHtml(repo)}</code> failed:\n<pre>${truncateHtml(escapeHtml(String(err)), 1500)}</pre>`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const session: Session = {
    chatId,
    topicId,
    name,
    engine,
    repoUrl: repo,
    workdir,
    status: 'idle',
    createdAt: new Date().toISOString(),
  };
  await store.upsert(session);

  await ctx.api.editMessageText(
    chatId,
    note.message_id,
    [
      `✅ <b>Session ready</b>`,
      `📦 <code>${escapeHtml(repo)}</code>${cloneResult === 'reused' ? ' (workspace reused)' : ''}`,
      `🤖 ${engine}`,
      '',
      'Send a prompt as a message in this topic.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}

/** Repo-less chat session: a topic bound to an empty git-initialized sandbox. */
export const CHAT_REPO_LABEL = '💬 chat';

export async function startChatFlow(
  ctx: Context,
  deps: BotDeps,
  engine: EngineKind,
): Promise<void> {
  const { cfg, store } = deps;
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;

  let topicId = getTopicId(ctx);
  if (topicId !== undefined && store.get(chatId, topicId)) {
    await reply(ctx, `This topic is already bound to <code>${escapeHtml(store.get(chatId, topicId)!.repoUrl)}</code>.`);
    return;
  }

  const name = `chat · ${engine}`;
  if (topicId === undefined) {
    if (ctx.chat.type !== 'supergroup') {
      await reply(ctx, 'I need a forum supergroup with Topics enabled, where I am an admin with the "Manage Topics" permission.');
      return;
    }
    try {
      const topic = await ctx.api.createForumTopic(chatId, name);
      topicId = topic.message_thread_id;
    } catch (err) {
      await reply(
        ctx,
        `❌ Couldn't create the topic:\n<pre>${truncateHtml(escapeHtml(String(err)), 500)}</pre>`,
      );
      return;
    }
  }

  const workdir = path.join(cfg.workspacesDir, `chat-${topicId}`);
  try {
    await initChatWorkdir(workdir);
  } catch (err) {
    await ctx.api.sendMessage(
      chatId,
      `❌ Couldn't create the chat workspace:\n<pre>${truncateHtml(escapeHtml(String(err)), 800)}</pre>`,
      { message_thread_id: topicId, parse_mode: 'HTML' },
    );
    return;
  }

  const session: Session = {
    chatId,
    topicId,
    name,
    engine,
    repoUrl: CHAT_REPO_LABEL,
    workdir,
    status: 'idle',
    createdAt: new Date().toISOString(),
  };
  await store.upsert(session);

  await ctx.api.sendMessage(
    chatId,
    [
      `💬 <b>Chat ready</b> — no repository`,
      `🤖 ${engine}`,
      '',
      'Just write here. The agent has its tools (web search, a sandbox for drafts) — the conversation context is preserved just like in a regular session.',
    ].join('\n'),
    { message_thread_id: topicId, parse_mode: 'HTML' },
  );
}

const HANDOFF_HEADER =
  'This is a continuation of a conversation that was held with another AI agent in the same repository. Brief history:';
const HANDOFF_BUDGET = 12_000;

/**
 * Build a short natural-language recap of the recent conversation, used both
 * for cross-engine handoffs (native memory can't cross engines) and for
 * /compact (squeeze the same-engine conversation). Newest exchanges get
 * priority; the whole thing is kept within ~HANDOFF_BUDGET chars. The header
 * frames the recap. Returns undefined when there is nothing to carry.
 */
function buildPendingContext(
  history?: Array<{ prompt: string; answer: string }>,
  header: string = HANDOFF_HEADER,
): string | undefined {
  if (!history || history.length === 0) return undefined;
  const blocks: string[] = [];
  let total = header.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const block = `User: ${history[i]!.prompt}\nAssistant: ${history[i]!.answer}`;
    if (total + block.length + 2 > HANDOFF_BUDGET) {
      // Even the newest exchange overflows — carry a truncated slice of it.
      if (blocks.length === 0) blocks.unshift(block.slice(0, Math.max(0, HANDOFF_BUDGET - total - 2)));
      break;
    }
    blocks.unshift(block);
    total += block.length + 2;
  }
  return `${header}\n\n${blocks.join('\n\n')}`;
}

export { COMPACT_HEADER };

/* ── /review prompt builder (codex rubric) ────────────────────────────────── */

/** What a /review run should look at. */
export type ReviewMode =
  | { kind: 'uncommitted' }
  | { kind: 'base'; ref: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'focus'; focus: string };

/**
 * Parse /review arguments into a mode:
 *   /review                → uncommitted (working tree + staged + untracked)
 *   /review base <branch>  → diff vs merge-base with <branch>
 *   /review commit <sha>   → one specific commit
 *   /review <any text>     → uncommitted, with that text as an extra focus
 */
export function parseReviewArgs(arg: string): ReviewMode {
  const t = arg.trim();
  if (!t) return { kind: 'uncommitted' };
  const [first, ...rest] = t.split(/\s+/);
  const head = first!.toLowerCase();
  if (head === 'base' && rest.length > 0) return { kind: 'base', ref: rest[0]! };
  if (head === 'commit' && rest.length > 0) return { kind: 'commit', sha: rest[0]! };
  return { kind: 'focus', focus: t };
}

const REVIEW_RUBRIC =
  'You are a reviewer of code changes made by another engineer. Find bugs the author would want to fix.\n\n' +
  'What counts as a bug (flag only these):\n' +
  '1. Genuinely affects correctness, performance, security, or maintainability.\n' +
  '2. The bug is specific and actionable (not a vague complaint or a mix of several problems).\n' +
  '3. Does not demand a higher level of rigor than the rest of the code.\n' +
  '4. The bug was introduced by these changes (do not flag pre-existing ones).\n' +
  '5. The author would very likely fix it once told about the problem.\n' +
  '6. The bug does not rely on unstated assumptions about the code or the author\'s intent.\n' +
  '7. It is not enough to assume something breaks somewhere else — point to the specific affected place.\n' +
  '8. It is clearly not the author\'s intended change.\n\n' +
  'Priorities: [P0] — brings everything down, a release/work blocker, only for universal problems with no assumptions about the input · ' +
  '[P1] — urgent, in the next cycle · [P2] — fine, fix over time · [P3] — minor, nice to have.\n' +
  'Ignore style, formatting, typos, and documentation unless they distort the meaning.\n' +
  'A comment on each bug — one paragraph: why it is a bug and how to fix it; no code snippets longer than 3 lines.';

const REVIEW_OUTPUT =
  'RESPONSE FORMAT — strictly this Markdown, with no extra text before or after:\n\n' +
  'Verdict: patch is correct | patch is incorrect — <one-line explanation>\n' +
  '[P0] path/file.ts:line — short title\n' +
  '  the essence of the problem and how to fix it\n' +
  '[P2] path/file.ts:line — title\n' +
  '  ...\n\n' +
  'Sort findings by ascending priority (P0 first). ' +
  'If there are no bugs — return only the line "Verdict: patch is correct — no remarks".';

/** Build the single /review prompt used for BOTH engines (identical format). */
export function buildReviewPrompt(mode: ReviewMode): string {
  let target: string;
  switch (mode.kind) {
    case 'base':
      target =
        `Changes under review: the diff of the current branch against its divergence point with branch ${mode.ref} — ` +
        `\`git diff $(git merge-base ${mode.ref} HEAD)...HEAD\`. Examine only this branch's changes.`;
      break;
    case 'commit':
      target =
        `Changes under review: a specific commit ${mode.sha} — look at \`git show ${mode.sha}\` and examine only it.`;
      break;
    case 'focus':
      target =
        'Changes under review: uncommitted edits (`git diff HEAD`), staged, and ' +
        'new (untracked) files. First look at `git status`, then the diffs themselves.\n' +
        `Pay special attention to: ${mode.focus}.`;
      break;
    default:
      target =
        'Changes under review: uncommitted edits (`git diff HEAD`), staged, and ' +
        'new (untracked) files. First look at `git status`, then the diffs themselves.';
  }
  return `${REVIEW_RUBRIC}\n\n${target}\n\n${REVIEW_OUTPUT}`;
}

/** The /compact checkpoint prompt (adapted from codex's compact/prompt.md). */
const COMPACTION_PROMPT =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Write a handoff summary for another LLM that will continue this work:\n' +
  '1) current progress and the key decisions made;\n' +
  '2) important context, constraints, and user preferences;\n' +
  '3) what is left to do — clear next steps;\n' +
  '4) critical data, examples, or links needed to continue.\n' +
  'Write concisely and in a structured way so the next LLM can continue seamlessly. ' +
  'Do not make any changes to code or files — only the summary.';

/** Label for a persisted goal status (UI). */
export function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case 'active':
      return 'active';
    case 'blocked':
      return 'blocked';
    case 'budget_limited':
      return 'stopped by budget';
    case 'usage_limited':
      return 'stopped by limit';
    case 'failed':
      return 'aborted';
    case 'complete':
      return 'achieved';
  }
}

/**
 * /compact — squeeze this session's conversation into a recap that seeds a
 * fresh engine session (works for both engines, unlike Claude's native
 * /compact). Mutates the session in place; returns the recap length, or null
 * when there's no history to compact (caller leaves the session untouched).
 */
export function compactSession(s: Session): number | null {
  const summary = buildPendingContext(s.history, COMPACT_HEADER);
  if (!summary) return null;
  s.engineSessionId = undefined;
  s.contextUsedTokens = undefined;
  s.contextWindowTokens = undefined;
  s.pendingContext = summary;
  return summary.length;
}

/** Frames the recap seeded into a forked codex session (no native fork). */
const FORK_HEADER =
  'This is a branch of the previous conversation — it continues in a new branch. ' +
  'Brief history of the original conversation:';
export { FORK_HEADER };

/**
 * Build a Markdown transcript of the session for /export: a header (repo,
 * engine, model, created, exchange count) followed by every history exchange
 * as "## Prompt N" / "### Answer" blocks. Pure — spends no tokens.
 */
export function buildExportMarkdown(s: Session): string {
  const history = s.history ?? [];
  const lines: string[] = [
    `# Session: ${s.name}`,
    '',
    `- Repository: ${s.repoUrl}`,
    `- Engine: ${s.engine}${s.model ? ` (${s.model})` : ''}`,
    `- Created: ${s.createdAt}`,
    `- Exchanges: ${history.length}`,
  ];
  if (s.goal) lines.push(`- Goal: ${s.goal}`);
  history.forEach((ex, i) => {
    lines.push('', `## Prompt ${i + 1}`, '', ex.prompt, '', '### Answer', '', ex.answer);
  });
  return lines.join('\n') + '\n';
}

/**
 * Build the child session for /fork. Copies the configuration and a deep copy
 * of history. Conversation continuity: claude branches the native session via
 * forkNext (+the parent engineSessionId); codex, lacking a native fork, seeds a
 * pendingContext recap instead. Pure — the caller creates the topic/workdir.
 */
export function buildForkSession(old: Session, newTopicId: number, workdir: string): Session {
  const fork: Session = {
    chatId: old.chatId,
    topicId: newTopicId,
    name: `${old.name} · fork`,
    engine: old.engine,
    repoUrl: old.repoUrl,
    workdir,
    model: old.model,
    effort: old.effort,
    verbose: old.verbose,
    budgetTokens: old.budgetTokens,
    goal: old.goal,
    history: old.history ? old.history.map((e) => ({ ...e })) : undefined,
    status: 'idle',
    createdAt: new Date().toISOString(),
  };
  if (old.engine === 'claude') {
    fork.engineSessionId = old.engineSessionId;
    if (old.engineSessionId) fork.forkNext = true;
  } else {
    fork.pendingContext = buildPendingContext(old.history, FORK_HEADER);
  }
  return fork;
}

/** Switch engine (and optionally model), resetting native context but carrying a recap. */
async function crossEngineHandoff(
  ctx: Context,
  store: SessionStore,
  s: Session,
  targetEngine: EngineKind,
  model?: string,
): Promise<void> {
  s.engine = targetEngine;
  s.model = model;
  s.engineSessionId = undefined;
  s.contextUsedTokens = undefined;
  s.contextWindowTokens = undefined;
  s.pendingContext = buildPendingContext(s.history);
  await store.upsert(s);
  await refreshTopicModel(ctx, store, s);
  await reply(
    ctx,
    `🔁 Engine: <b>${escapeHtml(targetEngine)}</b>, model: <b>${escapeHtml(model ?? 'CLI default')}</b>. ` +
      'Context carried over as a brief recap (native memory across engines is impossible).',
  );
}

/** Set the model within the current engine — native context is preserved. */
async function setSameEngineModel(
  ctx: Context,
  store: SessionStore,
  s: Session,
  name: string | undefined,
  unknown = false,
): Promise<void> {
  s.model = name;
  s.contextUsedTokens = undefined;
  s.contextWindowTokens = undefined;
  await store.upsert(s);
  await refreshTopicModel(ctx, store, s);
  const shown = escapeHtml(name ?? 'CLI default');
  const note = unknown ? ' (unknown model — I\'ll pass it to the engine as-is)' : '';
  await reply(ctx, `Model: <b>${shown}</b> — context preserved, applies from the next prompt${note}.`);
}

/** Keep the first-prompt title, replacing only its model suffix. */
async function refreshTopicModel(ctx: Context, store: SessionStore, s: Session): Promise<void> {
  if (!s.topicTitleBase || !ctx.chat) return;
  s.name = buildTopicTitle(s.topicTitleBase, modelTitle(s));
  await store.upsert(s);
  await ctx.api
    .editForumTopic(s.chatId, s.topicId, { name: s.name })
    .catch((err) => console.error(`[topic] rename failed for ${s.topicId}:`, err));
}

async function sendModelKeyboard(ctx: Context, s: Session): Promise<void> {
  const kb = new InlineKeyboard();
  const mark = (engine: EngineKind, m: string) =>
    s.engine === engine && s.model?.toLowerCase() === m ? '✅ ' : '';
  for (const m of CLAUDE_MODELS) kb.text(`${mark('claude', m)}${m}`, `model:claude:${m}`).row();
  for (const m of CODEX_MODELS) kb.text(`${mark('codex', m)}${m}`, `model:codex:${m}`).row();
  const current = s.model ?? 'CLI default';
  await reply(
    ctx,
    `Current: <b>${escapeHtml(current)}</b> (${escapeHtml(s.engine)}). ` +
      'Within the engine, context is preserved; when switching engines the bot will carry over a brief conversation history.',
    { reply_markup: kb },
  );
}

/** Label for the effort a session falls back to when none is set. */
function defaultEffortLabel(engine: EngineKind, cfg: Config): string {
  return engine === 'claude' ? `bot default (${cfg.defaultEffortClaude})` : 'CLI default';
}

async function sendEffortKeyboard(ctx: Context, s: Session, cfg: Config): Promise<void> {
  const kb = new InlineKeyboard();
  for (const v of validEfforts(s.engine)) {
    const mark = s.effort === v ? '✅ ' : '';
    kb.text(`${mark}${v}`, `effort:${v}`).row();
  }
  const shown = s.effort ?? defaultEffortLabel(s.engine, cfg);
  await reply(
    ctx,
    `🧠 Reasoning effort: <b>${escapeHtml(shown)}</b> (${escapeHtml(s.engine)}). ` +
      'Pick a value — it applies from the next run:',
    { reply_markup: kb },
  );
}

/* ── /usage rendering ─────────────────────────────────────────────────── */

function progressBar(fraction: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

export function fmtResetTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relFromNow(epochSec: number): string {
  const diffMs = epochSec * 1000 - Date.now();
  if (diffMs <= 0) return '';
  const totalMin = Math.round(diffMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? ` (+${h}h ${m}m)` : ` (+${m}m)`;
}

function resetSuffix(epochSec?: number): string {
  return epochSec ? ` · reset ${fmtResetTime(epochSec)}${relFromNow(epochSec)}` : '';
}

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'week',
};

function orderClaudeWindows(windows: ClaudeWindow[]): ClaudeWindow[] {
  const order = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);
  return [...windows].sort((a, b) => order(a.key) - order(b.key));
}

function renderClaudeWindow(w: ClaudeWindow): string {
  const label = CLAUDE_WINDOW_LABELS[w.key] ?? w.key;
  const pct = Math.round(w.utilization * 100);
  return `${escapeHtml(label)}: ${progressBar(w.utilization)} ${pct}%${resetSuffix(w.resetsAt)}`;
}

function renderCodexWindow(label: string, w: CodexWindow): string {
  const pct = Math.round(w.usedPercent);
  return `${label}: ${progressBar(w.usedPercent / 100)} ${pct}%${resetSuffix(w.resetsAt)}`;
}

/** "Bot today: claude N work tokens / M runs; codex …". */
function renderDailyLine(today: DayTotals): string {
  const parts: string[] = [];
  for (const engine of ['claude', 'codex'] as const) {
    const e = today[engine];
    if (!e) continue;
    let p = `${engine} ${formatTok(e.workTokens)} work tokens / ${e.runs} runs`;
    if (e.guardStops > 0) p += ` · ⛔${e.guardStops}`;
    parts.push(p);
  }
  return parts.length > 0 ? `🤖 <b>Bot today:</b> ${parts.join('; ')}` : '🤖 <b>Bot today:</b> empty for now';
}

/** "🖥 Server" — RAM / disk / egress. Skips null collectors; [] if all null. */
function renderServerSection(rs: ResourceStatus | null): string[] {
  if (!rs) return [];
  const body: string[] = [];
  if (rs.memory) {
    const m = rs.memory;
    let l = `RAM: ${Math.round(m.availableMb)} / ${Math.round(m.totalMb)} MB free`;
    if (m.swapFreeMb !== null && m.swapTotalMb !== null) {
      l += ` · swap ${Math.round(m.swapFreeMb)} / ${Math.round(m.swapTotalMb)} MB`;
    }
    if (rs.verdicts.memory === 'block') l = `⏳ ${l}`;
    body.push(l);
  }
  if (rs.disk) {
    const mark = rs.verdicts.disk === 'block' ? '⏳ ' : rs.verdicts.disk === 'warn' ? '⚠️ ' : '';
    body.push(`${mark}disk: ${rs.disk.usedPct}% used of ${Math.round(rs.disk.totalGb)} GB`);
  }
  if (rs.egress && rs.egressUsedPct !== null) {
    const mark = rs.verdicts.egress === 'warn' ? '⚠️ ' : '';
    body.push(
      `${mark}egress: ${Math.round(rs.egress.monthTxMb)} / ${rs.egressFreeMb} MB ` +
        `(${rs.egressUsedPct}%) · ${rs.daysLeftInMonth} days until month end`,
    );
  }
  return body.length > 0 ? ['', '🖥 <b>Server</b>', ...body] : [];
}

function renderUsage(opts: {
  claude: ClaudeLimits | null;
  claudeTokenMissing: boolean;
  codex: CodexLimits | null;
  today: DayTotals;
  resources: ResourceStatus | null;
}): string {
  const lines: string[] = ['📊 <b>Subscription limits</b>', '', '<b>Claude</b>'];
  if (opts.claudeTokenMissing) {
    lines.push('unavailable locally (token in Keychain) — works on the VM');
  } else if (!opts.claude) {
    lines.push('failed to fetch');
  } else {
    for (const w of orderClaudeWindows(opts.claude.windows)) lines.push(renderClaudeWindow(w));
  }

  lines.push('', '<b>Codex</b>');
  const c = opts.codex;
  if (!c) {
    lines.push('failed to fetch');
  } else {
    if (c.primary) lines.push(renderCodexWindow('5-hour window', c.primary));
    if (c.secondary) lines.push(renderCodexWindow('week', c.secondary));
    if (c.planType) lines.push(`plan: ${escapeHtml(c.planType)}`);
    if (c.resetCreditsAvailable > 0) lines.push(`💳 limit resets available: ${c.resetCreditsAvailable}`);
  }

  lines.push('', renderDailyLine(opts.today));
  lines.push(...renderServerSection(opts.resources));
  return lines.join('\n');
}

export function registerCommands(bot: Bot, deps: BotDeps): void {
  const { cfg, store, manager } = deps;

  bot.command(['help', 'start'], (ctx) =>
    reply(ctx, ctx.match.trim().toLowerCase() === 'all' ? HELP_FULL : HELP),
  );

  bot.command('new', async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const repo = parts[0] ?? '';
    const engineArg = parts[1];
    const engine = (engineArg ?? cfg.defaultEngine) as EngineKind;
    if (!isValidRepo(repo) || (engineArg && engineArg !== 'claude' && engineArg !== 'codex')) {
      await reply(ctx, 'Format: <code>/new owner/repo [claude|codex]</code>');
      return;
    }
    await startSessionFlow(ctx, deps, repo, engine);
  });

  bot.command('create', async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const name = parts[0] ?? '';
    const rest = parts.slice(1);
    const known = new Set(['private', 'public', 'claude', 'codex']);
    if (!isValidNewRepoName(name) || rest.some((r) => !known.has(r))) {
      await reply(
        ctx,
        'Format: <code>/create name [private|public] [claude|codex]</code> — new repository (private by default)',
      );
      return;
    }
    const visibility: 'private' | 'public' = rest.includes('public') ? 'public' : 'private';
    const engine: EngineKind = rest.includes('codex')
      ? 'codex'
      : rest.includes('claude')
        ? 'claude'
        : cfg.defaultEngine;

    const note = await reply(ctx, `⏳ Creating repository <code>${escapeHtml(name)}</code>…`);
    let full: string;
    try {
      full = await createRepo(name, visibility);
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        note.message_id,
        `❌ Failed to create the repository:\n<pre>${truncateHtml(escapeHtml(String(err)), 1000)}</pre>`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    await ctx.api.editMessageText(
      ctx.chat!.id,
      note.message_id,
      `✅ Repository <code>${escapeHtml(full)}</code> created (${visibility}).`,
      { parse_mode: 'HTML' },
    );
    await startSessionFlow(ctx, deps, full, engine);
  });

  bot.command('chat', async (ctx) => {
    const arg = ctx.match.trim();
    if (arg && arg !== 'claude' && arg !== 'codex') {
      await reply(ctx, 'Format: <code>/chat [claude|codex]</code> — chat without a repository');
      return;
    }
    await startChatFlow(ctx, deps, (arg || cfg.defaultEngine) as EngineKind);
  });

  bot.callbackQuery('chat:new', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await startChatFlow(ctx, deps, cfg.defaultEngine);
  });

  bot.command('repos', (ctx) => sendRepoKeyboard(ctx, 'Pick a repository:'));

  bot.callbackQuery(/^repo:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const idx = Number(ctx.match[1]);
    const key = chatId !== undefined ? `${chatId}:${ctx.msg?.message_id}` : undefined;
    const repo = key !== undefined ? repoCache.get(key)?.[idx] : undefined;
    // "query is too old" (a click on a stale button) must not crash the whole flow
    if (!repo) {
      await ctx.answerCallbackQuery({ text: 'The list is stale — run /repos again.' }).catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery().catch(() => undefined);
    await startSessionFlow(ctx, deps, repo, cfg.defaultEngine);
  });

  bot.command('sessions', async (ctx) => {
    const sessions = store.all();
    if (sessions.length === 0) {
      await reply(ctx, 'No sessions yet. Create one: /new owner/repo or /repos.');
      return;
    }
    const lines = sessions.map((s) => {
      const queued = manager.queueLength(s.chatId, s.topicId);
      return `${statusGlyph(s)} <b>${escapeHtml(s.name)}</b> — <code>${escapeHtml(s.repoUrl)}</code> — ${s.engine}${
        s.status === 'running' ? ' · running' : ''
      }${queued ? ` · queued: ${queued}` : ''}`;
    });
    // Many sessions can exceed Telegram's 4096-char limit — send in chunks.
    const chunks = chunkHtmlBlocks(lines);
    for (let i = 0; i < chunks.length; i++) {
      await reply(ctx, chunks[i]!, { disable_notification: i > 0 });
    }
  });

  bot.command('status', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    let git = '';
    try {
      git = await gitStatusShort(s.workdir);
    } catch (err) {
      git = String(err);
    }
    await reply(
      ctx,
      [
        `${statusGlyph(s)} <b>${escapeHtml(s.name)}</b>`,
        `📦 <code>${escapeHtml(s.repoUrl)}</code>`,
        `🤖 ${s.engine}${s.model ? ` · ${escapeHtml(s.model)}` : ''}`,
        `📂 <code>${escapeHtml(s.workdir)}</code>`,
        `🧵 context: ${s.engineSessionId ? `<code>${escapeHtml(s.engineSessionId.slice(0, 8))}…</code>` : 'new'}`,
        `⏳ queue: ${manager.queueLength(s.chatId, s.topicId)}`,
        '',
        `<pre>${truncateHtml(escapeHtml(git || 'git: empty'), 1500)}</pre>`,
      ].join('\n'),
    );
  });

  bot.command('engine', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim();
    if (arg !== 'claude' && arg !== 'codex') {
      await reply(ctx, `Currently: <b>${s.engine}</b>. Switch: <code>/engine claude|codex</code>`);
      return;
    }
    if (arg === s.engine) {
      await reply(ctx, `Already ${arg}.`);
      return;
    }
    await crossEngineHandoff(ctx, store, s, arg);
  });

  bot.command('model', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim();
    if (!arg) {
      await sendModelKeyboard(ctx, s);
      return;
    }
    if (arg.toLowerCase() === 'default') {
      await setSameEngineModel(ctx, store, s, undefined);
      return;
    }
    const resolved = resolveModel(arg);
    if (!resolved) {
      await setSameEngineModel(ctx, store, s, arg, true);
      return;
    }
    if (resolved.engine === s.engine) {
      await setSameEngineModel(ctx, store, s, resolved.name);
      return;
    }
    await crossEngineHandoff(ctx, store, s, resolved.engine, resolved.name);
  });

  const contextWindowCommand = async (ctx: Context) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const model = s.model ?? cfg.defaultModels[s.engine] ?? 'CLI default';
    const used = s.contextUsedTokens;
    const window = s.contextWindowTokens;
    const lines = [`🧠 Model: <b>${escapeHtml(model)}</b>`];
    if (window !== undefined) {
      const usedLabel = used === undefined ? 'no data' : `${formatTok(used)} tokens`;
      const percent = used === undefined ? '' : ` (${((used / window) * 100).toFixed(1)}%)`;
      lines.push(`Context window: <b>${formatTok(window)}</b> tokens`);
      lines.push(`Used: <b>${usedLabel}</b>${percent}`);
    } else if (used !== undefined) {
      lines.push(`Used: <b>${formatTok(used)}</b> tokens`);
      lines.push('The model has not reported the window size yet.');
    } else {
      lines.push('No data yet — send at least one prompt in this session.');
    }
    await reply(ctx, lines.join('\n'));
  };
  bot.command(['context', 'context-window'], contextWindowCommand);

  bot.command('effort', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim().toLowerCase();
    if (!arg) {
      await sendEffortKeyboard(ctx, s, cfg);
      return;
    }
    if (arg === 'default') {
      s.effort = undefined;
      await store.upsert(s);
      await reply(
        ctx,
        `🧠 Reasoning effort: ${escapeHtml(defaultEffortLabel(s.engine, cfg))} — applies from the next run.`,
      );
      return;
    }
    if (!isValidEffort(s.engine, arg)) {
      await reply(
        ctx,
        `Invalid value for <b>${escapeHtml(s.engine)}</b>. Allowed: ${validEfforts(s.engine).join(', ')} (or <code>default</code>).`,
      );
      return;
    }
    s.effort = arg;
    await store.upsert(s);
    await reply(ctx, `🧠 Reasoning effort: <b>${escapeHtml(arg)}</b> — applies from the next run.`);
  });

  bot.callbackQuery(/^effort:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const s = requireSession(ctx, deps);
    if (!s) return;
    const value = ctx.match[1]!;
    // Stale keyboard safety: reject values invalid for the session's engine
    // (e.g. the engine was switched after the keyboard was rendered).
    if (!isValidEffort(s.engine, value)) {
      await reply(ctx, `The value <code>${escapeHtml(value)}</code> is invalid for <b>${escapeHtml(s.engine)}</b> — run /effort again.`);
      return;
    }
    s.effort = value;
    await store.upsert(s);
    await reply(ctx, `🧠 Reasoning effort: <b>${escapeHtml(value)}</b> — applies from the next run.`);
  });

  bot.command('compact', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim().toLowerCase();

    // /compact fast — the old local, token-free recap of the rolling history.
    if (arg === 'fast') {
      const chars = compactSession(s);
      if (chars === null) {
        await reply(ctx, 'Nothing to compact locally — there is no history yet.');
        return;
      }
      await store.upsert(s);
      await reply(
        ctx,
        `🗜 Context compacted locally: the next prompt will start a fresh session with a brief recap (${chars} chars). Files untouched.`,
      );
      return;
    }

    // Default: ask the model itself to write a handoff checkpoint (codex pattern).
    if ((!s.history || s.history.length === 0) && !s.engineSessionId) {
      await reply(ctx, 'Nothing to compact — there is no conversation yet. Local option: <code>/compact fast</code>.');
      return;
    }
    if (manager.isRunning(s.chatId, s.topicId)) {
      await reply(ctx, 'Session is busy — wait for the run to finish and repeat /compact.');
      return;
    }
    s.compactPending = true;
    await store.upsert(s);
    const res = await manager.submitPrompt(s, COMPACTION_PROMPT);
    if (res.status === 'started' || res.status === 'queued') {
      await reply(
        ctx,
        res.status === 'queued'
          ? `⏸ Compaction queued (#${res.position}) — the context will be compacted once it completes.`
          : '🗜 Asking the model to write a conversation checkpoint… the context will be compacted once it completes.',
        { disable_notification: true },
      );
    } else {
      s.compactPending = undefined;
      await store.upsert(s);
      await submitBlockedReply(ctx, res);
    }
  });

  bot.command('review', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    // One crafted prompt for both engines so the output format matches (we no
    // longer use claude's native /review).
    await submitAgentPrompt(ctx, deps, s, buildReviewPrompt(parseReviewArgs(ctx.match)));
  });

  bot.command('init', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const prompt =
      s.engine === 'claude'
        ? '/init'
        : 'Study the repository and create AGENTS.md with instructions for AI agents: ' +
          'project structure, build and test commands, code conventions.';
    await submitAgentPrompt(ctx, deps, s, prompt);
  });

  const GOAL_MAX = 500;
  bot.command('goal', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim();
    const running = manager.isRunning(s.chatId, s.topicId);
    const gs = s.goalState;

    // Status view.
    if (!arg) {
      if (gs && gs.status !== 'complete') {
        const label = running ? 'running' : goalStatusLabel(gs.status);
        const resume = running ? '' : '\nContinue: <code>/goal continue</code>';
        await reply(
          ctx,
          `🎯 Goal: <b>${escapeHtml(gs.goal)}</b>\nStatus: ${label} · iteration ${gs.iteration}/${gs.max}${resume}`,
        );
      } else if (gs?.status === 'complete') {
        await reply(
          ctx,
          `✅ Goal achieved: <b>${escapeHtml(gs.goal)}</b>. New one: <code>/goal &lt;text&gt;</code>`,
        );
      } else {
        await reply(ctx, 'No goal. Set one: <code>/goal &lt;text&gt;</code> — the agent will work in iterations until it is achieved.');
      }
      return;
    }

    // Clear.
    if (arg.toLowerCase() === 'off') {
      const had = gs !== undefined;
      await manager.clearGoal(s);
      await reply(ctx, had ? '🎯 Goal cleared, loop stopped.' : '🎯 There was no goal anyway.');
      return;
    }

    // Resume a non-complete goal.
    if (arg.toLowerCase() === 'continue') {
      if (!gs || gs.status === 'complete') {
        await reply(ctx, 'No unfinished goal to continue. Set a new one: <code>/goal &lt;text&gt;</code>.');
        return;
      }
      if (running || manager.isGoalActive(s.chatId, s.topicId)) {
        await reply(ctx, 'The goal loop is already running. Stop: /stop or /goal off.');
        return;
      }
      const res = await manager.resumeGoal(s, cfg.goalMaxIterations);
      if (res.status === 'started' || res.status === 'queued') {
        await reply(
          ctx,
          `▶️ Continuing the goal (iteration ${s.goalState!.iteration}/${s.goalState!.max}). Stop: /goal off or /stop`,
        );
      } else {
        await submitBlockedReply(ctx, res);
      }
      return;
    }

    // Start a new goal.
    if (running || manager.isGoalActive(s.chatId, s.topicId)) {
      await reply(ctx, 'Session is busy (a run or an active goal loop). Stop it: /stop or /goal off.');
      return;
    }
    let goal = arg;
    let note = '';
    if (goal.length > GOAL_MAX) {
      goal = goal.slice(0, GOAL_MAX);
      note = ` (truncated to ${GOAL_MAX} chars)`;
    }
    const max = cfg.goalMaxIterations;
    const res = await manager.startGoal(s, goal, max);
    if (res.status === 'started' || res.status === 'queued') {
      await reply(
        ctx,
        `🎯 Goal accepted${note} — working in iterations (limit ${max}). Stop: /goal off or /stop`,
      );
      return;
    }
    // A pre-flight gate blocked the very first iteration (startGoal already tore
    // the loop down) — just tell the user why.
    await submitBlockedReply(ctx, res);
  });

  // ▶️ Continue goal — offered after a restart interrupted an active goal loop.
  bot.callbackQuery(/^goalresume:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const chatId = ctx.chat?.id;
    const topicId = Number(ctx.match[1]);
    const s = chatId !== undefined ? store.get(chatId, topicId) : undefined;
    if (!s) {
      await reply(ctx, 'Session not found.');
      return;
    }
    if (!s.goalState || s.goalState.status === 'complete') {
      await reply(ctx, 'The goal is already finished or cleared.');
      return;
    }
    if (manager.isRunning(chatId!, topicId) || manager.isGoalActive(chatId!, topicId)) {
      await reply(ctx, 'The goal loop is already running.');
      return;
    }
    const res = await manager.resumeGoal(s, cfg.goalMaxIterations);
    if (res.status === 'started' || res.status === 'queued') {
      await reply(ctx, `▶️ Continuing the goal (iteration ${s.goalState!.iteration}/${s.goalState!.max}).`);
    } else {
      await submitBlockedReply(ctx, res);
    }
  });

  const NOTES_MAX_COUNT = 10;
  const NOTES_MAX_CHARS = 2000;
  bot.command(['note', 'btw'], async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim();
    if (!arg) {
      await reply(ctx, 'Format: <code>/btw &lt;text&gt;</code> — a note to the agent for the next run (does not start a run).');
      return;
    }
    const notes = s.notes ? [...s.notes] : [];
    notes.push(arg);
    while (notes.length > NOTES_MAX_COUNT) notes.shift();
    while (notes.reduce((n, x) => n + x.length, 0) > NOTES_MAX_CHARS && notes.length > 1) {
      notes.shift();
    }
    s.notes = notes;
    await store.upsert(s);
    await reply(ctx, `📝 I'll take it into account on the next run (notes: ${notes.length}).`);
  });

  bot.command('export', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    if (!s.history || s.history.length === 0) {
      await reply(ctx, 'Nothing to export yet — there is no conversation history.');
      return;
    }
    const md = buildExportMarkdown(s);
    const date = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(md, 'utf8'), `session-${s.topicId}-${date}.md`),
      { message_thread_id: getTopicId(ctx), disable_notification: true },
    );
  });

  bot.command('fork', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    if (ctx.chat.type !== 'supergroup') {
      await reply(ctx, 'I need a forum supergroup with Topics enabled, where I am an admin with the "Manage Topics" permission.');
      return;
    }
    const newName = `${s.name} · fork`;
    let newTopicId: number;
    try {
      const topic = await ctx.api.createForumTopic(chatId, newName);
      newTopicId = topic.message_thread_id;
    } catch (err) {
      await reply(
        ctx,
        `❌ Couldn't create a topic for the branch:\n<pre>${truncateHtml(escapeHtml(String(err)), 500)}</pre>`,
      );
      return;
    }

    const isChat = s.repoUrl === CHAT_REPO_LABEL;
    const workdir = isChat
      ? path.join(cfg.workspacesDir, `chat-${newTopicId}`)
      : path.join(cfg.workspacesDir, workdirName(s.repoUrl, newTopicId));
    try {
      if (isChat) await initChatWorkdir(workdir);
      else await cloneRepo(s.repoUrl, workdir);
    } catch (err) {
      await ctx.api.sendMessage(
        chatId,
        `❌ Couldn't prepare the branch workspace:\n<pre>${truncateHtml(escapeHtml(String(err)), 800)}</pre>`,
        { message_thread_id: newTopicId, parse_mode: 'HTML' },
      );
      return;
    }

    const fork = buildForkSession(s, newTopicId, workdir);
    await store.upsert(fork);

    const cloneNote = isChat
      ? ''
      : '\n\n⚠️ This is a fresh clone — uncommitted files from the original topic are not carried over here.';
    await ctx.api.sendMessage(
      chatId,
      `🍴 Branch created from "${escapeHtml(s.name)}". The conversation continues from here; the original topic is untouched.${cloneNote}`,
      { message_thread_id: newTopicId, parse_mode: 'HTML' },
    );
    await reply(ctx, `🍴 Branched the conversation into a new topic "${escapeHtml(newName)}".`);
  });

  bot.command('skills', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const globalDir =
      s.engine === 'claude'
        ? path.join(os.homedir(), '.claude', 'skills')
        : path.join(os.homedir(), '.codex', 'skills');
    const [repoSkills, globalSkills] = await Promise.all([
      s.engine === 'claude' ? listSubdirs(path.join(s.workdir, '.claude', 'skills')) : Promise.resolve([]),
      listSubdirs(globalDir),
    ]);
    if (repoSkills.length === 0 && globalSkills.length === 0) {
      await reply(ctx, 'No skills found — neither in the repository nor in the global folder.');
      return;
    }
    const lines: string[] = ['🧩 <b>Skills</b>'];
    if (repoSkills.length > 0) {
      lines.push('', '<b>Repository</b>', ...repoSkills.map((n) => `• <code>${escapeHtml(n)}</code>`));
    }
    if (globalSkills.length > 0) {
      lines.push('', '<b>Global</b>', ...globalSkills.map((n) => `• <code>${escapeHtml(n)}</code>`));
    }
    lines.push(
      '',
      '<i>Invoke: <code>/skill-name</code> directly in the topic (Claude) — unknown /commands go to the engine.</i>',
    );
    await reply(ctx, lines.join('\n'));
  });

  bot.command('memory', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const order = s.engine === 'claude' ? ['CLAUDE.md', 'AGENTS.md'] : ['AGENTS.md', 'CLAUDE.md'];
    let content: string | undefined;
    let used: string | undefined;
    for (const f of order) {
      try {
        const text = await fs.readFile(path.join(s.workdir, f), 'utf8');
        if (text.trim()) {
          content = text;
          used = f;
          break;
        }
      } catch {
        /* try the next one */
      }
    }
    if (!content || !used) {
      await reply(ctx, 'No instructions file — create one via /init.');
      return;
    }
    const blocks = [`📄 <b>${escapeHtml(used)}</b>`, ...renderMarkdownish(content)];
    const chunks = chunkHtmlBlocks(blocks);
    for (let i = 0; i < chunks.length; i++) {
      await reply(ctx, chunks[i]!, { disable_notification: i > 0 });
    }
  });

  // Durable cross-session bot memory (distinct from /memory, which shows the
  // repo's CLAUDE.md/AGENTS.md). List / add / forget owner-level facts.
  bot.command('memories', async (ctx) => {
    const { store, enabled } = deps.memory;
    if (!enabled) {
      await reply(ctx, '🧠 Bot memory is off (BOT_MEMORY=off).');
      return;
    }
    const arg = ctx.match.trim();
    const [subRaw, ...restParts] = arg.split(/\s+/);
    const sub = subRaw?.toLowerCase() ?? '';
    const rest = arg.slice(subRaw?.length ?? 0).trim();

    if (sub === 'add') {
      if (!rest) {
        await reply(ctx, 'What should I remember? <code>/memories add &lt;fact text&gt;</code>');
        return;
      }
      const created = await store.add({ text: rest, category: 'other' });
      await reply(
        ctx,
        created
          ? `🧠 Remembered: ${escapeHtml(created.text)}\n<code>${shortFactId(created.id)}</code>`
          : 'That fact already exists (or is empty).',
      );
      return;
    }

    if (sub === 'forget') {
      const token = restParts.join(' ').trim();
      if (!token) {
        await reply(ctx, 'What should I forget? <code>/memories forget &lt;id|all&gt;</code>');
        return;
      }
      if (token.toLowerCase() === 'all') {
        const n = await store.clear();
        await reply(ctx, n > 0 ? `🗑 Forgot all facts (${n}).` : 'Memory is already empty.');
        return;
      }
      const match = store.all().find((f) => f.id === token || f.id.startsWith(token));
      if (!match) {
        await reply(ctx, `Fact with id <code>${escapeHtml(token)}</code> not found.`);
        return;
      }
      await store.remove(match.id);
      await reply(ctx, `🗑 Forgot: ${escapeHtml(match.text)}`);
      return;
    }

    if (sub && sub !== '') {
      await reply(
        ctx,
        'Usage: <code>/memories</code> · <code>/memories add &lt;text&gt;</code> · <code>/memories forget &lt;id|all&gt;</code>',
      );
      return;
    }

    // No subcommand → list, grouped by category with usage counts.
    const blocks = renderMemories(store.all());
    for (let i = 0; i < blocks.length; i++) {
      await reply(ctx, blocks[i]!, { disable_notification: i > 0 });
    }
  });

  bot.command('mcp', async (ctx) => {
    const chatId = ctx.chat?.id;
    const note = await reply(ctx, '🔌 Querying MCP servers…').catch(() => undefined);
    const [claude, codex] = await Promise.all([mcpList('claude'), mcpList('codex')]);
    const section = (out: string | null) =>
      out ? `<pre>${truncateHtml(escapeHtml(out), 1500)}</pre>` : 'failed to fetch';
    const text = [
      '🔌 <b>MCP servers</b>',
      '',
      '<b>Claude</b>',
      section(claude),
      '',
      '<b>Codex</b>',
      section(codex),
    ].join('\n');
    if (chatId !== undefined && note) {
      await ctx.api
        .editMessageText(chatId, note.message_id, text, { parse_mode: 'HTML' })
        .catch(() => reply(ctx, text).catch(() => undefined));
    } else {
      await reply(ctx, text).catch(() => undefined);
    }
  });

  bot.callbackQuery(/^model:(claude|codex):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const s = requireSession(ctx, deps);
    if (!s) return;
    const engine = ctx.match[1] as EngineKind;
    const name = ctx.match[2]!;
    if (engine === s.engine) {
      await setSameEngineModel(ctx, store, s, name);
      return;
    }
    await crossEngineHandoff(ctx, store, s, engine, name);
  });

  bot.command('usage', async (ctx) => {
    const chatId = ctx.chat?.id;
    const note = await reply(ctx, '📊 Gathering subscription limits…').catch(() => undefined);
    const claudeTokenMissing = !process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const [claude, codex, resources] = await Promise.all([
      claudeTokenMissing ? Promise.resolve(null) : readClaudeLimits(),
      readCodexLimits(),
      readResourceStatus(cfg).catch(() => null),
    ]);
    const text = renderUsage({
      claude,
      claudeTokenMissing,
      codex,
      today: deps.accounting.today(),
      resources,
    });
    if (chatId !== undefined && note) {
      await ctx.api
        .editMessageText(chatId, note.message_id, text, { parse_mode: 'HTML' })
        .catch(() => reply(ctx, text).catch(() => undefined));
    } else {
      await reply(ctx, text).catch(() => undefined);
    }
  });

  // High-privilege owner op (already gated by the allowlist middleware): pull the
  // latest bot code from GitHub, build it in an isolated temp dir, swap it into
  // the live install, and restart. `/update check` just reports current vs latest.
  bot.command('update', async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();

    if (arg === 'check') {
      const note = await reply(ctx, '🔎 Checking for a new version…').catch(() => undefined);
      const [current, latest] = await Promise.all([getCurrentVersion(), getLatestVersion()]);
      const check = computeUpdateCheck(current, latest);
      let text: string;
      if (check.state === 'unknown-latest') {
        text = "❓ Couldn't reach GitHub to check the latest version — try again later.";
      } else if (check.state === 'up-to-date') {
        text = `✅ Up to date (<code>${shortSha(check.latest)}</code>).`;
      } else {
        text = `⬆️ Update available: <code>${shortSha(check.current)}</code> → <code>${shortSha(
          check.latest,
        )}</code> — run /update`;
      }
      if (ctx.chat && note) {
        await ctx.api
          .editMessageText(ctx.chat.id, note.message_id, text, { parse_mode: 'HTML' })
          .catch(() => reply(ctx, text).catch(() => undefined));
      } else {
        await reply(ctx, text).catch(() => undefined);
      }
      return;
    }

    if (arg) {
      await reply(
        ctx,
        'Usage: <code>/update</code> (pull + build + restart) or <code>/update check</code>.',
      );
      return;
    }

    // A successful update self-exits to restart — that would kill any active run.
    if (manager.activeCount() > 0) {
      await reply(ctx, '⏳ A run is in progress; /stop it or wait, then /update.');
      return;
    }

    await reply(ctx, '⏳ Updating: fetching + building the latest… (the bot will restart)');
    const res = await runUpdate({
      chatId: ctx.chat?.id,
      topicId: getTopicId(ctx),
      now: Date.now(),
    });
    if (!res.ok) {
      await reply(
        ctx,
        `❌ Update failed (the running bot is untouched):\n<pre>${truncateHtml(
          escapeHtml(res.tail),
          1500,
        )}</pre>`,
      );
      return;
    }
    if (isUnderSystemd()) {
      await reply(
        ctx,
        `✅ Built <code>${shortSha(res.from)}</code>→<code>${shortSha(res.to)}</code>. Restarting…`,
      );
      // systemd's Restart=always relaunches us into the new code — no sudo needed.
      process.exit(0);
    } else {
      await reply(
        ctx,
        `✅ Built <code>${shortSha(res.to)}</code>. Restart the bot to apply (npm run dev / your process manager).`,
      );
    }
  });

  bot.command('budget', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim();
    const globalLabel =
      cfg.guardHardTokens === 0 ? 'off' : `${formatTok(cfg.guardHardTokens)} work tokens`;

    if (!arg) {
      let text: string;
      if (s.budgetTokens === undefined) {
        text = `💰 Run budget: global limit (${globalLabel}). Set your own: <code>/budget 500k</code> · <code>/budget off</code>`;
      } else if (s.budgetTokens === 0) {
        text =
          '💰 Run budget: <b>off</b> for this session (Token Guard won\'t stop the run). ' +
          '<code>/budget 500k</code> — set a limit, <code>/budget default</code> — restore the global one.';
      } else {
        text =
          `💰 Run budget: <b>${formatTok(s.budgetTokens)}</b> work tokens (session override). ` +
          '<code>/budget off</code> — turn off, <code>/budget default</code> — restore the global one.';
      }
      await reply(ctx, text);
      return;
    }

    if (arg.toLowerCase() === 'default') {
      s.budgetTokens = undefined;
      await store.upsert(s);
      await reply(ctx, `💰 Run budget: restored the global limit (${globalLabel}).`);
      return;
    }

    const parsed = parseBudget(arg);
    if (parsed === null) {
      await reply(
        ctx,
        'Format: <code>/budget 500k</code> | <code>/budget 500000</code> | <code>/budget off</code> | <code>/budget default</code>',
      );
      return;
    }
    s.budgetTokens = parsed;
    await store.upsert(s);
    await reply(
      ctx,
      parsed === 0
        ? '💰 Token Guard is <b>off</b> for this session (token and step limits won\'t stop the run).'
        : `💰 Run budget: <b>${formatTok(parsed)}</b> work tokens. Exceeding it stops the run — the context is preserved.`,
    );
  });

  bot.command('stop', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const droppedQueue = manager.clearQueue(s.chatId, s.topicId);
    const stopped = manager.cancel(s.chatId, s.topicId);
    await reply(
      ctx,
      stopped
        ? `⏹ Stopping…${droppedQueue ? ` Queue cleared (${droppedQueue}).` : ''}`
        : droppedQueue
          ? `Queue cleared (${droppedQueue}), there was no active run.`
          : 'Nothing is running right now.',
    );
  });

  bot.command('branch', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim().toLowerCase();
    if (arg === 'on') s.useBranch = true;
    else if (arg === 'off') s.useBranch = undefined;
    else if (arg === '') {
      await reply(
        ctx,
        s.useBranch
          ? `🌿 Branch mode: <b>on</b> — the agent works in <code>topic-${s.topicId}</code>, doesn't touch main. Turn off: <code>/branch off</code>`
          : '🌿 Branch mode: <b>off</b> — the agent pushes wherever it sees fit (usually main). Turn on: <code>/branch on</code>',
      );
      return;
    } else {
      await reply(ctx, 'Format: <code>/branch on|off</code>');
      return;
    }
    await store.upsert(s);
    await reply(
      ctx,
      s.useBranch
        ? `🌿 On: the agent will work in branch <code>topic-${s.topicId}</code> (main — only via PR). Protects against conflicts with parallel sessions in the same repo.`
        : '🌿 Off: the agent decides again on its own where to push.',
    );
  });

  bot.command('ci', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    await reply(ctx, '⏳ Checking the last CI run…', { disable_notification: true });
    // /branch on: look only at the session branch's runs, don't attribute others.
    const run = await latestRun(s.workdir, s.useBranch ? `topic-${s.topicId}` : undefined);
    if (!run) {
      await reply(ctx, 'No CI runs found (no workflows or gh is unavailable).');
      return;
    }
    const glyph = run.status !== 'completed' ? '⏳' : run.conclusion === 'success' ? '✅' : '❌';
    const extra =
      run.status === 'completed' && run.conclusion !== 'success'
        ? { reply_markup: new InlineKeyboard().text('🔧 Fix it', `cifix:${s.topicId}`) }
        : {};
    await reply(
      ctx,
      `${glyph} <b>${escapeHtml(run.title || run.branch)}</b> — ${escapeHtml(run.status === 'completed' ? (run.conclusion ?? '?') : run.status)}\n${escapeHtml(run.url)}`,
      extra,
    );
  });

  bot.callbackQuery(/^cifix:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const chatId = ctx.chat?.id;
    const topicId = Number(ctx.match[1]);
    const s = chatId !== undefined ? store.get(chatId, topicId) : undefined;
    if (!s) return;
    await submitAgentPrompt(
      ctx,
      deps,
      s,
      'CI failed on the last run. Look at `gh run view --log-failed` for the latest run, ' +
        'find the cause, fix it, run the tests locally, and push the fix.',
    );
  });

  bot.command('verbose', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim().toLowerCase();
    let next: boolean;
    if (arg === 'on') next = true;
    else if (arg === 'off') next = false;
    else if (arg === '') next = !(s.verbose ?? false);
    else {
      await reply(ctx, 'Format: <code>/verbose</code> | <code>/verbose on</code> | <code>/verbose off</code>');
      return;
    }
    s.verbose = next;
    await store.upsert(s);
    await reply(ctx, `Verbose mode: ${next ? 'on' : 'off'}`);
  });

  // /clear is Claude's native naming for the same thing — register both.
  const resetHandler = async (ctx: Context) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    s.engineSessionId = undefined;
    s.contextUsedTokens = undefined;
    s.contextWindowTokens = undefined;
    await store.upsert(s);
    await reply(ctx, '🧹 Context reset — the next prompt will start a new conversation in the same workspace.');
  };
  bot.command(['reset', 'clear'], resetHandler);

  async function startPreviewFlow(
    ctx: Context,
    s: Session,
    port: number | undefined,
    command: string | undefined,
  ): Promise<void> {
    const key = sessionKey(s.chatId, s.topicId);
    const note = await reply(ctx, '⏳ Bringing up the server and tunnel… (up to a couple of minutes on a weak VM)');
    try {
      const info = await deps.preview.start({
        key,
        workdir: s.workdir,
        port,
        command,
        fallbackCommand: s.announcedCmd,
        pagePath: s.announcedPath,
        onExpire: (i) => {
          void ctx.api
            .sendMessage(
              s.chatId,
              `🌐 Preview stopped by the timer (${Math.round(i.ttlMs / 60_000)} min) — saving VM memory. Again: /preview`,
              { message_thread_id: s.topicId, disable_notification: true },
            )
            .catch(() => undefined);
        },
      });
      await ctx.api.editMessageText(
        ctx.chat!.id,
        note.message_id,
        [
          `🌐 <b>Preview live:</b> ${info.url}`,
          ...(info.directUrl
            ? [`📱 If the link doesn't open (DNS filter/carrier): ${info.directUrl}`]
            : []),
          `Server: <code>${escapeHtml(info.server)}</code> · port ${info.port}`,
          `⏳ Auto-stops in ${Math.round(info.ttlMs / 60_000)} min · stop: /preview stop`,
          '⚠️ The link is public (a random subdomain with no password) — not for secrets.',
          ...(info.servesWholeDir
            ? ['⚠️ The static server serves the entire workspace folder (including internal files).']
            : []),
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        note.message_id,
        `❌ Preview didn't come up:\n<pre>${truncateHtml(escapeHtml(String(err instanceof Error ? err.message : err)), 1500)}</pre>`,
        { parse_mode: 'HTML' },
      );
    }
  }

  // The "🌐 Preview on :PORT" button — the bot offers it on its own when the
  // agent announces a local server in its reply.
  bot.callbackQuery(/^preview:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const chatId = ctx.chat?.id;
    const topicId = getTopicId(ctx);
    const s = chatId !== undefined && topicId !== undefined ? store.get(chatId, topicId) : undefined;
    if (!s) return;
    await startPreviewFlow(ctx, s, Number(ctx.match[1]), undefined);
  });

  bot.command('preview', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const key = sessionKey(s.chatId, s.topicId);
    const args = parsePreviewArgs(ctx.match);

    if (args.kind === 'stop') {
      const stopped = deps.preview.stop(key);
      await reply(ctx, stopped ? '⏹ Preview stopped.' : 'Preview is not running.');
      return;
    }
    if (args.kind === 'status') {
      const info = deps.preview.status(key);
      if (!info) {
        await reply(ctx, 'Preview is not running. Bring it up: <code>/preview [port] [command]</code>');
        return;
      }
      const leftMin = Math.max(0, Math.round((info.startedAt + info.ttlMs - Date.now()) / 60_000));
      await reply(
        ctx,
        `🌐 ${info.url}${info.directUrl ? `\n📱 Direct address: ${info.directUrl}` : ''}\nPort ${info.port} · auto-stops in ~${leftMin} min`,
      );
      return;
    }

    // Bare /preview: first the port the agent announced last.
    await startPreviewFlow(ctx, s, args.port ?? s.announcedPort, args.command);
  });

  bot.command('diff', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    try {
      const { stat, diff } = await gitDiff(s.workdir);
      if (!stat && !diff) {
        await reply(ctx, 'No changes (git diff is empty).');
        return;
      }
      const blocks: string[] = [];
      if (stat) blocks.push(`<pre><code>${escapeHtml(truncate(stat, 3000))}</code></pre>`);
      if (diff) blocks.push(`<pre><code>${escapeHtml(truncate(diff, 12000))}</code></pre>`);
      for (const chunk of chunkHtmlBlocks(blocks)) {
        await reply(ctx, chunk);
      }
    } catch (err) {
      await reply(ctx, `❌ git diff failed:\n<pre>${truncateHtml(escapeHtml(String(err)), 800)}</pre>`);
    }
  });

  bot.command('file', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim();
    if (!arg) {
      await reply(ctx, 'Format: <code>/file &lt;path&gt;</code> — sends a file from the workspace as a document (path relative to the repo root).');
      return;
    }
    const resolved = path.resolve(s.workdir, arg);
    if (resolved !== s.workdir && !resolved.startsWith(s.workdir + path.sep)) {
      await reply(ctx, '❌ Path is outside the workspace.');
      return;
    }
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      await reply(ctx, `❌ Not found: <code>${escapeHtml(arg)}</code>`);
      return;
    }
    if (stat.isDirectory()) {
      await reply(ctx, '❌ That is a directory — give me a file path.');
      return;
    }
    if (stat.size > FILE_SEND_MAX_BYTES) {
      await reply(ctx, `❌ File is too large to send (${humanBytes(stat.size)}, limit ${humanBytes(FILE_SEND_MAX_BYTES)}).`);
      return;
    }
    await ctx.replyWithDocument(new InputFile(resolved), {
      message_thread_id: getTopicId(ctx),
      disable_notification: true,
    });
  });

  bot.command('commit', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const message = ctx.match.trim();
    if (!message) {
      await reply(
        ctx,
        'Format: <code>/commit &lt;message&gt;</code> — commits all current changes without pushing.',
      );
      return;
    }
    if (s.status === 'running' || manager.queueLength(s.chatId, s.topicId) > 0) {
      await reply(
        ctx,
        '⏳ The agent is still working or has queued work. Wait for it to finish, then run /commit.',
      );
      return;
    }
    try {
      const result = await gitCommitAll(s.workdir, message);
      await reply(
        ctx,
        `✅ Committed <code>${escapeHtml(result.sha)}</code> — ${escapeHtml(result.subject)}\nNot pushed.`,
      );
    } catch (err) {
      await reply(
        ctx,
        `❌ Commit failed:\n<pre>${truncateHtml(escapeHtml(String(err instanceof Error ? err.message : err)), 1200)}</pre>`,
      );
    }
  });

  bot.command('cleanup', async (ctx) => {
    if (!ctx.chat) return;
    const note = await reply(ctx, '🧹 Looking for unused workspaces…').catch(() => undefined);
    const liveWorkdirs = store.all().map((s) => s.workdir);
    const orphans = await findOrphanWorkspaces(cfg.workspacesDir, liveWorkdirs);

    if (orphans.length === 0) {
      const text = '✨ Nothing to clean — every directory in <code>workspaces</code> is taken by a live session.';
      if (note) {
        await ctx.api
          .editMessageText(ctx.chat.id, note.message_id, text, { parse_mode: 'HTML' })
          .catch(() => reply(ctx, text).catch(() => undefined));
      } else {
        await reply(ctx, text).catch(() => undefined);
      }
      return;
    }

    const totalBytes = orphans.reduce((n, o) => n + o.bytes, 0);
    const listing = orphans
      .map((o) => `• <code>${escapeHtml(o.name)}</code> — ${escapeHtml(o.size)}`)
      .join('\n');
    const text =
      `🧹 <b>Unused workspaces</b> (${orphans.length})\n${listing}\n\n` +
      `Will free ~<b>${humanBytes(totalBytes)}</b>. These are directories with no bound session.`;
    const kb = new InlineKeyboard()
      .text(`🧹 Delete ${orphans.length} dirs`, 'cleanup:go')
      .text('Cancel', 'cleanup:cancel');

    // The keyboard lives on the message we send now; key the cache by its id.
    let sent;
    if (note) {
      sent = await ctx.api
        .editMessageText(ctx.chat.id, note.message_id, text, { parse_mode: 'HTML', reply_markup: kb })
        .catch(() => undefined);
    }
    if (!sent) {
      sent = await reply(ctx, text, { reply_markup: kb }).catch(() => undefined);
    }
    if (sent && typeof sent !== 'boolean') {
      rememberCleanup(`${ctx.chat.id}:${sent.message_id}`, orphans);
    }
  });

  bot.callbackQuery(/^cleanup:go$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const key = chatId !== undefined ? `${chatId}:${ctx.msg?.message_id}` : '';
    const orphans = key ? cleanupCache.get(key) : undefined;
    if (!orphans) {
      await ctx.answerCallbackQuery({ text: 'The list is stale — run /cleanup again.' }).catch(() => undefined);
      return;
    }
    cleanupCache.delete(key);
    await ctx.answerCallbackQuery({ text: 'Deleting…' }).catch(() => undefined);
    const res = await deleteWorkspaces(cfg.workspacesDir, orphans);
    const refusedPart = res.refused > 0 ? ` (unsafe paths skipped: ${res.refused})` : '';
    await reply(
      ctx,
      `🧹 Directories deleted: <b>${res.deleted}</b>, freed ~<b>${humanBytes(res.freedBytes)}</b>${refusedPart}.`,
    ).catch(() => undefined);
  });

  bot.callbackQuery(/^cleanup:cancel$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) cleanupCache.delete(`${chatId}:${ctx.msg?.message_id}`);
    await ctx.answerCallbackQuery({ text: 'Cancelled.' }).catch(() => undefined);
  });
}
