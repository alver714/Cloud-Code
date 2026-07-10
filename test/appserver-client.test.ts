import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { AppServerClient, notifThreadId, type SpawnedProc } from '../src/engines/appserver.js';

/**
 * A fake `codex app-server` process: the client writes JSON-RPC lines to
 * `stdin`, the test reads them (parsed) and pushes replies/notifications onto
 * `stdout`. No real process is ever spawned.
 */
function makeFakeProc() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: any[] = [];
  let closeCb: ((info: { code: number | null; reason?: string }) => void) | undefined;

  // Parse each line the client writes so tests can correlate ids.
  let buf = '';
  stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) written.push(JSON.parse(line));
    }
  });

  const proc: SpawnedProc = {
    stdin,
    stdout,
    pid: 4242,
    kill: () => {},
    onClose: (cb) => {
      closeCb = cb;
    },
  };

  return {
    proc,
    written,
    /** Push a server message to the client. */
    reply: (obj: unknown) => stdout.write(JSON.stringify(obj) + '\n'),
    /** Simulate an unexpected process exit. */
    triggerClose: (reason = 'boom') => closeCb?.({ code: 1, reason }),
    /** Wait until the client has written a message matching a predicate. */
    waitFor: async (pred: (m: any) => boolean, tries = 200): Promise<any> => {
      for (let i = 0; i < tries; i++) {
        const m = written.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 1));
      }
      throw new Error('timed out waiting for a written message');
    },
  };
}

describe('AppServerClient JSON-RPC framing', () => {
  it('handshakes then correlates request/response by id', async () => {
    const fake = makeFakeProc();
    const client = new AppServerClient(() => fake.proc);

    const ready = client.ensureReady();
    const init = await fake.waitFor((m) => m.method === 'initialize');
    expect(init.id).toBeTypeOf('number');
    fake.reply({ jsonrpc: '2.0', id: init.id, result: { userAgent: 'codex' } });
    await ready;

    // the `initialized` notification carries no id
    const initialized = fake.written.find((m) => m.method === 'initialized');
    expect(initialized).toBeDefined();
    expect(initialized.id).toBeUndefined();
    expect(client.pid).toBe(4242);

    // thread/start correlates by its own id
    const startP = client.startThread({ cwd: '/tmp/wd', model: 'gpt-5-codex', effort: 'high' });
    const start = await fake.waitFor((m) => m.method === 'thread/start');
    expect(start.params.cwd).toBe('/tmp/wd');
    expect(start.params.approvalPolicy).toBe('never');
    expect(start.params.sandbox).toBe('danger-full-access');
    expect(start.params.config.model_reasoning_effort).toBe('high');
    fake.reply({
      jsonrpc: '2.0',
      id: start.id,
      result: { thread: { id: 'thread-9' }, model: 'gpt-5-codex', reasoningEffort: 'high' },
    });
    const started = await startP;
    expect(started.threadId).toBe('thread-9');
    expect(started.model).toBe('gpt-5-codex');

    // turn/start returns the new turn id
    const turnP = client.sendTurn('thread-9', 'do it');
    const turn = await fake.waitFor((m) => m.method === 'turn/start');
    expect(turn.params.threadId).toBe('thread-9');
    expect(turn.params.input[0]).toMatchObject({ type: 'text', text: 'do it' });
    fake.reply({ jsonrpc: '2.0', id: turn.id, result: { turn: { id: 'turn-1' } } });
    expect(await turnP).toBe('turn-1');
  });

  it('routes notifications to the listener of the matching thread only', async () => {
    const fake = makeFakeProc();
    const client = new AppServerClient(() => fake.proc);
    const ready = client.ensureReady();
    const init = await fake.waitFor((m) => m.method === 'initialize');
    fake.reply({ jsonrpc: '2.0', id: init.id, result: {} });
    await ready;

    const got1: string[] = [];
    const got2: string[] = [];
    client.onNotification('t1', (n) => got1.push(n.method));
    const unsub2 = client.onNotification('t2', (n) => got2.push(n.method));

    fake.reply({
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: { threadId: 't1', tokenUsage: { total: {}, last: {} } },
    });
    fake.reply({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 't2', item: {} } });
    // thread/started routes by params.thread.id
    fake.reply({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 't1' } } });

    await new Promise((r) => setTimeout(r, 20));
    expect(got1).toEqual(['thread/tokenUsage/updated', 'thread/started']);
    expect(got2).toEqual(['item/started']);

    // unsubscribe stops further delivery
    unsub2();
    fake.reply({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't2', turn: {} } });
    await new Promise((r) => setTimeout(r, 20));
    expect(got2).toEqual(['item/started']);
  });

  it('rejects in-flight requests and broadcasts $disconnect on unexpected exit', async () => {
    const fake = makeFakeProc();
    const client = new AppServerClient(() => fake.proc);
    const ready = client.ensureReady();
    const init = await fake.waitFor((m) => m.method === 'initialize');
    fake.reply({ jsonrpc: '2.0', id: init.id, result: {} });
    await ready;

    const disconnects: string[] = [];
    client.onNotification('t1', (n) => {
      if (n.method === '$disconnect') disconnects.push(String(n.params?.message));
    });

    // a request that will never get a reply
    const startP = client.startThread({ cwd: '/tmp/wd' });
    await fake.waitFor((m) => m.method === 'thread/start');

    fake.triggerClose('server crashed');

    await expect(startP).rejects.toThrow(/app-server unavailable|server crashed/);
    expect(disconnects).toEqual(['server crashed']);
  });

  it('respawns on the next ensureReady after a crash', async () => {
    let spawns = 0;
    const fakes: ReturnType<typeof makeFakeProc>[] = [];
    const client = new AppServerClient(() => {
      spawns++;
      const f = makeFakeProc();
      fakes.push(f);
      return f.proc;
    });

    const ready1 = client.ensureReady();
    const init1 = await fakes[0]!.waitFor((m) => m.method === 'initialize');
    fakes[0]!.reply({ jsonrpc: '2.0', id: init1.id, result: {} });
    await ready1;
    expect(spawns).toBe(1);

    fakes[0]!.triggerClose('crash');

    const ready2 = client.ensureReady();
    const init2 = await fakes[1]!.waitFor((m) => m.method === 'initialize');
    fakes[1]!.reply({ jsonrpc: '2.0', id: init2.id, result: {} });
    await ready2;
    expect(spawns).toBe(2);
  });
});

describe('notifThreadId', () => {
  it('reads params.threadId or params.thread.id', () => {
    expect(notifThreadId({ method: 'x', params: { threadId: 'a' } })).toBe('a');
    expect(notifThreadId({ method: 'x', params: { thread: { id: 'b' } } })).toBe('b');
    expect(notifThreadId({ method: 'x', params: {} })).toBeUndefined();
    expect(notifThreadId({ method: 'x' })).toBeUndefined();
  });
});
