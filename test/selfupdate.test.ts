import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeUpdateCheck,
  consumeUpdateMarker,
  getCurrentVersion,
  isUnderSystemd,
  parseLsRemote,
  runUpdate,
  shortSha,
  type ExecFn,
  type UpdateMarker,
} from '../src/system/selfupdate.js';

describe('parseLsRemote', () => {
  it('parses the SHA from a single main ref line', () => {
    expect(parseLsRemote('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4\trefs/heads/main')).toBe(
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
    );
  });

  it('picks refs/heads/main when several refs are present', () => {
    const out = [
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\tHEAD',
      'cafebabecafebabecafebabecafebabecafebabe\trefs/heads/main',
      '0000000000000000000000000000000000000000\trefs/heads/dev',
    ].join('\n');
    expect(parseLsRemote(out)).toBe('cafebabecafebabecafebabecafebabecafebabe');
  });

  it('returns undefined for empty / non-SHA output', () => {
    expect(parseLsRemote('')).toBeUndefined();
    expect(parseLsRemote('   \n  ')).toBeUndefined();
    expect(parseLsRemote('fatal: repository not found')).toBeUndefined();
  });
});

describe('computeUpdateCheck', () => {
  it('reports unknown-latest when the remote SHA is missing', () => {
    expect(computeUpdateCheck('abc1234', undefined)).toEqual({
      state: 'unknown-latest',
      current: 'abc1234',
    });
  });

  it('reports up-to-date when current equals latest', () => {
    expect(computeUpdateCheck('sha', 'sha')).toEqual({
      state: 'up-to-date',
      current: 'sha',
      latest: 'sha',
    });
  });

  it('reports available when they differ or current is unknown', () => {
    expect(computeUpdateCheck('old', 'new')).toEqual({
      state: 'available',
      current: 'old',
      latest: 'new',
    });
    expect(computeUpdateCheck(undefined, 'new')).toEqual({
      state: 'available',
      current: undefined,
      latest: 'new',
    });
  });
});

describe('shortSha / isUnderSystemd', () => {
  it('shortens to 7 chars or "unknown"', () => {
    expect(shortSha('a1b2c3d4e5f6')).toBe('a1b2c3d');
    expect(shortSha(undefined)).toBe('unknown');
  });

  it('detects systemd via INVOCATION_ID', () => {
    expect(isUnderSystemd({ INVOCATION_ID: 'abc' })).toBe(true);
    expect(isUnderSystemd({})).toBe(false);
  });
});

describe('getCurrentVersion', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfupdate-ver-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads and trims the VERSION file when present', async () => {
    const file = path.join(dir, 'VERSION');
    await fs.writeFile(file, 'deadbeef\n');
    expect(await getCurrentVersion(file)).toBe('deadbeef');
  });

  it('returns undefined when absent or empty', async () => {
    expect(await getCurrentVersion(path.join(dir, 'nope'))).toBeUndefined();
    const empty = path.join(dir, 'VERSION');
    await fs.writeFile(empty, '  \n');
    expect(await getCurrentVersion(empty)).toBeUndefined();
  });
});

describe('consumeUpdateMarker', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'selfupdate-home-'));
    await fs.mkdir(path.join(home, '.coding-bot'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('reads then deletes the marker (only reports once)', async () => {
    const marker: UpdateMarker = { from: 'old', to: 'new', at: 1, chatId: 5, topicId: 9 };
    const file = path.join(home, '.coding-bot', 'last-update.json');
    await fs.writeFile(file, JSON.stringify(marker));
    expect(await consumeUpdateMarker(home)).toEqual(marker);
    // consumed
    await expect(fs.access(file)).rejects.toThrow();
    expect(await consumeUpdateMarker(home)).toBeUndefined();
  });

  it('returns undefined for a missing / malformed marker', async () => {
    expect(await consumeUpdateMarker(home)).toBeUndefined();
    await fs.writeFile(path.join(home, '.coding-bot', 'last-update.json'), 'not json');
    expect(await consumeUpdateMarker(home)).toBeUndefined();
  });
});

