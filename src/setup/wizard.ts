/**
 * Interactive setup wizard — `npm run setup`.
 *
 * Walks a new user from zero to a working bot: deployment target, engine
 * choice, prerequisite/auth checks, Telegram bot + owner + group verification,
 * .env generation, and finally launch (local) or deploy (cloud).
 *
 * This file is deliberately thin: all decision logic lives in ./checks.ts
 * (pure + unit-tested). Here we only prompt, spawn, HTTP and orchestrate.
 * Node built-ins only — no bot library, no new npm deps.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEnv,
  captureSupergroup,
  captureUser,
  extractVersion,
  isValidBotTokenShape,
  maskToken,
  nodeMajor,
  parseGetMe,
  parseGhAuthStatus,
  probeTool,
  verifyGroup,
  type Engine,
  type ExecResult,
  type Target,
  type ToolProbe,
} from './checks.js';

/* ------------------------------------------------------------------ *
 * Tiny ANSI + emoji helpers (degrade gracefully when not a TTY)
 * ------------------------------------------------------------------ */
const useColor = stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint('1', s);
const dim = (s: string) => paint('2', s);
const green = (s: string) => paint('32', s);
const red = (s: string) => paint('31', s);
const yellow = (s: string) => paint('33', s);
const cyan = (s: string) => paint('36', s);
const OK = green('✅');
const NO = red('❌');
const WARN = yellow('⚠️');
const WAIT = '⏳';

const log = (s = '') => stdout.write(`${s}\n`);
const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');

/* ------------------------------------------------------------------ *
 * Prompt helpers
 * ------------------------------------------------------------------ */
let rl: readline.Interface;

async function ask(question: string, def?: string): Promise<string> {
  const suffix = def !== undefined && def !== '' ? dim(` [${def}]`) : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer === '' && def !== undefined ? def : answer;
}

async function confirm(question: string, def = true): Promise<boolean> {
  const hint = def ? 'Y/n' : 'y/N';
  const a = (await rl.question(`${question} ${dim(`[${hint}]`)} `)).trim().toLowerCase();
  if (a === '') return def;
  return a === 'y' || a === 'yes';
}

async function choose<T extends string>(
  question: string,
  options: { value: T; label: string }[],
  def: T,
): Promise<T> {
  log(bold(question));
  options.forEach((o, i) => log(`  ${i + 1}) ${o.label}${o.value === def ? dim(' (default)') : ''}`));
  while (true) {
    const a = await ask('Choose', String(options.findIndex((o) => o.value === def) + 1));
    const byNum = Number(a);
    if (Number.isInteger(byNum) && byNum >= 1 && byNum <= options.length) {
      return options[byNum - 1].value;
    }
    const byVal = options.find((o) => o.value === a.toLowerCase());
    if (byVal) return byVal.value;
    log(red('  Please enter a valid number.'));
  }
}

/* ------------------------------------------------------------------ *
 * Subprocess helpers
 * ------------------------------------------------------------------ */

/** Run a command, capture output. Returns null if it could not spawn (ENOENT). */
function run(cmd: string, args: string[]): ExecResult | null {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 });
    if (r.error) return null;
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch {
    return null;
  }
}

/**
 * Cached `<cmd> --version` probe. Some CLIs are slow to answer (`claude
 * --version` runs an update check, ~5s), and the wizard probes the same tool
 * in both the prerequisites and auth steps — spawn it at most once.
 */
const versionProbeCache = new Map<string, ToolProbe>();
function probeVersion(cmd: string): ToolProbe {
  let p = versionProbeCache.get(cmd);
  if (!p) {
    p = probeTool(run(cmd, ['--version']));
    versionProbeCache.set(cmd, p);
  }
  return p;
}

/** Run a command attached to the terminal (interactive login flows). */
function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Run a command interactively but also capture stdout (for `claude setup-token`). */
function runCapture(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => {
      const s = String(d);
      out += s;
      stdout.write(s);
    });
    child.on('error', () => resolve({ code: 127, stdout: out }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: out }));
  });
}

/* ------------------------------------------------------------------ *
 * Telegram HTTP (global fetch — Node 22+)
 * ------------------------------------------------------------------ */
