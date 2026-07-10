import { describe, expect, it } from 'vitest';
import { friendlyToolUse, mapClaudeEvents } from '../src/engines/claude.js';
import { cleanShellCommand, mapCodexEvents } from '../src/engines/codex.js';
import type { AgentEvent } from '../src/engines/types.js';
import { collect, fixtureSource } from './helpers.js';

function byKind(events: AgentEvent[], kind: AgentEvent['kind']): AgentEvent[] {
  return events.filter((e) => e.kind === kind);
}

describe('cleanShellCommand', () => {
  it('strips the login-shell wrapper and surrounding quotes for every shell', () => {
    expect(cleanShellCommand("/bin/zsh -lc 'echo hi'")).toBe('echo hi');
    expect(cleanShellCommand('/bin/bash -lc "npm test"')).toBe('npm test');
    expect(cleanShellCommand('/usr/bin/sh -lc \'ls -la\'')).toBe('ls -la');
    expect(cleanShellCommand('/usr/bin/dash -lc "pwd"')).toBe('pwd');
  });

  it('leaves an already-clean command untouched', () => {
    expect(cleanShellCommand('git status')).toBe('git status');
  });
});

describe('friendlyToolUse (claude)', () => {
  it('builds verb + short path, with a diffstat for Edit', () => {
    expect(friendlyToolUse('Read', { file_path: 'src/bot/commands.ts' })).toBe(
      'Read bot/commands.ts',
    );
    expect(
      friendlyToolUse('Edit', {
        file_path: 'src/bot/format.ts',
        old_string: 'a\nb',
        new_string: 'a\nb\nc\nd',
      }),
    ).toBe('Edited bot/format.ts +4 -2');
  });

  it('uses the Bash description, and returns undefined without one', () => {
    expect(friendlyToolUse('Bash', { command: 'ls', description: 'List files' })).toBe('List files');
    expect(friendlyToolUse('Bash', { command: 'ls' })).toBeUndefined();
  });

  it('maps search / web / task / todo tools', () => {
    expect(friendlyToolUse('Grep', { pattern: 'TODO' })).toBe('Searched TODO');
    expect(friendlyToolUse('WebFetch', { url: 'https://x.dev' })).toBe('Fetched https://x.dev');
    expect(friendlyToolUse('WebSearch', { query: 'grammy 429' })).toBe('Searched web: grammy 429');
    expect(friendlyToolUse('TodoWrite', {})).toBe('Updated tasks');
  });
});

describe('mapClaudeEvents (recorded fixtures)', () => {
  it('maps a full first run: init, tool use/result, text, result', async () => {
    const events = await collect(mapClaudeEvents(fixtureSource('claude-run1.jsonl')));

    const init = byKind(events, 'init')[0] as Extract<AgentEvent, { kind: 'init' }>;
    expect(init.engineSessionId).toMatch(/^[0-9a-f-]{36}$/);

    const tools = byKind(events, 'tool-use') as Extract<AgentEvent, { kind: 'tool-use' }>[];
    const bash = tools.find((t) => t.name === 'Bash');
    expect(bash?.summary).toContain('echo fixture-hello');
    // the Bash `description` field becomes the friendly title
    expect(bash?.friendly).toBe('Echo fixture-hello');

    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('DONE');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.usage?.contextWindowTokens).toBe(1_000_000);
    expect(events.every((e) => e.kind !== 'error')).toBe(true);

    // usage ticks: cumulative, one per API call, monotonically growing
    const ticks = byKind(events, 'usage-tick') as Extract<AgentEvent, { kind: 'usage-tick' }>[];
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    const last = ticks.at(-1)!.cumulative;
    expect(last.steps).toBe(ticks.length);
    expect(last.outputTokens).toBeGreaterThan(0);
    expect(last.cacheReadTokens + last.freshInputTokens + last.cacheCreationTokens).toBeGreaterThan(0);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.cumulative.outputTokens).toBeGreaterThanOrEqual(
        ticks[i - 1]!.cumulative.outputTokens,
      );
    }
  });

  it('maps a resumed run and keeps the conversation result', async () => {
    const events = await collect(mapClaudeEvents(fixtureSource('claude-run2-resume.jsonl')));
    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('fixture-hello');
  });

  it('emits an error event when the stream ends without a result', async () => {
    async function* empty() {
      // nothing
    }
    const events = await collect(
      mapClaudeEvents({
        lines: empty(),
        exited: Promise.resolve({ code: 1, signal: null, stderrTail: 'boom' }),
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('error');
    expect((events[0] as Extract<AgentEvent, { kind: 'error' }>).message).toContain('boom');
  });
});

describe('mapCodexEvents (recorded fixtures)', () => {
  it('maps a full first run: thread id, shell command, result', async () => {
    const events = await collect(mapCodexEvents(fixtureSource('codex-run1.jsonl')));

    const init = byKind(events, 'init')[0] as Extract<AgentEvent, { kind: 'init' }>;
    expect(init.engineSessionId).toMatch(/^[0-9a-f-]+$/);

    const tools = byKind(events, 'tool-use') as Extract<AgentEvent, { kind: 'tool-use' }>[];
    const shell = tools.find((t) => t.name === 'Shell');
    // the `/bin/zsh -lc '…'` wrapper and quotes are stripped; commands carry
    // no friendly title — compact mode hides them (reasoning narrates instead)
    expect(shell?.summary).toBe('echo fixture-hello');
    expect(shell?.friendly).toBeUndefined();

    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('DONE');
    expect(result.usage?.outputTokens).toBeGreaterThan(0);

    // codex has no interim usage — steps tick per item.started, tokens land at the end
    const ticks = byKind(events, 'usage-tick') as Extract<AgentEvent, { kind: 'usage-tick' }>[];
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    const last = ticks.at(-1)!.cumulative;
    expect(last.outputTokens).toBeGreaterThan(0);
    expect(last.freshInputTokens + last.cacheReadTokens).toBeGreaterThan(0);
  });

  it('maps a resumed run', async () => {
    const events = await collect(mapCodexEvents(fixtureSource('codex-run2-resume.jsonl')));
    const result = byKind(events, 'result')[0] as Extract<AgentEvent, { kind: 'result' }>;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('fixture-hello');
  });

  it('maps reasoning items to reasoning narration events', async () => {
    async function* lines() {
      yield { raw: '', json: { type: 'thread.started', thread_id: 'abc' } };
      yield {
        raw: '',
        json: {
          type: 'item.completed',
          item: { id: 'i1', type: 'reasoning', text: '**Exploring the codebase**' },
        },
      };
      yield { raw: '', json: { type: 'turn.completed', usage: {} } };
    }
    const events = await collect(
      mapCodexEvents({
        lines: lines(),
        exited: Promise.resolve({ code: 0, signal: null, stderrTail: '' }),
      }),
    );
    const reasoning = byKind(events, 'reasoning')[0] as Extract<AgentEvent, { kind: 'reasoning' }>;
    expect(reasoning.text).toBe('**Exploring the codebase**');
  });

  it('emits an error event when the stream dies before turn.completed', async () => {
    async function* lines() {
      yield { raw: '', json: { type: 'thread.started', thread_id: 'abc' } };
    }
    const events = await collect(
      mapCodexEvents({
        lines: lines(),
        exited: Promise.resolve({ code: null, signal: 'SIGKILL' as const, stderrTail: '' }),
      }),
    );
    expect(events.at(-1)!.kind).toBe('error');
  });
});
