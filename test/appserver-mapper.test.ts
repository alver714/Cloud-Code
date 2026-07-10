import { describe, expect, it } from 'vitest';
import { mapAppServerEvents } from '../src/engines/codex-appserver.js';
import type { AppServerNotification } from '../src/engines/appserver.js';
import type { AgentEvent } from '../src/engines/types.js';
import { collect } from './helpers.js';

function byKind(events: AgentEvent[], kind: AgentEvent['kind']): AgentEvent[] {
  return events.filter((e) => e.kind === kind);
}

/** Feed a fixed array of synthetic notifications through the mapper. */
async function run(
  notifs: AppServerNotification[],
  ctx: Parameters<typeof mapAppServerEvents>[1] = { threadId: 't1' },
): Promise<AgentEvent[]> {
  async function* gen(): AsyncGenerator<AppServerNotification, void, void> {
    for (const n of notifs) yield n;
  }
  return collect(mapAppServerEvents(gen(), ctx));
}

function tokenUsage(
  total: Partial<Record<'inputTokens' | 'cachedInputTokens' | 'outputTokens', number>>,
  last: Partial<Record<'inputTokens' | 'cachedInputTokens' | 'outputTokens', number>> = total,
  modelContextWindow?: number,
): AppServerNotification {
  return {
    method: 'thread/tokenUsage/updated',
    params: { threadId: 't1', turnId: 'turn1', tokenUsage: { total, last, modelContextWindow } },
  };
}

describe('mapAppServerEvents — token usage → usage-tick', () => {
  it('splits fresh vs cache on a fresh thread and reports real cumulative tokens', async () => {
    const events = await run([
      { method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn1' } } },
      // fresh thread: last === total, so baseline is ~0
      tokenUsage(
        { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 },
        { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 },
        272_000,
      ),
      { method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn1', status: 'completed' } } },
    ]);

    const tick = byKind(events, 'usage-tick')[0] as Extract<AgentEvent, { kind: 'usage-tick' }>;
    expect(tick.cumulative.freshInputTokens).toBe(600); // 1000 - 400
    expect(tick.cumulative.cacheReadTokens).toBe(400);
    expect(tick.cumulative.outputTokens).toBe(50);
    expect(tick.cumulative.cacheCreationTokens).toBe(0); // codex doesn't split it
    expect(tick.cumulative.steps).toBe(1);
  });

  it('keeps cumulative monotonic across several updates', async () => {
    const events = await run([
      tokenUsage(
        { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 30 },
        { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 30 },
      ),
      tokenUsage(
        { inputTokens: 2500, cachedInputTokens: 900, outputTokens: 120 },
        { inputTokens: 1500, cachedInputTokens: 700, outputTokens: 90 },
      ),
      tokenUsage(
        { inputTokens: 4000, cachedInputTokens: 1600, outputTokens: 210 },
        { inputTokens: 1500, cachedInputTokens: 700, outputTokens: 90 },
      ),
      { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } },
    ]);

    const ticks = byKind(events, 'usage-tick') as Extract<AgentEvent, { kind: 'usage-tick' }>[];
    expect(ticks).toHaveLength(3);
    for (let i = 1; i < ticks.length; i++) {
      const a = ticks[i - 1]!.cumulative;
      const b = ticks[i]!.cumulative;
      expect(b.freshInputTokens).toBeGreaterThanOrEqual(a.freshInputTokens);
      expect(b.cacheReadTokens).toBeGreaterThanOrEqual(a.cacheReadTokens);
      expect(b.outputTokens).toBeGreaterThanOrEqual(a.outputTokens);
      expect(b.steps).toBe(a.steps + 1);
    }
    // final cumulative reflects the real total
    const last = ticks.at(-1)!.cumulative;
    expect(last.cacheReadTokens).toBe(1600);
    expect(last.freshInputTokens).toBe(4000 - 1600);
    expect(last.outputTokens).toBe(210);
  });

  it('ticks on last-only updates (no cumulative total) so the guard sees progress', async () => {
    const events = await run([
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 't1',
          tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 } },
        },
      },
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 't1',
          tokenUsage: { last: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 20 } },
        },
      },
      { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } },
    ]);

    const ticks = byKind(events, 'usage-tick') as Extract<AgentEvent, { kind: 'usage-tick' }>[];
    expect(ticks).toHaveLength(2);
    const last = ticks.at(-1)!.cumulative;
    expect(last.steps).toBe(2);
    expect(last.freshInputTokens).toBe(60 + 100); // (100-40) + (200-100)
    expect(last.cacheReadTokens).toBe(140);
    expect(last.outputTokens).toBe(30);
  });

  it('baselines a RESUMED thread so per-run spend excludes prior turns', async () => {
    // total already carries 5000 prior-input / 300 prior-output before this run;
    // `last` is only this call, so baseline = total - last strips the history.
    const events = await run([
      tokenUsage(
        { inputTokens: 6000, cachedInputTokens: 1000, outputTokens: 350 },
        { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 },
      ),
      { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } },
    ]);
    const tick = byKind(events, 'usage-tick')[0] as Extract<AgentEvent, { kind: 'usage-tick' }>;
    // run input = 6000 - (6000-1000) = 1000 ; run cached = 1000 - (1000-200) = 200
    expect(tick.cumulative.freshInputTokens).toBe(800); // 1000 - 200
    expect(tick.cumulative.cacheReadTokens).toBe(200);
    expect(tick.cumulative.outputTokens).toBe(50); // 350 - (350-50)
  });
});

