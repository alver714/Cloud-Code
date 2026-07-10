import { describe, expect, it } from 'vitest';
import {
  chunkHtmlBlocks,
  escapeHtml,
  formatEventLine,
  renderMarkdownish,
  truncate,
  truncateHtml,
} from '../src/bot/format.js';

describe('escapeHtml', () => {
  it('escapes the three HTML-relevant characters', () => {
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });
});

describe('renderMarkdownish', () => {
  it('turns fences into pre blocks and escapes contents', () => {
    const blocks = renderMarkdownish('Intro\n\n```ts\nconst a = 1 < 2;\n```\n\nOutro `x&y`');
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe('<pre><code>const a = 1 &lt; 2;</code></pre>');
    expect(blocks[2]).toContain('<code>x&amp;y</code>');
  });

  it('handles unclosed fences without throwing', () => {
    const blocks = renderMarkdownish('text\n```\ncode without closing');
    expect(blocks.length).toBeGreaterThan(0);
  });
});

describe('chunkHtmlBlocks', () => {
  it('keeps small blocks in one chunk', () => {
    expect(chunkHtmlBlocks(['a', 'b'], 100)).toEqual(['a\n\nb']);
  });

  it('splits at the limit without breaking pre tags', () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i} with <angle>`).join('\n');
    const block = `<pre><code>${escapeHtml(code)}</code></pre>`;
    const chunks = chunkHtmlBlocks([block], 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
      expect(c.startsWith('<pre><code>')).toBe(true);
      expect(c.endsWith('</code></pre>')).toBe(true);
      // no split inside an entity
      expect(c).not.toMatch(/&[a-z]{0,3}$/);
    }
    // content round-trip (modulo the newlines eaten at cut points)
    const joined = chunks
      .map((c) => c.slice('<pre><code>'.length, -'</code></pre>'.length))
      .join('\n');
    expect(joined.replace(/\n/g, '')).toBe(escapeHtml(code).replace(/\n/g, ''));
  });

  it('splits an oversized plain paragraph', () => {
    const chunks = chunkHtmlBlocks(['word '.repeat(2000)], 3900);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3900);
  });
});

describe('truncateHtml', () => {
  const escaped = '&amp;&lt;&gt;'.repeat(500);

  it('stays within max and never ends mid-entity', () => {
    // budgets ≥ one 5-char entity (real call sites use 500–1500)
    for (const max of [8, 13, 25, 137, 999, 6001]) {
      const out = truncateHtml(escaped, max);
      expect(out.length).toBeLessThanOrEqual(max);
      const body = out.endsWith('…') ? out.slice(0, -1) : out;
      const amp = body.lastIndexOf('&');
      if (amp !== -1) {
        // a trailing '&' must be part of a complete entity (has its ';')
        expect(body.indexOf(';', amp)).toBeGreaterThan(amp);
      }
    }
  });

  it('returns the input unchanged when already within max', () => {
    expect(truncateHtml('&amp;', 10)).toBe('&amp;');
  });
});

describe('/diff-shaped escape-then-chunk pipeline', () => {
  it('keeps every outgoing message within the Telegram limit', () => {
    // 2600 raw '<' → 10400 chars once escaped: must be split, entity-safe
    const diff = '<'.repeat(2600);
    const blocks = [`<pre><code>${escapeHtml(truncate(diff, 12000))}</code></pre>`];
    const chunks = chunkHtmlBlocks(blocks);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(c.startsWith('<pre><code>')).toBe(true);
      expect(c.endsWith('</code></pre>')).toBe(true);
      // no entity split at a chunk boundary
      expect(c).not.toMatch(/&[a-z]{0,3}<\/code>/);
    }
  });
});

describe('formatEventLine', () => {
  it('compact mode: prefers the friendly title and adds no raw-command <code>', () => {
    const line = formatEventLine(
      { kind: 'tool-use', name: 'Bash', summary: 'npm test', friendly: 'Ran the tests' },
      false,
    );
    expect(line).toBe('▸ <b>Bash</b> Ran the tests');
    expect(line).not.toContain('<code>');
  });

  it('compact mode: hides tool-use without a real human title (raw commands are noise)', () => {
    // no friendly at all
    expect(
      formatEventLine({ kind: 'tool-use', name: 'Bash', summary: 'npm test' }, false),
    ).toBeUndefined();
    // codex-style: friendly equals the raw command — still noise
    expect(
      formatEventLine(
        { kind: 'tool-use', name: 'Shell', summary: 'git status', friendly: 'git status' },
        false,
      ),
    ).toBeUndefined();
  });

  it('renders reasoning narration in italics in both modes', () => {
    for (const verbose of [false, true]) {
      const line = formatEventLine(
        { kind: 'reasoning', text: '**Investigating repo structure**' },
        verbose,
      );
      expect(line).toBe('<i>Investigating repo structure</i>');
    }
    expect(formatEventLine({ kind: 'reasoning', text: '   ' }, false)).toBeUndefined();
  });

  it('verbose mode: shows the raw summary in <code>, ignoring the friendly title', () => {
    const line = formatEventLine(
      { kind: 'tool-use', name: 'Bash', summary: 'npm test', friendly: 'Ran the tests' },
      true,
    );
    expect(line).toBe('▸ <b>Bash</b> <code>npm test</code>');
    expect(line).not.toContain('Ran the tests');
  });

  it('defaults to compact mode when no flag is passed', () => {
    expect(
      formatEventLine({ kind: 'tool-use', name: 'Grep', summary: 'foo', friendly: 'Searched foo' }),
    ).toBe('▸ <b>Grep</b> Searched foo');
  });

  it('hides successful tool results and shows failed ones in both modes', () => {
    for (const verbose of [false, true]) {
      expect(
        formatEventLine({ kind: 'tool-result', name: 'tool', ok: true, summary: 'fine' }, verbose),
      ).toBeUndefined();
      expect(
        formatEventLine({ kind: 'tool-result', name: 'tool', ok: false, summary: 'exit 1' }, verbose),
      ).toContain('✗');
    }
  });

  it('always shows assistant-text and error events', () => {
    for (const verbose of [false, true]) {
      expect(
        formatEventLine({ kind: 'assistant-text', text: 'thinking' }, verbose),
      ).toContain('thinking');
      expect(formatEventLine({ kind: 'error', message: 'boom' }, verbose)).toContain('boom');
    }
  });

  it('skips init and result events', () => {
    expect(formatEventLine({ kind: 'init', engineSessionId: 'x' })).toBeUndefined();
    expect(formatEventLine({ kind: 'result', ok: true, text: 'done' })).toBeUndefined();
  });
});
