import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { BotDeps } from './commands.js';
import { registerCommands } from './commands.js';
import { registerTopicHandlers } from './topics.js';

/** Bare bot: api plugins only, no handlers — so the manager can be built on top of bot.api. */
export function createBot(token: string): Bot {
  const bot = new Bot(token);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  return bot;
}

/** Attach middleware and handlers once all deps exist. */
export function setupBot(bot: Bot, deps: BotDeps): void {
  // Owner allowlist — everything else is dropped silently, first.
  const allowed = new Set(deps.cfg.allowedUserIds);
  bot.use(async (ctx, next) => {
    if (!ctx.from || !allowed.has(ctx.from.id)) return;
    await next();
  });

  registerCommands(bot, deps);
  registerTopicHandlers(bot, deps); // generic text handler goes last

  bot.catch((err) => {
    console.error('[bot] update handler error:', err.error);
  });
}

export const BOT_COMMANDS = [
  { command: 'new', description: 'Новая сессия: /new owner/repo [claude|codex]' },
  { command: 'create', description: 'Новый репозиторий с нуля + сессия' },
  { command: 'repos', description: 'Выбрать репозиторий из GitHub' },
  { command: 'sessions', description: 'Список всех сессий' },
  { command: 'status', description: 'Состояние сессии и git status' },
  { command: 'stop', description: 'Остановить текущий запуск' },
  { command: 'diff', description: 'Показать git diff' },
  { command: 'engine', description: 'Сменить движок: claude|codex' },
  { command: 'model', description: 'Модель сессии' },
  { command: 'context', description: 'Окно контекста и занятое место' },
  { command: 'usage', description: 'Лимиты подписок + расход бота + состояние VM' },
  { command: 'cleanup', description: 'Удалить неиспользуемые workspaces' },
  { command: 'budget', description: 'Лимит токенов на запуск: 500k|off|default' },
  { command: 'verbose', description: 'Подробный режим: on|off' },
  { command: 'reset', description: 'Начать разговор заново' },
  { command: 'help', description: 'Справка' },
];
