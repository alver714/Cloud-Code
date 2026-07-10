import { GrammyError, type Api } from 'grammy';
import type { AgentEvent } from '../engines/types.js';
import type { RunReporter, RunSummary } from '../sessions/manager.js';
import {
  chunkHtmlBlocks,
  escapeHtml,
  formatElapsed,
  formatEventLine,
  formatTok,
  formatUsage,
  renderMarkdownish,
  truncate,
} from './format.js';

/** Minimum gap between two sends (Telegram allows ~20 msg/min per group). */
const MIN_GAP_MS = 2500;
/** A coalesced activity batch larger than this is split into several messages. */
const COALESCE_LIMIT = 3800;
/** Show the replayed-context size in stats from this many input tokens. */
const CTX_SHOW_THRESHOLD = 120_000;
/** Suggest /reset from this many input tokens. */
const CTX_RESET_HINT_THRESHOLD = 250_000;

interface Payload {
  text: string;
  silent: boolean;
}

type QueueItem =
  | { kind: 'activity'; lines: string[] }
  | { kind: 'message'; payloads: Payload[] };

/**
 * Streams one engine run into one forum topic as a sequence of separate
 * messages (no live-edited message, no elapsed ticker):
 *   - each assistant-text is its own silent message;
 *   - each activity line (tool-use per mode, failed tool-result, error) is a
 *     silent message; bursts coalesce into one message while a per-streamer
 *     send queue enforces a minimum gap between sends;
 *   - end() flushes the queue and sends the final result / stats / error with
 *     a notification.
 *
 * The most recent assistant-text is buffered so that, if it equals the final
 * result text, it is not sent twice.
 */
