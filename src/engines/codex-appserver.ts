import type { AgentEvent, Engine, EngineRun, EngineRunOptions } from './types.js';
import { cleanShellCommand } from './codex.js';
import { AppServerClient, type AppServerNotification } from './appserver.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Codex engine over the long-lived `codex app-server` JSON-RPC transport.
 * Alongside CodexEngine (which shells out to `codex exec` per run), this shares
 * ONE AppServerClient across every run. The payoff is live per-turn token usage
 * (`thread/tokenUsage/updated` → usage-tick → real Token Guard for codex) and a
 * native `turn/interrupt` that stops a turn without killing the shared server.
 *
 * Notification method names are from codex-rs app-server-protocol v2:
 *   thread/started, turn/started, item/started, item/completed,
 *   thread/tokenUsage/updated, turn/completed, error.
 * Turns are sent with `turn/start`; threads resumed with `thread/resume`.
 */
export class CodexAppServerEngine implements Engine {
  readonly kind = 'codex' as const;
  private readonly client: AppServerClient;

  constructor(client: AppServerClient) {
    this.client = client;
  }

  run(opts: EngineRunOptions): EngineRun {
    const client = this.client;
    const channel = makeNotifChannel();
    let threadId: string | undefined;
    let currentTurnId: string | undefined;
    let cancelled = false;
    let unsubscribe = () => {};

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      // interrupt only the turn — the shared app-server keeps running
      if (threadId && currentTurnId) void client.interrupt(threadId, currentTurnId);
      // guarantee the run ends even if there is no active turn to interrupt
      channel.push({ method: '$cancelled' });
    };

