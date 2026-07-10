import type { AgentEvent, Engine, EngineRun, EngineRunOptions } from './types.js';
import { spawnJsonl, type JsonlSource } from './spawn.js';

/**
 * Codex CLI headless:
 *   codex exec --json --dangerously-bypass-approvals-and-sandbox -C <workdir> -
 *   codex exec resume <thread_id> --json --dangerously-bypass-approvals-and-sandbox -
 * Prompt goes to stdin ('-' positional). `exec resume` has no -C flag —
 * the working directory comes from the spawned process cwd.
 */
export class CodexEngine implements Engine {
  readonly kind = 'codex' as const;

  run(opts: EngineRunOptions): EngineRun {
    const args = buildCodexArgs(opts);

    const proc = spawnJsonl({
      cmd: 'codex',
      args,
      cwd: opts.workdir,
      env: opts.env,
      stdinData: opts.prompt,
      rawLogPath: opts.rawLogPath,
    });

    return { events: mapCodexEvents(proc, opts.workdir), cancel: proc.kill, pid: proc.pid };
  }
}

/**
 * Pure builder for the `codex exec` argv. Per-run effort is passed as a TOML
 * config override — the value itself must include the quotes, e.g. the arg
 * string is: model_reasoning_effort="high". Flags precede the '-' positional.
 */
export function buildCodexArgs(opts: EngineRunOptions): string[] {
  const flags = ['--json', '--dangerously-bypass-approvals-and-sandbox'];
  if (opts.model) flags.push('-m', opts.model);
  if (opts.effort) flags.push('-c', `model_reasoning_effort="${opts.effort}"`);

  return opts.resumeSessionId
    ? ['exec', 'resume', opts.resumeSessionId, ...flags, '-']
    : ['exec', ...flags, '-C', opts.workdir, '-'];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function* mapCodexEvents(
  src: JsonlSource,
  workdir?: string,
): AsyncGenerator<AgentEvent, void, void> {
  let lastAgentMessage = '';
  let finished = false;
  // codex exec --json has no interim usage events — steps are the only live
  // signal; tokens land once with turn.completed
  const cum = {
    freshInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    steps: 0,
  };

  for await (const line of src.lines) {
    const ev = line.json as any;
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue;

    switch (ev.type) {
      case 'thread.started':
        if (typeof ev.thread_id === 'string') {
          yield { kind: 'init', engineSessionId: ev.thread_id };
        }
        break;

      case 'item.started': {
        cum.steps += 1;
        yield { kind: 'usage-tick', cumulative: { ...cum } };
        const item = ev.item;
        switch (item?.type) {
          case 'command_execution': {
            const cmd = cleanShellCommand(String(item.command ?? ''));
            // no friendly: raw commands are verbose-only noise; compact mode
            // narrates through reasoning events instead
            yield { kind: 'tool-use', name: 'Shell', summary: clip(cmd) };
            break;
          }
          case 'web_search':
            yield { kind: 'tool-use', name: 'WebSearch', summary: clip(String(item.query ?? '')) };
            break;
          case 'mcp_tool_call':
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

      case 'item.completed': {
        const item = ev.item;
        switch (item?.type) {
          case 'agent_message':
            if (typeof item.text === 'string' && item.text.trim()) {
              lastAgentMessage = item.text;
              yield { kind: 'assistant-text', text: item.text };
            }
            break;
          case 'command_execution': {
            const ok = item.exit_code === 0 || item.exit_code === undefined;
            yield {
              kind: 'tool-result',
              name: 'Shell',
              ok,
              summary: ok
                ? ''
                : `exit ${String(item.exit_code)}: ${clip(String(item.aggregated_output ?? ''))}`,
            };
            break;
          }
          case 'file_change': {
            const paths = Array.isArray(item.changes)
              ? item.changes
                  .map((c: any) => relPath(String(c?.path ?? ''), workdir))
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
          case 'error':
            yield { kind: 'error', message: clip(String(item.message ?? 'codex error')) };
            break;
          case 'reasoning':
            // Codex's own narration — the compact-mode equivalent of Claude's
            // Bash descriptions ("Investigating repo structure").
            if (typeof item.text === 'string' && item.text.trim()) {
              yield { kind: 'reasoning', text: item.text };
            }
            break;
          case 'todo_list':
          default:
            break;
        }
        break;
      }

      case 'turn.completed': {
        finished = true;
        const usage = ev.usage;
        if (usage && typeof usage === 'object') {
          const input = numberOrUndefined(usage.input_tokens) ?? 0;
          const cached = numberOrUndefined(usage.cached_input_tokens) ?? 0;
          cum.freshInputTokens += Math.max(0, input - cached);
          cum.cacheReadTokens += cached;
          cum.outputTokens += numberOrUndefined(usage.output_tokens) ?? 0;
          yield { kind: 'usage-tick', cumulative: { ...cum } };
        }
        yield {
          kind: 'result',
          ok: true,
          text: lastAgentMessage,
          usage: usage
            ? {
                inputTokens: numberOrUndefined(usage.input_tokens),
                outputTokens: numberOrUndefined(usage.output_tokens),
                contextWindowTokens:
                  numberOrUndefined(usage.context_window) ??
                  numberOrUndefined(usage.context_window_tokens) ??
                  numberOrUndefined(ev.context_window) ??
                  numberOrUndefined(ev.context_window_tokens) ??
                  numberOrUndefined(ev.model_context_window),
              }
            : undefined,
        };
        break;
      }

      case 'turn.failed': {
        finished = true;
        const message = String(ev.error?.message ?? 'turn failed');
        yield { kind: 'result', ok: false, text: message };
        break;
      }

      case 'error':
        yield { kind: 'error', message: clip(String(ev.message ?? 'codex error')) };
        break;

      default:
        break; // turn.started, item.updated, unknown — ignored
    }
  }

  const exit = await src.exited;
  if (!finished) {
    const sig = exit.signal ? `, signal ${exit.signal}` : '';
    yield {
      kind: 'error',
      message:
        `codex exited (code ${exit.code}${sig}) without turn.completed` +
        (exit.stderrTail ? `\n${exit.stderrTail}` : ''),
    };
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * Codex wraps shell commands like `/bin/zsh -lc 'echo hi'` or
 * `/usr/bin/bash -lc "..."`. Strip the login-shell wrapper and the
 * surrounding quotes so both summary and friendly show the real command.
 */
export function cleanShellCommand(raw: string): string {
  let s = raw.trim();
  const m = /^\S*\/(?:ba|z|da)?sh -lc\s+/.exec(s);
  if (m) {
    s = s.slice(m[0].length).trim();
    const q = s[0];
    if ((q === "'" || q === '"') && s.length >= 2 && s[s.length - 1] === q) {
      s = s.slice(1, -1);
    }
  }
  return s;
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
