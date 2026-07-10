import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/engines/claude.js';
import { buildCodexArgs } from '../src/engines/codex.js';
import { isValidEffort, validEfforts } from '../src/engines/effort.js';
import type { EngineRunOptions } from '../src/engines/types.js';

const base: EngineRunOptions = { prompt: 'hi', workdir: '/tmp/wd' };

describe('isValidEffort (per-engine)', () => {
  it('accepts the shared core for both engines', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(isValidEffort('claude', e)).toBe(true);
      expect(isValidEffort('codex', e)).toBe(true);
    }
  });

  it('rejects codex-only minimal/ultra for claude but allows them for codex', () => {
    expect(isValidEffort('claude', 'minimal')).toBe(false);
    expect(isValidEffort('claude', 'ultra')).toBe(false);
    expect(isValidEffort('codex', 'minimal')).toBe(true);
    expect(isValidEffort('codex', 'ultra')).toBe(true);
  });

  it('is case-insensitive and rejects junk', () => {
    expect(isValidEffort('claude', 'HIGH')).toBe(true);
    expect(isValidEffort('codex', 'nope')).toBe(false);
  });

  it('validEfforts differ by engine', () => {
    expect(validEfforts('claude')).not.toContain('ultra');
    expect(validEfforts('codex')).toContain('ultra');
  });
});

describe('buildClaudeArgs', () => {
  it('adds --effort from per-run opts, overriding the engine default', () => {
    const args = buildClaudeArgs({ ...base, effort: 'high' }, { effort: 'medium' });
    const i = args.indexOf('--effort');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('high');
    // only one --effort present
    expect(args.filter((a) => a === '--effort')).toHaveLength(1);
  });

  it('falls back to the engine default effort when no per-run effort', () => {
    const args = buildClaudeArgs({ ...base }, { effort: 'medium' });
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
  });

  it('omits --effort when neither is set', () => {
    expect(buildClaudeArgs({ ...base }, {})).not.toContain('--effort');
  });

  it('includes --model and --resume when provided', () => {
    const args = buildClaudeArgs({ ...base, model: 'fable', resumeSessionId: 'sid' });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('fable');
    expect(args[args.indexOf('--resume') + 1]).toBe('sid');
  });

  it('adds --fork-session alongside --resume when forkSession is set', () => {
    const args = buildClaudeArgs({ ...base, resumeSessionId: 'sid', forkSession: true });
    expect(args).toContain('--resume');
    expect(args).toContain('--fork-session');
  });

  it('omits --fork-session without a resume id (nothing to fork)', () => {
    expect(buildClaudeArgs({ ...base, forkSession: true })).not.toContain('--fork-session');
  });
});

describe('buildCodexArgs', () => {
  it('adds -c model_reasoning_effort="…" BEFORE the trailing "-" positional', () => {
    const args = buildCodexArgs({ ...base, effort: 'high' });
    const ci = args.indexOf('-c');
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(args[ci + 1]).toBe('model_reasoning_effort="high"');
    expect(args[args.length - 1]).toBe('-');
    expect(ci).toBeLessThan(args.length - 1);
  });

  it('keeps the effort override before "-" on the resume variant too', () => {
    const args = buildCodexArgs({ ...base, effort: 'ultra', resumeSessionId: 'tid' });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'tid']);
    const ci = args.indexOf('-c');
    expect(args[ci + 1]).toBe('model_reasoning_effort="ultra"');
    expect(args[args.length - 1]).toBe('-');
    expect(ci).toBeLessThan(args.indexOf('-', ci)); // effort precedes positional
  });

  it('omits the effort override when not set', () => {
    const args = buildCodexArgs({ ...base });
    expect(args).not.toContain('-c');
    expect(args).toEqual(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-C', '/tmp/wd', '-']);
  });
});
