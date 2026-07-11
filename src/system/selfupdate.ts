import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sanitizedChildEnv } from '../util/childEnv.js';

/**
 * In-bot self-update ("/update"). The bot pulls the latest code from the PUBLIC
 * GitHub repo, builds it in an isolated temp dir, and only then swaps the built
 * `dist/` into the live install (`/opt/coding-bot`). The restart is delegated to
 * systemd: on the VM the unit runs with `Restart=always`, so after staging the
 * new build the process simply `process.exit(0)`s and is relaunched into the new
 * code — no `sudo`/`systemctl` (blocked by `NoNewPrivileges=true`).
 *
 * Safety design:
 * - The clone + `npm ci` + `npm run build` all happen in a throwaway temp dir.
 *   If ANY of them fail, the live install is never touched and the running bot
 *   keeps serving. Only after a verified build (dist/index.js present) do we
 *   mutate `/opt/coding-bot`.
 * - The previous `dist/` is renamed to `dist.bak` before the new one is copied,
 *   so a crash-looping new build can be rolled back by hand over SSH.
 * - A marker file survives the restart so the next boot can confirm success in
 *   the topic that issued /update.
 *
 * The pure helpers (parseLsRemote, computeUpdateCheck, shortSha, isUnderSystemd)
 * are unit-tested; runUpdate takes an injectable `exec` + injectable dirs so
 * tests never actually clone GitHub or spawn npm.
 */

const execFileAsync = promisify(execFile);

/** Public repo — clone / ls-remote need no auth. */
export const UPDATE_REPO_URL = 'https://github.com/alver714/Cloud-Code';
export const DEFAULT_BRANCH = 'main';
/** The systemd WorkingDirectory on the VM; overridable for local dev / tests. */
export const DEFAULT_TARGET_DIR = process.env.CODING_BOT_DIR ?? '/opt/coding-bot';
/** Marker file (under $HOME/.coding-bot) read+deleted on the next boot. */
export const MARKER_FILE = 'last-update.json';

// npm ci / tsc on an e2-micro are slow — be generous.
const CLONE_TIMEOUT_MS = 120_000;
const NPM_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 300_000;

export interface ExecOpts {
  cwd?: string;
  timeout?: number;
}
export interface ExecResult {
  stdout: string;
  stderr: string;
}
/** argv-array exec (no shell); injectable so tests stub git/npm. */
export type ExecFn = (cmd: string, args: string[], opts: ExecOpts) => Promise<ExecResult>;

const defaultExec: ExecFn = (cmd, args, opts) =>
  execFileAsync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    // git/npm need no bot/provider secrets — strip them all.
    env: sanitizedChildEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });

/* ── pure helpers ─────────────────────────────────────────────────────────── */

/** Short (7-char) SHA for display; "unknown" when the SHA is missing. */
export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}

/** systemd sets INVOCATION_ID for every unit it launches. */
export function isUnderSystemd(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.INVOCATION_ID;
}

/**
 * Parse `git ls-remote <url> main` output → the branch SHA. Prefers
 * refs/heads/main, falls back to HEAD, then to the first SHA-looking token.
 * Undefined when there is nothing SHA-shaped.
 */
export function parseLsRemote(stdout: string): string | undefined {
  const rows = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter((p) => p[0] !== undefined && /^[0-9a-f]{7,40}$/i.test(p[0]));
  const byRef = (ref: string) => rows.find((r) => r[1] === ref)?.[0];
  return byRef('refs/heads/main') ?? byRef('HEAD') ?? rows[0]?.[0];
}

export type UpdateCheck =
  | { state: 'unknown-latest'; current?: string }
  | { state: 'up-to-date'; current?: string; latest: string }
  | { state: 'available'; current?: string; latest: string };

/** Decide the /update check verdict from the two SHAs. Pure. */
export function computeUpdateCheck(
  current: string | undefined,
  latest: string | undefined,
): UpdateCheck {
  if (!latest) return { state: 'unknown-latest', current };
  if (current && current === latest) return { state: 'up-to-date', current, latest };
  return { state: 'available', current, latest };
}

/** Keep the last `n` chars — enough of a failed command's output to diagnose. */
function tailOf(s: string, n = 2000): string {
  return s.length <= n ? s : s.slice(-n);
}

/** Best-effort human-readable tail from an execFile-style rejection. */
function execErrorTail(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  const out = [e?.stdout, e?.stderr, e?.message].filter(Boolean).join('\n').trim();
  return tailOf(out || String(err));
}

/* ── version files + marker ───────────────────────────────────────────────── */

