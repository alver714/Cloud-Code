import path from 'node:path';
import type {
  AgentEvent,
  Engine,
  EngineKind,
  EngineRun,
  Usage,
  UsageTick,
} from '../engines/types.js';
import {
  dedupeAgainst,
  sanitizeFact,
  selectMemoryForInjection,
  type FactExtractor,
} from '../memory/extract.js';
import { sanitizedChildEnv } from '../util/childEnv.js';
import type { MemoryStore } from '../memory/store.js';
import { extractAnnouncedServer, type AnnouncedServer } from '../system/preview.js';
import type { DiskInfo, EgressInfo, MemoryInfo } from '../system/resources.js';
import type { UsageAccounting } from '../usage/accounting.js';
import { RunGuard, workTokens, type RunGuardConfig } from './guard.js';
import { SessionStore } from './store.js';
import { sessionKey, type GoalState, type GoalStatus, type Session } from './types.js';

export interface RunSummary {
  ok: boolean;
  cancelled: boolean;
  resultText?: string;
  errorMessages: string[];
  costUsd?: number;
  durationMs?: number;
  usage?: Usage;
  /** Set when the Token Guard hard-stopped the run. */
  guardStopped?: { workTokens: number; limit: number };
  /** input/context-window occupancy (%) when both provider numbers are known. */
  contextPct?: number;
}

/** Frames the model-made /compact checkpoint that seeds the next fresh session. */
export const COMPACT_HEADER = 'Condensed summary of the earlier conversation in this session:';

/** The bot layer implements this per run (a TopicStreamer). */
export interface RunReporter {
  start(): Promise<void>;
  onEvent(ev: AgentEvent): Promise<void> | void;
  end(summary: RunSummary): Promise<void>;
  /** Optional silent side-channel notice (Token Guard soft warning). */
  notice?(text: string): Promise<void>;
}

export type ReporterFactory = (session: Session, prompt: string) => RunReporter;

/** Engine 5h-window usage, as read for the pre-flight gate. */
export interface WindowUsage {
  usedPercent: number;
  resetsAt?: number;
}
export type WindowReader = (engine: EngineKind) => Promise<WindowUsage | null>;

export type SubmitResult =
  | { status: 'started' }
  | { status: 'queued'; position: number }
  | { status: 'limit-blocked'; usedPercent: number; resetsAt?: number }
  /** Hard resource stop — no force button (memory too low / disk almost full). */
  | { status: 'resource-blocked'; reason: 'memory' | 'disk'; detail: string }
  /** Egress near the free-tier budget — confirm-with-button (like limit-blocked). */
  | { status: 'egress-blocked'; usedMb: number; freeMb: number; usedPct: number };

export interface SubmitOptions {
  /** Skip the pre-flight subscription-window gate (a user-confirmed force). */
  bypassPreflight?: boolean;
  /**
   * INTERNAL (goal machine only): marks this prompt as a /goal loop iteration.
   * Only runs carrying this flag may advance the goal loop when they finish —
   * an interleaved plain user message must never be parsed as a goal verdict.
   */
  goalIteration?: boolean;
}

interface ActiveRun {
  run: EngineRun;
  cancelled: boolean;
  guardTripped: boolean;
}

interface PendingJob {
  key: string;
  prompt: string;
  /** True when this queued prompt is a /goal loop iteration (see SubmitOptions). */
  goalIteration?: boolean;
}

/**
 * Resource Guard wiring for the pre-flight gates. Collectors are injected (same
 * DI style as readWindow) so tests can stub them; each fails open (null).
 */
export interface ResourceGuardOptions {
  /** RESOURCE_GUARD — false skips all resource gates entirely. */
  enabled: boolean;
  /** Filesystem to statfs for the disk gate (the workspaces dir). */
  diskPath: string;
  /** Combined MemAvailable+SwapFree below this (MB) hard-blocks a start. */
  minFreeMemMb: number;
  /** Disk usedPct ≥ this hard-blocks a start. */
  diskBlockPct: number;
  /** Free monthly egress budget (MB). */
  egressFreeMb: number;
  /** Egress ≥ this percent of the budget triggers a confirm-with-button. */
  egressWarnPct: number;
  readMemory: () => Promise<MemoryInfo | null>;
  readDisk: (dirPath: string) => Promise<DiskInfo | null>;
  readEgress: () => Promise<EgressInfo | null>;
}

export interface ManagerOptions {
  logsDir: string;
  maxConcurrentRuns: number;
  defaultModels: Partial<Record<EngineKind, string>>;
  /** Soft/hard/step thresholds (session /budget overrides the hard token limit). */
  guard: RunGuardConfig;
  /** Block a start when the 5h window is ≥ this percent; 0 = disabled. */
  preflightPct: number;
  /** Reads the engine's 5h window for the pre-flight gate; null = fail-open. */
  readWindow?: WindowReader;
  /** Per-day spend accounting, updated at run end. */
  accounting?: UsageAccounting;
  /** Resource Guard collectors + thresholds; omitted = no resource gates. */
  resource?: ResourceGuardOptions;
  /** Cross-session bot memory (injection + opportunistic extraction); omitted = off. */
  memory?: MemoryRuntimeOptions;
  /**
   * Loop-level side channel to the session's topic (🎯/🏁/⚠️ goal-loop
   * messages). Omitted = loop notifications are dropped.
   */
  notifyTopic?: (session: Session, text: string, silent: boolean) => Promise<void>;
  /** Fired after a successful run in which the agent pushed to the remote. */
  onPush?: (session: Session) => void;
  /** Fired after a run in which the agent announced a local server port. */
  onPortAnnounced?: (session: Session, port: number) => void;
}

/**
 * Cross-session memory wiring. `extract` is injected (not tied to an engine) so
 * tests stub it and production wires a cheap claude-haiku call. All of it is
 * best-effort: a failure here never touches the main run.
 */
