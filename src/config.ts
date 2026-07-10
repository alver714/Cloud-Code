import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { EngineKind } from './engines/types.js';

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, 'a @BotFather token is required'),
  ALLOWED_USER_IDS: z.string().min(1, 'specify at least one Telegram user id'),
  WORKSPACES_DIR: z.preprocess(emptyToUndefined, z.string().default('~/workspaces')),
  SESSIONS_FILE: z.preprocess(emptyToUndefined, z.string().default('~/.coding-bot/sessions.json')),
  LOGS_DIR: z.preprocess(emptyToUndefined, z.string().default('~/logs')),
  DEFAULT_ENGINE: z.preprocess(emptyToUndefined, z.enum(['claude', 'codex']).default('claude')),
  DEFAULT_MODEL_CLAUDE: z.preprocess(emptyToUndefined, z.string().optional()),
  DEFAULT_MODEL_CODEX: z.preprocess(emptyToUndefined, z.string().optional()),
  // Codex transport: 'exec' (default, safe — one `codex exec` per run) or
  // 'app-server' (shared long-lived JSON-RPC process — live token usage +
  // native interrupt). Flip to 'exec' if the app-server path misbehaves.
  CODEX_TRANSPORT: z.preprocess(emptyToUndefined, z.enum(['exec', 'app-server']).default('exec')),
  // xhigh — the CLI default — inflates subagent fan-out and limit usage
  DEFAULT_EFFORT_CLAUDE: z.preprocess(
    emptyToUndefined,
    z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  ),
  MAX_BUDGET_USD_CLAUDE: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  MAX_CONCURRENT_RUNS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(20).default(3),
  ),
  // Token Guard — live control of a single run's spend ("work tokens").
  // Calibration: an average healthy run is ~85k work tokens — warn
  // only about noticeably heavy ones, otherwise the guard is noisy on every normal run
  GUARD_SOFT_TOKENS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).default(150_000),
  ),
  GUARD_HARD_TOKENS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).default(250_000),
  ),
  GUARD_MAX_STEPS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).default(200)),
  // Maximum autonomous iterations of the /goal loop.
  GOAL_MAX_ITERATIONS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(50).default(10),
  ),
  GUARD_PREFLIGHT_PCT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().min(0).max(100).default(90),
  ),
  // Auto-stop of the live preview (/preview), minutes — to save RAM on e2-micro.
  PREVIEW_TTL_MINUTES: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(5).max(240).default(30),
  ),
  // Cross-session bot memory: accumulates durable facts about the user/projects
  // and mixes a summary into new runs. 'off' — no injection and no extraction.
  BOT_MEMORY: z.preprocess(emptyToUndefined, z.enum(['on', 'off']).default('on')),
  // Resource Guard — keeps the bot within the Always Free tier (e2-micro).
  // 'off' disables pre-start checks, but /usage still shows what it can.
  RESOURCE_GUARD: z.preprocess(emptyToUndefined, z.enum(['on', 'off']).default('on')),
  // Free outbound traffic per month (MB) and warning threshold (%).
  EGRESS_FREE_MB: z.preprocess(emptyToUndefined, z.coerce.number().min(0).default(1024)),
  EGRESS_WARN_PCT: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(100).default(80)),
  // Below this amount of free memory (MemAvailable + SwapFree, MB) new runs do not start.
  MIN_FREE_MEM_MB: z.preprocess(emptyToUndefined, z.coerce.number().min(0).default(300)),
  // Warning and hard-block thresholds for disk fullness (%).
  DISK_WARN_PCT: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(100).default(85)),
  DISK_BLOCK_PCT: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(100).default(95)),
});

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  workspacesDir: string;
  sessionsFile: string;
  logsDir: string;
  defaultEngine: EngineKind;
  defaultModels: Partial<Record<EngineKind, string>>;
  codexTransport: 'exec' | 'app-server';
  defaultEffortClaude: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxBudgetUsdClaude?: number;
  maxConcurrentRuns: number;
  guardSoftTokens: number;
  guardHardTokens: number;
  guardMaxSteps: number;
  guardPreflightPct: number;
  goalMaxIterations: number;
  previewTtlMinutes: number;
  botMemory: boolean;
  resourceGuard: boolean;
  egressFreeMb: number;
  egressWarnPct: number;
  minFreeMemMb: number;
  diskWarnPct: number;
  diskBlockPct: number;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration (.env):\n${issues}`);
  }
  const e = parsed.data;

  const allowedUserIds = e.ALLOWED_USER_IDS.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (allowedUserIds.length === 0) {
    throw new Error('ALLOWED_USER_IDS must contain at least one numeric Telegram user id');
  }

  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    allowedUserIds,
    workspacesDir: expandHome(e.WORKSPACES_DIR),
    sessionsFile: expandHome(e.SESSIONS_FILE),
    logsDir: expandHome(e.LOGS_DIR),
    defaultEngine: e.DEFAULT_ENGINE,
    defaultModels: {
      claude: e.DEFAULT_MODEL_CLAUDE,
      codex: e.DEFAULT_MODEL_CODEX,
    },
    codexTransport: e.CODEX_TRANSPORT,
    defaultEffortClaude: e.DEFAULT_EFFORT_CLAUDE,
    maxBudgetUsdClaude: e.MAX_BUDGET_USD_CLAUDE,
    maxConcurrentRuns: e.MAX_CONCURRENT_RUNS,
    guardSoftTokens: e.GUARD_SOFT_TOKENS,
    guardHardTokens: e.GUARD_HARD_TOKENS,
    guardMaxSteps: e.GUARD_MAX_STEPS,
    guardPreflightPct: e.GUARD_PREFLIGHT_PCT,
    goalMaxIterations: e.GOAL_MAX_ITERATIONS,
    previewTtlMinutes: e.PREVIEW_TTL_MINUTES,
    botMemory: e.BOT_MEMORY === 'on',
    resourceGuard: e.RESOURCE_GUARD === 'on',
    egressFreeMb: e.EGRESS_FREE_MB,
    egressWarnPct: e.EGRESS_WARN_PCT,
    minFreeMemMb: e.MIN_FREE_MEM_MB,
    diskWarnPct: e.DISK_WARN_PCT,
    diskBlockPct: e.DISK_BLOCK_PCT,
  };
}