describe('runUpdate', () => {
  let home: string;
  let target: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'selfupdate-run-home-'));
    target = await fs.mkdtemp(path.join(os.tmpdir(), 'selfupdate-run-target-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  });

  const NEW_SHA = 'newsha00000000000000000000000000000000ab';

  /**
   * Fake exec: `git clone` populates the (mkdtemp'd) clone dir with a built
   * tree; `rev-parse` returns the new SHA; npm ci / build are no-ops. When
   * `failOn` matches a command it throws with stdout/stderr (like execFile).
   */
  function fakeExec(opts: { failOn?: 'build' | 'clone'; calls: string[][] } = { calls: [] }): ExecFn {
    return async (cmd, args) => {
      opts.calls.push([cmd, ...args]);
      const joined = args.join(' ');
      if (cmd === 'git' && args[0] === 'clone') {
        if (opts.failOn === 'clone') {
          throw Object.assign(new Error('clone failed'), { stdout: '', stderr: 'fatal: nope' });
        }
        const cloneDir = args[args.length - 1]!;
        await fs.mkdir(path.join(cloneDir, 'dist'), { recursive: true });
        await fs.writeFile(path.join(cloneDir, 'dist', 'index.js'), 'NEW BUILD');
        await fs.writeFile(path.join(cloneDir, 'package.json'), '{"new":true}');
        await fs.writeFile(path.join(cloneDir, 'package-lock.json'), '{"lock":"new"}');
        return { stdout: '', stderr: '' };
      }
      if (cmd === 'git' && args[0] === '-C' && args.includes('rev-parse')) {
        return { stdout: `${NEW_SHA}\n`, stderr: '' };
      }
      if (cmd === 'npm' && joined.includes('run build')) {
        if (opts.failOn === 'build') {
          throw Object.assign(new Error('build failed'), {
            stdout: 'tsc output',
            stderr: 'error TS1234: boom',
          });
        }
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
  }

  it('succeeds: backs up old dist, copies new build, writes VERSION + marker', async () => {
    // Seed a "current" install.
    await fs.mkdir(path.join(target, 'dist'), { recursive: true });
    await fs.writeFile(path.join(target, 'dist', 'index.js'), 'OLD BUILD');
    await fs.writeFile(path.join(target, 'VERSION'), 'oldsha123\n');

    const calls: string[][] = [];
    const res = await runUpdate({
      now: 12345,
      repoUrl: 'https://example.invalid/repo',
      targetDir: target,
      homeDir: home,
      chatId: 42,
      topicId: 7,
      exec: fakeExec({ calls }),
    });

    expect(res).toEqual({ ok: true, from: 'oldsha123', to: NEW_SHA });
    // new build swapped in
    expect(await fs.readFile(path.join(target, 'dist', 'index.js'), 'utf8')).toBe('NEW BUILD');
    // old build preserved for rollback
    expect(await fs.readFile(path.join(target, 'dist.bak', 'index.js'), 'utf8')).toBe('OLD BUILD');
    // package files copied
    expect(await fs.readFile(path.join(target, 'package.json'), 'utf8')).toBe('{"new":true}');
    // VERSION updated
    expect((await fs.readFile(path.join(target, 'VERSION'), 'utf8')).trim()).toBe(NEW_SHA);
    // marker written for the post-restart confirmation
    const marker = JSON.parse(
      await fs.readFile(path.join(home, '.coding-bot', 'last-update.json'), 'utf8'),
    ) as UpdateMarker;
    expect(marker).toEqual({ from: 'oldsha123', to: NEW_SHA, at: 12345, chatId: 42, topicId: 7 });
    // prod deps synced in the target dir
    expect(calls).toContainEqual([
      'npm',
      'ci',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ]);
    // clone temp dir cleaned up
    const leftovers = (await fs.readdir(path.join(home, '.coding-bot'))).filter((n) =>
      n.startsWith('update-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('aborts on build failure WITHOUT touching the live install', async () => {
    await fs.mkdir(path.join(target, 'dist'), { recursive: true });
    await fs.writeFile(path.join(target, 'dist', 'index.js'), 'OLD BUILD');
    await fs.writeFile(path.join(target, 'VERSION'), 'oldsha123\n');

    const res = await runUpdate({
      now: 1,
      targetDir: target,
      homeDir: home,
      exec: fakeExec({ failOn: 'build', calls: [] }),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.tail).toContain('error TS1234');
    // live install untouched
    expect(await fs.readFile(path.join(target, 'dist', 'index.js'), 'utf8')).toBe('OLD BUILD');
    expect((await fs.readFile(path.join(target, 'VERSION'), 'utf8')).trim()).toBe('oldsha123');
    await expect(fs.access(path.join(target, 'dist.bak'))).rejects.toThrow();
    await expect(
      fs.access(path.join(home, '.coding-bot', 'last-update.json')),
    ).rejects.toThrow();
  });
});