export interface MemoryRuntimeOptions {
  /** BOT_MEMORY — false disables both injection and extraction entirely. */
  enabled: boolean;
  store: MemoryStore;
  /** Mines durable facts from a finished exchange (best-effort, may resolve []). */
  extract: FactExtractor;
  /** Extract on the 1st substantive run per session, then every Nth (default 3). */
  everyNRuns?: number;
  /** A run whose result is shorter than this is too trivial to mine (default 400). */
  minResultChars?: number;
  /** Char budget for the injected memory summary block (default 2000). */
  injectBudgetChars?: number;
}

const MEMORY_EVERY_N_DEFAULT = 3;
const MEMORY_MIN_RESULT_CHARS = 400;
const MEMORY_INJECT_BUDGET = 2_000;

const PREFLIGHT_CACHE_MS = 60_000;
const PREFLIGHT_TIMEOUT_MS = 3_000;
const RESOURCE_CACHE_MS = 30_000;

interface ResourceSnapshot {
  at: number;
  mem: MemoryInfo | null;
  disk: DiskInfo | null;
  egress: EgressInfo | null;
}

const HISTORY_MAX_ENTRIES = 20;
const HISTORY_MAX_CHARS = 24_000;
const HISTORY_ANSWER_MAX = 2000;

/** Compact token count for guard notices (kept local to avoid a bot-layer import). */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Append a successful exchange to the session's rolling history, capped both by
 * entry count and total characters (oldest dropped first). Mutates in place.
 */
function appendHistory(session: Session, prompt: string, answer: string): void {
  const entry = {
    prompt,
    answer: answer.length > HISTORY_ANSWER_MAX ? answer.slice(0, HISTORY_ANSWER_MAX) : answer,
  };
  const history = session.history ? [...session.history, entry] : [entry];
  while (history.length > HISTORY_MAX_ENTRIES) history.shift();
  let total = history.reduce((n, e) => n + e.prompt.length + e.answer.length, 0);
  while (total > HISTORY_MAX_CHARS && history.length > 1) {
    const dropped = history.shift()!;
    total -= dropped.prompt.length + dropped.answer.length;
  }
  session.history = history;
}

/**
 * Compose the final prompt the engine receives from the session's one-shot
 * context. Order (outermost first): memory block → branch rule → notes block →
 * pendingContext block → raw user prompt. notes/pendingContext are one-shot (the
 * caller clears them once the run is spawned); the memory block is durable and
 * re-derived every run (never injected into /compact runs — caller passes none).
 */
function assembleEnginePrompt(session: Session, prompt: string, memoryBlock?: string): string {
  let out = session.pendingContext
    ? `${session.pendingContext}\n\n---\n\nNew request:\n${prompt}`
    : prompt;
  if (session.notes && session.notes.length > 0) {
    const block =
      'By the way, notes from the user (keep them in mind):\n' +
      session.notes.map((n) => `- ${n}`).join('\n');
    out = `${block}\n\n${out}`;
  }
  if (session.useBranch) {
    out =
      `Session rule: all work is done in the git branch topic-${session.topicId} ` +
      '(create it from the current one if it does not exist yet; commit and push only it, ' +
      'never touch main/master directly — changes there go only through a PR).\n\n' +
      out;
  }
  if (memoryBlock) {
    out = `${memoryBlock}\n\n${out}`;
  }
  return out;
}

/**
 * Legacy GOAL_ACHIEVED sentinel detector — kept as a fallback for old sessions /
 * agents that still emit the marker instead of the structured verdict line.
 * Tolerant of markdown decoration («**GOAL_ACHIEVED**», «✅ GOAL_ACHIEVED»).
 */
export function hasGoalAchieved(text: string | undefined): boolean {
  if (!text) return false;
  return text
    .split('\n')
    .some((l) => l.trim().replace(/^[*_#>`✅🎯\s-]+/u, '').startsWith('GOAL_ACHIEVED'));
}

export type GoalVerdictStatus = 'in_progress' | 'complete' | 'blocked';
export interface GoalVerdict {
  status: GoalVerdictStatus;
  evidence: string;
}

/**
 * Parse the structured completion verdict an iteration is asked to END with:
 *   {"goal_status":"in_progress"|"complete"|"blocked","evidence":"…"}
 * Finds the LAST line mentioning "goal_status" (tolerant of ```json fences and
 * surrounding prose) and JSON-parses the object on it. If no single-line object
 * matches, falls back to a multi-line scan: from the last `}` back to its
 * matching `{` (models sometimes pretty-print the verdict). Malformed or
 * missing → in_progress, with a legacy GOAL_ACHIEVED marker treated as complete.
 */
export function parseGoalVerdict(text: string | undefined): GoalVerdict {
  const fallback = (): GoalVerdict =>
    hasGoalAchieved(text) ? { status: 'complete', evidence: '' } : { status: 'in_progress', evidence: '' };
  if (!text) return fallback();
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/goal_status/i.test(lines[i]!)) continue;
    const line = lines[i]!;
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) continue;
    const v = verdictFromJson(line.slice(start, end + 1));
    if (v) return v;
  }
  return parseMultilineVerdict(text) ?? fallback();
}

/** JSON.parse a candidate blob into a GoalVerdict; null when it isn't one. */
function verdictFromJson(blob: string): GoalVerdict | null {
  try {
    const obj = JSON.parse(blob) as Record<string, unknown>;
    const st = obj.goal_status;
    if (st === 'complete' || st === 'blocked' || st === 'in_progress') {
      return { status: st, evidence: typeof obj.evidence === 'string' ? obj.evidence : '' };
    }
  } catch {
    /* not valid JSON */
  }
  return null;
}

/**
 * Multi-line fallback for a pretty-printed verdict object: take the LAST `}`
 * in the text, walk backwards to its matching `{` (brace balance) and try to
 * parse the whole slice — even when it spans several lines.
 */
