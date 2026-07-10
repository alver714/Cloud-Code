import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  daysLeftInMonth,
  parseMeminfo,
  parseVnstat,
  readDisk,
} from '../src/system/resources.js';

const MEMINFO = `MemTotal:        1009648 kB
MemFree:          123456 kB
MemAvailable:     512000 kB
Buffers:           10000 kB
Cached:           200000 kB
SwapTotal:       3145728 kB
SwapFree:        3000320 kB
`;

describe('parseMeminfo', () => {
  it('parses MemAvailable/MemTotal/Swap into MiB', () => {
    const m = parseMeminfo(MEMINFO)!;
    expect(m).not.toBeNull();
    expect(m.availableMb).toBe(500); // 512000 kB / 1024
    expect(m.totalMb).toBeCloseTo(986, 0);
    expect(m.swapTotalMb).toBe(3072); // 3145728 / 1024
    expect(m.swapFreeMb).toBeCloseTo(2930, 0);
  });

  it('leaves swap fields null when swap lines are absent', () => {
    const m = parseMeminfo('MemTotal: 1000000 kB\nMemAvailable: 400000 kB\n')!;
    expect(m.swapFreeMb).toBeNull();
    expect(m.swapTotalMb).toBeNull();
    expect(m.availableMb).toBeCloseTo(390.6, 1);
  });

  it('returns null when a required field is missing', () => {
    expect(parseMeminfo('MemTotal: 1000000 kB\n')).toBeNull(); // no MemAvailable
    expect(parseMeminfo('garbage not meminfo')).toBeNull();
  });
});

const VNSTAT_V2 = {
  vnstatversion: '2.9',
  jsonversion: '2',
  interfaces: [
    {
      name: 'ens4',
      traffic: {
        total: { rx: 1, tx: 2 },
        month: [
          { id: 1, date: { year: 2026, month: 6 }, rx: 100, tx: 200 },
          { id: 2, date: { year: 2026, month: 7 }, rx: 500000000, tx: 314572800 },
        ],
      },
    },
  ],
};

// vnstat 1.x: traffic.months (plural), tx in KiB.
const VNSTAT_V1 = {
  jsonversion: '1',
  interfaces: [
    {
      id: 'eth0',
      traffic: {
        months: [{ date: { year: 2026, month: 7 }, rx: 1000, tx: 307200 }],
      },
    },
  ],
};

describe('parseVnstat', () => {
  const july = new Date(2026, 6, 10); // month index 6 → calendar month 7

  it('reads the current-month tx from v2 byte counts', () => {
    // 314572800 bytes = 300 MiB
    expect(parseVnstat(VNSTAT_V2, july)).toBe(300);
  });

  it('reads v1 KiB counts (tx * 1024)', () => {
    // 307200 KiB = 314572800 bytes = 300 MiB
    expect(parseVnstat(VNSTAT_V1, july)).toBe(300);
  });

  it('falls back to the newest entry when no month matches', () => {
    expect(parseVnstat(VNSTAT_V2, new Date(2099, 0, 1))).toBe(300);
  });

  it('returns null on malformed / empty input', () => {
    expect(parseVnstat(null, july)).toBeNull();
    expect(parseVnstat('nonsense', july)).toBeNull();
    expect(parseVnstat({}, july)).toBeNull();
    expect(parseVnstat({ interfaces: [] }, july)).toBeNull();
    expect(parseVnstat({ interfaces: [{ traffic: { month: [] } }] }, july)).toBeNull();
    expect(
      parseVnstat({ interfaces: [{ traffic: { month: [{ date: { year: 2026, month: 7 } }] } }] }, july),
    ).toBeNull(); // entry has no numeric tx
  });
});

describe('daysLeftInMonth', () => {
  it('counts whole days to the end of the calendar month', () => {
    expect(daysLeftInMonth(new Date(2026, 6, 10))).toBe(21); // July has 31 days
    expect(daysLeftInMonth(new Date(2026, 6, 31))).toBe(0);
    expect(daysLeftInMonth(new Date(2026, 1, 28))).toBe(0); // Feb 2026 (non-leap)
  });
});

describe('readDisk (statfs integration-lite)', () => {
  it('returns a sane shape for a real directory', async () => {
    const d = await readDisk(os.tmpdir());
    expect(d).not.toBeNull();
    expect(d!.totalGb).toBeGreaterThan(0);
    expect(d!.freeGb).toBeGreaterThanOrEqual(0);
    expect(d!.usedPct).toBeGreaterThanOrEqual(0);
    expect(d!.usedPct).toBeLessThanOrEqual(100);
  });

  it('returns null for a nonexistent path', async () => {
    expect(await readDisk('/no/such/path/xyzzy-does-not-exist')).toBeNull();
  });
});
