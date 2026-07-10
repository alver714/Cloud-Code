import { InlineKeyboard, type Bot } from 'grammy';
import { fmtResetTime, getTopicId, reply, sendRepoKeyboard, type BotDeps } from './commands.js';

/**
 * Prompts blocked by the pre-flight subscription-window gate, awaiting a
 * user "force". Keyed by `chatId:topicId`, single-slot (a newer block for the
 * same topic replaces the older pending prompt).
 */
const pendingForced = new Map<string, string>();
const PENDING_MAX = 100;

function rememberPending(chatId: number, topicId: number, prompt: string): void {
  pendingForced.set(`${chatId}:${topicId}`, prompt);
  while (pendingForced.size > PENDING_MAX) {
    const oldest = pendingForced.keys().next().value;
    if (oldest === undefined) break;
    pendingForced.delete(oldest);
  }
}

/** Prompt routing + topic lifecycle. Register AFTER registerCommands. */
export function registerTopicHandlers(bot: Bot, deps: BotDeps): void {
  const { store, manager } = deps;

  // 🚀 Запустить — re-submit the blocked prompt, bypassing the pre-flight gate.
  bot.callbackQuery(/^force:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const topicId = Number(ctx.match[1]);
    const key = chatId !== undefined ? `${chatId}:${topicId}` : undefined;
    const prompt = key !== undefined ? pendingForced.get(key) : undefined;
    // Stale keyboard (bot restarted / already consumed) — don't act on nothing.
    if (chatId === undefined || key === undefined || prompt === undefined) {
      await ctx
        .answerCallbackQuery({ text: 'Запрос устарел — отправь промпт заново.' })
        .catch(() => undefined);
      return;
    }
    pendingForced.delete(key);
    const session = store.get(chatId, topicId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Сессия не найдена.' }).catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Запускаю…' }).catch(() => undefined);
    const res = await manager.submitPrompt(session, prompt, { bypassPreflight: true });
    if (res.status === 'queued') {
      await reply(ctx, `⏸ Принято, в очереди (№${res.position}). Остановить всё: /stop`, {
        disable_notification: true,
      });
    }
  });

  // ✋ Отмена — drop the blocked prompt.
  bot.callbackQuery(/^forcecancel:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const topicId = Number(ctx.match[1]);
    if (chatId !== undefined) pendingForced.delete(`${chatId}:${topicId}`);
    await ctx.answerCallbackQuery({ text: 'Отменено.' }).catch(() => undefined);
  });

  // A user created a topic by hand — offer to bind a repo right away.
  bot.on('message:forum_topic_created', async (ctx) => {
    await sendRepoKeyboard(ctx, 'Новый топик 🎉 Привяжи репозиторий — это станет отдельной сессией:');
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.msg.text.trim();
    if (!text) return;

    if (ctx.chat.type === 'private') {
      await reply(
        ctx,
        'Я работаю в форум-супергруппе: создай группу, включи темы (Topics), добавь меня админом с правом «Manage Topics». Дальше — /help там.',
      );
      return;
    }

    const topicId = getTopicId(ctx);
    if (topicId === undefined) {
      // General topic: only known commands make sense; ignore other slashes.
      if (!text.startsWith('/')) {
        await reply(ctx, 'Это General — здесь только команды (/help). Для работы создай топик: /new owner/repo или /repos.');
      }
      return;
    }

    const session = store.get(ctx.chat.id, topicId);
    if (!session) {
      await sendRepoKeyboard(ctx, 'Топик не привязан. Выбери репозиторий:');
      return;
    }

    // Unknown slash-commands intentionally fall through to the engine
    // (Claude Code custom slash commands like /review).
    const res = await manager.submitPrompt(session, text);
    if (res.status === 'queued') {
      // Run-lifecycle notice, not a direct command reply → send silently.
      await reply(ctx, `⏸ Принято, в очереди (№${res.position}). Остановить всё: /stop`, {
        disable_notification: true,
      });
    } else if (res.status === 'limit-blocked') {
      const pct = Math.round(res.usedPercent);
      const resetPart = res.resetsAt ? ` (сброс ${fmtResetTime(res.resetsAt)})` : '';
      rememberPending(ctx.chat.id, topicId, text);
      const kb = new InlineKeyboard()
        .text('🚀 Запустить', `force:${topicId}`)
        .text('✋ Отмена', `forcecancel:${topicId}`);
      await reply(ctx, `⚠️ Окно подписки заполнено на ${pct}%${resetPart}. Всё равно запустить?`, {
        reply_markup: kb,
      });
    }
  });
}
