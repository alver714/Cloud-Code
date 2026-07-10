import type { EngineKind } from '../engines/types.js';

export type SessionStatus = 'idle' | 'running' | 'error';

/** Lifecycle of a persisted /goal loop (survives restart). */
export type GoalStatus =
  | 'active'
  | 'blocked'
  | 'budget_limited'
  | 'usage_limited'
  | 'complete'
  | 'failed';

/**
 * Persisted /goal status machine (codex ext/goal pattern). Lives on the session
 * so a loop survives a bot restart; the manager keeps only a thin runtime set of
 * keys whose auto-advance loop is live in the current process.
 */
export interface GoalState {
  goal: string;
  /** 1-based iteration counter. */
  iteration: number;
  /** Iteration budget (from GOAL_MAX_ITERATIONS; extended on /goal continue). */
  max: number;
  status: GoalStatus;
  /** Consecutive identical-blocker count; terminal 'blocked' only at >= 3. */
  blockerStreak?: number;
  /** Normalized (lowercased/trimmed/≤120 char) last blocker evidence. */
  lastBlocker?: string;
}

/** One forum topic = one session. */
export interface Session {
  chatId: number;
  topicId: number;
  name: string;
  /** First user prompt, used as the stable part of the dynamic Telegram topic title. */
  topicTitleBase?: string;
  engine: EngineKind;
  /** owner/repo */
  repoUrl: string;
  workdir: string;
  /** claude session_id / codex thread_id from the latest run. */
  engineSessionId?: string;
  model?: string;
  /** Per-session reasoning effort (both engines); undefined = engine default. */
  effort?: string;
  /** Last provider-reported context occupancy for /context-window. */
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  /** Output verbosity: false/undefined = compact, true = verbose progress. */
  verbose?: boolean;
  /** /branch on: the agent works in git branch topic-<topicId>, not main. */
  useBranch?: boolean;
  /** The port the agent last announced in text (localhost:NNNN) — for /preview. */
  announcedPort?: number;
  /** The page path from the announced URL — appended to preview links. */
  announcedPath?: string;
  /** The command the agent used to start the server — /preview re-runs it bot-owned. */
  announcedCmd?: string;
  /**
   * Per-session Token Guard hard limit (work tokens), overriding GUARD_HARD_TOKENS.
   * 0 = token guard off for this session; undefined = use the global default.
   */
  budgetTokens?: number;
  /** Rolling conversation history (used for cross-engine handoff summaries). */
  history?: Array<{ prompt: string; answer: string }>;
  /** One-shot prefix folded into the next prompt (cross-engine context carry). */
  pendingContext?: string;
  /** Autonomous goal-loop target (/goal): the agent iterates until achieved. */
  goal?: string;
  /** Current /goal loop iteration (1-based); cleared when the goal is achieved. */
  goalIteration?: number;
  /** Persisted /goal status machine (survives restart); source of truth for the loop. */
  goalState?: GoalState;
  /**
   * True while a /compact run is in flight: pumpRun turns its result into the
   * next pendingContext checkpoint, then clears this flag.
   */
  compactPending?: boolean;
  /** One-shot notes injected into the next run, then cleared (/btw). */
  notes?: string[];
  /**
   * Set on a freshly forked claude session — the FIRST run resumes the parent
   * session id but writes to a NEW one (--fork-session). Cleared after that run.
   */
  forkNext?: boolean;
  status: SessionStatus;
  createdAt: string;
  lastRunAt?: string;
  /** PID of the engine process while status === 'running' (for crash reaping). */
  runningPid?: number;
}

export function sessionKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}
