import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import type { Config } from '../config.js';

const execFileAsync = promisify(execFile);

const VNSTAT_TIMEOUT_MS = 3_000;

export interface MemoryInfo {
  availableMb: number;
  totalMb: number;
  /** null when swap info is unavailable (macOS / os fallback). */
  swapFreeMb: number | null;
  swapTotalMb: number | null;
}

export interface DiskInfo {
  freeGb: number;
  totalGb: number;
  /** 0..100, df-style (used / (used + available)). */
  usedPct: number;
}

export interface EgressInfo {
  /** Current calendar month transmit total, in MiB. */
  monthTxMb: number;
}

export type Verdict = 'ok' | 'warn' | 'block' | null;

export interface ResourceStatus {
  memory: MemoryInfo | null;
  disk: DiskInfo | null;
  egress: EgressInfo | null;
  /** Configured free-egress budget (echoed for the renderer). */
  egressFreeMb: number;
  /** monthTxMb as a percent of egressFreeMb; null when egress is unavailable. */
  egressUsedPct: number | null;
  /** Whole days remaining until the end of the current calendar month. */
  daysLeftInMonth: number;
  verdicts: { memory: Verdict; disk: Verdict; egress: Verdict };
}

/* ── memory ──────────────────────────────────────────────────────────── */

/**
 * Parse /proc/meminfo text. Values there are in kB (KiB); we return MiB.
 * Returns null if the two required fields (MemTotal, MemAvailable) are missing.
 * Pure — takes the file text so it can be unit-tested from a fixture.
 */
export function parseMeminfo(text: string): MemoryInfo | null {
  const kb = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const memTotal = kb('MemTotal');
  const memAvail = kb('MemAvailable');
  if (memTotal === undefined || memAvail === undefined) return null;
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  const toMb = (v: number) => v / 1024;
  return {
    availableMb: toMb(memAvail),
    totalMb: toMb(memTotal),
    swapFreeMb: swapFree !== undefined ? toMb(swapFree) : null,
    swapTotalMb: swapTotal !== undefined ? toMb(swapTotal) : null,
  };
}

/**
 * Memory snapshot: /proc/meminfo on Linux (with swap), os totals elsewhere
 * (no swap visibility → null swap fields). Never throws — null on any error.
 */
export async function readMemory(): Promise<MemoryInfo | null> {
  if (process.platform === 'linux') {
    try {
      const parsed = parseMeminfo(await fs.readFile('/proc/meminfo', 'utf8'));
      if (parsed) return parsed;
    } catch {
      /* fall through to the os-based fallback */
    }
  }
  try {
    const totalMb = os.totalmem() / (1024 * 1024);
    const availableMb = os.freemem() / (1024 * 1024);
    if (!Number.isFinite(totalMb) || totalMb <= 0) return null;
    return { availableMb, totalMb, swapFreeMb: null, swapTotalMb: null };
  } catch {
    return null;
  }
}

/* ── disk ────────────────────────────────────────────────────────────── */

/**
 * Free/total/used% for the filesystem holding dirPath, via fs.statfs.
 * usedPct is df-style (excludes root-reserved blocks). Null on any error.
 */
export async function readDisk(dirPath: string): Promise<DiskInfo | null> {
  try {
    const s = await fs.statfs(dirPath);
    const bsize = Number(s.bsize);
    const total = Number(s.blocks) * bsize;
    const avail = Number(s.bavail) * bsize;
    const used = (Number(s.blocks) - Number(s.bfree)) * bsize;
    if (!Number.isFinite(total) || total <= 0) return null;
    const denom = used + avail;
    const usedPct = denom > 0 ? Math.round((used / denom) * 100) : 0;
    const GB = 1024 ** 3;
    return { freeGb: avail / GB, totalGb: total / GB, usedPct };
  } catch {
    return null;
  }
}

