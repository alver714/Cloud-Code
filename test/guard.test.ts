import { describe, expect, it } from 'vitest';
import type { UsageTick } from '../src/engines/types.js';
import { RunGuard, parseBudget, workTokens } from '../src/sessions/guard.js';

function tick(partial: Partial<UsageTick>): UsageTick {
  return {
    freshInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    steps: 0,
    ...partial,
  };
}

describe('workTokens', () => {
  it('weights cache reads at 0.1× and rounds', () => {
    expect(
      workTokens(
        tick({
          freshInputTokens: 1000,
          cacheCreationTokens: 500,
          outputTokens: 200,
          cacheReadTokens: 10_000,
        }),
      ),
    ).toBe(1000 + 500 + 200 + 1000); // 0.1 × 10000 = 1000
    expect(workTokens(tick({ cacheReadTokens: 5 }))).toBe(1); // 0.5 rounds to 1 (round-half-up)
  });
});

describe('RunGuard', () => {
  it('fires soft exactly once when crossing the soft threshold', () => {
    const g = new RunGuard({ softTokens: 100, hardTokens: 1000, maxSteps: 0 });
    expect(g.check(tick({ outputTokens: 50 }))).toBe('ok');
    expect(g.check(tick({ outputTokens: 100 }))).toBe('soft');
    expect(g.check(tick({ outputTokens: 150 }))).toBe('ok'); // not soft again
    expect(g.check(tick({ outputTokens: 200 }))).toBe('ok');
  });

  it('fires hard exactly once when crossing the hard token threshold', () => {
    const g = new RunGuard({ softTokens: 100, hardTokens: 300, maxSteps: 0 });
    expect(g.check(tick({ outputTokens: 120 }))).toBe('soft');
    expect(g.check(tick({ outputTokens: 300 }))).toBe('hard');
    expect(g.check(tick({ outputTokens: 500 }))).toBe('ok'); // not hard again
  });

  it('reports hard straight away (no soft) when one tick clears the hard line', () => {
    const g = new RunGuard({ softTokens: 100, hardTokens: 250, maxSteps: 0 });
    expect(g.check(tick({ outputTokens: 400 }))).toBe('hard');
    expect(g.check(tick({ outputTokens: 500 }))).toBe('ok');
  });

  it('fires hard via the step backstop even with no token spend', () => {
    const g = new RunGuard({ softTokens: 0, hardTokens: 0, maxSteps: 5 });
    expect(g.check(tick({ steps: 4 }))).toBe('ok');
    expect(g.check(tick({ steps: 5 }))).toBe('hard');
  });

  it('treats 0 thresholds as disabled', () => {
    const g = new RunGuard({ softTokens: 0, hardTokens: 0, maxSteps: 0 });
    expect(g.check(tick({ outputTokens: 10_000_000, steps: 10_000 }))).toBe('ok');
  });
});

describe('parseBudget', () => {
  it('parses k-suffix, plain numbers, m-suffix and off', () => {
    expect(parseBudget('500k')).toBe(500_000);
    expect(parseBudget('500000')).toBe(500_000);
    expect(parseBudget('1.5k')).toBe(1_500);
    expect(parseBudget('0.5m')).toBe(500_000);
    expect(parseBudget('OFF')).toBe(0);
    expect(parseBudget('off')).toBe(0);
    expect(parseBudget('0')).toBe(0);
    expect(parseBudget(' 250K ')).toBe(250_000);
  });

  it('returns null on garbage', () => {
    expect(parseBudget('abc')).toBeNull();
    expect(parseBudget('')).toBeNull();
    expect(parseBudget('12x')).toBeNull();
    expect(parseBudget('-5')).toBeNull();
  });
});
