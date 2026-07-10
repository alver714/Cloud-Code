import type { EngineKind } from '../engines/types.js';

export type SessionStatus = 'idle' | 'running' | 'error';

/** One forum topic = one session. */
export interface Session {
  chatId: number;
  topicId: number;
  name: string;
  engine: EngineKind;
  /** owner/repo */
  repoUrl: string;
  workdir: string;
  /** claude session_id / codex thread_id from the latest run. */
  engineSessionId?: string;
  model?: string;
  /** Output verbosity: false/undefined = compact, true = verbose progress. */
  verbose?: boolean;
  /**
   * Per-session Token Guard hard limit (work tokens), overriding GUARD_HARD_TOKENS.
   * 0 = token guard off for this session; undefined = use the global default.
   */
  budgetTokens?: number;
  /** Rolling conversation history (used for cross-engine handoff summaries). */
  history?: Array<{ prompt: string; answer: string }>;
  /** One-shot prefix folded into the next prompt (cross-engine context carry). */
  pendingContext?: string;
  status: SessionStatus;
  createdAt: string;
  lastRunAt?: string;
  /** PID of the engine process while status === 'running' (for crash reaping). */
  runningPid?: number;
}

export function sessionKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}
