import { describe, expect, it } from 'vitest';
import {
  buildExportMarkdown,
  buildForkSession,
  buildReviewPrompt,
  FORK_HEADER,
  goalStatusLabel,
  parseReviewArgs,
} from '../src/bot/commands.js';
import type { Session } from '../src/sessions/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    chatId: -1,
    topicId: 1,
    name: 's',
    engine: 'claude',
    repoUrl: 'owner/repo',
    workdir: '/tmp/wd',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildExportMarkdown', () => {
  it('renders a header and every exchange as prompt/answer blocks', () => {
    const md = buildExportMarkdown(
      makeSession({
        model: 'fable',
        goal: 'ship it',
        history: [
          { prompt: 'add x', answer: 'done x' },
          { prompt: 'add y', answer: 'done y' },
        ],
      }),
    );
    expect(md).toContain('# Session: s');
    expect(md).toContain('- Repository: owner/repo');
    expect(md).toContain('- Engine: claude (fable)');
    expect(md).toContain('- Exchanges: 2');
    expect(md).toContain('- Goal: ship it');
    expect(md).toContain('## Prompt 1');
    expect(md).toContain('add x');
    expect(md).toContain('### Answer');
    expect(md).toContain('done y');
  });

  it('handles an empty history without throwing', () => {
    const md = buildExportMarkdown(makeSession());
    expect(md).toContain('- Exchanges: 0');
    expect(md).not.toContain('## Prompt');
  });
});

describe('buildForkSession', () => {
  const history = [{ prompt: 'p', answer: 'a' }];

  it('claude: carries the parent session id and flags forkNext', () => {
    const old = makeSession({ engine: 'claude', engineSessionId: 'sid-parent', goal: 'g', history });
    const fork = buildForkSession(old, 99, '/tmp/fork');
    expect(fork.topicId).toBe(99);
    expect(fork.name).toBe('s · fork');
    expect(fork.engineSessionId).toBe('sid-parent');
    expect(fork.forkNext).toBe(true);
    expect(fork.pendingContext).toBeUndefined();
    expect(fork.goal).toBe('g');
    // deep copy — mutating the fork history must not touch the parent
    fork.history![0]!.answer = 'changed';
    expect(old.history![0]!.answer).toBe('a');
  });

  it('claude without a parent session id does not set forkNext', () => {
    const old = makeSession({ engine: 'claude', history });
    const fork = buildForkSession(old, 5, '/tmp/f');
    expect(fork.engineSessionId).toBeUndefined();
    expect(fork.forkNext).toBeUndefined();
  });

  it('codex: seeds a pendingContext recap instead of a native fork', () => {
    const old = makeSession({ engine: 'codex', engineSessionId: 'thread', history });
    const fork = buildForkSession(old, 7, '/tmp/f');
    expect(fork.forkNext).toBeUndefined();
    expect(fork.pendingContext).toContain(FORK_HEADER);
    expect(fork.pendingContext).toContain('p');
  });
});

describe('parseReviewArgs', () => {
  it('empty → uncommitted', () => {
    expect(parseReviewArgs('')).toEqual({ kind: 'uncommitted' });
    expect(parseReviewArgs('   ')).toEqual({ kind: 'uncommitted' });
  });
  it('base <branch> → base', () => {
    expect(parseReviewArgs('base main')).toEqual({ kind: 'base', ref: 'main' });
    expect(parseReviewArgs('BASE develop')).toEqual({ kind: 'base', ref: 'develop' });
  });
  it('commit <sha> → commit', () => {
    expect(parseReviewArgs('commit abc123')).toEqual({ kind: 'commit', sha: 'abc123' });
  });
  it('anything else → focus (including a bare base/commit)', () => {
    expect(parseReviewArgs('pay attention to security')).toEqual({
      kind: 'focus',
      focus: 'pay attention to security',
    });
    expect(parseReviewArgs('base')).toEqual({ kind: 'focus', focus: 'base' });
  });
});

describe('buildReviewPrompt', () => {
  it('keeps the [P0]-[P3] scale and the structured verdict format in every mode', () => {
    for (const mode of [
      { kind: 'uncommitted' } as const,
      { kind: 'base', ref: 'main' } as const,
      { kind: 'commit', sha: 'deadbee' } as const,
      { kind: 'focus', focus: 'races' } as const,
    ]) {
      const p = buildReviewPrompt(mode);
      expect(p).toContain('[P0]');
      expect(p).toContain('[P3]');
      expect(p).toContain('Verdict: patch is correct');
    }
  });
  it('uncommitted targets the working tree + staged + untracked', () => {
    const p = buildReviewPrompt({ kind: 'uncommitted' });
    expect(p).toContain('git diff HEAD');
    expect(p).toContain('untracked');
  });
  it('base targets the merge-base diff with the branch', () => {
    const p = buildReviewPrompt({ kind: 'base', ref: 'release' });
    expect(p).toContain('git merge-base release HEAD');
  });
  it('commit targets git show for the sha', () => {
    const p = buildReviewPrompt({ kind: 'commit', sha: 'abc123' });
    expect(p).toContain('git show abc123');
  });
  it('focus appends the focus onto the uncommitted target', () => {
    const p = buildReviewPrompt({ kind: 'focus', focus: 'memory leaks' });
    expect(p).toContain('git diff HEAD');
    expect(p).toContain('memory leaks');
  });
});

describe('goalStatusLabel', () => {
  it('maps every status to a label', () => {
    expect(goalStatusLabel('active')).toBe('active');
    expect(goalStatusLabel('blocked')).toBe('blocked');
    expect(goalStatusLabel('budget_limited')).toBe('stopped by budget');
    expect(goalStatusLabel('usage_limited')).toBe('stopped by limit');
    expect(goalStatusLabel('failed')).toBe('aborted');
    expect(goalStatusLabel('complete')).toBe('achieved');
  });
});
