import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Engine, EngineRun, EngineRunOptions } from '../src/engines/types.js';
import { SessionManager, type RunReporter, type RunSummary } from '../src/sessions/manager.js';
import { SessionStore } from '../src/sessions/store.js';
import type { Session } from '../src/sessions/types.js';
import { UsageAccounting } from '../src/usage/accounting.js';

let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-test-'));
  store = new SessionStore(path.join(dir, 'sessions.json'));
  await store.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function makeSession(topicId: number): Session {
  return {
    chatId: -1,
    topicId,
    name: `s${topicId}`,
    engine: 'claude',
    repoUrl: 'owner/repo',
    workdir: dir,
    status: 'idle',
    createdAt: new Date().toISOString(),
  };
}

/** Engine whose runs resolve when the test releases them. */
class MockEngine implements Engine {
  readonly kind = 'claude' as const;
  readonly seen: EngineRunOptions[] = [];
  private releases: Array<(events: AgentEvent[]) => void> = [];

  run(opts: EngineRunOptions): EngineRun {
    this.seen.push(opts);
    let release!: (events: AgentEvent[]) => void;
    const gate = new Promise<AgentEvent[]>((resolve) => (release = resolve));
    this.releases.push(release);

    async function* events(): AsyncGenerator<AgentEvent, void, void> {
      for (const ev of await gate) yield ev;
    }
    return { events: events(), cancel: () => release([]), pid: 4242 };
  }

  /** Finish the oldest pending run with the given events. */
  release(events: AgentEvent[]): void {
    this.releases.shift()?.(events);
  }
}

class NullReporter implements RunReporter {
  summaries: RunSummary[] = [];
  async start(): Promise<void> {}
  onEvent(): void {}
  async end(summary: RunSummary): Promise<void> {
    this.summaries.push(summary);
  }
}

/** Engine that plays a fixed script of events and honors cancellation. */
class ScriptEngine implements Engine {
  readonly kind = 'claude' as const;
  cancelled = false;
  constructor(private readonly script: AgentEvent[]) {}
  run(): EngineRun {
    const self = this;
    async function* events(): AsyncGenerator<AgentEvent, void, void> {
      for (const ev of self.script) {
        if (self.cancelled) return;
        yield ev;
        await Promise.resolve(); // yield control so a cancel can land between ticks
      }
    }
    return {
      events: events(),
      cancel: () => {
        self.cancelled = true;
      },
      pid: 7777,
    };
  }
}

class RecordingReporter implements RunReporter {
  notices: string[] = [];
  summaries: RunSummary[] = [];
  async start(): Promise<void> {}
  onEvent(): void {}
  async notice(text: string): Promise<void> {
    this.notices.push(text);
  }
  async end(summary: RunSummary): Promise<void> {
    this.summaries.push(summary);
  }
}

const usageTick = (outputTokens: number, steps: number): AgentEvent => ({
  kind: 'usage-tick',
  cumulative: {
    freshInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens,
    steps,
  },
});

const okRun = (sessionId: string): AgentEvent[] => [
  { kind: 'init', engineSessionId: sessionId },
  { kind: 'assistant-text', text: 'hi' },
  { kind: 'result', ok: true, text: 'hi' },
];

