import path from 'node:path';
import type {
  AgentEvent,
  Engine,
  EngineKind,
  EngineRun,
  Usage,
  UsageTick,
} from '../engines/types.js';
import type { UsageAccounting } from '../usage/accounting.js';
import { RunGuard, workTokens, type RunGuardConfig } from './guard.js';
import { SessionStore } from './store.js';
import { sessionKey, type Session } from './types.js';

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
}

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
  | { status: 'limit-blocked'; usedPercent: number; resetsAt?: number };

export interface SubmitOptions {
  /** Skip the pre-flight subscription-window gate (a user-confirmed force). */
  bypassPreflight?: boolean;
}

interface ActiveRun {
  run: EngineRun;
  cancelled: boolean;
  guardTripped: boolean;
}

interface PendingJob {
  key: string;
  prompt: string;
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
}

const PREFLIGHT_CACHE_MS = 60_000;
const PREFLIGHT_TIMEOUT_MS = 3_000;

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
 * Owns run lifecycle: one engine process per session, FIFO queue for
 * prompts that arrive while a session is busy or the global limit is hit.
 * Sessions run concurrently and independently.
 */
export class SessionManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly pending: PendingJob[] = [];
  /** Pre-flight window reads, cached briefly so we don't hammer the app-server. */
  private readonly windowCache = new Map<EngineKind, { at: number; value: WindowUsage | null }>();

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

  async submitPrompt(
    session: Session,
    prompt: string,
    opts: SubmitOptions = {},
  ): Promise<SubmitResult> {
    const key = sessionKey(session.chatId, session.topicId);
    if (this.active.has(key) || this.active.size >= this.opts.maxConcurrentRuns) {
      this.pending.push({ key, prompt });
      return { status: 'queued', position: this.pending.filter((j) => j.key === key).length };
    }
    // Pre-flight gate: only for a fresh start the user initiated (queued jobs
    // re-drained through startRun bypass this, as do user-confirmed forces).
    if (!opts.bypassPreflight && this.opts.preflightPct > 0 && this.opts.readWindow) {
      const w = await this.checkWindow(session.engine);
      if (w && w.usedPercent >= this.opts.preflightPct) {
        return { status: 'limit-blocked', usedPercent: w.usedPercent, resetsAt: w.resetsAt };
      }
    }
    this.startRun(session, prompt);
    return { status: 'started' };
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
      const text = `⚠️ Запуск уже потратил ~${fmtTokens(workTokens(tick))} токенов работы (шагов: ${tick.steps})`;
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

  /** Returns true if a run was actually cancelled. */
  cancel(chatId: number, topicId: number): boolean {
    const state = this.active.get(sessionKey(chatId, topicId));
    if (!state) return false;
    state.cancelled = true;
    state.run.cancel();
    return true;
  }

  cancelAll(): void {
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.ALLOWED_USER_IDS;
    if (engine !== 'claude') {
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_API_KEY;
    }
    if (engine !== 'codex') {
      delete env.OPENAI_API_KEY;
    }
    return env;
  }

  /** Fire-and-forget; all errors are contained inside. */
  private startRun(session: Session, prompt: string): void {
    const key = sessionKey(session.chatId, session.topicId);
    const engine = this.engines[session.engine];
    const model = session.model ?? this.opts.defaultModels[session.engine];

    // A pending cross-engine handoff summary is folded into this run's prompt
    // (the reporter/history still use the user's raw prompt below).
    const enginePrompt = session.pendingContext
      ? `${session.pendingContext}\n\n---\n\nНовый запрос:\n${prompt}`
      : prompt;

    let run: EngineRun;
    try {
      run = engine.run({
        prompt: enginePrompt,
        workdir: session.workdir,
        resumeSessionId: session.engineSessionId,
        model,
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
    // The handoff summary is now baked into this run — consume it once.
    if (session.pendingContext !== undefined) {
      session.pendingContext = undefined;
      void this.store.upsert(session);
    }
    // Reserve the slot synchronously so concurrent submits queue correctly.
    this.active.set(key, { run, cancelled: false, guardTripped: false });

    void this.pumpRun(key, session, prompt, run).catch((err) => {
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
    const hardTokens = session.budgetTokens ?? this.opts.guard.hardTokens;
    const guard = new RunGuard({
      softTokens: this.opts.guard.softTokens,
      hardTokens,
      maxSteps: this.opts.guard.maxSteps,
    });
    let lastTick: UsageTick | undefined;

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
        if (ev.kind === 'result') {
          summary.ok = ev.ok;
          summary.resultText = ev.text;
          summary.costUsd = ev.costUsd;
          summary.durationMs = ev.durationMs;
          summary.usage = ev.usage;
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

    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.active.size < this.opts.maxConcurrentRuns) {
      const idx = this.pending.findIndex((j) => !this.active.has(j.key));
      if (idx === -1) return;
      const job = this.pending.splice(idx, 1)[0]!;
      const session = this.store.getByKey(job.key);
      if (!session) continue;
      this.startRun(session, job.prompt);
    }
  }
}
