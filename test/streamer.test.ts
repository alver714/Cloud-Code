import { GrammyError, type Api } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopicStreamer } from '../src/bot/streamer.js';
import type { AgentEvent } from '../src/engines/types.js';

interface Sent {
  chatId: number;
  text: string;
  extra?: Record<string, unknown>;
}

function makeApi() {
  let nextId = 1;
  const sent: Sent[] = [];
  const api = {
    sendMessage: vi.fn(async (chatId: number, text: string, extra?: Record<string, unknown>) => {
      sent.push({ chatId, text, extra });
      return { message_id: nextId++ };
    }),
  };
  return { api: api as unknown as Api, sent };
}

const toolUse = (name: string, summary: string, friendly?: string): AgentEvent => ({
  kind: 'tool-use',
  name,
  summary,
  friendly,
});

const silent = (m: Sent | undefined) => m?.extra?.disable_notification === true;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TopicStreamer (message stream)', () => {
  it('sends each item as its own silent message; final result notifies then a silent stats line', async () => {
    const { api, sent } = makeApi();
    const s = new TopicStreamer(api, -100, 42, 'fix the bug', false);

    await s.start();
    expect(sent).toHaveLength(0); // compact mode → no start marker

    s.onEvent({ kind: 'assistant-text', text: 'Working on it' });
    s.onEvent(toolUse('Bash', 'npm test', 'Ran the tests'));
    const endP = s.end({
      ok: true,
      cancelled: false,
      errorMessages: [],
      resultText: 'All done',
      costUsd: 0.42,
      durationMs: 65_000,
      usage: { inputTokens: 100_000, outputTokens: 32_000 },
    });
    await vi.runAllTimersAsync();
    await endP;

    // order: intermediate text, activity line, final result, stats
    expect(sent.map((m) => m.text)).toEqual([
      'Working on it',
      '▸ <b>Bash</b> Ran the tests',
      'All done',
      '✅ 1m 5s · 32.0k tok ответа',
    ]);

    // (a) intermediates are silent
    expect(silent(sent[0])).toBe(true);
    expect(silent(sent[1])).toBe(true);
    // (b) final ok first message notifies, stats stays silent
    expect(sent[2]!.extra?.disable_notification).toBeUndefined();
    expect(silent(sent[3])).toBe(true);
    // cost намеренно скрыт из статистики
    expect(sent.every((m) => !m.text.includes('$'))).toBe(true);
    // (e) every message within the Telegram limit
    for (const m of sent) expect(m.text.length).toBeLessThanOrEqual(4096);
  });

  it('renders friendly titles in compact mode and raw commands in verbose mode', async () => {
    // compact: friendly title, no raw-command <code> noise
    const compact = makeApi();
    const cs = new TopicStreamer(compact.api, -100, 1, 't', false);
    await cs.start();
    cs.onEvent(toolUse('Edit', 'src/bot/commands.ts', 'Edited bot/commands.ts +3 -1'));
    const cEnd = cs.end({ ok: true, cancelled: false, errorMessages: [], durationMs: 1000 });
    await vi.runAllTimersAsync();
    await cEnd;
    expect(compact.sent[0]!.text).toBe('▸ <b>Edit</b> Edited bot/commands.ts +3 -1');
    expect(compact.sent[0]!.text).not.toContain('<code>');

    // verbose: start marker + raw command in <code>
    const verbose = makeApi();
    const vs = new TopicStreamer(verbose.api, -100, 2, 'title', true);
    await vs.start();
    vs.onEvent(toolUse('Bash', 'npm run build', 'Built the project'));
    const vEnd = vs.end({ ok: true, cancelled: false, errorMessages: [], durationMs: 1000 });
    await vi.runAllTimersAsync();
    await vEnd;
    expect(verbose.sent[0]!.text).toContain('⏳'); // silent start marker
    expect(silent(verbose.sent[0])).toBe(true);
    const rawLine = verbose.sent.find((m) => m.text.includes('npm run build'));
    expect(rawLine!.text).toContain('<code>npm run build</code>');
  });

  it('coalesces a burst of activity lines into one message and respects the min gap', async () => {
    const { api, sent } = makeApi();
    const s = new TopicStreamer(api, -100, 7, 'burst', false);
    await s.start();

    for (let i = 0; i < 5; i++) s.onEvent(toolUse('Bash', `cmd ${i}`, `Ran cmd ${i}`));
    await vi.runAllTimersAsync();

    // all five coalesced into ONE silent message
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 5; i++) expect(sent[0]!.text).toContain(`Ran cmd ${i}`);
    expect(silent(sent[0])).toBe(true);

    // a later line must wait for the ~2.5s gap before it is sent
    s.onEvent(toolUse('Bash', 'later', 'Ran later'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain('Ran later');
  });

  it('does not send the final result text twice when it equals the last assistant-text', async () => {
    const { api, sent } = makeApi();
    const s = new TopicStreamer(api, -100, 5, 'dedupe', false);
    await s.start();

    s.onEvent({ kind: 'assistant-text', text: 'Final answer.' });
    const endP = s.end({
      ok: true,
      cancelled: false,
      errorMessages: [],
      resultText: 'Final answer.',
      durationMs: 1000,
    });
    await vi.runAllTimersAsync();
    await endP;

    const withText = sent.filter((m) => m.text.includes('Final answer.'));
    expect(withText).toHaveLength(1); // only the final one, not the intermediate
    expect(withText[0]!.extra?.disable_notification).toBeUndefined(); // it is the notifying final
  });

  it('keeps a distinct intermediate assistant-text and still sends the final result', async () => {
    const { api, sent } = makeApi();
    const s = new TopicStreamer(api, -100, 6, 'no-dedupe', false);
    await s.start();

    s.onEvent({ kind: 'assistant-text', text: 'Working…' });
    const endP = s.end({
      ok: true,
      cancelled: false,
      errorMessages: [],
      resultText: 'Different result',
      durationMs: 1000,
    });
    await vi.runAllTimersAsync();
    await endP;

    const working = sent.find((m) => m.text.includes('Working…'));
    const result = sent.find((m) => m.text.includes('Different result'));
    expect(silent(working)).toBe(true);
    expect(result!.extra?.disable_notification).toBeUndefined();
  });

  it('splits oversized coalesced batches and results so every message ≤ 4096', async () => {
    const { api, sent } = makeApi();
    const s = new TopicStreamer(api, -100, 3, 'big', false);
    await s.start();

    for (let i = 0; i < 200; i++) {
      s.onEvent(toolUse('Bash', `command ${i}`, `Ran a fairly long command number ${i} `.repeat(3)));
    }
    await vi.runAllTimersAsync();

    const endP = s.end({
      ok: true,
      cancelled: false,
      errorMessages: [],
      resultText: 'x'.repeat(20_000),
      durationMs: 1000,
    });
    await vi.runAllTimersAsync();
    await endP;

    expect(sent.length).toBeGreaterThan(1);
    for (const m of sent) expect(m.text.length).toBeLessThanOrEqual(4096);
  });

  it('reports a cancellation as a single notifying message and drops queued progress', async () => {
    const { api, sent } = makeApi();
    const s = new TopicStreamer(api, -100, 8, 'run', false);
    await s.start();

    // first activity goes out immediately; the rest stay queued behind the gap
    s.onEvent(toolUse('Bash', 'cmd 0', 'Ran cmd 0'));
    await vi.advanceTimersByTimeAsync(10);
    s.onEvent(toolUse('Bash', 'cmd 1', 'Ran cmd 1'));
    s.onEvent({ kind: 'assistant-text', text: 'trailing text that must not appear' });

    const endP = s.end({ ok: false, cancelled: true, errorMessages: [] });
    await vi.runAllTimersAsync();
    await endP;

    const last = sent.at(-1)!;
    expect(last.text).toContain('⏹');
    expect(last.text).not.toContain('❌');
    expect(last.extra?.disable_notification).toBeUndefined();
    expect(sent.some((m) => m.text.includes('Ran cmd 1'))).toBe(false);
    expect(sent.some((m) => m.text.includes('trailing text'))).toBe(false);
  });

  it('renders a Token Guard hard-stop as a distinct notifying ⛔ message', async () => {
    const { api, sent } = makeApi();
    const s = new TopicStreamer(api, -100, 10, 'run', false);
    await s.start();

    // trailing progress that must be dropped, like a cancel
    s.onEvent(toolUse('Bash', 'cmd', 'Running something'));
    const endP = s.end({
      ok: false,
      cancelled: true, // a guard stop also sets cancelled internally
      errorMessages: [],
      guardStopped: { workTokens: 300_000, limit: 250_000 },
    });
    await vi.runAllTimersAsync();
    await endP;

    const last = sent.at(-1)!;
    expect(last.text).toContain('⛔');
    expect(last.text).toContain('Token Guard');
    expect(last.text).toContain('/budget');
    expect(last.text).not.toContain('⏹'); // NOT the cancelled message
    expect(last.text).not.toContain('❌'); // NOT the error path
    expect(last.extra?.disable_notification).toBeUndefined(); // notification ON
    // trailing activity dropped like the cancelled path
    expect(sent.some((m) => m.text.includes('Running something'))).toBe(false);
  });

  it('sends a Token Guard soft-warning notice as a silent message', async () => {
    const { api, sent } = makeApi();
    const s = new TopicStreamer(api, -100, 11, 'run', false);
    await s.start();

    await s.notice('⚠️ Запуск уже потратил ~120.0k токенов работы (шагов: 5)');
    await vi.runAllTimersAsync();

    expect(sent[0]!.text).toContain('⚠️');
    expect(sent[0]!.text).toContain('токенов работы');
    expect(silent(sent[0])).toBe(true);
  });

  it('reports a failure with a notifying header and stderr detail', async () => {
    const { api, sent } = makeApi();
    const s = new TopicStreamer(api, -100, 9, 'run', false);
    await s.start();

    const endP = s.end({ ok: false, cancelled: false, errorMessages: ['engine died: exit 1'] });
    await vi.runAllTimersAsync();
    await endP;

    const fail = sent.find((m) => m.text.includes('❌'));
    expect(fail).toBeDefined();
    expect(fail!.extra?.disable_notification).toBeUndefined();
    expect(sent.some((m) => m.text.includes('engine died'))).toBe(true);
  });

  it('falls back to plain text when Telegram rejects the HTML entities', async () => {
    const { api, sent } = makeApi();
    const parseError = Object.create(GrammyError.prototype) as GrammyError & { description: string };
    parseError.description = "Bad Request: can't parse entities";

    let calls = 0;
    (api.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (chatId: number, text: string, extra?: Record<string, unknown>) => {
        calls++;
        if (calls === 1) throw parseError;
        sent.push({ chatId, text, extra });
        return { message_id: 99 };
      },
    );

    const s = new TopicStreamer(api, -100, 9, 'run', true); // verbose → start marker to send
    await s.start();
    await vi.runAllTimersAsync();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.extra?.parse_mode).toBeUndefined(); // retried without HTML parsing
    expect(sent[0]!.extra?.disable_notification).toBe(true); // still a silent marker
  });
});