/** Polls until the condition holds (run pumps do real disk I/O). */
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('SessionManager', () => {
  function makeManager(engine: MockEngine, maxConcurrentRuns = 3) {
    const reporter = new NullReporter();
    const manager = new SessionManager(
      store,
      { claude: engine, codex: engine },
      () => reporter,
      {
        logsDir: dir,
        maxConcurrentRuns,
        defaultModels: {},
        guard: { softTokens: 0, hardTokens: 0, maxSteps: 0 },
        preflightPct: 0,
      },
    );
    return { manager, reporter };
  }

  it('runs a prompt, stores the engine session id, resumes with it next time', async () => {
    const engine = new MockEngine();
    const { manager } = makeManager(engine);
    const session = makeSession(1);
    await store.upsert(session);

    expect((await manager.submitPrompt(session, 'first')).status).toBe('started');
    expect(store.get(-1, 1)?.status).toBe('running');

    engine.release(okRun('sid-1'));
    await waitUntil(() => store.get(-1, 1)?.status === 'idle');
    expect(store.get(-1, 1)?.engineSessionId).toBe('sid-1');

    await manager.submitPrompt(session, 'second');
    expect(engine.seen[1]?.resumeSessionId).toBe('sid-1');
    engine.release(okRun('sid-1'));
    await waitUntil(() => store.get(-1, 1)?.status === 'idle');
  });

  it('queues a second prompt for a busy session and runs it after', async () => {
    const engine = new MockEngine();
    const { manager } = makeManager(engine);
    const session = makeSession(1);
    await store.upsert(session);

    await manager.submitPrompt(session, 'one');
    const res = await manager.submitPrompt(session, 'two');
    expect(res).toEqual({ status: 'queued', position: 1 });
    expect(engine.seen).toHaveLength(1);

    engine.release(okRun('sid-1'));
    await waitUntil(() => engine.seen.length === 2);
    expect(engine.seen[1]?.prompt).toBe('two');
    engine.release(okRun('sid-1'));
    await waitUntil(() => store.get(-1, 1)?.status === 'idle');
  });

  it('respects the global concurrency limit across sessions', async () => {
    const engine = new MockEngine();
    const { manager } = makeManager(engine, 1);
    const a = makeSession(1);
    const b = makeSession(2);
    await store.upsert(a);
    await store.upsert(b);

    await manager.submitPrompt(a, 'a');
    const res = await manager.submitPrompt(b, 'b');
    expect(res.status).toBe('queued');
    expect(engine.seen).toHaveLength(1);

    engine.release(okRun('sid-a'));
    await waitUntil(() => engine.seen.length === 2);
    expect(engine.seen[1]?.prompt).toBe('b');
    engine.release(okRun('sid-b'));
    await waitUntil(() => store.get(-1, 2)?.status === 'idle');
  });

  it('marks the session error when the run fails', async () => {
    const engine = new MockEngine();
    const { manager, reporter } = makeManager(engine);
    const session = makeSession(1);
    await store.upsert(session);

    await manager.submitPrompt(session, 'boom');
    engine.release([
      { kind: 'error', message: 'engine exploded' },
      { kind: 'result', ok: false, text: 'failed' },
    ]);
    await waitUntil(() => store.get(-1, 1)?.status === 'error');

    expect(reporter.summaries[0]?.ok).toBe(false);
    expect(reporter.summaries[0]?.errorMessages).toContain('engine exploded');
  });

  it('strips bot secrets from the engine environment', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'secret-token');
    try {
      const engine = new MockEngine();
      const { manager } = makeManager(engine);
      const session = makeSession(1);
      await store.upsert(session);

      await manager.submitPrompt(session, 'x');
      expect(engine.seen[0]?.env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
      engine.release(okRun('s'));
      await waitUntil(() => store.get(-1, 1)?.status === 'idle');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('SessionManager · Token Guard', () => {
  it('warns at soft and hard-stops the run past the hard token limit', async () => {
    const engine = new ScriptEngine([
      { kind: 'init', engineSessionId: 'sid-g' },
      usageTick(50, 1),
      usageTick(120, 2), // crosses soft (100) → notice
      usageTick(300, 3), // crosses hard (250) → cancel
      { kind: 'assistant-text', text: 'trailing, should not surface' },
      { kind: 'result', ok: true, text: 'done' },
    ]);
    const reporter = new RecordingReporter();
    const manager = new SessionManager(store, { claude: engine, codex: engine }, () => reporter, {
      logsDir: dir,
      maxConcurrentRuns: 3,
      defaultModels: {},
      guard: { softTokens: 100, hardTokens: 250, maxSteps: 0 },
      preflightPct: 0,
    });
    const session = makeSession(1);
    await store.upsert(session);

    await manager.submitPrompt(session, 'go');
    await waitUntil(() => reporter.summaries.length === 1);

    expect(engine.cancelled).toBe(true); // guard invoked run.cancel()
    expect(reporter.summaries[0]?.guardStopped).toEqual({ workTokens: 300, limit: 250 });
    expect(reporter.notices.some((n) => n.includes('токенов работы'))).toBe(true);
    // a guard-stopped run stays resumable (idle), not marked error
    expect(store.get(-1, 1)?.status).toBe('idle');
  });

  it('honors a per-session budgetTokens override for the hard limit', async () => {
    const engine = new ScriptEngine([
      { kind: 'init', engineSessionId: 'sid-b' },
      usageTick(600, 1), // above the session budget (500) → hard at once
      { kind: 'result', ok: true, text: 'done' },
    ]);
    const reporter = new RecordingReporter();
    const manager = new SessionManager(store, { claude: engine, codex: engine }, () => reporter, {
      logsDir: dir,
      maxConcurrentRuns: 3,
      defaultModels: {},
      guard: { softTokens: 0, hardTokens: 250, maxSteps: 0 },
      preflightPct: 0,
    });
    const session = { ...makeSession(2), budgetTokens: 500 };
    await store.upsert(session);

    await manager.submitPrompt(session, 'go');
    await waitUntil(() => reporter.summaries.length === 1);
    expect(reporter.summaries[0]?.guardStopped).toEqual({ workTokens: 600, limit: 500 });
  });

  it('blocks a start when the pre-flight window is at/above the threshold, and caches the read', async () => {
    const engine = new MockEngine();
    const reporter = new NullReporter();
    let reads = 0;
    const manager = new SessionManager(store, { claude: engine, codex: engine }, () => reporter, {
      logsDir: dir,
      maxConcurrentRuns: 3,
      defaultModels: {},
      guard: { softTokens: 0, hardTokens: 0, maxSteps: 0 },
      preflightPct: 90,
      readWindow: async () => {
        reads++;
        return { usedPercent: 95, resetsAt: 1234 };
      },
    });
    const session = makeSession(1);
    await store.upsert(session);

    const res1 = await manager.submitPrompt(session, 'go');
    const res2 = await manager.submitPrompt(session, 'go again');
    expect(res1).toEqual({ status: 'limit-blocked', usedPercent: 95, resetsAt: 1234 });
    expect(res2.status).toBe('limit-blocked');
    expect(engine.seen).toHaveLength(0); // never started
    expect(reads).toBe(1); // 60s in-memory cache — the second submit reused it

    // a user-confirmed force bypasses the gate
    const forced = await manager.submitPrompt(session, 'go', { bypassPreflight: true });
    expect(forced.status).toBe('started');
    expect(reads).toBe(1); // bypass does not read the window
    engine.release(okRun('s'));
    await waitUntil(() => store.get(-1, 1)?.status === 'idle');
  });

  it('fails open (proceeds) when the pre-flight window read returns null', async () => {
    const engine = new MockEngine();
    const reporter = new NullReporter();
    const manager = new SessionManager(store, { claude: engine, codex: engine }, () => reporter, {
      logsDir: dir,
      maxConcurrentRuns: 3,
      defaultModels: {},
      guard: { softTokens: 0, hardTokens: 0, maxSteps: 0 },
      preflightPct: 90,
      readWindow: async () => null,
    });
    const session = makeSession(1);
    await store.upsert(session);

    const res = await manager.submitPrompt(session, 'go');
    expect(res.status).toBe('started');
    engine.release(okRun('s'));
    await waitUntil(() => store.get(-1, 1)?.status === 'idle');
  });

  it('records spend into accounting at run end from the last tick', async () => {
    const engine = new MockEngine();
    const reporter = new NullReporter();
    const acc = new UsageAccounting(path.join(dir, 'stats.json'));
    await acc.load();
    const manager = new SessionManager(store, { claude: engine, codex: engine }, () => reporter, {
      logsDir: dir,
      maxConcurrentRuns: 3,
      defaultModels: {},
      guard: { softTokens: 0, hardTokens: 0, maxSteps: 0 },
      preflightPct: 0,
      accounting: acc,
    });
    const session = makeSession(3);
    await store.upsert(session);

    await manager.submitPrompt(session, 'go');
    engine.release([
      { kind: 'init', engineSessionId: 's' },
      usageTick(500, 2), // freshInput 0, output 500 → work 500
      { kind: 'result', ok: true, text: 'ok' },
    ]);
    await waitUntil(() => store.get(-1, 3)?.status === 'idle');

    expect(acc.today().claude).toMatchObject({
      workTokens: 500,
      outputTokens: 500,
      runs: 1,
      guardStops: 0,
    });
  });
});
