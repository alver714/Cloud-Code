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
  { command: 'new', description: 'New session: /new owner/repo [claude|codex]' },
  { command: 'create', description: 'New repository from scratch + session' },
  { command: 'chat', description: 'Chat with the agent without a repository' },
  { command: 'repos', description: 'Pick a repository from GitHub' },
  { command: 'sessions', description: 'List all sessions' },
  { command: 'status', description: 'Session state and git status' },
  { command: 'preview', description: 'Live preview: dev server + public link' },
  { command: 'stop', description: 'Stop the current run' },
  { command: 'diff', description: 'Show git diff' },
  { command: 'engine', description: 'Switch engine: claude|codex' },
  { command: 'model', description: 'Session model' },
  { command: 'effort', description: 'Reasoning effort: low|medium|high|xhigh|max|default' },
  { command: 'context', description: 'Context window and space used' },
  { command: 'goal', description: 'Autonomous loop until the goal is met: text|off' },
  { command: 'note', description: 'Note to the agent for the next run (alias /btw)' },
  { command: 'branch', description: 'Agent works in the topic-N branch: on|off' },
  { command: 'ci', description: 'Status of the latest CI run' },
  { command: 'usage', description: 'Subscription limits + bot spend + VM state' },
  { command: 'cleanup', description: 'Remove unused workspaces' },
  { command: 'budget', description: 'Token limit per run: 500k|off|default' },
  { command: 'verbose', description: 'Verbose mode: on|off' },
  { command: 'compact', description: 'Compact the conversation into a summary' },
  { command: 'fork', description: 'Branch the conversation into a new topic' },
  { command: 'export', description: 'Export the session history as a file' },
  { command: 'review', description: 'Code review of the current changes' },
  { command: 'init', description: 'Create the agent instructions file (CLAUDE.md/AGENTS.md)' },
  { command: 'memory', description: 'Show the repository instructions file (CLAUDE.md/AGENTS.md)' },
  { command: 'memories', description: 'Bot memory: facts across sessions (add|forget)' },
  { command: 'skills', description: 'Available skills' },
  { command: 'mcp', description: 'Connected MCP servers' },
  { command: 'reset', description: 'Reset the conversation' },
  { command: 'clear', description: 'Reset the conversation (alias /reset)' },
  { command: 'help', description: 'Help' },
];
