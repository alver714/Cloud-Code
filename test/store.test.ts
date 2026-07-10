import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions/store.js';
import type { Session } from '../src/sessions/types.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'store-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeSession(topicId: number): Session {
  return {
    chatId: -100123,
    topicId,
    name: `s${topicId}`,
    engine: 'claude',
    repoUrl: 'owner/repo',
    workdir: `/tmp/w${topicId}`,
    status: 'idle',
    createdAt: new Date().toISOString(),
  };
}

describe('SessionStore', () => {
  it('persists and reloads sessions', async () => {
    const file = path.join(dir, 'sessions.json');
    const store = new SessionStore(file);
    await store.load();
    await store.upsert(makeSession(1));
    await store.upsert({ ...makeSession(2), engineSessionId: 'abc' });

    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.all()).toHaveLength(2);
    expect(reloaded.get(-100123, 2)?.engineSessionId).toBe('abc');
  });

  it('recovers from a corrupted main file using the .bak', async () => {
    const file = path.join(dir, 'sessions.json');
    const store = new SessionStore(file);
    await store.load();
    await store.upsert(makeSession(1));
    await store.upsert(makeSession(2)); // creates .bak with session 1

    await fs.writeFile(file, '{broken json', 'utf8');

    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.all().length).toBeGreaterThanOrEqual(1);
  });

  it('serializes concurrent writes without corruption', async () => {
    const file = path.join(dir, 'sessions.json');
    const store = new SessionStore(file);
    await store.load();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.upsert(makeSession(i))));

    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.all()).toHaveLength(20);
  });
});