async function tg(token: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

/* ------------------------------------------------------------------ *
 * Existing .env parsing (for re-run defaults)
 * ------------------------------------------------------------------ */
function readExistingEnv(): Record<string, string> {
  const p = path.join(projectRoot, '.env');
  const out: Record<string, string> = {};
  try {
    const text = fs.readFileSync(p, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    /* no existing .env — fine */
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Wizard steps
 * ------------------------------------------------------------------ */

interface Answers {
  target: Target;
  defaultEngine: Engine;
  engines: Engine[];
  telegramBotToken: string;
  botUsername?: string;
  allowedUserIds: number[];
  claudeOauthToken?: string;
}

function banner() {
  log();
  log(bold(cyan('  Cloud Code — setup wizard')));
  log(dim('  A Telegram bot that runs Claude Code / Codex on your machine or a GCP VM.'));
  log(dim('  Ctrl-C aborts at any time — just run `npm run setup` again to resume.'));
  log();
}

function installHint(tool: string): string {
  switch (tool) {
    case 'git':
      return 'install Xcode Command Line Tools: xcode-select --install';
    case 'gh':
      return 'https://cli.github.com  (brew install gh)';
    case 'claude':
      return 'https://docs.claude.com/claude-code  (npm i -g @anthropic-ai/claude-code)';
    case 'codex':
      return 'https://github.com/openai/codex  (npm i -g @openai/codex)';
    case 'gcloud':
      return 'https://cloud.google.com/sdk/docs/install';
    default:
      return '';
  }
}

/** Print a single prerequisite line. Returns whether the tool is present. */
function reportTool(label: string, key: string, probe: { found: boolean; version?: string }): boolean {
  if (probe.found) {
    log(`  ${OK} ${label}${probe.version ? dim(` (${probe.version})`) : ''}`);
    return true;
  }
  log(`  ${NO} ${label} — ${dim(installHint(key))}`);
  return false;
}

async function stepPrerequisites(target: Target, engine: Engine): Promise<boolean> {
  log(bold('\nPrerequisites'));
  log(dim('  checking installed tools…' + (engine === 'claude' ? " (claude's CLI can take a few seconds)" : '')));
  const nodeProbe = probeVersion('node');
  const nodeVerOut = nodeProbe.version ? `v${nodeProbe.version}` : '';
  const major = nodeMajor(nodeVerOut || process.version);
  if (major !== undefined && major >= 22) {
    log(`  ${OK} node ${dim(`(${nodeProbe.version ?? process.version})`)}`);
  } else {
    log(`  ${WARN} node ${dim(`(${nodeProbe.version ?? process.version})`)} — Node 22+ recommended`);
  }

  let allRequired = true;
  allRequired = reportTool('git', 'git', probeVersion('git')) && allRequired;
  allRequired = reportTool('gh (GitHub CLI)', 'gh', probeVersion('gh')) && allRequired;

  const engineProbe = probeVersion(engine);
  allRequired = reportTool(engine === 'claude' ? 'claude (Claude Code)' : 'codex (Codex CLI)', engine, engineProbe) && allRequired;

  if (target === 'cloud') {
    allRequired = reportTool('gcloud', 'gcloud', probeVersion('gcloud')) && allRequired;
  }

  if (!allRequired) {
    log(red('\n  Some required tools are missing.'));
    return confirm('  Continue anyway?', false);
  }
  return true;
}

async function stepProviderAuth(
  answers: Answers,
  engine: Engine,
  existing: Record<string, string>,
): Promise<void> {
  log(bold(`\nProvider auth — ${engine === 'claude' ? 'Claude Code' : 'Codex'}`));

  if (engine === 'claude') {
    if (answers.target === 'local') {
      const probe = probeVersion('claude');
      if (probe.found) {
        log(`  ${OK} claude CLI is usable ${dim(`(${probe.version ?? ''})`)}`);
        log(dim('  On macOS Claude Code signs in via the Keychain — no token stored in .env.'));
        log(dim('  If runs fail with an auth error, run `claude` once and log in interactively.'));
      } else {
        log(`  ${WARN} claude CLI not detected — install it, then run \`claude\` once to log in.`);
      }
      return;
    }

    // cloud: need a long-lived OAuth token
    if (existing.CLAUDE_CODE_OAUTH_TOKEN) {
      log(`  ${OK} existing token found ${dim(maskToken(existing.CLAUDE_CODE_OAUTH_TOKEN))}`);
      if (await confirm('  Reuse it?', true)) {
        answers.claudeOauthToken = existing.CLAUDE_CODE_OAUTH_TOKEN;
        return;
      }
    }
    log(dim('  Cloud VMs are headless — Claude needs a long-lived OAuth token.'));
    if (await confirm('  Run `claude setup-token` now?', true)) {
      const { stdout: out } = await runCapture('claude', ['setup-token']);
      const m = out.match(/sk-ant-oat[\w-]+/);
      if (m) {
        answers.claudeOauthToken = m[0];
        log(`  ${OK} captured token ${dim(maskToken(m[0]))}`);
        return;
      }
      log(`  ${WARN} could not auto-capture the token from the output.`);
    }
    const pasted = await ask('  Paste the sk-ant-oat… token');
    if (pasted) {
      answers.claudeOauthToken = pasted;
      log(`  ${OK} stored token ${dim(maskToken(pasted))}`);
    } else {
      log(`  ${WARN} no token stored — cloud Claude will not authenticate without it.`);
    }
    return;
  }

  // codex
  const authPath = path.join(process.env.HOME ?? '', '.codex', 'auth.json');
  while (true) {
    if (fs.existsSync(authPath)) {
      log(`  ${OK} Codex auth found at ${dim('~/.codex/auth.json')}`);
      return;
    }
    log(`  ${NO} no ~/.codex/auth.json yet.`);
    log(dim('  Run `codex login` (or `codex` then /login) in another terminal to sign in.'));
    if (!(await confirm('  I have logged in — re-check?', true))) {
      log(`  ${WARN} continuing without Codex auth — the engine will fail until you log in.`);
      return;
    }
  }
}

async function stepGitHub(): Promise<void> {
  log(bold('\nGitHub'));
  while (true) {
    const state = parseGhAuthStatus(run('gh', ['auth', 'status']));
    if (state.loggedIn) {
      log(`  ${OK} gh authenticated${state.account ? dim(` as ${state.account}`) : ''}`);
      return;
    }
    log(`  ${NO} gh is not logged in.`);
    if (await confirm('  Run `gh auth login` now?', true)) {
      await runInteractive('gh', ['auth', 'login']);
      continue;
    }
    if (!(await confirm('  Re-check gh auth?', true))) {
      log(`  ${WARN} continuing without GitHub — repo operations will fail until you log in.`);
      return;
    }
  }
}

async function stepTelegramBot(answers: Answers, existing: Record<string, string>): Promise<void> {
  log(bold('\nTelegram bot'));
  log(`  1. Open ${cyan('https://t.me/BotFather')} and send ${bold('/newbot')}.`);
  log('  2. Choose a name and a username ending in "bot".');
  log('  3. BotFather replies with an HTTP API token — paste it below.');

  const def = existing.TELEGRAM_BOT_TOKEN;
  while (true) {
    const token = await ask('  Bot token', def ? maskToken(def) : undefined);
    // If the user accepted the masked default, reuse the real one.
    const real = def && token === maskToken(def) ? def : token;
    if (!isValidBotTokenShape(real)) {
      log(`  ${NO} that does not look like a bot token (expected 123456:ABC…). Try again.`);
      continue;
    }
    log(`  ${WAIT} verifying via getMe…`);
    let me;
    try {
      me = parseGetMe(await tg(real, 'getMe'));
    } catch (e) {
      log(`  ${NO} network error contacting Telegram: ${dim(String(e))}`);
      continue;
    }
    if (me.ok) {
      answers.telegramBotToken = real;
      answers.botUsername = me.username;
      log(`  ${OK} token valid — bot is ${bold('@' + (me.username ?? '?'))}`);
      return;
    }
    log(`  ${NO} Telegram rejected the token: ${dim(me.error ?? 'unknown')}. Try again.`);
  }
}

/** Long-poll getUpdates until `pick` returns a value or timeout (ms). */
async function pollUpdates<T>(
  token: string,
  pick: (payload: unknown) => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let offset: number | undefined;
  while (Date.now() < deadline) {
    let payload: unknown;
    try {
      payload = await tg(token, 'getUpdates', { timeout: 25, offset });
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const hit = pick(payload);
    if (hit !== undefined) return hit;
    // advance offset past what we've seen so long-poll doesn't re-serve them
    const arr = (payload as { result?: { update_id?: number }[] })?.result;
    if (Array.isArray(arr) && arr.length > 0) {
      const last = arr[arr.length - 1]?.update_id;
      if (typeof last === 'number') offset = last + 1;
    }
  }
  return undefined;
}

async function stepOwnerId(answers: Answers, existing: Record<string, string>): Promise<void> {
  log(bold('\nOwner user id'));
  const existingIds = existing.ALLOWED_USER_IDS;
  if (existingIds) {
    log(`  ${dim('existing:')} ${existingIds}`);
    if (await confirm('  Reuse the existing allowed user id(s)?', true)) {
      answers.allowedUserIds = existingIds
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (answers.allowedUserIds.length) return;
    }
  }

  log(`  Open ${cyan('https://t.me/' + (answers.botUsername ?? 'your_bot'))}, press ${bold('Start')} and send any message.`);
  log(dim('  Waiting up to 5 minutes for your message… (Ctrl-C to cancel and enter it manually)'));
  const user = await pollUpdates(answers.telegramBotToken, captureUser, 5 * 60_000);
  if (user) {
    log(`  ${OK} captured id ${bold(String(user.id))}${user.firstName ? dim(` (${user.firstName})`) : ''}`);
    answers.allowedUserIds = [user.id];
    return;
  }

  log(`  ${WARN} no message captured.`);
  while (true) {
    const manual = await ask('  Enter your Telegram user id manually (e.g. via @userinfobot)');
    const n = Number(manual);
    if (Number.isInteger(n) && n > 0) {
      answers.allowedUserIds = [n];
      return;
    }
    log(red('  That is not a valid numeric id.'));
  }
}

async function stepGroup(answers: Answers): Promise<void> {
  log(bold('\nGroup verification'));
  log('  Create a Telegram supergroup, then:');
  log('   • enable ' + bold('Topics') + ' (makes it a forum),');
  log('   • add ' + bold('@' + (answers.botUsername ?? 'your_bot')) + ' as an ' + bold('administrator') + ',');
  log('   • grant it the ' + bold('Manage Topics') + ' permission.');

  while (true) {
    log(dim('\n  Now send any message in that group. Waiting up to 5 minutes…'));
    const chat = await pollUpdates(answers.telegramBotToken, captureSupergroup, 5 * 60_000);
    if (!chat) {
      if (await confirm('  No group message captured. Skip group verification?', false)) return;
      continue;
    }
    log(`  ${WAIT} found group ${bold(chat.title ?? String(chat.id))} — checking configuration…`);
    let chatInfo: unknown;
    let memberInfo: unknown;
    try {
      chatInfo = await tg(answers.telegramBotToken, 'getChat', { chat_id: chat.id });
      const meId = answers.telegramBotToken.split(':')[0];
      memberInfo = await tg(answers.telegramBotToken, 'getChatMember', {
        chat_id: chat.id,
        user_id: Number(meId),
      });
    } catch (e) {
      log(`  ${NO} error querying Telegram: ${dim(String(e))}`);
      continue;
    }
    const chatResult = (chatInfo as { result?: unknown })?.result as
      | { type?: string; is_forum?: boolean; title?: string }
      | undefined;
    const memberResult = (memberInfo as { result?: unknown })?.result as
      | { status?: string; can_manage_topics?: boolean }
      | undefined;
    const v = verifyGroup(chatResult ?? {}, memberResult ?? {});

    log(`   ${v.isForum ? OK : NO} Topics enabled (forum)`);
    log(`   ${v.botIsAdmin ? OK : NO} bot is an administrator`);
    log(`   ${v.canManageTopics ? OK : NO} bot can Manage Topics`);

    if (v.verdict === 'pass') {
      log(`  ${OK} group is ready.`);
      return;
    }
    log(red('  Group is not ready:'));
    v.remediation.forEach((r) => log(`   • ${r}`));
    if (await confirm('  Fixed it — re-check? (No skips verification)', true)) continue;
    return;
  }
}

async function stepSecondEngine(
  answers: Answers,
  existing: Record<string, string>,
): Promise<void> {
  const other: Engine = answers.defaultEngine === 'claude' ? 'codex' : 'claude';
  log(bold('\nSecond engine (optional)'));
  log(dim(`  You set up ${answers.defaultEngine}. You can also configure ${other} now — or skip.`));
  if (!(await confirm(`  Set up ${other} as well?`, false))) {
    log(dim('  Skipped — a single-engine .env is fully valid.'));
    return;
  }
  // Ensure its CLI exists (best-effort report), then run its auth.
  reportTool(other === 'claude' ? 'claude (Claude Code)' : 'codex (Codex CLI)', other, probeVersion(other));
  await stepProviderAuth(answers, other, existing);
  answers.engines.push(other);
}

function writeEnvFile(answers: Answers): { wrote: string; backup?: string } {
  const envPath = path.join(projectRoot, '.env');
  let backup: string | undefined;
  if (fs.existsSync(envPath)) {
    backup = path.join(projectRoot, '.env.bak');
    fs.copyFileSync(envPath, backup);
  }
  const content = buildEnv({
    target: answers.target,
    defaultEngine: answers.defaultEngine,
    engines: answers.engines,
    telegramBotToken: answers.telegramBotToken,
    allowedUserIds: answers.allowedUserIds,
    claudeOauthToken: answers.claudeOauthToken,
  });
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
  return { wrote: envPath, backup };
}

async function stepFinish(answers: Answers): Promise<void> {
  log(bold('\nAll set.'));
  if (answers.target === 'local') {
    const hasModules = fs.existsSync(path.join(projectRoot, 'node_modules'));
    if (!hasModules && (await confirm('  node_modules missing — run `npm install` now?', true))) {
      await runInteractive('npm', ['install']);
    }
    if (await confirm('  Start the bot now with `npm run dev`?', false)) {
      log(dim('  Launching… (Ctrl-C to stop)'));
      await runInteractive('npm', ['run', 'dev']);
    } else {
      log(`\n  Start it any time with: ${bold('npm run dev')}`);
    }
  } else {
    log('  Deploy to your GCP VM with these commands (from the project root):');
    log(`    ${bold('./deploy/01-create-vm.sh')}   ${dim('# create the e2-micro free-tier VM')}`);
    log(`    ${bold('./deploy/02-install.sh')}     ${dim('# install Node, the CLIs and dependencies')}`);
    log(`    ${bold('./deploy/03-push-auth.sh')}   ${dim('# push tokens (same ones prepared in .env)')}`);
    log(`    ${bold('./deploy/04-deploy.sh')}      ${dim('# ship the code and start the systemd service')}`);
    log(dim('\n  Your .env is already prepared; 03-push-auth.sh will use/prompt for the same tokens.'));
  }
  log(`\n  ${green('You are done')} — open your Telegram group and type ${bold('/help')}.`);
  log();
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  rl = readline.createInterface({ input: stdin, output: stdout });
  banner();

  const existing = readExistingEnv();
  if (Object.keys(existing).length > 0) {
    log(`${WARN} An existing .env was found — its values will be offered as defaults.`);
  }

  const target = await choose<Target>(
    '\nWhere will the bot run?',
    [
      { value: 'cloud', label: '☁️  Cloud (GCP VM) — recommended, the intended way' },
      {
        value: 'local',
        label: '💻  Local (this machine) — not the intended mode; quick try/dev only  ' + dim('(Better Call Steinberger)'),
      },
    ],
    (existing.RESOURCE_GUARD === 'off' ? 'local' : 'cloud') as Target,
  );
  if (target === 'local') {
    log(dim("  Heads up: local is the unintended path — Cloud is recommended for real, 24/7 use."));
  }

  const defaultEngine = await choose<Engine>(
    '\nWhich engine do you want to set up first?',
    [
      { value: 'claude', label: 'Claude Code' },
      { value: 'codex', label: 'Codex' },
    ],
    ((existing.DEFAULT_ENGINE as Engine) || 'claude') as Engine,
  );

  const answers: Answers = {
    target,
    defaultEngine,
    engines: [defaultEngine],
    telegramBotToken: '',
    allowedUserIds: [],
  };

  const proceed = await stepPrerequisites(target, defaultEngine);
  if (!proceed) {
    log(red('\nAborting. Install the missing tools and run `npm run setup` again.'));
    rl.close();
    return;
  }

  await stepProviderAuth(answers, defaultEngine, existing);
  await stepGitHub();
  await stepTelegramBot(answers, existing);
  await stepOwnerId(answers, existing);
  await stepGroup(answers);
  await stepSecondEngine(answers, existing);

  const { wrote, backup } = writeEnvFile(answers);
  log(bold('\n.env written'));
  if (backup) log(`  ${dim('backed up previous .env → .env.bak')}`);
  log(`  ${OK} ${wrote} ${dim('(chmod 600)')}`);
  log(dim(`  engines: ${answers.engines.join(', ')} • default: ${answers.defaultEngine} • token: ${maskToken(answers.telegramBotToken)}`));

  await stepFinish(answers);
  rl.close();
}

// Clean Ctrl-C.
process.on('SIGINT', () => {
  log(`\n\n${yellow('Aborted.')} Run ${bold('npm run setup')} again to resume.`);
  process.exit(130);
});

main().catch((e) => {
  // Ctrl-D / closed stdin surfaces as an AbortError — treat it as a clean
  // cancellation, not a crash.
  const name = (e as { name?: string } | undefined)?.name;
  const msg = String((e as { message?: string } | undefined)?.message ?? e);
  if (name === 'AbortError' || /Ctrl\+D|aborted/i.test(msg)) {
    log(`\n\n${yellow('Cancelled.')} Run ${bold('npm run setup')} again to resume.`);
    process.exit(130);
  }
  log(`\n${red('Setup failed:')} ${String((e as { stack?: string })?.stack ?? e)}`);
  process.exit(1);
});
