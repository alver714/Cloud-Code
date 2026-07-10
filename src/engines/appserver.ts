import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sanitizedChildEnv } from '../util/childEnv.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Long-lived `codex app-server` (JSON-RPC over newline-delimited stdio) shared
 * by every codex run when CODEX_TRANSPORT=app-server. Unlike `codex exec`, one
 * process serves many threads (conversations) at once, streams live per-turn
 * token usage, and supports native turn interrupt — the whole reason Wave 2
 * exists.
 *
 * Framing is identical to src/usage/limits.ts: one JSON object per stdout line,
 * requests carry an `id`, notifications don't. Handshake:
 *   → initialize (id) ; ← result ; → initialized (notification).
 *
 * The process is spawned lazily on first ensureReady(). If it dies unexpectedly
 * all in-flight requests are rejected and every active listener receives a
 * synthetic `$disconnect` notification so no run can hang waiting for a
 * `turn/completed` that will never come. The next ensureReady() respawns.
 */

/** A subset of ChildProcess the client needs — injectable for tests. */
export interface SpawnedProc {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  pid: number | undefined;
  kill(): void;
  /** Register a one-shot exit/close/error handler. */
  onClose(cb: (info: { code: number | null; reason?: string }) => void): void;
}

export type SpawnFn = () => SpawnedProc;

export interface AppServerNotification {
  method: string;
  params?: any;
}

export type NotificationListener = (notif: AppServerNotification) => void;

export interface StartThreadOptions {
  cwd: string;
  model?: string;
  effort?: string;
}

export interface StartedThread {
  threadId: string;
  model?: string;
  reasoningEffort?: string;
}

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 60_000;
const CLIENT_INFO = { name: 'cloud-code', title: 'cloud-code', version: '1.0.0' };

