import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { sanitizedChildEnv } from '../util/childEnv.js';

const execFileAsync = promisify(execFile);

const DU_TIMEOUT_MS = 15_000;

/**
 * True only when target is a *direct* child directory of workspacesDir — never
 * the dir itself, never a nested path, never an escape via `..`. This is the
 * guard that keeps /cleanup from ever `rm -rf`-ing something outside workspaces.
 */
export function isSafeWorkspacePath(workspacesDir: string, target: string): boolean {
  const base = path.resolve(workspacesDir);
  const resolved = path.resolve(target);
  const rel = path.relative(base, resolved);
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    !path.isAbsolute(rel) &&
    !rel.includes(path.sep)
  );
}

/** Parse a `du -sh` size token (e.g. "1.2G", "4.0K", "512B", "0") into bytes. */
export function parseHumanSize(token: string): number {
  const m = /^([\d.]+)\s*([BKMGTP]?)/i.exec(token.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return 0;
  const mult: Record<string, number> = {
    B: 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
  };
  return Math.round(n * (mult[(m[2] || 'B').toUpperCase()] ?? 1));
}

/** Compact human size for a byte count. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export interface OrphanWorkspace {
  name: string;
  path: string;
  /** Human-readable size from `du -sh` ("?" when du failed). */
  size: string;
  bytes: number;
}

/**
 * Direct-child directories of workspacesDir that no live session owns, each
 * sized with `du -sh`. liveWorkdirs are the workdirs of current sessions.
 * Returns [] when workspacesDir can't be read.
 */
export async function findOrphanWorkspaces(
  workspacesDir: string,
  liveWorkdirs: Iterable<string>,
): Promise<OrphanWorkspace[]> {
  const live = new Set<string>();
  for (const w of liveWorkdirs) live.add(path.resolve(w));

  let entries;
  try {
    entries = await fs.readdir(workspacesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const orphans: OrphanWorkspace[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const abs = path.resolve(workspacesDir, e.name);
    if (live.has(abs)) continue;
    let size = '?';
    let bytes = 0;
    try {
      const { stdout } = await execFileAsync('du', ['-sh', abs], {
        timeout: DU_TIMEOUT_MS,
        env: sanitizedChildEnv(),
      });
      const token = stdout.trim().split(/\s+/)[0] ?? '';
      if (token) {
        size = token;
        bytes = parseHumanSize(token);
      }
    } catch {
      /* du failed — keep unknown size */
    }
    orphans.push({ name: e.name, path: abs, size, bytes });
  }
  return orphans;
}

/**
 * Delete each target that passes isSafeWorkspacePath (recursive, force).
 * Returns how many were removed, bytes freed, and how many were refused by the
 * safety guard. Never throws.
 */
export async function deleteWorkspaces(
  workspacesDir: string,
  targets: ReadonlyArray<{ path: string; bytes: number }>,
): Promise<{ deleted: number; freedBytes: number; refused: number }> {
  let deleted = 0;
  let freedBytes = 0;
  let refused = 0;
  for (const t of targets) {
    if (!isSafeWorkspacePath(workspacesDir, t.path)) {
      refused++;
      continue;
    }
    try {
      await fs.rm(t.path, { recursive: true, force: true });
      deleted++;
      freedBytes += t.bytes;
    } catch {
      /* leave undeleted; not counted */
    }
  }
  return { deleted, freedBytes, refused };
}
