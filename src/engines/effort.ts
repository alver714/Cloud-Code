import type { EngineKind } from './types.js';

/**
 * Reasoning-effort levels accepted per engine. The shared core is
 * low|medium|high|xhigh|max; Codex additionally accepts minimal and ultra,
 * which Claude rejects.
 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export function validEfforts(engine: EngineKind): readonly string[] {
  return engine === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS;
}

/** Case-insensitive per-engine validity check for a reasoning-effort value. */
export function isValidEffort(engine: EngineKind, value: string): boolean {
  return validEfforts(engine).includes(value.trim().toLowerCase());
}