/* ── egress (vnstat) ─────────────────────────────────────────────────── */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Extract the current calendar month's transmit total (MiB) from `vnstat --json m`.
 * Tolerates both formats: v2 uses `traffic.month[]` with byte counts (preferred),
 * v1 uses `traffic.months[]` with KiB counts. Falls back to the newest entry when
 * no entry matches the current month. Returns null on anything unparseable.
 * Pure — `now` is injectable for deterministic tests.
 */
export function parseVnstat(json: unknown, now: Date = new Date()): number | null {
  if (!json || typeof json !== 'object') return null;
  const iface = Array.isArray((json as any).interfaces) ? (json as any).interfaces[0] : undefined;
  const traffic = iface && typeof iface === 'object' ? iface.traffic : undefined;
  if (!traffic || typeof traffic !== 'object') return null;

  let entries: any[] | undefined;
  let unitKiB = false;
  if (Array.isArray(traffic.month)) {
    entries = traffic.month; // v2 — bytes
  } else if (Array.isArray(traffic.months)) {
    entries = traffic.months; // v1 — KiB
    unitKiB = true;
  }
  if (!entries || entries.length === 0) return null;

  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const match = entries.find((e) => e?.date?.year === y && e?.date?.month === mo);
  const chosen = match ?? entries[entries.length - 1];
  const tx = chosen?.tx;
  if (typeof tx !== 'number' || !Number.isFinite(tx)) return null;

  const bytes = unitKiB ? tx * 1024 : tx;
  return bytes / (1024 * 1024);
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Read this month's egress via `vnstat --json m` (3s timeout). Returns null when
 * vnstat is absent, times out, or emits nothing parseable.
 */
export async function readEgress(): Promise<EgressInfo | null> {
  try {
    const { stdout } = await execFileAsync('vnstat', ['--json', 'm'], {
      timeout: VNSTAT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      return null;
    }
    const monthTxMb = parseVnstat(json);
    return monthTxMb === null ? null : { monthTxMb };
  } catch {
    return null;
  }
}

/* ── aggregate ───────────────────────────────────────────────────────── */

/** Whole days remaining until the end of the current calendar month. */
export function daysLeftInMonth(now: Date = new Date()): number {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(0, daysInMonth - now.getDate());
}

function memVerdict(m: MemoryInfo | null, minFreeMemMb: number): Verdict {
  if (!m) return null;
  const free = m.availableMb + (m.swapFreeMb ?? 0);
  return free < minFreeMemMb ? 'block' : 'ok';
}

function diskVerdict(d: DiskInfo | null, warnPct: number, blockPct: number): Verdict {
  if (!d) return null;
  if (d.usedPct >= blockPct) return 'block';
  if (d.usedPct >= warnPct) return 'warn';
  return 'ok';
}

function egressVerdict(usedPct: number | null, warnPct: number): Verdict {
  if (usedPct === null) return null;
  return usedPct >= warnPct ? 'warn' : 'ok';
}

/**
 * Collect all three signals and grade them against the configured limits.
 * Every collector fails open (null); a null signal yields a null verdict.
 * Used by /usage — the manager's gates use the injected collectors directly.
 */
export async function readResourceStatus(cfg: Config): Promise<ResourceStatus> {
  const [memory, disk, egress] = await Promise.all([
    readMemory(),
    readDisk(cfg.workspacesDir),
    readEgress(),
  ]);
  const egressUsedPct =
    egress && cfg.egressFreeMb > 0
      ? Math.round((egress.monthTxMb / cfg.egressFreeMb) * 100)
      : null;
  return {
    memory,
    disk,
    egress,
    egressFreeMb: cfg.egressFreeMb,
    egressUsedPct,
    daysLeftInMonth: daysLeftInMonth(),
    verdicts: {
      memory: memVerdict(memory, cfg.minFreeMemMb),
      disk: diskVerdict(disk, cfg.diskWarnPct, cfg.diskBlockPct),
      egress: egressVerdict(egressUsedPct, cfg.egressWarnPct),
    },
  };
}
