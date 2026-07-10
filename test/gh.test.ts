import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initChatWorkdir, isValidNewRepoName, isValidRepo, workdirName } from '../src/github/gh.js';

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
