import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

export interface ProcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export interface JsonlLine {
  raw: string;
  json: unknown;
}

/** What the event mappers consume — real process or test fixture. */
export interface JsonlSource {
  lines: AsyncGenerator<JsonlLine, void, void>;
  exited: Promise<ProcExit>;
}

export interface JsonlProc extends JsonlSource {
  kill(): void;
  pid: number | undefined;
}

export interface SpawnJsonlOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. */
  stdinData?: string;
  rawLogPath?: string;
}

const STDERR_TAIL_LIMIT = 4000;
const SIGKILL_GRACE_MS = 5000;

/**
 * Spawns a CLI that emits one JSON object per stdout line.
 * The child is detached into its own process group so cancel() can kill
 * the whole tree (engines spawn their own children).
 */
export function spawnJsonl(opts: SpawnJsonlOptions): JsonlProc {
  let rawLog: fs.WriteStream | undefined;
  if (opts.rawLogPath) {
    fs.mkdirSync(path.dirname(opts.rawLogPath), { recursive: true });
    rawLog = fs.createWriteStream(opts.rawLogPath, { flags: 'a' });
    rawLog.on('error', () => undefined);
    rawLog.write(`\n[run ${new Date().toISOString()}] ${opts.cmd} ${opts.args.join(' ')}\n`);
  }

  const child = spawn(opts.cmd, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    rawLog?.write(`[stderr] ${chunk}`);
  });

  child.stdin.on('error', () => undefined); // EPIPE when the child dies early
  if (opts.stdinData !== undefined) child.stdin.write(opts.stdinData);
  child.stdin.end();

  const exited = new Promise<ProcExit>((resolve) => {
    let done = false;
    child.once('close', (code, signal) => {
      if (done) return;
      done = true;
      rawLog?.end();
      resolve({ code, signal, stderrTail });
    });
    child.once('error', (err) => {
      // e.g. ENOENT — 'close' never fires
      if (done) return;
      done = true;
      rawLog?.end();
      resolve({ code: null, signal: null, stderrTail: stderrTail || String(err) });
    });
  });

  let hasExited = false;
  void exited.then(() => {
    hasExited = true;
  });

  let killed = false;
  function kill(): void {
    if (killed) return;
    killed = true;
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      // hasExited guards against SIGKILLing a recycled pid/process group
      if (hasExited) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, SIGKILL_GRACE_MS);
    timer.unref();
    void exited.then(() => clearTimeout(timer));
  }

  async function* lines(): AsyncGenerator<JsonlLine, void, void> {
    const rl = createInterface({ input: child.stdout });
    try {
      for await (const raw of rl) {
        rawLog?.write(raw + '\n');
        const trimmed = raw.trim();
        if (!trimmed) continue;
        let json: unknown;
        try {
          json = JSON.parse(trimmed);
        } catch {
          json = undefined;
        }
        yield { raw, json };
      }
    } finally {
      rl.close();
    }
  }

  return { lines: lines(), exited, kill, pid: child.pid };
}
