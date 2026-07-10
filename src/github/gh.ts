import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { sanitizedChildEnv } from '../util/childEnv.js';

const execFileAsync = promisify(execFile);

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Validates an `owner/repo` slug. Beyond REPO_RE, rejects `.`/`..` path
 * segments — REPO_RE permits them, but they'd let a crafted name traverse
 * outside the intended clone target.
 */
export function isValidRepo(name: string): boolean {
  if (!REPO_RE.test(name)) return false;
  return !name.split('/').some((seg) => seg === '.' || seg === '..');
}

/**
 * gh/git inherit the bot's environment; strip the bot's own secrets and
 * provider credentials so a subprocess can never read them.
 */
function childEnv(): NodeJS.ProcessEnv {
  return sanitizedChildEnv();
}

export async function listRepos(limit = 30): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'gh',
    ['repo', 'list', '--limit', String(limit), '--json', 'nameWithOwner'],
    { timeout: 30_000, env: childEnv() },
  );
  const parsed = JSON.parse(stdout) as { nameWithOwner?: string }[];
  return parsed.map((r) => r.nameWithOwner ?? '').filter((r) => isValidRepo(r));
}

/**
 * Workspace for a repo-less /chat session: empty dir with git init
 * (codex exec refuses to work outside a git repository).
 */
export async function initChatWorkdir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await execFileAsync('git', ['init', '-q', dir], { timeout: 15_000, env: childEnv() });
}

/** Bare repo name for /create (no owner) — or a full owner/repo slug. */
export function isValidNewRepoName(name: string): boolean {
  if (name.includes('/')) return isValidRepo(name);
  return /^[A-Za-z0-9_.-]+$/.test(name) && name !== '.' && name !== '..';
}

let cachedLogin: string | undefined;

/** GitHub login of the authenticated gh user (cached for the process). */
export async function ghLogin(): Promise<string> {
  if (cachedLogin) return cachedLogin;
  const { stdout } = await execFileAsync('gh', ['api', 'user', '-q', '.login'], {
    timeout: 15_000,
    env: childEnv(),
  });
  cachedLogin = stdout.trim();
  if (!cachedLogin) throw new Error('gh api user returned an empty login');
  return cachedLogin;
}

/**
 * Creates a new GitHub repo (with a README so the clone has a default
 * branch) and returns its full owner/repo slug.
 */
export async function createRepo(
  name: string,
  visibility: 'private' | 'public',
): Promise<string> {
  if (!isValidNewRepoName(name)) throw new Error(`Invalid repository name: ${name}`);
  const full = name.includes('/') ? name : `${await ghLogin()}/${name}`;
  await execFileAsync(
    'gh',
    ['repo', 'create', full, `--${visibility}`, '--add-readme'],
    { timeout: 60_000, env: childEnv() },
  );
  return full;
}

/** Clones owner/repo into dest; reuses dest if it already exists. */
export async function cloneRepo(nameWithOwner: string, dest: string): Promise<'cloned' | 'reused'> {
  if (!isValidRepo(nameWithOwner)) throw new Error(`Invalid repository name: ${nameWithOwner}`);
  try {
    await fs.access(dest);
    return 'reused';
  } catch {
    /* not there yet */
  }
  await execFileAsync('gh', ['repo', 'clone', nameWithOwner, dest], {
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    env: childEnv(),
  });
  return 'cloned';
}

export async function gitStatusShort(workdir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', workdir, 'status', '-sb'], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: childEnv(),
  });
  return stdout.trim();
}

export async function gitDiff(workdir: string): Promise<{ stat: string; diff: string }> {
  const opts = { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: childEnv() };
  const { stdout: stat } = await execFileAsync('git', ['-C', workdir, 'diff', '--stat'], opts);
  const { stdout: diff } = await execFileAsync('git', ['-C', workdir, 'diff'], opts);
  return { stat: stat.trim(), diff: diff.trim() };
}

export interface GitCommitResult {
  sha: string;
  subject: string;
}

/** Stage every workspace change (including deletions and untracked files) and commit it. */
export async function gitCommitAll(workdir: string, message: string): Promise<GitCommitResult> {
  const subject = message.trim();
  if (!subject) throw new Error('Commit message must not be empty.');

  const opts = { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: childEnv() };
  const { stdout: status } = await execFileAsync(
    'git',
    ['-C', workdir, 'status', '--porcelain'],
    opts,
  );
  if (!status.trim()) throw new Error('Nothing to commit — the working tree is clean.');

  await execFileAsync('git', ['-C', workdir, 'add', '-A'], opts);
  await execFileAsync('git', ['-C', workdir, 'commit', '-m', subject], opts);
  const { stdout: sha } = await execFileAsync(
    'git',
    ['-C', workdir, 'rev-parse', '--short', 'HEAD'],
    opts,
  );
  return { sha: sha.trim(), subject };
}

/** Directory name for a session workspace: owner-repo-topicId. */
export function workdirName(nameWithOwner: string, topicId: number): string {
  const safe = nameWithOwner.replace('/', '-').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}-${topicId}`;
}

export function repoShort(nameWithOwner: string): string {
  return nameWithOwner.split('/')[1] ?? nameWithOwner;
}