export class TopicStreamer implements RunReporter {
  private readonly queue: QueueItem[] = [];
  private pendingText?: string;
  private hasSent = false;
  private lastSendAt = 0;
  private processing = false;
  private readonly drainWaiters: Array<() => void> = [];
  private readonly startedAt = Date.now();

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly topicId: number | undefined,
    private readonly title: string,
    private readonly verbose: boolean,
  ) {}

  async start(): Promise<void> {
    if (this.verbose) {
      this.enqueue({
        kind: 'message',
        payloads: [{ text: `⏳ ${escapeHtml(this.title)}`, silent: true }],
      });
    }
  }

  onEvent(ev: AgentEvent): void {
    if (ev.kind === 'assistant-text') {
      if (!ev.text.trim()) return;
      // A new assistant-text arrived — flush the previously buffered one, then
      // hold this one (only the very last is a dedupe candidate for end()).
      if (this.pendingText !== undefined) this.enqueueText(this.pendingText);
      this.pendingText = ev.text;
      return;
    }

    const line = formatEventLine(ev, this.verbose);
    // init/result/successful tool-results render nothing — keep the buffered
    // assistant-text intact so end() can dedupe it against the result text.
    if (line === undefined) return;

    if (this.pendingText !== undefined) {
      this.enqueueText(this.pendingText);
      this.pendingText = undefined;
    }
    this.enqueueActivity(line);
  }

  /** Silent side-channel notice (Token Guard soft warning) — a queued message. */
  async notice(text: string): Promise<void> {
    this.enqueue({ kind: 'message', payloads: [{ text, silent: true }] });
  }

  async end(summary: RunSummary): Promise<void> {
    if (summary.cancelled || summary.guardStopped) {
      // /stop or a Token Guard hard-stop: drop everything still queued —
      // trailing progress after the stop only confuses; the final message says
      // it all.
      this.queue.length = 0;
      this.pendingText = undefined;
    }
    // Resolve the buffered assistant-text: skip it when it duplicates the final
    // result text, otherwise send it as its own intermediate message.
    if (this.pendingText !== undefined) {
      const dupe =
        summary.ok &&
        summary.resultText !== undefined &&
        this.pendingText.trim() === summary.resultText.trim();
      if (!dupe) this.enqueueText(this.pendingText);
      this.pendingText = undefined;
    }

    this.enqueue({ kind: 'message', payloads: this.finalPayloads(summary) });
    await this.drain();
  }

  // --- queue plumbing ---

  private enqueueActivity(line: string): void {
    const last = this.queue[this.queue.length - 1];
    if (last && last.kind === 'activity') {
      last.lines.push(line);
    } else {
      this.queue.push({ kind: 'activity', lines: [line] });
    }
    void this.processQueue();
  }

  private enqueueText(text: string): void {
    const payloads = chunkHtmlBlocks(renderMarkdownish(text)).map((c) => ({
      text: c,
      silent: true,
    }));
    if (payloads.length === 0) return;
    this.enqueue({ kind: 'message', payloads });
  }

  private enqueue(item: QueueItem): void {
    this.queue.push(item);
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        // Wait BEFORE shifting so a still-queued activity item keeps coalescing
        // newly arriving lines during the gap.
        await this.waitGap();
        const item = this.queue.shift()!;
        const payloads = this.renderItem(item);
        for (let i = 0; i < payloads.length; i++) {
          if (i > 0) await this.waitGap();
          await this.sendPayload(payloads[i]!);
          this.hasSent = true;
          this.lastSendAt = Date.now();
        }
      }
    } finally {
      this.processing = false;
      if (this.queue.length === 0) {
        for (const w of this.drainWaiters.splice(0)) w();
      }
    }
  }

  private renderItem(item: QueueItem): Payload[] {
    if (item.kind === 'message') return item.payloads;
    const body = item.lines.join('\n');
    if (body.length <= COALESCE_LIMIT) return [{ text: body, silent: true }];
    return chunkHtmlBlocks(item.lines, COALESCE_LIMIT).map((text) => ({ text, silent: true }));
  }

  private async waitGap(): Promise<void> {
    if (!this.hasSent) return; // the very first send goes out immediately
    const wait = this.lastSendAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  private drain(): Promise<void> {
    if (this.queue.length === 0 && !this.processing) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  // --- final messages ---

  private finalPayloads(summary: RunSummary): Payload[] {
    // Token Guard hard-stop: a DISTINCT notifying message (checked before the
    // cancelled ⏹ path, since a guard stop also sets `cancelled`).
    if (summary.guardStopped) {
      const { workTokens: work, limit } = summary.guardStopped;
      const text =
        limit > 0
          ? `⛔ Остановлено Token Guard: потрачено ~${formatTok(work)} токенов работы (лимит ${formatTok(limit)}). ` +
            'Контекст сохранён — продолжить можно следующим промптом, поднять лимит: /budget'
          : `⛔ Остановлено Token Guard: ~${formatTok(work)} токенов работы, достигнут предел шагов. ` +
            'Контекст сохранён — продолжить можно следующим промптом.';
      return [{ text, silent: false }];
    }

    if (summary.cancelled) {
      return [
        {
          text: '⏹ Остановлено. Контекст разговора сохранён — можно отправить новый промпт.',
          silent: false,
        },
      ];
    }

    if (summary.ok) {
      const payloads: Payload[] = [];
      if (summary.resultText?.trim()) {
        for (const chunk of chunkHtmlBlocks(renderMarkdownish(summary.resultText))) {
          payloads.push({ text: chunk, silent: true });
        }
      }
      payloads.push({ text: this.statsLine(summary), silent: true });
      // Notify only on the first final message.
      if (payloads.length > 0) payloads[0]!.silent = false;
      return payloads;
    }

    const detail = [summary.resultText, ...summary.errorMessages].filter(Boolean).join('\n\n');
    const blocks = [
      '❌ Запуск завершился с ошибкой.',
      `<pre><code>${escapeHtml(truncate(detail || 'нет деталей', 3500))}</code></pre>`,
    ];
    return chunkHtmlBlocks(blocks).map((text, i) => ({ text, silent: i !== 0 }));
  }

  private statsLine(summary: RunSummary): string {
    // costUsd намеренно не показываем: при подписочной авторизации это
    // справочный API-эквивалент, который только пугает (остаётся в summary/логах)
    const parts = [formatElapsed(summary.durationMs ?? Date.now() - this.startedAt)];
    const usage = formatUsage(summary.usage);
    if (usage) parts.push(usage);
    // inputTokens = весь реплей контекста (вкл. кэш) — индикатор раздутой сессии
    const ctx = summary.usage?.inputTokens ?? 0;
    if (ctx >= CTX_SHOW_THRESHOLD) parts.push(`контекст ~${formatTok(ctx)}`);
    let line = `✅ ${parts.join(' · ')}`;
    if (ctx >= CTX_RESET_HINT_THRESHOLD) {
      line +=
        '\n💡 Контекст сессии сильно раздулся — /reset начнёт разговор заново (файлы останутся, историю перенесу).';
    }
    return line;
  }

  // --- sending ---

  private async sendPayload(p: Payload): Promise<void> {
    const extra: Record<string, unknown> = {
      message_thread_id: this.topicId,
      parse_mode: 'HTML',
    };
    if (p.silent) extra.disable_notification = true;
    try {
      await this.api.sendMessage(this.chatId, p.text, extra);
    } catch (err) {
      if (err instanceof GrammyError && err.description.includes("can't parse entities")) {
        const plain: Record<string, unknown> = { message_thread_id: this.topicId };
        if (p.silent) plain.disable_notification = true;
        try {
          await this.api.sendMessage(this.chatId, stripHtml(p.text), plain);
        } catch (err2) {
          console.error('[streamer] plain-text send failed:', err2);
        }
        return;
      }
      // Swallow other errors so the rest of the queue still drains.
      console.error('[streamer] send failed:', err);
    }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