function defaultSpawn(): SpawnedProc {
  const child = spawn('codex', ['app-server'], {
    // Bot secrets and Claude credentials must not reach the codex process
    // (codex keeps its own ~/.codex auth; OPENAI_API_KEY stays available).
    env: sanitizedChildEnv({ keepCodex: true }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // EPIPE on the shared pipe (server died mid-write) must not crash the bot —
  // same guard as spawn.ts / usage/limits.ts.
  child.stdin?.on('error', () => undefined);
  child.stderr?.setEncoding('utf8');
  let stderrTail = '';
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    pid: child.pid,
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    },
    onClose: (cb) => {
      let done = false;
      const fire = (code: number | null) => {
        if (done) return;
        done = true;
        cb({ code, reason: stderrTail || undefined });
      };
      child.once('close', (code) => fire(code));
      child.once('error', (err) => {
        stderrTail = stderrTail || String(err);
        fire(null);
      });
    },
  };
}

export class AppServerClient {
  private proc: SpawnedProc | undefined;
  private initialized = false;
  private readyPromise: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, Set<NotificationListener>>();
  private readonly spawnFn: SpawnFn;

  constructor(spawnFn: SpawnFn = defaultSpawn) {
    this.spawnFn = spawnFn;
  }

  /** Informational — the shared app-server pid (undefined before first spawn). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Spawn + handshake if not already connected. Idempotent, coalesces callers. */
  ensureReady(): Promise<void> {
    if (this.proc && this.initialized) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.handshake().catch((err) => {
      // failed handshake — drop the half-spawned proc so a retry respawns
      this.teardown(err instanceof Error ? err.message : String(err));
      this.readyPromise = undefined;
      throw err;
    });
    return this.readyPromise;
  }

  private async handshake(): Promise<void> {
    const proc = this.spawnFn();
    this.proc = proc;
    this.attach(proc);
    // id:1-style request; must go out before we await so the reply can arrive
    await this.request('initialize', { clientInfo: CLIENT_INFO });
    this.notify('initialized');
    this.initialized = true;
  }

  private attach(proc: SpawnedProc): void {
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.onLine(line));
    proc.onClose(({ reason }) => {
      rl.close();
      if (this.proc === proc) this.teardown(reason ?? 'app-server exited');
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // non-JSON banner line
    }
    if (msg == null || typeof msg !== 'object') return;

    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`app-server ${String(msg.error.message ?? 'error')}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === 'string') {
      this.dispatch({ method: msg.method, params: msg.params });
    }
  }

  /** Route a notification to the listeners of its thread. */
  private dispatch(notif: AppServerNotification): void {
    const threadId = notifThreadId(notif);
    if (threadId === undefined) return;
    const set = this.listeners.get(threadId);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(notif);
      } catch {
        /* a listener throwing must not break dispatch */
      }
    }
  }

  /** Reject every in-flight request and tell every listener the link dropped. */
  private teardown(reason: string): void {
    this.proc = undefined;
    this.initialized = false;
    this.readyPromise = undefined;
    const err = new Error(`codex app-server unavailable: ${reason}`);
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    // synthetic terminal notification so mid-turn runs end instead of hanging
    for (const [, set] of this.listeners) {
      for (const cb of [...set]) {
        try {
          cb({ method: '$disconnect', params: { message: reason } });
        } catch {
          /* ignore */
        }
      }
    }
  }

  private send(obj: unknown): void {
    if (!this.proc) throw new Error('codex app-server not connected');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
  }

  private request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`app-server ${method} timed out`));
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async startThread(opts: StartThreadOptions): Promise<StartedThread> {
    await this.ensureReady();
    const params: Record<string, unknown> = {
      cwd: opts.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    };
    if (opts.model) params.model = opts.model;
    if (opts.effort) params.config = { model_reasoning_effort: opts.effort };
    const res = await this.request('thread/start', params);
    return readStarted(res);
  }

  async resumeThread(threadId: string, opts: Omit<StartThreadOptions, 'cwd'> & { cwd?: string }): Promise<StartedThread> {
    await this.ensureReady();
    const params: Record<string, unknown> = {
      threadId,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    };
    if (opts.cwd) params.cwd = opts.cwd;
    if (opts.model) params.model = opts.model;
    if (opts.effort) params.config = { model_reasoning_effort: opts.effort };
    const res = await this.request('thread/resume', params);
    return readStarted(res);
  }

  /** Send a user turn; resolves with the new turnId (from the turn/start reply). */
  async sendTurn(threadId: string, text: string): Promise<string> {
    await this.ensureReady();
    const res = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    const turnId = res?.turn?.id;
    if (typeof turnId !== 'string') throw new Error('turn/start returned no turn id');
    return turnId;
  }

  /** Interrupt one turn. Never kills the shared server. Tolerates "no active turn". */
  async interrupt(threadId: string, turnId: string): Promise<void> {
    if (!this.proc || !this.initialized) return;
    try {
      await this.request('turn/interrupt', { threadId, turnId }, 10_000);
    } catch {
      // -32600 "no active turn to interrupt" (already done) or a dead server —
      // either way there is nothing left to stop.
    }
  }

  /** Subscribe to this thread's notifications. Returns an unsubscribe fn. */
  onNotification(threadId: string, cb: NotificationListener): () => void {
    let set = this.listeners.get(threadId);
    if (!set) {
      set = new Set();
      this.listeners.set(threadId, set);
    }
    set.add(cb);
    return () => {
      const s = this.listeners.get(threadId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.listeners.delete(threadId);
    };
  }

  /** Graceful shutdown for process exit. Kills the shared server. */
  async shutdown(): Promise<void> {
    const proc = this.proc;
    this.teardown('shutdown');
    if (proc) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

/** Pull the thread id out of any notification shape we care about. */
export function notifThreadId(notif: AppServerNotification): string | undefined {
  const p = notif.params;
  if (p && typeof p === 'object') {
    if (typeof p.threadId === 'string') return p.threadId;
    if (p.thread && typeof p.thread === 'object' && typeof p.thread.id === 'string') {
      return p.thread.id;
    }
  }
  return undefined;
}

function readStarted(res: any): StartedThread {
  const threadId = res?.thread?.id;
  if (typeof threadId !== 'string') throw new Error('thread start returned no thread id');
  return {
    threadId,
    model: typeof res.model === 'string' ? res.model : undefined,
    reasoningEffort: typeof res.reasoningEffort === 'string' ? res.reasoningEffort : undefined,
  };
}