/** The deployed commit SHA (baked into VERSION at deploy time); undefined if absent. */
export async function getCurrentVersion(
  versionFile: string = path.join(DEFAULT_TARGET_DIR, 'VERSION'),
): Promise<string | undefined> {
  try {
    const v = (await fs.readFile(versionFile, 'utf8')).trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Latest SHA on the remote branch via `git ls-remote`; undefined on any failure. */
export async function getLatestVersion(
  repoUrl: string = UPDATE_REPO_URL,
  branch: string = DEFAULT_BRANCH,
  exec: ExecFn = defaultExec,
): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['ls-remote', repoUrl, branch], { timeout: 20_000 });
    return parseLsRemote(stdout);
  } catch {
    return undefined;
  }
}

export interface UpdateMarker {
  from?: string;
  to: string;
  at: number;
  chatId?: number;
  topicId?: number;
}

/** Read + delete the update marker (if any) so the next boot can confirm once. */
export async function consumeUpdateMarker(
  homeDir: string = os.homedir(),
): Promise<UpdateMarker | undefined> {
  const file = path.join(homeDir, '.coding-bot', MARKER_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    await fs.rm(file, { force: true }).catch(() => undefined);
    const parsed = JSON.parse(raw) as UpdateMarker;
    return typeof parsed?.to === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/* ── the staged update ────────────────────────────────────────────────────── */

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Swap the freshly built clone into the live install: back up the current
 * `dist/` to `dist.bak` (removing any older backup first), then copy the new
 * `dist/`, `package.json`, `package-lock.json` over the target.
 */
async function stageBuild(cloneDir: string, targetDir: string): Promise<void> {
  const dist = path.join(targetDir, 'dist');
  const bak = path.join(targetDir, 'dist.bak');
  await fs.rm(bak, { recursive: true, force: true });
  if (await pathExists(dist)) await fs.rename(dist, bak);
  await fs.cp(path.join(cloneDir, 'dist'), dist, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) {
    await fs.cp(path.join(cloneDir, f), path.join(targetDir, f), { force: true });
  }
}

export interface RunUpdateOpts {
  /** Timestamp for the marker — pass Date.now() from the live path. */
  now: number;
  repoUrl?: string;
  branch?: string;
  targetDir?: string;
  homeDir?: string;
  chatId?: number;
  topicId?: number;
  exec?: ExecFn;
}

export type UpdateResult =
  | { ok: true; from?: string; to: string }
  | { ok: false; tail: string };

/**
 * Clone → build in a temp dir; on success stage into targetDir, sync prod deps,
 * write VERSION + the restart marker. On ANY failure before staging, the live
 * install is untouched and { ok:false } carries the output tail. The caller
 * restarts (systemd) or tells the user to, only when ok.
 */
export async function runUpdate(opts: RunUpdateOpts): Promise<UpdateResult> {
  const repoUrl = opts.repoUrl ?? UPDATE_REPO_URL;
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const targetDir = opts.targetDir ?? DEFAULT_TARGET_DIR;
  const homeDir = opts.homeDir ?? os.homedir();
  const exec = opts.exec ?? defaultExec;

  const stateDir = path.join(homeDir, '.coding-bot');
  await fs.mkdir(stateDir, { recursive: true });
  const cloneDir = await fs.mkdtemp(path.join(stateDir, 'update-'));

  try {
    // ── isolated: nothing here touches the running bot ──
    await exec('git', ['clone', '--depth', '1', '--branch', branch, repoUrl, cloneDir], {
      timeout: CLONE_TIMEOUT_MS,
    });
    const rev = await exec('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], { timeout: 15_000 });
    const to = rev.stdout.trim();
    // full install (incl. dev deps) so tsc is available, then build.
    await exec('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: cloneDir,
      timeout: NPM_TIMEOUT_MS,
    });
    await exec('npm', ['run', 'build'], { cwd: cloneDir, timeout: BUILD_TIMEOUT_MS });
    if (!(await pathExists(path.join(cloneDir, 'dist', 'index.js')))) {
      throw new Error('build produced no dist/index.js — aborting');
    }

    // ── verified build: from here we mutate the live install ──
    const from = await getCurrentVersion(path.join(targetDir, 'VERSION'));
    await stageBuild(cloneDir, targetDir);
    // sync prod-only deps to match the new package-lock.
    await exec('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: targetDir,
      timeout: NPM_TIMEOUT_MS,
    });
    await fs.writeFile(path.join(targetDir, 'VERSION'), `${to}\n`);
    const marker: UpdateMarker = {
      from,
      to,
      at: opts.now,
      chatId: opts.chatId,
      topicId: opts.topicId,
    };
    await fs.writeFile(path.join(stateDir, MARKER_FILE), JSON.stringify(marker));
    return { ok: true, from, to };
  } catch (err) {
    return { ok: false, tail: execErrorTail(err) };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
