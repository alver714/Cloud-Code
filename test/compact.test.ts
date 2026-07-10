import { describe, expect, it } from 'vitest';
import { COMPACT_HEADER, compactSession } from '../src/bot/commands.js';
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
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('compactSession', () => {
  it('sets pendingContext with the compaction header and clears the engine session', () => {
    const s = makeSession({
      engineSessionId: 'sid',
      contextUsedTokens: 1234,
      contextWindowTokens: 200000,
      history: [{ prompt: 'add a feature', answer: 'done, edited src/x.ts' }],
    });
    const chars = compactSession(s);
    expect(chars).not.toBeNull();
    expect(s.pendingContext).toContain(COMPACT_HEADER);
    expect(s.pendingContext).toContain('add a feature');
    expect(chars).toBe(s.pendingContext!.length);
    expect(s.engineSessionId).toBeUndefined();
    expect(s.contextUsedTokens).toBeUndefined();
    expect(s.contextWindowTokens).toBeUndefined();
  });

  it('leaves the session untouched when there is no history', () => {
    const s = makeSession({ engineSessionId: 'sid' });
    const chars = compactSession(s);
    expect(chars).toBeNull();
    expect(s.pendingContext).toBeUndefined();
    expect(s.engineSessionId).toBe('sid');
  });
});
