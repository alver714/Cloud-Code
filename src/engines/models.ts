import type { EngineKind } from './types.js';

/**
 * Known model aliases per engine (as accepted by the respective CLIs).
 * Free-text models NOT in these lists are still allowed — they apply to the
 * session's current engine and are passed to the CLI verbatim.
 */
export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const CODEX_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
] as const;

export interface ResolvedModel {
  engine: EngineKind;
  /** Canonical (list-cased) model name. */
  name: string;
}

/**
 * Exact, case-insensitive match against the known catalogs. Returns the engine
 * the model belongs to and its canonical name, or undefined for unknown names.
 */
export function resolveModel(name: string): ResolvedModel | undefined {
  const lower = name.trim().toLowerCase();
  if (!lower) return undefined;
  const claude = CLAUDE_MODELS.find((m) => m === lower);
  if (claude) return { engine: 'claude', name: claude };
  const codex = CODEX_MODELS.find((m) => m === lower);
  if (codex) return { engine: 'codex', name: codex };
  return undefined;
}
