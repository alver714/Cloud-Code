import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { EngineKind } from './engines/types.js';

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, 'нужен токен от @BotFather'),
  ALLOWED_USER_IDS: z.string().min(1, 'укажи хотя бы один Telegram user id'),
  WORKSPACES_DIR: z.preprocess(emptyToUndefined, z.string().default('~/workspaces')),
  SESSIONS_FILE: z.preprocess(emptyToUndefined, z.string().default('~/.coding-bot/sessions.json')),
  LOGS_DIR: z.preprocess(emptyToUndefined, z.string().default('~/logs')),
  DEFAULT_ENGINE: z.preprocess(emptyToUndefined, z.enum(['claude', 'codex']).default('claude')),
  DEFAULT_MODEL_CLAUDE: z.preprocess(emptyToUndefined, z.string().optional()),
  DEFAULT_MODEL_CODEX: z.preprocess(emptyToUndefined, z.string().optional()),
  // xhigh — дефолт CLI — раздувает fan-out субагентов и расход лимитов
  DEFAULT_EFFORT_CLAUDE: z.preprocess(
    emptyToUndefined,
    z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  ),
  MAX_BUDGET_USD_CLAUDE: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  MAX_CONCURRENT_RUNS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(20).default(3),
  ),
  // Token Guard — живой контроль расхода одного запуска ("токены работы").
  GUARD_SOFT_TOKENS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).default(100_000),
  ),
  GUARD_HARD_TOKENS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).default(250_000),
  ),
  GUARD_MAX_STEPS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).default(200)),
  GUARD_PREFLIGHT_PCT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().min(0).max(100).default(90),
  ),
});

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  workspacesDir: string;
  sessionsFile: string;
  logsDir: string;
  defaultEngine: EngineKind;
  defaultModels: Partial<Record<EngineKind, string>>;
  defaultEffortClaude: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxBudgetUsdClaude?: number;
  maxConcurrentRuns: number;
  guardSoftTokens: number;
  guardHardTokens: number;
  guardMaxSteps: number;
  guardPreflightPct: number;
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
    throw new Error(`Некорректная конфигурация (.env):\n${issues}`);
  }
  const e = parsed.data;

  const allowedUserIds = e.ALLOWED_USER_IDS.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (allowedUserIds.length === 0) {
    throw new Error('ALLOWED_USER_IDS должен содержать хотя бы один числовой Telegram user id');
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
    defaultEffortClaude: e.DEFAULT_EFFORT_CLAUDE,
    maxBudgetUsdClaude: e.MAX_BUDGET_USD_CLAUDE,
    maxConcurrentRuns: e.MAX_CONCURRENT_RUNS,
    guardSoftTokens: e.GUARD_SOFT_TOKENS,
    guardHardTokens: e.GUARD_HARD_TOKENS,
    guardMaxSteps: e.GUARD_MAX_STEPS,
    guardPreflightPct: e.GUARD_PREFLIGHT_PCT,
  };
}
