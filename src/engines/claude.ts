import type { AgentEvent, Engine, EngineRun, EngineRunOptions } from './types.js';
import { spawnJsonl, type JsonlSource } from './spawn.js';

/**
 * Claude Code CLI in headless print mode:
 *   claude -p --verbose --output-format stream-json --dangerously-skip-permissions
 * Prompt goes to stdin. NOTE: depending on the CLI version a resumed print-mode
 * run may issue a NEW session_id in its init event — the manager always stores
 * the latest one it sees.
 */
export interface ClaudeEngineOptions {
  /** Default CLI effort is xhigh — it inflates subagent fan-out dramatically. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Circuit breaker for runaway runs. */
  maxBudgetUsd?: number;
}

export class ClaudeEngine implements Engine {
  readonly kind = 'claude' as const;

  constructor(private readonly engineOpts: ClaudeEngineOptions = {}) {}

  run(opts: EngineRunOptions): EngineRun {
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      // keeps the cached system-prompt prefix stable across resumed runs
      '--exclude-dynamic-system-prompt-sections',
    ];
    if (this.engineOpts.effort) args.push('--effort', this.engineOpts.effort);
    if (this.engineOpts.maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(this.engineOpts.maxBudgetUsd));
    }
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);

    const proc = spawnJsonl({
      cmd: 'claude',
      args,
      cwd: opts.workdir,
      env: opts.env,
      stdinData: opts.prompt,
      rawLogPath: opts.rawLogPath,
    });

    return { events: mapClaudeEvents(proc), cancel: proc.kill, pid: proc.pid };
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function* mapClaudeEvents(src: JsonlSource): AsyncGenerator<AgentEvent, void, void> {
  let sawResult = false;
  let initModel: string | undefined;
  const cum = {
    freshInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    steps: 0,
  };
  // stream-json emits one assistant line per content block — usage repeats
  // for the same message id, so accumulate only once per API call
  let lastUsageMessageId: string | undefined;
  for await (const line of src.lines) {
    const ev = line.json as any;
    if (!ev || typeof ev !== 'object') continue;
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && typeof ev.session_id === 'string') {
          initModel = typeof ev.model === 'string' ? ev.model : undefined;
          yield {
            kind: 'init',
            engineSessionId: ev.session_id,
            model: typeof ev.model === 'string' ? ev.model : undefined,
          };
        }
        break;

      case 'assistant': {
        const usage = ev.message?.usage;
        const msgId = typeof ev.message?.id === 'string' ? ev.message.id : undefined;
        if (usage && typeof usage === 'object' && msgId !== lastUsageMessageId) {
          lastUsageMessageId = msgId;
          cum.freshInputTokens += numberOrUndefined(usage.input_tokens) ?? 0;
          cum.cacheCreationTokens += numberOrUndefined(usage.cache_creation_input_tokens) ?? 0;
          cum.cacheReadTokens += numberOrUndefined(usage.cache_read_input_tokens) ?? 0;
          cum.outputTokens += numberOrUndefined(usage.output_tokens) ?? 0;
          cum.steps += 1;
          yield { kind: 'usage-tick', cumulative: { ...cum } };
        }
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        for (const item of content) {
          if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
            yield { kind: 'assistant-text', text: item.text };
          } else if (item?.type === 'tool_use') {
            const name = typeof item.name === 'string' ? item.name : 'tool';
            yield {
              kind: 'tool-use',
              name,
              summary: summarizeToolUse(name, item.input),
              friendly: friendlyToolUse(name, item.input),
            };
          }
        }
        break;
      }

      case 'user': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        for (const item of content) {
          if (item?.type === 'tool_result') {
            yield {
              kind: 'tool-result',
              name: 'tool',
              ok: item.is_error !== true,
              summary: firstLine(extractText(item.content)),
            };
          }
        }
        break;
      }

      case 'result': {
        sawResult = true;
        const ok = ev.subtype === 'success' && ev.is_error !== true;
        const modelUsage = ev.modelUsage && typeof ev.modelUsage === 'object' ? ev.modelUsage : {};
        const modelEntry =
          (initModel && modelUsage[initModel]) ||
          Object.values(modelUsage)
            .filter((v: any) => v && typeof v === 'object' && typeof v.inputTokens === 'number')
            .sort((a: any, b: any) => (b.inputTokens ?? 0) - (a.inputTokens ?? 0))[0];
        yield {
          kind: 'result',
          ok,
          text:
            typeof ev.result === 'string'
              ? ev.result
              : ok
                ? ''
                : `Claude завершился с ошибкой (${String(ev.subtype ?? 'unknown')})`,
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
          durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : undefined,
          usage: ev.usage
            ? {
                // real input = fresh + cache writes + cache reads
                inputTokens:
                  (numberOrUndefined(ev.usage.input_tokens) ?? 0) +
                  (numberOrUndefined(ev.usage.cache_creation_input_tokens) ?? 0) +
                  (numberOrUndefined(ev.usage.cache_read_input_tokens) ?? 0),
                outputTokens: numberOrUndefined(ev.usage.output_tokens),
                contextWindowTokens: numberOrUndefined(modelEntry?.contextWindow),
              }
            : undefined,
        };
        break;
      }

      default:
        break; // stream_event partials and unknown types are ignored
    }
  }

  const exit = await src.exited;
  if (!sawResult) {
    const sig = exit.signal ? `, signal ${exit.signal}` : '';
    yield {
      kind: 'error',
      message:
        `claude завершился (code ${exit.code}${sig}) без result-события` +
        (exit.stderrTail ? `\n${exit.stderrTail}` : ''),
    };
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join(' ')
      .trim();
  }
  return '';
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  const line = i === -1 ? s : s.slice(0, i);
  return line.length > 160 ? line.slice(0, 159) + '…' : line;
}