    async function* events(): AsyncGenerator<AgentEvent, void, void> {
      try {
        await client.ensureReady();
        const started = opts.resumeSessionId
          ? await client.resumeThread(opts.resumeSessionId, {
              cwd: opts.workdir,
              model: opts.model,
              effort: opts.effort,
            })
          : await client.startThread({
              cwd: opts.workdir,
              model: opts.model,
              effort: opts.effort,
            });
        threadId = started.threadId;
        unsubscribe = client.onNotification(threadId, (n) => channel.push(n));

        if (cancelled) {
          channel.push({ method: '$cancelled' });
        } else {
          currentTurnId = await client.sendTurn(threadId, opts.prompt);
          if (cancelled) void client.interrupt(threadId, currentTurnId);
        }

        yield* mapAppServerEvents(channel.iterable, {
          threadId,
          workdir: opts.workdir,
          onTurnId: (id) => {
            currentTurnId = id;
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Any transport failure surfaces as a clean error+result so the run
        // never hangs — the user can flip CODEX_TRANSPORT=exec and retry.
        yield { kind: 'error', message: `codex app-server: ${message}` };
        yield { kind: 'result', ok: false, text: message };
      } finally {
        unsubscribe();
        // Wake and finish the channel iterator so no suspended consumer leaks.
        channel.close();
      }
    }

    return { events: events(), cancel, pid: client.pid };
  }
}

export interface MapContext {
  threadId: string;
  workdir?: string;
  /** Called when the turn id becomes known (turn/started). */
  onTurnId?: (turnId: string) => void;
  /** Idle watchdog: no notification for this long → synthesize a terminal
   * error+result (default TURN_IDLE_TIMEOUT_MS). Test hook. */
  idleTimeoutMs?: number;
}

/** A stream with no turn/completed and no $disconnect for this long is stuck —
 * synthesize a terminal error+result so the run can't hang forever. */
const TURN_IDLE_TIMEOUT_MS = 5 * 60_000;

interface TokenBaseline {
  input: number;
  cached: number;
  output: number;
}

/**
 * Pure notification → AgentEvent mapper. Consumes an async stream of
 * `{method, params}` notifications for ONE thread/turn and yields normalized
 * events, returning after the terminal (turn/completed, fatal error, or the
 * synthetic $disconnect / $cancelled).
 *
 * Token math: `thread/tokenUsage/updated.tokenUsage.total` is CUMULATIVE across
 * the whole thread, so on a resumed thread it already includes prior turns. To
 * report per-run spend for the Token Guard we baseline off the first update
 * (baseline = total − last = cumulative before this run's first model call) and
 * emit `total − baseline`. For a fresh thread the baseline is ~0, i.e. exactly
 * fresh = inputTokens − cachedInputTokens, cacheRead = cachedInputTokens,
 * output = outputTokens. `steps` increments once per token update.
 * result.usage reports the LAST model call's tokens (current context size),
 * not the cumulative total.
 */
export async function* mapAppServerEvents(
  notifs: AsyncIterable<AppServerNotification>,
  ctx: MapContext,
): AsyncGenerator<AgentEvent, void, void> {
  yield { kind: 'init', engineSessionId: ctx.threadId };

  let lastAgentMessage = '';
  let baseline: TokenBaseline | undefined;
  let lastUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  let contextWindow: number | undefined;
  const cum = {
    freshInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    steps: 0,
  };

  const idleMs = ctx.idleTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;
  const it = notifs[Symbol.asyncIterator]();
  try {
  for (;;) {
    // Watchdog: race each next() against an idle timer — a silently dead
    // stream (no turn/completed, no $disconnect) must still terminate the run.
    let idleTimer: NodeJS.Timeout | undefined;
    const step = await Promise.race([
      it.next(),
      new Promise<'idle'>((resolve) => {
        idleTimer = setTimeout(() => resolve('idle'), idleMs);
        idleTimer.unref?.();
      }),
    ]);
    if (idleTimer) clearTimeout(idleTimer);
    if (step === 'idle') {
      const msg = `codex app-server: no events for ${Math.round(idleMs / 60_000)} min — the run is stuck, stopping`;
      yield { kind: 'error', message: msg };
      yield { kind: 'result', ok: false, text: lastAgentMessage || msg };
      return;
    }
    if (step.done) return;
    const notif = step.value;
    const params = notif.params ?? {};
    switch (notif.method) {
      case 'turn/started': {
        const id = params?.turn?.id;
        if (typeof id === 'string') ctx.onTurnId?.(id);
        break;
      }

      case 'thread/tokenUsage/updated': {
        const tu = params?.tokenUsage;
        const total = tu?.total;
        const last = tu?.last;
        if (total && typeof total === 'object') {
          const tInput = n(total.inputTokens);
          const tCached = n(total.cachedInputTokens);
          const tOutput = n(total.outputTokens);
          if (baseline === undefined) {
            baseline = {
              input: Math.max(0, tInput - n(last?.inputTokens)),
              cached: Math.max(0, tCached - n(last?.cachedInputTokens)),
              output: Math.max(0, tOutput - n(last?.outputTokens)),
            };
          }
          const runInput = Math.max(0, tInput - baseline.input);
          const runCached = Math.max(0, tCached - baseline.cached);
          const runOutput = Math.max(0, tOutput - baseline.output);
          cum.freshInputTokens = Math.max(0, runInput - runCached);
          cum.cacheReadTokens = runCached;
          cum.outputTokens = runOutput;
          cum.steps += 1;
          yield { kind: 'usage-tick', cumulative: { ...cum } };
        } else if (last && typeof last === 'object') {
          // Last-only update (no cumulative total): accumulate the per-call
          // numbers so the Token Guard still sees steps/spend progressing.
          const lCached = n(last.cachedInputTokens);
          cum.freshInputTokens += Math.max(0, n(last.inputTokens) - lCached);
          cum.cacheReadTokens += lCached;
          cum.outputTokens += n(last.outputTokens);
          cum.steps += 1;
          yield { kind: 'usage-tick', cumulative: { ...cum } };
        }
        if (last && typeof last === 'object') {
          lastUsage = {
            inputTokens: numOpt(last.inputTokens),
            outputTokens: numOpt(last.outputTokens),
          };
        }
        const cw = numOpt(tu?.modelContextWindow);
        if (cw !== undefined && cw > 0) contextWindow = cw;
        break;
      }

      case 'item/started': {
        const item = params?.item;
        switch (item?.type) {
          case 'commandExecution':
            yield {
              kind: 'tool-use',
              name: 'Shell',
              summary: clip(cleanShellCommand(String(item.command ?? ''))),
            };
            break;
          case 'webSearch':
            yield { kind: 'tool-use', name: 'WebSearch', summary: clip(String(item.query ?? '')) };
            break;
          case 'mcpToolCall':
            yield {
              kind: 'tool-use',
              name: 'MCP',
              summary: clip(`${String(item.server ?? '')}.${String(item.tool ?? '')}`),
            };
            break;
          default:
            break;
        }
        break;
      }

      case 'item/completed': {
        const item = params?.item;
        switch (item?.type) {
          case 'agentMessage':
            // Emit once on completion — item/agentMessage/delta streaming is
            // ignored to avoid partial-text spam (matches the exec mapper).
            if (typeof item.text === 'string' && item.text.trim()) {
              lastAgentMessage = item.text;
              yield { kind: 'assistant-text', text: item.text };
            }
            break;
          case 'reasoning': {
            const text = joinReasoning(item);
            if (text) yield { kind: 'reasoning', text };
            break;
          }
          case 'commandExecution': {
            const ok = item.exitCode === 0 || item.exitCode === undefined || item.exitCode === null;
            yield {
              kind: 'tool-result',
              name: 'Shell',
              ok,
              summary: ok
                ? ''
                : `exit ${String(item.exitCode)}: ${clip(String(item.aggregatedOutput ?? ''))}`,
            };
            break;
          }
          case 'fileChange': {
            const paths = Array.isArray(item.changes)
              ? item.changes
                  .map((c: any) => relPath(String(c?.path ?? ''), ctx.workdir))
                  .filter(Boolean)
                  .join(', ')
              : '';
            yield {
              kind: 'tool-use',
              name: 'Edit',
              summary: clip(paths),
              friendly: paths ? `Edited ${clip(paths, 100)}` : undefined,
            };
            break;
          }
          case 'mcpToolCall':
            yield {
              kind: 'tool-result',
              name: 'MCP',
              ok: item.error == null,
              summary: '',
            };
            break;
          default:
            break;
        }
        break;
      }

      case 'turn/completed': {
        const status = params?.turn?.status;
        const turnErr = params?.turn?.error;
        if (status === 'failed') {
          const msg = clip(String(turnErr?.message ?? 'turn failed'));
          yield { kind: 'error', message: msg };
          yield { kind: 'result', ok: false, text: msg };
        } else if (status === 'interrupted') {
          yield { kind: 'result', ok: false, text: lastAgentMessage || 'interrupted' };
        } else {
          yield {
            kind: 'result',
            ok: true,
            text: lastAgentMessage,
            usage: {
              inputTokens: lastUsage?.inputTokens,
              outputTokens: lastUsage?.outputTokens,
              contextWindowTokens: contextWindow,
            },
          };
        }
        return;
      }

      case 'error': {
        // ErrorNotification: { error, willRetry, threadId, turnId }. A retrying
        // error is non-terminal; a non-retrying one ends the run.
        const willRetry = params?.willRetry === true;
        const msg = clip(String(params?.error?.message ?? 'codex error'));
        yield { kind: 'error', message: msg };
        if (!willRetry) {
          yield { kind: 'result', ok: false, text: msg };
          return;
        }
        break;
      }

      case '$disconnect': {
        const msg = String(params?.message ?? 'app-server disconnected');
        yield { kind: 'error', message: `codex app-server: ${msg}` };
        yield { kind: 'result', ok: false, text: msg };
        return;
      }

      case '$cancelled':
        yield { kind: 'result', ok: false, text: lastAgentMessage || 'interrupted' };
        return;

      default:
        break; // thread/started, item/agentMessage/delta, plan updates — ignored
    }
  }
  } finally {
    // Belt-and-braces: release the source iterator (the notif channel) even
    // when this generator is torn down early by its consumer.
    try {
      void it.return?.();
    } catch {
      /* ignore */
    }
  }
}

interface NotifChannel {
  push(n: AppServerNotification): void;
  /** Ends the stream: pending and future next() resolve done, waiters wake. */
  close(): void;
  iterable: AsyncGenerator<AppServerNotification, void, void>;
}

/**
 * Unbounded async queue bridging the client's callback to a for-await stream.
 * Implemented as a hand-rolled iterator (not an async generator) so return()
 * settles IMMEDIATELY even while a next() is suspended on the wake promise —
 * an async generator parked on `await` would queue the return behind a promise
 * that is never resolved after unsubscribe, leaking one suspended generator
 * per run.
 */
function makeNotifChannel(): NotifChannel {
  const queue: AppServerNotification[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const wakeUp = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const iterator: AsyncGenerator<AppServerNotification, void, void> = {
    async next(): Promise<IteratorResult<AppServerNotification, void>> {
      for (;;) {
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        if (closed) return { value: undefined, done: true };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    async return(): Promise<IteratorResult<AppServerNotification, void>> {
      closed = true;
      queue.length = 0;
      wakeUp();
      return { value: undefined, done: true };
    },
    async throw(err?: unknown): Promise<IteratorResult<AppServerNotification, void>> {
      closed = true;
      queue.length = 0;
      wakeUp();
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<AppServerNotification, void, void>;
  return {
    push(n) {
      if (closed) return;
      queue.push(n);
      wakeUp();
    },
    close() {
      closed = true;
      wakeUp();
    },
    iterable: iterator,
  };
}

function joinReasoning(item: any): string {
  const pick = (arr: unknown): string =>
    Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).join('\n') : '';
  return (pick(item?.summary) || pick(item?.content)).trim();
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function numOpt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Makes an absolute workspace path readable: strips the workdir prefix. */
function relPath(p: string, workdir?: string): string {
  if (workdir && p.startsWith(workdir)) {
    const rest = p.slice(workdir.length).replace(/^\/+/, '');
    if (rest) return rest;
  }
  return p;
}

function clip(s: string, max = 140): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}