function parseMultilineVerdict(text: string): GoalVerdict | null {
  if (!/goal_status/i.test(text)) return null;
  const end = text.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return verdictFromJson(text.slice(i, end + 1));
    }
  }
  return null;
}

/** Streak key for a blocked verdict with EMPTY evidence — an empty string is
 * falsy and used to reset the streak every time, so 3 consecutive
 * empty-evidence blocks never terminated the loop. */
const EMPTY_BLOCKER_KEY = '(no evidence)';

/** Minimal HTML escape for agent-controlled text interpolated into
 * parse_mode:HTML notifications (kept local to avoid a bot-layer import). */
function escapeHtmlLocal(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Normalize a blocker description for streak comparison (per codex's rule). */
function normalizeBlocker(evidence: string): string {
  return evidence.toLowerCase().trim().slice(0, 120);
}

/** Shared completion-audit + structured-verdict tail appended to every goal prompt. */
const GOAL_AUDIT =
  'Completion audit: before declaring the goal achieved, go through EVERY goal requirement ' +
  '(each item, named artifact, command, test, invariant) and check it against the ACTUAL current ' +
  'state — file, command output, test result, behavior. Do not narrow the scope or redefine ' +
  'success to fit what is already done: complete only with full, verified coverage of all requirements. ' +
  'Weak, indirect, or missing evidence = not achieved, keep working.';

const GOAL_VERDICT_FORMAT =
  'RESPONSE FORMAT: end your response with EXACTLY one final line — JSON:\n' +
  '{"goal_status":"in_progress"|"complete"|"blocked","evidence":"brief proof or blocker description"}\n' +
  '- complete — only if the audit confirmed all requirements;\n' +
  '- blocked — only if you are in a real dead end and cannot make progress without user intervention/an external change;\n' +
  '- otherwise in_progress. If the line is missing or the format is broken — it counts as in_progress.';

/** The prompt that starts a /goal loop (iteration 1). */
export function goalStartPrompt(goal: string, max: number): string {
  return (
    `Goal: ${goal}\n\n` +
    `Work toward the goal autonomously, in iterations (up to ${max}). ` +
    'Rely on the actual state of the worktree and external systems as the source of truth.\n\n' +
    `${GOAL_AUDIT}\n\n${GOAL_VERDICT_FORMAT}`
  );
}

/** The prompt for every /goal loop iteration after the first. */
export function goalIterationPrompt(gs: GoalState, blockedRetry = false): string {
  return (
    `Continue working on the goal: ${gs.goal}\n` +
    `Iteration ${gs.iteration} of ${gs.max}.\n\n` +
    (blockedRetry
      ? 'The previous iteration reported a blocker — try a DIFFERENT approach, do not repeat what already did not work.\n\n'
      : '') +
    'Check the current state of the worktree (do not rely only on the memory of past steps).\n\n' +
    `${GOAL_AUDIT}\n\n${GOAL_VERDICT_FORMAT}`
  );
}

/** What the restart-resume path should do for a session (pure; no bot). */
export type GoalRestartNotice = 'goal-resume' | 'generic' | null;

/**
 * Decide the post-restart notice for a session: an interrupted active goal loop
 * gets a resume offer, a plain interrupted run gets the generic notice, anything
 * else gets nothing. Pure so it can be unit-tested without the bot.
 */
export function goalRestartNotice(session: Session): GoalRestartNotice {
  if (session.goalState?.status === 'active') return 'goal-resume';
  if (session.status === 'running' || session.runningPid !== undefined) return 'generic';
  return null;
}

/** Map a blocking pre-flight SubmitResult to the resumable goal status it implies. */
function goalBlockStatus(res: SubmitResult): GoalStatus | null {
  if (
    res.status === 'limit-blocked' ||
    res.status === 'egress-blocked' ||
    res.status === 'resource-blocked'
  ) {
    return 'usage_limited';
  }
  return null;
}

/** HH:MM for a unix-seconds reset time (kept local to avoid a bot-layer import). */
function fmtEpochHM(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Loop-pause message for a pre-flight gate that blocked the next goal iteration. */
function goalBlockReason(res: SubmitResult): string {
  const tail = ' Continue later: /goal continue.';
  if (res.status === 'limit-blocked') {
    const reset = res.resetsAt ? ` (resets at ${fmtEpochHM(res.resetsAt)})` : '';
    return `⏸ Goal loop stopped by the subscription limit (${Math.round(res.usedPercent)}%${reset}).${tail}`;
  }
  if (res.status === 'egress-blocked') {
    return `⏸ Goal loop stopped: VM outbound traffic near the limit (${res.usedPct}%).${tail}`;
  }
  if (res.status === 'resource-blocked') {
    return res.reason === 'memory'
      ? `⏸ Goal loop stopped: low memory on the VM (${res.detail} MB).${tail}`
      : `⏸ Goal loop stopped: disk almost full (${res.detail}%).${tail}`;
  }
  return `⏸ Goal loop paused.${tail}`;
}

/**
 * Owns run lifecycle: one engine process per session, FIFO queue for
 * prompts that arrive while a session is busy or the global limit is hit.
 * Sessions run concurrently and independently.
 */
export class SessionManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly pending: PendingJob[] = [];
  /** Pre-flight window reads, cached briefly so we don't hammer the app-server. */
  private readonly windowCache = new Map<EngineKind, { at: number; value: WindowUsage | null }>();
  /** Resource collector reads, cached 30s (shared across the memory/disk/egress gates). */
  private resourceCache?: ResourceSnapshot;
  /**
   * Keys whose /goal auto-advance loop is live in THIS process. The persisted
   * source of truth is session.goalState; this thin set decides whether a
   * finished run should trigger the next iteration (a restart empties it, so an
   * interrupted goal waits for /goal continue instead of auto-resuming).
   */
  private readonly goalRunning = new Set<string>();
  /**
   * Per-session count of substantive successful runs seen — drives the memory
   * extraction cadence (extract on the 1st, then every Nth). In-memory only.
   */
  private readonly memoryRunCounts = new Map<string, number>();

  constructor(
    private readonly store: SessionStore,
    private readonly engines: Record<EngineKind, Engine>,
    private readonly reporterFactory: ReporterFactory,
    private readonly opts: ManagerOptions,
  ) {}

  isRunning(chatId: number, topicId: number): boolean {
    return this.active.has(sessionKey(chatId, topicId));
  }

  queueLength(chatId: number, topicId: number): number {
    const key = sessionKey(chatId, topicId);
    return this.pending.filter((j) => j.key === key).length;
  }

  activeCount(): number {
    return this.active.size;
  }

  /** True when this process is auto-advancing a /goal loop for the session. */
  isGoalActive(chatId: number, topicId: number): boolean {
    return this.goalRunning.has(sessionKey(chatId, topicId));
  }

  /**
   * Start a fresh /goal loop (iteration 1): persist the status machine and submit
   * the first prompt through the normal gated path. On a pre-flight block the
   * loop is torn down (never left half-live). Returns the submit result.
   */
  async startGoal(session: Session, goal: string, max: number): Promise<SubmitResult> {
    const key = sessionKey(session.chatId, session.topicId);
    session.goalState = { goal, iteration: 1, max, status: 'active' };
    session.goal = goal;
    session.goalIteration = 1;
    this.goalRunning.add(key);
    await this.store.upsert(session);
    const res = await this.submitPrompt(session, goalStartPrompt(goal, max), {
      goalIteration: true,
    });
    if (res.status !== 'started' && res.status !== 'queued') {
      this.goalRunning.delete(key);
      session.goalState = undefined;
      await this.store.upsert(session);
    }
    return res;
  }

  /**
   * Resume a non-complete goal (blocked / budget_limited / usage_limited /
   * failed / interrupted-active): reset the blocker streak, re-arm the loop and
   * submit the next iteration. When the iteration budget was already spent it is
   * extended by `extraMax`. Returns the submit result for the caller to message.
   */
  async resumeGoal(session: Session, extraMax: number): Promise<SubmitResult> {
    const gs = session.goalState;
    if (!gs) return { status: 'started' };
    gs.blockerStreak = undefined;
    gs.lastBlocker = undefined;
    gs.status = 'active';
    if (gs.iteration >= gs.max) gs.max = gs.iteration + extraMax;
    this.goalRunning.add(sessionKey(session.chatId, session.topicId));
    return this.advanceToNextIteration(session, false);
  }

  /** Drop a session's goal entirely (/goal off): clear state and stop the loop. */
  async clearGoal(session: Session): Promise<void> {
    this.goalRunning.delete(sessionKey(session.chatId, session.topicId));
    session.goalState = undefined;
    session.goal = undefined;
    session.goalIteration = undefined;
    await this.store.upsert(session);
  }

  async submitPrompt(
    session: Session,
    prompt: string,
    opts: SubmitOptions = {},
  ): Promise<SubmitResult> {
    const key = sessionKey(session.chatId, session.topicId);
    const enqueue = (): SubmitResult => {
      this.pending.push({ key, prompt, goalIteration: opts.goalIteration });
      return { status: 'queued', position: this.pending.filter((j) => j.key === key).length };
    };
    if (this.active.has(key) || this.active.size >= this.opts.maxConcurrentRuns) {
      return enqueue();
    }
    // Pre-flight gates run only for a fresh start the user initiated (queued jobs
    // re-drained through startRun bypass these, as do user-confirmed forces).
    // Order: memory → disk → egress (Resource Guard) → subscription window.
    if (!opts.bypassPreflight) {
      const blocked = await this.checkResources();
      if (blocked) return blocked;

      if (this.opts.preflightPct > 0 && this.opts.readWindow) {
        const w = await this.checkWindow(session.engine);
        if (w && w.usedPercent >= this.opts.preflightPct) {
          return { status: 'limit-blocked', usedPercent: w.usedPercent, resetsAt: w.resetsAt };
        }
      }
      // The gates above awaited: a concurrent submit (or the goal auto-advance)
      // may have taken the slot meanwhile — re-check instead of breaching the cap.
      if (this.active.has(key) || this.active.size >= this.opts.maxConcurrentRuns) {
        return enqueue();
      }
    }
    this.startRun(session, prompt, opts.goalIteration === true);
    return { status: 'started' };
  }

  /**
   * Read the three resource signals (cached 30s) and grade them against the
   * configured limits, in order: memory (hard) → disk (hard) → egress (confirm).
   * Every signal fails open — a null collector result skips its gate. Returns
   * the blocking SubmitResult, or null when nothing blocks / guard is disabled.
   */
  private async checkResources(): Promise<SubmitResult | null> {
    const r = this.opts.resource;
    if (!r || !r.enabled) return null;

    const now = Date.now();
    if (!this.resourceCache || now - this.resourceCache.at >= RESOURCE_CACHE_MS) {
      const [mem, disk, egress] = await Promise.all([
        r.readMemory().catch(() => null),
        r.readDisk(r.diskPath).catch(() => null),
        r.readEgress().catch(() => null),
      ]);
      this.resourceCache = { at: now, mem, disk, egress };
    }
    const { mem, disk, egress } = this.resourceCache;

    if (mem) {
      const freeCombined = mem.availableMb + (mem.swapFreeMb ?? 0);
      if (freeCombined < r.minFreeMemMb) {
        return { status: 'resource-blocked', reason: 'memory', detail: String(Math.round(freeCombined)) };
      }
    }
    if (disk && disk.usedPct >= r.diskBlockPct) {
      return { status: 'resource-blocked', reason: 'disk', detail: String(disk.usedPct) };
    }
    if (egress && r.egressFreeMb > 0) {
      const usedPct = (egress.monthTxMb / r.egressFreeMb) * 100;
      if (usedPct >= r.egressWarnPct) {
        return {
          status: 'egress-blocked',
          usedMb: Math.round(egress.monthTxMb),
          freeMb: r.egressFreeMb,
          usedPct: Math.round(usedPct),
        };
      }
    }
    return null;
  }

  /**
   * Read the engine's 5h-window usage for the pre-flight gate, with a 60s
   * in-memory cache and a 3s timeout. Any failure resolves null (fail-open).
   */
  private async checkWindow(engine: EngineKind): Promise<WindowUsage | null> {
    const cached = this.windowCache.get(engine);
    if (cached && Date.now() - cached.at < PREFLIGHT_CACHE_MS) return cached.value;

    const value = await new Promise<WindowUsage | null>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        console.error(`[guard] pre-flight window read timed out for ${engine}`);
        resolve(null);
      }, PREFLIGHT_TIMEOUT_MS);
      this.opts.readWindow!(engine).then(
        (v) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          console.error(`[guard] pre-flight window read failed for ${engine}:`, err);
          resolve(null);
        },
      );
    });

    this.windowCache.set(engine, { at: Date.now(), value });
    return value;
  }

  /**
   * Feed one cumulative tick to the run's guard. On 'soft' send a silent
   * warning notice; on 'hard' flag the run, kill it via the same path as
   * cancel(), and mark the summary so end() renders the distinct ⛔ message.
   */
  private async applyGuard(
    key: string,
    tick: UsageTick,
    guard: RunGuard,
    hardTokens: number,
    summary: RunSummary,
    reporter: RunReporter,
  ): Promise<void> {
    const verdict = guard.check(tick);
    if (verdict === 'ok') return;

    if (verdict === 'soft') {
      if (!reporter.notice) return;
      const text = `⚠️ The run has already spent ~${fmtTokens(workTokens(tick))} work tokens (steps: ${tick.steps})`;
      try {
        await reporter.notice(text);
      } catch (err) {
        console.error(`[manager] reporter.notice failed for ${key}:`, err);
      }
      return;
    }

    // hard: stop the run (idempotent — only the first crossing acts)
    const state = this.active.get(key);
    if (!state || state.guardTripped) return;
    state.guardTripped = true;
    state.cancelled = true; // reuse the cancel path (suppresses the synthetic error)
    summary.guardStopped = { workTokens: workTokens(tick), limit: hardTokens };
    try {
      state.run.cancel();
    } catch (err) {
      console.error(`[manager] guard cancel failed for ${key}:`, err);
    }
  }

  /**
   * Returns true if a run was actually cancelled. Also pauses a /goal loop: the
   * runtime flag is dropped so no next iteration fires, but goalState stays
   * (status 'active' = interrupted) so /goal continue can pick it back up.
   */
  cancel(chatId: number, topicId: number): boolean {
    this.goalRunning.delete(sessionKey(chatId, topicId));
    const state = this.active.get(sessionKey(chatId, topicId));
    if (!state) return false;
    state.cancelled = true;
    state.run.cancel();
    return true;
  }

  cancelAll(): void {
    this.goalRunning.clear();
    for (const state of this.active.values()) {
      state.cancelled = true;
      state.run.cancel();
    }
  }

  /** Drop queued prompts for a session; returns how many were dropped. */
  clearQueue(chatId: number, topicId: number): number {
    const key = sessionKey(chatId, topicId);
    let dropped = 0;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.key === key) {
        this.pending.splice(i, 1);
        dropped++;
      }
    }
    return dropped;
  }

  /**
   * Engines must not see the bot's own secrets, and each engine only
   * gets its own auth (a codex-driven agent has no business reading
   * the Claude OAuth token and vice versa).
   */
  private childEnv(engine: EngineKind): NodeJS.ProcessEnv {
    return sanitizedChildEnv({ keepClaude: engine === 'claude', keepCodex: engine === 'codex' });
  }

  /** Fire-and-forget; all errors are contained inside. */
  private startRun(session: Session, prompt: string, isGoalIteration = false): void {
    const key = sessionKey(session.chatId, session.topicId);
    const engine = this.engines[session.engine];
    const model = session.model ?? this.opts.defaultModels[session.engine];

    // Durable cross-session memory: inject a top-ranked summary block (never into
    // /compact runs). The injected facts' usage is bumped once the run spawns.
    let injectedMemoryIds: string[] = [];
    let memoryBlock: string | undefined;
    const mem = this.opts.memory;
    if (mem?.enabled && !session.compactPending) {
      try {
        const sel = selectMemoryForInjection(
          mem.store.all(),
          mem.injectBudgetChars ?? MEMORY_INJECT_BUDGET,
          session.repoUrl, // A3: prefer same-repo facts; gate cross-repo ones
        );
        if (sel.block) {
          memoryBlock = sel.block;
          injectedMemoryIds = sel.injectedIds;
        }
      } catch (err) {
        console.error(`[manager] memory injection failed for ${key}:`, err);
      }
    }

    // The session's goal/notes/handoff context is folded into this run's prompt
    // (the reporter/history still use the user's raw prompt below).
    const enginePrompt = assembleEnginePrompt(session, prompt, memoryBlock);

    let run: EngineRun;
    try {
      run = engine.run({
        prompt: enginePrompt,
        workdir: session.workdir,
        resumeSessionId: session.engineSessionId,
        forkSession: session.forkNext,
        model,
        effort: session.effort,
        rawLogPath: path.join(
          this.opts.logsDir,
          `session-${session.chatId}-${session.topicId}.jsonl`,
        ),
        env: this.childEnv(session.engine),
      });
    } catch (err) {
      // e.g. unwritable LOGS_DIR — don't stall the drain loop
      console.error(`[manager] engine spawn failed for ${key}:`, err);
      session.status = 'error';
      session.runningPid = undefined;
      void this.store.upsert(session);
      // this run never occupied a slot, but queued jobs still need to drain
      this.drainQueue();
      return;
    }
    // The one-shot context is now baked into this run — consume it once.
    let consumed = false;
    if (session.pendingContext !== undefined) {
      session.pendingContext = undefined;
      consumed = true;
    }
    if (session.notes && session.notes.length > 0) {
      session.notes = undefined;
      consumed = true;
    }
    if (session.forkNext) {
      session.forkNext = undefined;
      consumed = true;
    }
    if (consumed) void this.store.upsert(session);
    // The injected facts got used this run — bump usage/recency (best-effort).
    if (mem?.enabled && injectedMemoryIds.length > 0) {
      void mem.store
        .bumpUsage(injectedMemoryIds)
        .catch((err) => console.error(`[manager] memory bumpUsage failed for ${key}:`, err));
    }
    // Reserve the slot synchronously so concurrent submits queue correctly.
    this.active.set(key, { run, cancelled: false, guardTripped: false });

    void this.pumpRun(key, session, prompt, run, isGoalIteration).catch((err) => {
      console.error(`[manager] run pump crashed for ${key}:`, err);
      this.active.delete(key);
      // a crashed pump never reached its own drainQueue — keep the queue moving
      this.drainQueue();
    });
  }

  private async pumpRun(
    key: string,
    session: Session,
    prompt: string,
    run: EngineRun,
    isGoalIteration: boolean,
  ): Promise<void> {
    session.status = 'running';
    session.lastRunAt = new Date().toISOString();
    session.runningPid = run.pid;
    try {
      await this.store.upsert(session);
    } catch (err) {
      // a persist failure must not skip reporter.end / drainQueue below
      console.error(`[manager] persist (run start) failed for ${key}:`, err);
    }

    const reporter = this.reporterFactory(session, prompt);
    const summary: RunSummary = { ok: false, cancelled: false, errorMessages: [] };
    const startedAt = Date.now();

    // Session /budget overrides the global hard token limit (0 = off).
    // An explicit `/budget off` (0) disables the step backstop too — the user
    // asked for an uncapped run, so maxSteps must not hard-stop it either.
    const hardTokens = session.budgetTokens ?? this.opts.guard.hardTokens;
    const guard = new RunGuard({
      softTokens: this.opts.guard.softTokens,
      hardTokens,
      maxSteps: session.budgetTokens === 0 ? 0 : this.opts.guard.maxSteps,
    });
    let lastTick: UsageTick | undefined;
    let sawPush = false;
    let announced: AnnouncedServer | undefined;
    const recentCommands: string[] = [];

    try {
      await reporter.start();
    } catch (err) {
      console.error(`[manager] reporter.start failed for ${key}:`, err);
    }

    try {
      for await (const ev of run.events) {
        if (ev.kind === 'init' && ev.engineSessionId !== session.engineSessionId) {
          // claude print mode issues a NEW session id on every resumed run
          session.engineSessionId = ev.engineSessionId;
          await this.store.upsert(session);
        }
        if (ev.kind === 'usage-tick') {
          lastTick = ev.cumulative;
          await this.applyGuard(key, ev.cumulative, guard, hardTokens, summary, reporter);
        }
        if (ev.kind === 'tool-use') {
          if (/\bgit push\b|\bgh pr merge\b/.test(ev.summary)) sawPush = true;
          recentCommands.push(ev.summary);
          if (recentCommands.length > 30) recentCommands.shift();
        }
        if (ev.kind === 'assistant-text' || (ev.kind === 'result' && ev.ok)) {
          const found = extractAnnouncedServer(ev.text);
          if (found) announced = found;
        }
        if (ev.kind === 'result') {
          summary.ok = ev.ok;
          summary.resultText = ev.text;
          summary.costUsd = ev.costUsd;
          summary.durationMs = ev.durationMs;
          summary.usage = ev.usage;
          if (ev.usage) {
            session.contextUsedTokens = ev.usage.inputTokens;
            if (ev.usage.contextWindowTokens !== undefined) {
              session.contextWindowTokens = ev.usage.contextWindowTokens;
            }
            if (
              ev.usage.inputTokens !== undefined &&
              ev.usage.contextWindowTokens !== undefined &&
              ev.usage.contextWindowTokens > 0
            ) {
              summary.contextPct = (ev.usage.inputTokens / ev.usage.contextWindowTokens) * 100;
            }
          }
        }
        if (ev.kind === 'error') {
          // A user-initiated /stop OR a Token Guard hard-stop kills the process;
          // the mapper then emits a synthetic "exited without result" error —
          // don't surface that as a failure.
          if (this.active.get(key)?.cancelled) continue;
          summary.errorMessages.push(ev.message);
        }
        try {
          await reporter.onEvent(ev);
        } catch (err) {
          console.error(`[manager] reporter.onEvent failed for ${key}:`, err);
        }
      }
    } catch (err) {
      summary.errorMessages.push(String(err));
    }

    // Record spend from the last cumulative tick (codex's final tick carries the
    // real token counts; claude ticks accrue per API call).
    if (lastTick && this.opts.accounting) {
      try {
        await this.opts.accounting.record(
          session.engine,
          lastTick,
          summary.guardStopped !== undefined,
        );
      } catch (err) {
        console.error(`[manager] accounting.record failed for ${key}:`, err);
      }
    }

    const state = this.active.get(key);
    summary.cancelled = state?.cancelled ?? false;
    if (summary.durationMs === undefined) summary.durationMs = Date.now() - startedAt;
    this.active.delete(key);

    // Captured before finishCompaction clears the flag: a /compact run is a
    // meta-run and must never feed the memory extractor.
    const wasCompactRun = session.compactPending === true;

    if (summary.ok && !summary.cancelled && summary.resultText) {
      appendHistory(session, prompt, summary.resultText);
    }

    session.status = summary.cancelled || summary.ok ? 'idle' : 'error';
    session.runningPid = undefined;
    try {
      await this.store.upsert(session);
    } catch (err) {
      // a persist failure must not skip reporter.end / drainQueue below
      console.error(`[manager] persist (run end) failed for ${key}:`, err);
    }

    try {
      await reporter.end(summary);
    } catch (err) {
      console.error(`[manager] reporter.end failed for ${key}:`, err);
    }

    try {
      await this.finishCompaction(session, summary);
    } catch (err) {
      console.error(`[manager] compaction finish failed for ${key}:`, err);
    }

    try {
      await this.advanceGoalLoop(key, session, summary, isGoalIteration);
    } catch (err) {
      console.error(`[manager] goal loop advance failed for ${key}:`, err);
      this.goalRunning.delete(key);
    }

    // Opportunistic, best-effort memory extraction (fire-and-forget: a cheap
    // engine call must not delay the queue drain). Never blocks or throws.
    this.maybeExtractMemories(key, session, prompt, summary, wasCompactRun);

    // The agent pushed — let the CI watcher (if wired) follow the run.
    if (sawPush && summary.ok && this.opts.onPush) {
      try {
        this.opts.onPush(session);
      } catch (err) {
        console.error(`[manager] onPush hook failed for ${key}:`, err);
      }
    }

    // The agent announced a local server — remember port, page path and the
    // command it used (agent background processes die with its run, so
    // /preview will re-run that command bot-owned) + offer a one-tap button.
    if (announced !== undefined && summary.ok && !summary.cancelled) {
      const portStr = String(announced.port);
      const serverCmd = [...recentCommands]
        .reverse()
        .find(
          (c) =>
            c.includes(portStr) && !/^\s*(curl|wget|sleep|head|tail|cat|grep|lsof|kill)\b/.test(c),
        );
      session.announcedPort = announced.port;
      session.announcedPath = announced.path;
      if (serverCmd) session.announcedCmd = serverCmd;
      try {
        await this.store.upsert(session);
      } catch (err) {
        console.error(`[manager] persist announced server failed for ${key}:`, err);
      }
      try {
        this.opts.onPortAnnounced?.(session, announced.port);
      } catch (err) {
        console.error(`[manager] onPortAnnounced hook failed for ${key}:`, err);
      }
    }

    this.drainQueue();
  }

  /** Loop-level notification (notifying, not silent); failures only logged. */
  private async notifyLoop(session: Session, text: string): Promise<void> {
    if (!this.opts.notifyTopic) return;
    try {
      await this.opts.notifyTopic(session, text, false);
    } catch (err) {
      console.error(`[manager] goal loop notify failed for ${session.topicId}:`, err);
    }
  }

  /**
   * On a finished /compact run, turn the model's checkpoint into the next
   * pendingContext and reset the native engine session, so the next real prompt
   * starts fresh from the handoff summary. A failed run leaves the session
   * untouched. No-op unless session.compactPending was set at submit time.
   */
  private async finishCompaction(session: Session, summary: RunSummary): Promise<void> {
    if (!session.compactPending) return;
    session.compactPending = undefined;
    if (summary.ok && !summary.cancelled && summary.resultText?.trim()) {
      session.pendingContext = `${COMPACT_HEADER}\n\n${summary.resultText.trim()}`;
      session.engineSessionId = undefined;
      session.contextUsedTokens = undefined;
      session.contextWindowTokens = undefined;
      await this.store.upsert(session);
      await this.notifyLoop(
        session,
        '🗜 Context condensed by the model — the next prompt will start a fresh session from this checkpoint.',
      );
    } else {
      await this.store.upsert(session);
      await this.notifyLoop(
        session,
        '⚠️ Failed to condense the context — the run did not finish successfully. The context is untouched.',
      );
    }
  }

  /**
   * Decide whether to mine durable memories from a finished run, and if so kick
   * off the extraction (fire-and-forget). Gates: memory enabled, run succeeded
   * and was substantive (not cancelled, not a /compact meta-run, result long
   * enough), and the per-session cadence (1st run then every Nth). The extractor
   * runs OUTSIDE the manager's run lifecycle, so it can never recurse into this.
   */
  private maybeExtractMemories(
    key: string,
    session: Session,
    prompt: string,
    summary: RunSummary,
    wasCompactRun: boolean,
  ): void {
    const mem = this.opts.memory;
    if (!mem?.enabled || wasCompactRun) return;
    if (!summary.ok || summary.cancelled) return;
    const result = summary.resultText?.trim();
    if (!result || result.length < (mem.minResultChars ?? MEMORY_MIN_RESULT_CHARS)) return;

    const everyN = Math.max(1, mem.everyNRuns ?? MEMORY_EVERY_N_DEFAULT);
    const count = (this.memoryRunCounts.get(key) ?? 0) + 1;
    this.memoryRunCounts.set(key, count);
    // Fire on the 1st substantive run, then every Nth (rare + cheap).
    if ((count - 1) % everyN !== 0) return;

    void this.extractMemories(session, prompt, result, mem).catch((err) =>
      console.error(`[memory] extraction crashed for ${session.topicId}:`, err),
    );
  }

  /**
   * Run the injected extractor, sanitize, dedupe, and store new facts. All
   * swallowed. A2: every model-extracted fact goes through sanitizeFact —
   * URL/shell/imperative-shaped "facts" (a prompt-injection vector via run
   * output) are dropped before they ever reach the store. Manually added
   * facts (/memories add) are owner-typed and bypass this path.
   */
  private async extractMemories(
    session: Session,
    prompt: string,
    resultText: string,
    mem: MemoryRuntimeOptions,
  ): Promise<void> {
    try {
      const extracted = await mem.extract({
        userPrompt: prompt,
        resultText,
        workdir: session.workdir,
      });
      const sanitized = extracted.flatMap((f) => {
        const text = sanitizeFact(f.text);
        return text === null ? [] : [{ ...f, text }];
      });
      if (sanitized.length === 0) return;
      const fresh = dedupeAgainst(mem.store.all(), sanitized);
      // A3: stamp the repo scope so injection can prefer same-repo facts.
      for (const f of fresh) await mem.store.add({ ...f, repo: session.repoUrl });
      if (fresh.length > 0) {
        console.log(`[memory] +${fresh.length} fact(s) from topic ${session.topicId}`);
      }
    } catch (err) {
      console.error(`[memory] extraction failed for ${session.topicId}:`, err);
    }
  }

  /**
   * Bump the goal to its next iteration and submit it through the normal gated
   * path. A pre-flight block flips the status to a resumable terminal state and
   * drops the runtime loop flag; the caller decides how to surface the block.
   */
  private async advanceToNextIteration(
    session: Session,
    blockedRetry: boolean,
  ): Promise<SubmitResult> {
    const key = sessionKey(session.chatId, session.topicId);
    const gs = session.goalState!;
    gs.iteration += 1;
    gs.status = 'active';
    session.goalIteration = gs.iteration;
    const res = await this.submitPrompt(session, goalIterationPrompt(gs, blockedRetry), {
      goalIteration: true,
    });
    const blockStatus = goalBlockStatus(res);
    if (blockStatus) {
      // A blocked submit never ran — roll the iteration back so the pause
      // doesn't silently consume the budget.
      gs.iteration -= 1;
      session.goalIteration = gs.iteration;
      gs.status = blockStatus;
      this.goalRunning.delete(key);
    }
    await this.store.upsert(session);
    return res;
  }

  /**
   * The /goal status machine, run at the end of every pump. Reads the persisted
   * goalState and decides: complete, blocked (only after 3 identical blockers),
   * budget/usage limited, failed, or advance to the next iteration.
   */
  private async advanceGoalLoop(
    key: string,
    session: Session,
    summary: RunSummary,
    isGoalIteration: boolean,
  ): Promise<void> {
    // Only a run that WAS a goal iteration may advance the loop: a plain user
    // message interleaved into an active loop must never be parsed as a verdict.
    if (!isGoalIteration) return;
    const gs = session.goalState;
    // Only a live loop for THIS process, still active, advances.
    if (!gs || !this.goalRunning.has(key) || gs.status !== 'active') return;

    // Token Guard hard-stop → budget_limited (resumable). Checked before
    // `cancelled` since a guard stop also sets it.
    if (summary.guardStopped) {
      gs.status = 'budget_limited';
      this.goalRunning.delete(key);
      await this.store.upsert(session);
      await this.notifyLoop(
        session,
        '💰 Goal loop stopped by budget — raise the limit (/budget) and continue (/goal continue).',
      );
      return;
    }

    // /stop cancelled the run: leave the goal interrupted (status stays active),
    // resumable via /goal continue. The runtime flag was already dropped.
    if (summary.cancelled) {
      this.goalRunning.delete(key);
      return;
    }

    if (!summary.ok) {
      gs.status = 'failed';
      this.goalRunning.delete(key);
      await this.store.upsert(session);
      await this.notifyLoop(
        session,
        `⚠️ Iteration ${gs.iteration} failed — the loop stopped. Continue: /goal continue.`,
      );
      return;
    }

    const verdict = parseGoalVerdict(summary.resultText);

    if (verdict.status === 'complete') {
      gs.status = 'complete';
      this.goalRunning.delete(key);
      session.goal = undefined;
      session.goalIteration = undefined;
      await this.store.upsert(session);
      await this.notifyLoop(session, `🎯 Goal achieved in ${gs.iteration} iterations.`);
      return;
    }

    if (verdict.status === 'blocked') {
      // Empty evidence uses a fixed sentinel key so 3 consecutive
      // empty-evidence blocks still terminate at the 3-strike rule.
      const norm = normalizeBlocker(verdict.evidence) || EMPTY_BLOCKER_KEY;
      if (gs.lastBlocker === norm) {
        gs.blockerStreak = (gs.blockerStreak ?? 0) + 1;
      } else {
        gs.blockerStreak = 1;
        gs.lastBlocker = norm;
      }
      // Terminal 'blocked' only after the same blocker repeats three times.
      if ((gs.blockerStreak ?? 0) >= 3) {
        gs.status = 'blocked';
        this.goalRunning.delete(key);
        await this.store.upsert(session);
        // Agent-controlled evidence goes into a parse_mode:HTML message —
        // escape it and cap the length or Telegram rejects the whole send.
        const evidence = escapeHtmlLocal(verdict.evidence.slice(0, 500)) || '(no description)';
        await this.notifyLoop(
          session,
          `⛔ Goal blocked: ${evidence}. Continue: /goal continue.`,
        );
        return;
      }
    } else {
      gs.blockerStreak = undefined;
      gs.lastBlocker = undefined;
    }

    if (gs.iteration >= gs.max) {
      gs.status = 'failed';
      this.goalRunning.delete(key);
      await this.store.upsert(session);
      await this.notifyLoop(
        session,
        `🏁 Iteration limit (${gs.max}) — the goal is not confirmed. Continue: /goal continue.`,
      );
      return;
    }

    const res = await this.advanceToNextIteration(session, verdict.status === 'blocked');
    if (res.status !== 'started' && res.status !== 'queued') {
      await this.notifyLoop(session, goalBlockReason(res));
    }
  }

  private drainQueue(): void {
    while (this.active.size < this.opts.maxConcurrentRuns) {
      const idx = this.pending.findIndex((j) => !this.active.has(j.key));
      if (idx === -1) return;
      const job = this.pending.splice(idx, 1)[0]!;
      const session = this.store.getByKey(job.key);
      if (!session) continue;
      this.startRun(session, job.prompt, job.goalIteration === true);
    }
  }
}