export function summarizeToolUse(name: string, input: any): string {
  try {
    switch (name) {
      case 'Bash':
        return clip(String(input?.command ?? ''));
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'NotebookEdit':
        return clip(String(input?.file_path ?? ''));
      case 'Glob':
      case 'Grep':
        return clip(String(input?.pattern ?? ''));
      case 'WebFetch':
        return clip(String(input?.url ?? ''));
      case 'WebSearch':
        return clip(String(input?.query ?? ''));
      case 'Task':
        return clip(String(input?.description ?? ''));
      case 'TodoWrite':
        return 'обновление списка задач';
      default:
        return clip(JSON.stringify(input ?? {}));
    }
  } catch {
    return '';
  }
}

/**
 * Human-friendly one-line title like the Claude Code UI shows
 * ("Edited src/bot/commands.ts +12 -3"). Returns undefined when there is
 * no meaningful title (e.g. a Bash call without a description).
 */
export function friendlyToolUse(name: string, input: any): string | undefined {
  try {
    switch (name) {
      case 'Bash': {
        const d = String(input?.description ?? '').trim();
        return d ? clip(d) : undefined;
      }
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'NotebookEdit': {
        const p = shortPath(String(input?.file_path ?? ''));
        if (!p) return undefined;
        const verb = name === 'Read' ? 'Read' : name === 'Write' ? 'Wrote' : 'Edited';
        let s = `${verb} ${p}`;
        if (name === 'Edit' && (input?.old_string !== undefined || input?.new_string !== undefined)) {
          const added = lineCount(String(input?.new_string ?? ''));
          const removed = lineCount(String(input?.old_string ?? ''));
          s += ` +${added} -${removed}`;
        }
        return s;
      }
      case 'Glob':
      case 'Grep': {
        const p = String(input?.pattern ?? '').trim();
        return p ? `Searched ${clip(p)}` : undefined;
      }
      case 'Task': {
        const d = String(input?.description ?? '').trim();
        return d ? clip(d) : undefined;
      }
      case 'WebFetch': {
        const u = String(input?.url ?? '').trim();
        return u ? `Fetched ${clip(u)}` : undefined;
      }
      case 'WebSearch': {
        const q = String(input?.query ?? '').trim();
        return q ? `Searched web: ${clip(q)}` : undefined;
      }
      case 'TodoWrite':
        return 'Updated tasks';
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** `src/bot/commands.ts` → `bot/commands.ts` (basename + its parent dir). */
function shortPath(p: string): string {
  const norm = p.replace(/\/+$/, '');
  if (!norm) return '';
  const slash = norm.lastIndexOf('/');
  const base = norm.slice(slash + 1);
  const parent = slash === -1 ? '' : norm.slice(0, slash);
  const parentBase = parent ? parent.slice(parent.lastIndexOf('/') + 1) : '';
  return parentBase ? `${parentBase}/${base}` : base;
}

/** Number of lines in a string (newline count + 1). */
function lineCount(s: string): number {
  return s.split('\n').length;
}

function clip(s: string, max = 140): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}
