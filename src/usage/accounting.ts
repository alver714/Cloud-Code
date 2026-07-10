import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineKind, UsageTick } from '../engines/types.js';
import { workTokens } from '../sessions/guard.js';

export interface DayEntry {
  workTokens: number;
  outputTokens: number;
  runs: number;
  guardStops: number;
}

export type DayTotals = Partial<Record<EngineKind, DayEntry>>;

interface StatsFile {
  version: 1;
  /** localDateKey → engine → totals */
  days: Record<string, DayTotals>;
}

/** `YYYY-MM-DD` in the machine's local timezone. */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyEntry(): DayEntry {
  return { workTokens: 0, outputTokens: 0, runs: 0, guardStops: 0 };
}

/**
 * Per-day, per-engine spend totals persisted to a tiny JSON file
 * (atomic tmp+rename). Every read tolerates a missing or corrupt file by
 * starting from empty — accounting must never break a run or /usage.
 */
export class UsageAccounting {
  private data: StatsFile = { version: 1, days: {} };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as StatsFile).days === 'object' &&
        (parsed as StatsFile).days !== null
      ) {
        // Drop day entries whose value isn't a plain object — a corrupt entry
        // would otherwise survive and crash `record`/`today` later.
        const days: Record<string, DayTotals> = {};
        for (const [key, value] of Object.entries((parsed as StatsFile).days)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) days[key] = value;
        }
        this.data = { version: 1, days };
      }
    } catch {
      // missing / unreadable / corrupt → start empty
    }
  }

  /** Fold one finished run into today's totals and persist. */
  async record(
    engine: EngineKind,
    tick: UsageTick,
    guardStopped: boolean,
    date: Date = new Date(),
  ): Promise<void> {
    const key = localDateKey(date);
    const day = (this.data.days[key] ??= {});
    const entry = (day[engine] ??= emptyEntry());
    entry.workTokens += workTokens(tick);
    entry.outputTokens += tick.outputTokens;
    entry.runs += 1;
    if (guardStopped) entry.guardStops += 1;
    await this.persist();
  }

  /** Totals for a given local day (defaults to today); empty object if none. */
  today(date: Date = new Date()): DayTotals {
    return this.data.days[localDateKey(date)] ?? {};
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    // .catch isolates each write: one failed write must not poison the chain
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}
