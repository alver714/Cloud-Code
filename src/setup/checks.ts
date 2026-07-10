/**
 * Pure, side-effect-free helpers for the setup wizard (`npm run setup`).
 *
 * Everything here is synchronous and I/O-free so it can be unit-tested hard:
 * the wizard (wizard.ts) does the prompting, spawning and HTTP, then feeds the
 * captured payloads through these parsers. Keeping the logic here means the
 * verdict matrix, token parsing and .env generation are tested without ever
 * touching the network or a TTY.
 */

export type Target = 'local' | 'cloud';
export type Engine = 'claude' | 'codex';

/* ------------------------------------------------------------------ *
 * Telegram bot token
 * ------------------------------------------------------------------ */

/**
 * Shape check for a @BotFather token: `<digits>:<35-ish url-safe chars>`.
 * This only guards against obvious typos/paste errors — the authoritative
 * check is a live getMe call.
 */
export function isValidBotTokenShape(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test((token ?? '').trim());
}

export interface GetMeResult {
  ok: boolean;
  username?: string;
  id?: number;
  error?: string;
}

/** Parse a Telegram `getMe` response into {ok, username}. */
export function parseGetMe(payload: unknown): GetMeResult {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'empty or non-JSON response' };
  }
  const p = payload as Record<string, unknown>;
  if (p.ok === true && p.result && typeof p.result === 'object') {
    const r = p.result as Record<string, unknown>;
    if (r.is_bot === false) {
      return { ok: false, error: 'this token belongs to a user account, not a bot' };
    }
    return {
      ok: true,
      username: typeof r.username === 'string' ? r.username : undefined,
      id: typeof r.id === 'number' ? r.id : undefined,
    };
  }
  const desc = typeof p.description === 'string' ? p.description : 'invalid token';
  return { ok: false, error: desc };
}

/**
 * Never print a full secret back to the terminal. Produces e.g.
 * `sk-ant-…TEST` or `1234567890:…0000`.
 */
export function maskToken(token: string): string {
  const t = (token ?? '').trim();
  if (!t) return '(empty)';
  if (t.length <= 6) return '****';
  const last4 = t.slice(-4);
  const m = t.match(/^(sk-ant-[a-z0-9]+-|sk-[a-z]+-|\d+:)/i);
  const prefix = m ? m[1] : t.slice(0, 4);
  return `${prefix}…${last4}`;
}

/* ------------------------------------------------------------------ *
 * Prerequisite / auth CLI probes
 * ------------------------------------------------------------------ */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ToolProbe {
  found: boolean;
  version?: string;
}

/** First semver-ish token (`22.3.0` / `2.40`) found in a string. */
export function extractVersion(output: string): string | undefined {
  const m = (output ?? '').match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}

/** Major version number of a Node version string like `v22.3.0`. */
export function nodeMajor(output: string): number | undefined {
  const v = extractVersion(output);
  if (!v) return undefined;
  const major = Number(v.split('.')[0]);
  return Number.isInteger(major) ? major : undefined;
}

/**
 * Turn a captured `<tool> --version` result into presence+version.
 * `null` means the command could not be spawned at all (ENOENT).
 */
export function probeTool(res: ExecResult | null): ToolProbe {
  if (!res) return { found: false };
  const found = res.code === 0;
  const version = extractVersion(`${res.stdout}\n${res.stderr}`);
  return found ? { found, version } : { found: false, version };
}

export interface GhAuthState {
  loggedIn: boolean;
  account?: string;
}

/** Parse `gh auth status` (exit code + text, which gh prints on either stream). */
export function parseGhAuthStatus(res: ExecResult | null): GhAuthState {
  if (!res) return { loggedIn: false };
  const text = `${res.stdout}\n${res.stderr}`;
  const loggedIn = res.code === 0 || /Logged in to/i.test(text);
  const m = text.match(/Logged in to \S+ (?:account|as) (\S+)/i);
  return { loggedIn, account: m ? m[1] : undefined };
}

/* ------------------------------------------------------------------ *
 * getUpdates capture
 * ------------------------------------------------------------------ */

export interface CapturedUser {
  id: number;
  firstName?: string;
}

interface UpdatesPayload {
  ok?: boolean;
  result?: unknown;
}