describe('mapAppServerEvents — items, result, failure', () => {
  it('emits init from the thread id', async () => {
    const events = await run(
      [{ method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } }],
      { threadId: 'thread-abc' },
    );
    const init = byKind(events, 'init')[0] as Extract<AgentEvent, { kind: 'init' }>;
    expect(init.engineSessionId).toBe('thread-abc');
  });

  it('maps a shell command exec (begin → tool-use, end → tool-result)', async () => {
    const events = await run([
      {
        method: 'item/started',
        params: {
          threadId: 't1',
          item: { id: 'c1', type: 'commandExecution', command: "/bin/zsh -lc 'npm test'" },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 't1',
          item: { id: 'c1', type: 'commandExecution', command: "/bin/zsh -lc 'npm test'", exitCode: 0 },
        },
      },
      { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } },
    ]);
    const toolUse = byKind(events, 'tool-use')[0] as Extract<AgentEvent, { kind: 'tool-use' }>;
    expect(toolUse.name).toBe('Shell');
    expect(toolUse.summary).toBe('npm test'); // login-shell wrapper stripped
    const toolResult = byKind(events, 'tool-result')[0] as Extract<AgentEvent, { kind: 'tool-result' }>;
    expect(toolResult.name).toBe('Shell');
    expect(toolResult.ok).toBe(true);
  });

  it('marks a non-zero exit as a failed tool-result', async () => {
    const events = await run([
      {
        method: 'item/completed',
        params: {
          threadId: 't1',
          item: { id: 'c1', type: 'commandExecution', command: 'false', exitCode: 1, aggregatedOutput: 'boom' },
        },
      },
      { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } },
    ]);
    const toolResult = byKind(events, 'tool-result')[0] as Extract<AgentEvent, { kind: 'tool-result' }>;
    expect(toolResult.ok).toBe(false);
    expect(toolResult.summary).toContain('exit 1');
  });

  it('maps agent message + reasoning, and reports them on completion', async () => {
    const events = await run([
      {
        method: 'item/completed',
        params: {
          threadId: 't1',
          item: { id: 'r1', type: 'reasoning', summary: ['Exploring the repo'], content: [] },
        },
      },
      {
        method: 'item/completed',
        params: { threadId: 't1', item: { id: 'a1', type: 'agentMessage', text: 'All done' } },
      },
      tokenUsage(
        { inputTokens: 900, cachedInputTokens: 100, outputTokens: 40 },
        { inputTokens: 900, cachedInputTokens: 100, outputTokens: 40 },
        272_000,
      ),
      { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } },
    ]);
    const reasoning = byKind(events, 'reasoning')[0] as Extract<AgentEvent, { kind: 'reasoning' }>;
    expect(reasoning.text).toBe('Exploring the repo');
    const text = byKind(events, 'assistant-text')[0] as Extract<AgentEvent, { kind: 'assistant-text' }>;
    expect(text.text).toBe('All done');

    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('All done');
    expect(result.usage?.inputTokens).toBe(900); // last model call's input = context size
    expect(result.usage?.outputTokens).toBe(40);
    expect(result.usage?.contextWindowTokens).toBe(272_000);
  });

  it('maps a failed turn to error + result(ok:false)', async () => {
    const events = await run([
      {
        method: 'turn/completed',
        params: {
          threadId: 't1',
          turn: { status: 'failed', error: { message: 'usage limit exceeded' } },
        },
      },
    ]);
    expect(byKind(events, 'error')).toHaveLength(1);
    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(false);
    expect(result.text).toContain('usage limit');
  });

  it('a non-retrying error notification ends the run', async () => {
    const events = await run([
      {
        method: 'error',
        params: { threadId: 't1', turnId: 'turn1', willRetry: false, error: { message: 'unauthorized' } },
      },
    ]);
    expect(byKind(events, 'error')).toHaveLength(1);
    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(false);
  });

  it('a $disconnect ends the run cleanly instead of hanging', async () => {
    const events = await run([{ method: '$disconnect', params: { message: 'app-server exited' } }]);
    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(false);
    expect(byKind(events, 'error')[0]).toBeDefined();
  });

  it('$cancelled ends the run with the last partial message', async () => {
    const events = await run([
      {
        method: 'item/completed',
        params: { threadId: 't1', item: { id: 'a1', type: 'agentMessage', text: 'partial' } },
      },
      { method: '$cancelled' },
    ]);
    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(false);
    expect(result.text).toBe('partial');
  });

  it('idle watchdog: a silently dead stream synthesizes a terminal error+result', async () => {
    async function* hanging(): AsyncGenerator<AppServerNotification, void, void> {
      yield {
        method: 'item/completed',
        params: { threadId: 't1', item: { id: 'a1', type: 'agentMessage', text: 'partial' } },
      };
      await new Promise(() => {}); // no turn/completed, no $disconnect — ever
    }
    const events = await collect(
      mapAppServerEvents(hanging(), { threadId: 't1', idleTimeoutMs: 25 }),
    );
    expect(byKind(events, 'error')).toHaveLength(1);
    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(false);
    expect(result.text).toBe('partial'); // the last agent message is preserved
  });
});
