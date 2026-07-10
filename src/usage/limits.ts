import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface CodexWindow {
  /** 0..100 */
  usedPercent: number;
  windowDurationMins?: number;
  /** epoch seconds */
  resetsAt?: number;
}

export interface CodexLimits {
  primary?: CodexWindow;
  secondary?: CodexWindow;
  planType?: string;
  /** rateLimitResetCredits.availableCount (0 when absent). */
  resetCreditsAvailable: number;
}

export interface ClaudeWindow {
  key: string;
  /** 0..1 fraction */
  utilization: number;
  /** epoch seconds */
  resetsAt?: number;
}

export interface ClaudeLimits {
  windows: ClaudeWindow[];
}

const RPC_TIMEOUT_MS = 10_000;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Parse the `result` object of codex `account/rateLimits/read`. Tolerant:
 * missing windows/fields become undefined; anything unrecognizable → null.
 */
export function parseCodexResult(result: any): CodexLimits | null {
  if (!result || typeof result !== 'object') return null;
  const rl = result.rateLimits;
  if (!rl || typeof rl !== 'object') return null;

  const win = (w: any): CodexWindow | undefined => {
    if (!w || typeof w !== 'object' || typeof w.usedPercent !== 'number') return undefined;
    return {
      usedPercent: w.usedPercent,
      windowDurationMins:
        typeof w.windowDurationMins === 'number' ? w.windowDurationMins : undefined,
      resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : undefined,
    };
  };

  return {
    primary: win(rl.primary),
    secondary: win(rl.secondary),
    planType: typeof rl.planType === 'string' ? rl.planType : undefined,
    resetCreditsAvailable:
      typeof result.rateLimitResetCredits?.availableCount === 'number'
        ? result.rateLimitResetCredits.availableCount
        : 0,
  };
}

/**
 * Parse the (undocumented) Anthropic OAuth usage JSON. Iterates object entries
 * and keeps any that look like a usage window ({utilization} or
 * {used_percentage}). Returns null if nothing usable was found.
 */
export function parseClaudeUsage(json: any): ClaudeLimits | null {
  if (!json || typeof json !== 'object') return null;
  const windows: ClaudeWindow[] = [];
  for (const [key, val] of Object.entries(json)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as any;
    let utilization: number | undefined;
    if (typeof v.utilization === 'number') utilization = v.utilization;
    else if (typeof v.used_percentage === 'number') utilization = v.used_percentage / 100;
    if (utilization === undefined) continue;
    const resetsAt =
      typeof v.resets_at === 'number'
        ? v.resets_at
        : typeof v.reset_at === 'number'
          ? v.reset_at
          : undefined;
    windows.push({ key, utilization, resetsAt });
  }
  return windows.length > 0 ? { windows } : null;
}

/** process.env minus the bot's own secrets (codex keeps its own auth). */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.ALLOWED_USER_IDS;
  return env;
}

/**
 * Read codex subscription limits via `codex app-server` (JSON-RPC over stdio).
 * The process is killed as soon as the id:2 reply arrives (or after a timeout).
 * Never throws — resolves null on any failure.
 */
export async function readCodexLimits(): Promise<CodexLimits | null> {
  return new Promise<CodexLimits | null>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn('codex', ['app-server'], {
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (val: CodexLimits | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(val);
    };

    timer = setTimeout(() => {
      console.error('[usage] codex app-server timed out');
      finish(null);
    }, RPC_TIMEOUT_MS);

    child.on('error', (err) => {
      console.error('[usage] codex app-server error:', err);
      finish(null);
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: any;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (msg && msg.id === 2) {
          if (msg.error) {
            console.error('[usage] codex rateLimits error:', msg.error);
            finish(null);
            return;
          }
          finish(parseCodexResult(msg.result));
        }
      });
    }

    if (child.stdin) {
      child.stdin.on('error', () => undefined); // EPIPE if the child dies early
      const rpc = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'tgbot', title: 'tgbot', version: '1.0.0' } },
        },
        { jsonrpc: '2.0', method: 'initialized' },
        { jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} },
      ];
      for (const line of rpc) child.stdin.write(JSON.stringify(line) + '\n');
    } else {
      finish(null);
    }
  });
}

/**
 * Read Claude subscription limits from the undocumented OAuth usage endpoint.
 * Returns null when the token is unset (macOS local dev keeps it in Keychain)
 * or on any HTTP/parse failure.
 */
export async function readClaudeLimits(): Promise<ClaudeLimits | null> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[usage] claude usage HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return parseClaudeUsage(json);
  } catch (err) {
    console.error('[usage] claude usage fetch failed:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
