import type { AgentEvent, Usage } from '../engines/types.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatUsage(usage: Usage | undefined): string | undefined {
  if (!usage) return undefined;
  // Show only generated tokens: input is inflated by re-reading the context
  // cache on every agent step and looks implausible.
  const out = usage.outputTokens ?? 0;
  if (out > 0) return `${formatTok(out)} output tok`;
  const total = (usage.inputTokens ?? 0) + out;
  return total > 0 ? `${formatTok(total)} tok` : undefined;
}

export function formatTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * One progress line for a run. Returns undefined for events that should not
 * appear (init, result, successful tool ends).
 *
 * compact (verbose=false): tool-use is shown ONLY when it has a real human
 *   title (friendly, differing from the raw summary) — raw commands are noise
 *   and stay hidden; codex narration comes from reasoning events instead.
 * verbose (verbose=true): the detailed style — raw command/pattern in <code>.
 * Both modes show assistant-text, reasoning and error, and both hide
 * successful tool-results while showing failed ones with ✗.
 */
export function formatEventLine(ev: AgentEvent, verbose = false): string | undefined {
  switch (ev.kind) {
    case 'tool-use': {
      if (verbose) {
        return `▸ <b>${escapeHtml(ev.name)}</b> <code>${escapeHtml(truncate(ev.summary, 160))}</code>`;
      }
      if (!ev.friendly || ev.friendly === ev.summary) return undefined;
      return `▸ <b>${escapeHtml(ev.name)}</b> ${escapeHtml(truncate(ev.friendly, 160))}`;
    }
    case 'reasoning': {
      const text = ev.text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      return text ? `<i>${escapeHtml(truncate(text, 300))}</i>` : undefined;
    }
    case 'tool-result':
      return ev.ok ? undefined : `  ✗ <code>${escapeHtml(truncate(ev.summary, 160))}</code>`;
    case 'assistant-text': {
      const text = ev.text.trim();
      return text ? escapeHtml(truncate(text, 700)) : undefined;
    }
    case 'error':
      return `⚠️ <code>${escapeHtml(truncate(ev.message, 300))}</code>`;
    default:
      return undefined;
  }
}

/**
 * Very small markdown-ish renderer for final agent replies:
 * ``` fences → <pre><code>, `inline` → <code>, **bold** → <b>.
 * Returns self-contained HTML blocks.
 */
export function renderMarkdownish(text: string): string[] {
  const blocks: string[] = [];
  const parts = text.split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      let code = part;
      const nl = part.indexOf('\n');
      if (nl !== -1 && /^[\w+.#-]*$/.test(part.slice(0, nl).trim())) {
        code = part.slice(nl + 1);
      }
      const trimmed = code.replace(/\n+$/, '');
      if (trimmed) blocks.push(`<pre><code>${escapeHtml(trimmed)}</code></pre>`);
    } else {
      for (const para of part.split(/\n{2,}/)) {
        const p = para.trim();
        if (p) blocks.push(inlineHtml(p));
      }
    }
  });
  return blocks;
}

function inlineHtml(p: string): string {
  let s = escapeHtml(p);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  return s;
}

/**
 * Truncates an ALREADY-ESCAPED html string. Never cuts inside an entity —
 * raw-truncate-then-escape is the wrong order (escaping can expand 5×
 * past the Telegram 4096 limit); escape first, then cap with this.
 */
export function truncateHtml(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  const cut = safeCut(escaped, Math.max(1, max - 1));
  return escaped.slice(0, cut) + '…';
}

const PRE_OPEN = '<pre><code>';
const PRE_CLOSE = '</code></pre>';

/** Pack HTML blocks into Telegram-sized messages. */
export function chunkHtmlBlocks(blocks: string[], limit = 3900): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };
  for (const block of blocks) {
    if (block.length > limit) {
      flush();
      chunks.push(...splitOversizedBlock(block, limit));
      continue;
    }
    if (current && current.length + block.length + 2 > limit) flush();
    current = current ? `${current}\n\n${block}` : block;
  }
  flush();
  return chunks;
}

function splitOversizedBlock(block: string, limit: number): string[] {
  if (block.startsWith(PRE_OPEN) && block.endsWith(PRE_CLOSE)) {
    const inner = block.slice(PRE_OPEN.length, -PRE_CLOSE.length);
    const budget = limit - PRE_OPEN.length - PRE_CLOSE.length;
    const out: string[] = [];
    let rest = inner;
    while (rest.length > 0) {
      const cut = safeCut(rest, budget);
      out.push(PRE_OPEN + rest.slice(0, cut) + PRE_CLOSE);
      rest = rest.slice(cut).replace(/^\n/, '');
    }
    return out;
  }
  // Oversized paragraph: drop inline tags (safe to split anywhere), plain text.
  const plain = block.replace(/<[^>]+>/g, '');
  const out: string[] = [];
  let rest = plain;
  while (rest.length > 0) {
    const cut = safeCut(rest, limit);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return out;
}

/** Pick a cut point ≤ budget that doesn't split an HTML entity, preferring line/word boundaries. */
function safeCut(s: string, budget: number): number {
  if (s.length <= budget) return s.length;
  let cut = budget;
  const nl = s.lastIndexOf('\n', cut);
  if (nl > budget / 2) {
    cut = nl;
  } else {
    const sp = s.lastIndexOf(' ', cut);
    if (sp > budget / 2) cut = sp;
  }
  // Never split inside an escaped entity like &amp; / &lt; / &gt;
  const amp = s.lastIndexOf('&', cut - 1);
  if (amp !== -1 && amp > cut - 7) {
    const semi = s.indexOf(';', amp);
    if (semi === -1 || semi >= cut) cut = amp;
  }
  return Math.max(1, cut);
}
