import { describe, expect, it } from 'vitest';
import { isValidRepo, workdirName } from '../src/github/gh.js';

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
