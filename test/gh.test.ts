import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  gitCommitAll,
  initChatWorkdir,
  isValidNewRepoName,
  isValidRepo,
  workdirName,
} from '../src/github/gh.js';

const execFileAsync = promisify(execFile);

describe('initChatWorkdir', () => {
  it('creates a git-initialized sandbox (codex requires a repo)', async () => {
    const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'chat-ws-')), 'chat-1');
    try {
      await initChatWorkdir(dir);
      const gitStat = await fs.stat(path.join(dir, '.git'));
      expect(gitStat.isDirectory()).toBe(true);
      await initChatWorkdir(dir); // idempotent — re-init must not throw
    } finally {
      await fs.rm(path.dirname(dir), { recursive: true, force: true });
    }
  });
});

describe('isValidNewRepoName', () => {
  it('accepts bare names and full slugs', () => {
    expect(isValidNewRepoName('my-new-project')).toBe(true);
    expect(isValidNewRepoName('bot_2.0')).toBe(true);
    expect(isValidNewRepoName('alver714/my-new-project')).toBe(true);
  });

  it('rejects traversal, empty, multi-segment and non-ASCII names', () => {
    expect(isValidNewRepoName('')).toBe(false);
    expect(isValidNewRepoName('.')).toBe(false);
    expect(isValidNewRepoName('..')).toBe(false);
    expect(isValidNewRepoName('../evil')).toBe(false);
    expect(isValidNewRepoName('a/b/c')).toBe(false);
    expect(isValidNewRepoName('café-münchen')).toBe(false);
  });
});

describe('isValidRepo', () => {
  it('accepts a normal owner/repo slug', () => {
    expect(isValidRepo('owner/repo')).toBe(true);
    expect(isValidRepo('my-org/my.repo_2')).toBe(true);
  });

  it('rejects traversal segments and malformed slugs', () => {
    expect(isValidRepo('../..')).toBe(false);
    expect(isValidRepo('owner/..')).toBe(false);
    expect(isValidRepo('./repo')).toBe(false);
    expect(isValidRepo('a/b/c')).toBe(false);
    expect(isValidRepo('')).toBe(false);
    expect(isValidRepo('noslash')).toBe(false);
  });
});

describe('workdirName', () => {
  it('replaces the slash and appends the topic id', () => {
    expect(workdirName('own/rep', 7)).toBe('own-rep-7');
  });

  it('sanitizes unsafe characters to underscores', () => {
    expect(workdirName('a b/c$d', 3)).toBe('a_b-c_d-3');
  });
});

describe('gitCommitAll', () => {
  it('stages tracked and untracked changes and creates a commit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-commit-'));
    try {
      await execFileAsync('git', ['init', '-q', dir]);
      await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
      await fs.writeFile(path.join(dir, 'new.txt'), 'hello');

      const result = await gitCommitAll(dir, '  add greeting  ');

      expect(result.subject).toBe('add greeting');
      expect(result.sha).toMatch(/^[0-9a-f]+$/);
      const { stdout: subject } = await execFileAsync('git', ['-C', dir, 'show', '-s', '--format=%s']);
      expect(subject.trim()).toBe('add greeting');
      const { stdout: status } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
      expect(status).toBe('');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty message and a clean tree', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-commit-empty-'));
    try {
      await execFileAsync('git', ['init', '-q', dir]);
      await expect(gitCommitAll(dir, '   ')).rejects.toThrow('must not be empty');
      await expect(gitCommitAll(dir, 'nothing')).rejects.toThrow('Nothing to commit');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
