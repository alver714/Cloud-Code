import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageTick } from '../src/engines/types.js';
import { UsageAccounting, localDateKey } from '../src/usage/accounting.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accounting-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

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

describe('UsageAccounting', () => {
  it('accumulates per-day, per-engine totals and counts guard stops', async () => {
    const acc = new UsageAccounting(path.join(dir, 'usage-stats.json'));
    await acc.load();

    const day = new Date(2026, 6, 10, 12, 0, 0);
    await acc.record('claude', tick({ freshInputTokens: 1000, outputTokens: 200 }), false, day);
    await acc.record('claude', tick({ outputTokens: 300 }), true, day);
    await acc.record('codex', tick({ freshInputTokens: 500 }), false, day);

    const today = acc.today(day);
    expect(today.claude).toEqual({
      workTokens: 1000 + 200 + 300,
      outputTokens: 500,
      runs: 2,
      guardStops: 1,
    });
    expect(today.codex).toEqual({
      workTokens: 500,
      outputTokens: 0,
      runs: 1,
      guardStops: 0,
    });
  });

  it('keeps different local days separate', async () => {
    const acc = new UsageAccounting(path.join(dir, 'usage-stats.json'));
    await acc.load();
    const d1 = new Date(2026, 6, 10, 9, 0, 0);
    const d2 = new Date(2026, 6, 11, 9, 0, 0);
    await acc.record('claude', tick({ outputTokens: 100 }), false, d1);
    await acc.record('claude', tick({ outputTokens: 200 }), false, d2);

    expect(acc.today(d1).claude?.outputTokens).toBe(100);
    expect(acc.today(d2).claude?.outputTokens).toBe(200);
  });

  it('round-trips through the file on disk', async () => {
    const file = path.join(dir, 'usage-stats.json');
    const day = new Date(2026, 6, 10, 12, 0, 0);
    const acc = new UsageAccounting(file);
    await acc.load();
    await acc.record('codex', tick({ freshInputTokens: 4000, outputTokens: 1000 }), true, day);

    const reloaded = new UsageAccounting(file);
    await reloaded.load();
    expect(reloaded.today(day).codex).toEqual({
      workTokens: 5000,
      outputTokens: 1000,
      runs: 1,
      guardStops: 1,
    });
  });

  it('tolerates a missing file (empty totals)', async () => {
    const acc = new UsageAccounting(path.join(dir, 'does-not-exist.json'));
    await acc.load();
    expect(acc.today()).toEqual({});
  });

  it('drops day entries whose value is not a plain object', async () => {
    const file = path.join(dir, 'usage-stats.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        days: {
          '2026-07-09': 'garbage',
          '2026-07-08': [1, 2],
          '2026-07-10': { claude: { workTokens: 5, outputTokens: 5, runs: 1, guardStops: 0 } },
        },
      }),
      'utf8',
    );
    const acc = new UsageAccounting(file);
    await acc.load();
    expect(acc.today(new Date(2026, 6, 9))).toEqual({});
    expect(acc.today(new Date(2026, 6, 8))).toEqual({});
    expect(acc.today(new Date(2026, 6, 10)).claude?.workTokens).toBe(5);
  });

  it('tolerates a corrupt file (starts empty, then records)', async () => {
    const file = path.join(dir, 'usage-stats.json');
    await fs.writeFile(file, '{broken json', 'utf8');
    const acc = new UsageAccounting(file);
    await acc.load();
    expect(acc.today()).toEqual({});

    const day = new Date(2026, 6, 10, 12, 0, 0);
    await acc.record('claude', tick({ outputTokens: 42 }), false, day);
    expect(acc.today(day).claude?.outputTokens).toBe(42);
  });
});

describe('localDateKey', () => {
  it('formats YYYY-MM-DD in local time', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });
});
