import type { UsageTick } from '../engines/types.js';

/**
 * "Work tokens" of a run — the Token Guard's single spend metric.
 * Cache reads are ~10× cheaper than fresh input, so they count at 0.1×.
 * Rounded to an integer.
 */
export function workTokens(tick: UsageTick): number {
  return Math.round(
    tick.freshInputTokens +
      tick.cacheCreationTokens +
      tick.outputTokens +
      0.1 * tick.cacheReadTokens,
  );
}

export interface RunGuardConfig {
  /** Warn once when work tokens cross this; 0 = disabled. */
  softTokens: number;
  /** Cancel the run when work tokens cross this; 0 = disabled. */
  hardTokens: number;
  /** Step-based backstop (mainly for codex, no live token data); 0 = disabled. */
  maxSteps: number;
}

export type GuardVerdict = 'ok' | 'soft' | 'hard';

/**
 * Pure, unit-testable spend watchdog for one run. Fed cumulative usage ticks;
 * emits 'soft' exactly once (crossing the soft token line) and 'hard' exactly
 * once (crossing the hard token line OR the step backstop). A single tick that
 * clears the hard line reports 'hard' straight away (no soft first).
 */
export class RunGuard {
  private softFired = false;
  private hardFired = false;

  constructor(private readonly cfg: RunGuardConfig) {}

  check(tick: UsageTick): GuardVerdict {
    if (!this.hardFired) {
      const tokenHard = this.cfg.hardTokens > 0 && workTokens(tick) >= this.cfg.hardTokens;
      const stepHard = this.cfg.maxSteps > 0 && tick.steps >= this.cfg.maxSteps;
      if (tokenHard || stepHard) {
        this.hardFired = true;
        this.softFired = true; // no point warning after a hard stop
        return 'hard';
      }
    }
    if (!this.softFired && this.cfg.softTokens > 0 && workTokens(tick) >= this.cfg.softTokens) {
      this.softFired = true;
      return 'soft';
    }
    return 'ok';
  }
}

/**
 * Parse a /budget argument into a token count.
 *   "500k" | "0.5m" → 500000, "500000" → 500000, "off" | "0" → 0 (disabled).
 * Returns null on unparseable input.
 */
export function parseBudget(arg: string): number | null {
  const s = arg.trim().toLowerCase();
  if (s === 'off') return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s);
  if (!m) return null;
  let n = parseFloat(m[1]!);
  if (m[2] === 'k') n *= 1_000;
  else if (m[2] === 'm') n *= 1_000_000;
  const rounded = Math.round(n);
  return Number.isFinite(rounded) && rounded >= 0 ? rounded : null;
}
