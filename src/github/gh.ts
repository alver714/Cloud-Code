import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

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
 * gh/git inherit the bot's environment; strip the bot's own secrets so a
 * subprocess (or anything it shells out to) can never read them.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.ALLOWED_USER_IDS;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
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

/** Clones owner/repo into dest; reuses dest if it already exists. */
export async function cloneRepo(nameWithOwner: string, dest: string): Promise<'cloned' | 'reused'> {
  if (!isValidRepo(nameWithOwner)) throw new Error(`Некорректное имя репозитория: ${nameWithOwner}`);
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

/** Directory name for a session workspace: owner-repo-topicId. */
export function workdirName(nameWithOwner: string, topicId: number): string {
  const safe = nameWithOwner.replace('/', '-').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}-${topicId}`;
}

export function repoShort(nameWithOwner: string): string {
  return nameWithOwner.split('/')[1] ?? nameWithOwner;
}