function updatesArray(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') return [];
  const result = (payload as UpdatesPayload).result;
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

/**
 * First `message.from` in a getUpdates payload → the human who messaged the
 * bot. Ignores channel posts (no `.message`) and updates without a sender.
 */
export function captureUser(payload: unknown): CapturedUser | undefined {
  for (const u of updatesArray(payload)) {
    const msg = u.message as Record<string, unknown> | undefined;
    const from = msg?.from as Record<string, unknown> | undefined;
    if (from && typeof from.id === 'number') {
      return {
        id: from.id,
        firstName: typeof from.first_name === 'string' ? from.first_name : undefined,
      };
    }
  }
  return undefined;
}

/** Thin wrapper matching the wizard's "capture user id" step. */
export function captureUserId(payload: unknown): number | undefined {
  return captureUser(payload)?.id;
}

export interface CapturedChat {
  id: number;
  title?: string;
}

/**
 * First message coming from a supergroup in a getUpdates payload → the group
 * the user just posted in. Used to discover the group's chat id.
 */
export function captureSupergroup(payload: unknown): CapturedChat | undefined {
  for (const u of updatesArray(payload)) {
    const msg =
      (u.message as Record<string, unknown> | undefined) ??
      (u.channel_post as Record<string, unknown> | undefined);
    const chat = msg?.chat as Record<string, unknown> | undefined;
    if (chat && chat.type === 'supergroup' && typeof chat.id === 'number') {
      return {
        id: chat.id,
        title: typeof chat.title === 'string' ? chat.title : undefined,
      };
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Group verification verdict
 * ------------------------------------------------------------------ */

export interface ChatInfo {
  type?: string;
  is_forum?: boolean;
  title?: string;
}

export interface MemberInfo {
  status?: string;
  can_manage_topics?: boolean;
}

export interface GroupVerdict {
  isForum: boolean;
  botIsAdmin: boolean;
  canManageTopics: boolean;
  verdict: 'pass' | 'fail';
  remediation: string[];
}

/**
 * Given a getChat result and a getChatMember(bot) result, decide whether the
 * group is usable: it must be a forum (Topics enabled) AND the bot must be an
 * admin (or creator) WITH the "Manage Topics" permission. Returns a precise
 * remediation list for whatever is missing.
 */
export function verifyGroup(chat: ChatInfo, member: MemberInfo): GroupVerdict {
  const isForum = chat?.is_forum === true;
  const status = member?.status;
  const botIsAdmin = status === 'administrator' || status === 'creator';
  // The group creator implicitly holds every admin permission, so
  // can_manage_topics may be absent for them.
  const canManageTopics = status === 'creator' || member?.can_manage_topics === true;

  const remediation: string[] = [];
  if (!isForum) {
    remediation.push(
      'Enable "Topics" in the group settings — this turns it into a forum supergroup.',
    );
  }
  if (!botIsAdmin) {
    remediation.push('Add the bot as an administrator of the group.');
  } else if (!canManageTopics) {
    remediation.push('Grant the bot the "Manage Topics" admin permission.');
  }

  const verdict = isForum && botIsAdmin && canManageTopics ? 'pass' : 'fail';
  return { isForum, botIsAdmin, canManageTopics, verdict, remediation };
}

/* ------------------------------------------------------------------ *
 * .env generation
 * ------------------------------------------------------------------ */

export interface BuildEnvInput {
  target: Target;
  /** The engine the user set up first → DEFAULT_ENGINE. */
  defaultEngine: Engine;
  /** All engines the user configured (1 or 2). */
  engines: Engine[];
  telegramBotToken: string;
  allowedUserIds: number[];
  /** Only used (and only emitted) for cloud + claude. */
  claudeOauthToken?: string;
}

/**
 * Build the full .env file content from the wizard's collected answers. The
 * defaults mirror config.ts / .env.example so a generated file needs no
 * hand-editing. Notable rules:
 *  - CLAUDE_CODE_OAUTH_TOKEN is emitted only for cloud + claude (locally,
 *    Claude Code uses the macOS Keychain and no token is needed).
 *  - CODEX_TRANSPORT=app-server when codex is configured (live token usage +
 *    native interrupt); otherwise the safe default 'exec'.
 *  - RESOURCE_GUARD defaults off locally (macOS memory metrics are unreliable)
 *    and on for the cloud free-tier VM.
 */
export function buildEnv(input: BuildEnvInput): string {
  const codex = input.engines.includes('codex');
  const claude = input.engines.includes('claude');
  const isCloud = input.target === 'cloud';

  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push('# Generated by `npm run setup`. Edit freely; re-run setup to regenerate.');
  push();
  push('# --- Telegram ---');
  push(`TELEGRAM_BOT_TOKEN=${input.telegramBotToken}`);
  push(`ALLOWED_USER_IDS=${input.allowedUserIds.join(',')}`);
  push();
  push('# --- Engine auth ---');
  if (isCloud && claude) {
    push('# Headless VM: generated locally with `claude setup-token`.');
    push(`CLAUDE_CODE_OAUTH_TOKEN=${input.claudeOauthToken ?? ''}`);
  } else if (claude) {
    push('# Local macOS: Claude Code uses the Keychain, no token needed.');
    push('CLAUDE_CODE_OAUTH_TOKEN=');
  }
  if (codex) {
    push('# Codex reads auth from ~/.codex/auth.json (pushed by deploy/03-push-auth.sh).');
  }
  push();
  push('# --- Paths ---');
  push('WORKSPACES_DIR=~/workspaces');
  push('SESSIONS_FILE=~/.coding-bot/sessions.json');
  push('LOGS_DIR=~/logs');
  push();
  push('# --- Engines ---');
  push(`DEFAULT_ENGINE=${input.defaultEngine}`);
  push('DEFAULT_MODEL_CLAUDE=sonnet');
  push('DEFAULT_MODEL_CODEX=');
  push(`CODEX_TRANSPORT=${codex ? 'app-server' : 'exec'}`);
  push('DEFAULT_EFFORT_CLAUDE=medium');
  push('MAX_BUDGET_USD_CLAUDE=');
  push('MAX_CONCURRENT_RUNS=3');
  push();
  push('# --- Token Guard ---');
  push('GUARD_SOFT_TOKENS=150000');
  push('GUARD_HARD_TOKENS=250000');
  push('GUARD_MAX_STEPS=200');
  push('GUARD_PREFLIGHT_PCT=90');
  push();
  push('# --- /goal loop ---');
  push('GOAL_MAX_ITERATIONS=10');
  push();
  push('# --- Preview ---');
  push('PREVIEW_TTL_MINUTES=30');
  push();
  push('# --- Bot memory ---');
  push('BOT_MEMORY=on');
  push();
  push('# --- Resource Guard ---');
  if (isCloud) {
    push('RESOURCE_GUARD=on');
    push('EGRESS_FREE_MB=1024');
    push('EGRESS_WARN_PCT=80');
    push('MIN_FREE_MEM_MB=300');
    push('DISK_WARN_PCT=85');
    push('DISK_BLOCK_PCT=95');
  } else {
    push('# Off locally: macOS memory metrics are unreliable.');
    push('RESOURCE_GUARD=off');
  }
  push();
  return lines.join('\n');
}
