import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizedChildEnv } from '../util/childEnv.js';

const execFileAsync = promisify(execFile);

/**
 * CI follow-up: after the agent pushes, poll `gh run list` in the workspace
 * and report the run's outcome back to the topic. Fail-open everywhere —
 * repos without workflows just produce silence.
 */

export interface CiRun {
  id: number;
  status: string;
  conclusion: string | null;
  url: string;
  title: string;
  branch: string;
}

/** Parses `gh run list --json ...` output; undefined when no runs / bad JSON. */
export function parseRunList(json: string): CiRun | undefined {
  try {
    const arr = JSON.parse(json) as Array<Record<string, unknown>>;
    const r = arr[0];
    if (!r || typeof r.databaseId !== 'number') return undefined;
    return {
      id: r.databaseId,
      status: String(r.status ?? ''),
      conclusion: r.conclusion == null || r.conclusion === '' ? null : String(r.conclusion),
      url: String(r.url ?? ''),
      title: String(r.displayTitle ?? ''),
      branch: String(r.headBranch ?? ''),
    };
  } catch {
    return undefined;
  }
}

/**
 * Newest CI run, optionally scoped to one branch (`gh run list --branch`) so a
 * concurrent run on another branch isn't misattributed. Without `branch` the
 * newest run of the whole repo is returned (pre-existing behavior — the caller
 * may not track which branch was pushed).
 */
export async function latestRun(workdir: string, branch?: string): Promise<CiRun | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'run',
        'list',
        '--limit',
        '1',
        ...(branch ? ['--branch', branch] : []),
        '--json',
        'databaseId,status,conclusion,url,displayTitle,headBranch',
      ],
      { cwd: workdir, timeout: 20_000, env: sanitizedChildEnv() },
    );
    return parseRunList(stdout);
  } catch {
    return undefined;
  }
}

export interface WatchOptions {
  /** Give GitHub time to register the run before the first poll. */
  initialDelayMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  /** Follow only this branch's runs (see latestRun). */
  branch?: string;
}

/**
 * Waits for the newest run to complete and calls onDone with it.
 * No workflows / no runs / timeout → resolves silently without onDone.
 */
export async function watchCi(
  workdir: string,
  onDone: (run: CiRun) => void,
  opts: WatchOptions = {},
): Promise<void> {
  const initialDelay = opts.initialDelayMs ?? 15_000;
  const interval = opts.intervalMs ?? 20_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);

  await new Promise((r) => setTimeout(r, initialDelay));
  let sawRun = false;
  while (Date.now() < deadline) {
    const run = await latestRun(workdir, opts.branch);
    if (!run) {
      if (!sawRun) return; // repo without workflows — exit quietly
    } else {
      sawRun = true;
      if (run.status === 'completed') {
        onDone(run);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
