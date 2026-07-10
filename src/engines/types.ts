export type EngineKind = 'claude' | 'codex';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Cumulative in-flight spend of one run — the Token Guard's raw material. */
export interface UsageTick {
  /** Uncached input tokens processed so far. */
  freshInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** Model API calls so far (claude, incl. subagents) or agent steps (codex). */
  steps: number;
}

/** Normalized event stream shared by all engines. */
export type AgentEvent =
  | { kind: 'init'; engineSessionId: string; model?: string }
  | { kind: 'assistant-text'; text: string }
  /** Short "what I'm doing" narration (codex reasoning summaries). */
  | { kind: 'reasoning'; text: string }
  /** Cumulative run spend; emitted as data arrives (never rendered to chat). */
  | { kind: 'usage-tick'; cumulative: UsageTick }
  | { kind: 'tool-use'; name: string; summary: string; friendly?: string }
  | { kind: 'tool-result'; name: string; summary: string; ok: boolean }
  | { kind: 'error'; message: string }
  | {
      kind: 'result';
      text: string;
      ok: boolean;
      usage?: Usage;
      costUsd?: number;
      durationMs?: number;
    };

export interface EngineRunOptions {
  prompt: string;
  workdir: string;
  /** Engine conversation id from a previous run — resume it. */
  resumeSessionId?: string;
  model?: string;
  /** Raw engine JSONL is appended here for debugging. */
  rawLogPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface EngineRun {
  events: AsyncGenerator<AgentEvent, void, void>;
  cancel(): void;
  readonly pid: number | undefined;
}

export interface Engine {
  readonly kind: EngineKind;
  run(opts: EngineRunOptions): EngineRun;
}
