import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS, CODEX_MODELS, resolveModel } from '../src/engines/models.js';

describe('resolveModel', () => {
  it('resolves known claude aliases to the claude engine', () => {
    for (const m of CLAUDE_MODELS) {
      expect(resolveModel(m)).toEqual({ engine: 'claude', name: m });
    }
  });

  it('resolves known codex models to the codex engine', () => {
    for (const m of CODEX_MODELS) {
      expect(resolveModel(m)).toEqual({ engine: 'codex', name: m });
    }
  });

  it('is case-insensitive and returns the canonical (list-cased) name', () => {
    expect(resolveModel('OPUS')).toEqual({ engine: 'claude', name: 'opus' });
    expect(resolveModel('  Sonnet  ')).toEqual({ engine: 'claude', name: 'sonnet' });
    expect(resolveModel('GPT-5.6-Terra')).toEqual({ engine: 'codex', name: 'gpt-5.6-terra' });
  });

  it('returns undefined for unknown or empty names', () => {
    expect(resolveModel('gpt-4')).toBeUndefined();
    expect(resolveModel('opusplan')).toBeUndefined();
    expect(resolveModel('')).toBeUndefined();
    expect(resolveModel('   ')).toBeUndefined();
  });
});
