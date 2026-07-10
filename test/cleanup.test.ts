import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteWorkspaces,
  findOrphanWorkspaces,
  humanBytes,
  isSafeWorkspacePath,
  parseHumanSize,
} from '../src/system/cleanup.js';

describe('isSafeWorkspacePath', () => {
  const base = '/home/bot/workspaces';

  it('accepts a direct child directory', () => {
    expect(isSafeWorkspacePath(base, '/home/bot/workspaces/owner-repo-42')).toBe(true);
    expect(isSafeWorkspacePath(base, path.join(base, 'a'))).toBe(true);
  });

  it('refuses the base itself, nested paths, and escapes', () => {
    expect(isSafeWorkspacePath(base, base)).toBe(false); // the dir itself
    expect(isSafeWorkspacePath(base, '/home/bot/workspaces/a/b')).toBe(false); // nested
    expect(isSafeWorkspacePath(base, '/home/bot/workspaces/../secrets')).toBe(false); // escape
    expect(isSafeWorkspacePath(base, '/etc/passwd')).toBe(false); // outside
    expect(isSafeWorkspacePath(base, '/home/bot')).toBe(false); // parent
  });

  it('normalizes . and redundant separators before checking', () => {
    expect(isSafeWorkspacePath(base, '/home/bot/workspaces/./a')).toBe(true);
    expect(isSafeWorkspacePath(base, '/home/bot/workspaces/a/..')).toBe(false); // == base
  });
});

describe('parseHumanSize / humanBytes', () => {
  it('parses du -sh tokens into bytes', () => {
    expect(parseHumanSize('512B')).toBe(512);
    expect(parseHumanSize('4.0K')).toBe(4096);
    expect(parseHumanSize('1.5M')).toBe(Math.round(1.5 * 1024 ** 2));
    expect(parseHumanSize('1.2G')).toBe(Math.round(1.2 * 1024 ** 3));
    expect(parseHumanSize('0')).toBe(0);
    expect(parseHumanSize('')).toBe(0);
    expect(parseHumanSize('nonsense')).toBe(0);
  });

  it('formats byte counts compactly', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(1024)).toBe('1.0 KB');
    expect(humanBytes(1024 ** 3)).toBe('1.0 GB');
  });
});

describe('findOrphanWorkspaces / deleteWorkspaces', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-test-'));
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  it('lists only directories with no live session', async () => {
    await fs.mkdir(path.join(ws, 'live-1'));
    await fs.mkdir(path.join(ws, 'orphan-1'));
    await fs.mkdir(path.join(ws, 'orphan-2'));
    await fs.writeFile(path.join(ws, 'a-file'), 'x'); // files are ignored

    const orphans = await findOrphanWorkspaces(ws, [path.join(ws, 'live-1')]);
    const names = orphans.map((o) => o.name).sort();
    expect(names).toEqual(['orphan-1', 'orphan-2']);
  });

  it('deletes orphan dirs and refuses paths outside the workspaces root', async () => {
    await fs.mkdir(path.join(ws, 'orphan-1'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'keep-me-'));
    try {
      const res = await deleteWorkspaces(ws, [
        { path: path.join(ws, 'orphan-1'), bytes: 4096 },
        { path: outside, bytes: 999 }, // outside root → must be refused
        { path: path.join(ws, '..', 'evil'), bytes: 1 }, // escape → refused
      ]);

      expect(res.deleted).toBe(1);
      expect(res.freedBytes).toBe(4096);
      expect(res.refused).toBe(2);
      // the outside dir must still exist
      await expect(fs.access(outside)).resolves.toBeUndefined();
      // the orphan is gone
      await expect(fs.access(path.join(ws, 'orphan-1'))).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
