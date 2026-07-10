import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { fmtResetTime, getTopicId, reply, sendRepoKeyboard, type BotDeps } from './commands.js';

/**
 * Prompts blocked by a confirm-with-button pre-flight gate (subscription window
 * OR egress budget), awaiting a user "force". Keyed by `chatId:topicId`,
 * single-slot (a newer block for the same topic replaces the older prompt).
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

/**
 * Shared confirm flow for every "soft" pre-flight block: remember the prompt so
 * the 🚀 force callback can resubmit it, and show the same 🚀/✋ keyboard.
 */
async function sendForceConfirm(
  ctx: Context,
  chatId: number,
  topicId: number,
  prompt: string,
  text: string,
): Promise<void> {
  rememberPending(chatId, topicId, prompt);
  const kb = new InlineKeyboard()
    .text('🚀 Run', `force:${topicId}`)
    .text('✋ Cancel', `forcecancel:${topicId}`);
  await reply(ctx, text, { reply_markup: kb });
}

/** Prompt routing + topic lifecycle. Register AFTER registerCommands. */
export function registerTopicHandlers(bot: Bot, deps: BotDeps): void {
  const { store, manager } = deps;

  // 🚀 Run — re-submit the blocked prompt, bypassing the pre-flight gate.
  bot.callbackQuery(/^force:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const topicId = Number(ctx.match[1]);
    const key = chatId !== undefined ? `${chatId}:${topicId}` : undefined;
    const prompt = key !== undefined ? pendingForced.get(key) : undefined;
    // Stale keyboard (bot restarted / already consumed) — don't act on nothing.
    if (chatId === undefined || key === undefined || prompt === undefined) {
      await ctx
        .answerCallbackQuery({ text: 'Request is stale — send the prompt again.' })
        .catch(() => undefined);
      return;
    }
    pendingForced.delete(key);
    const session = store.get(chatId, topicId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Session not found.' }).catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Running…' }).catch(() => undefined);
    const res = await manager.submitPrompt(session, prompt, { bypassPreflight: true });
    if (res.status === 'queued') {
      await reply(ctx, `⏸ Queued (#${res.position}). Stop everything: /stop`, {
        disable_notification: true,
      });
    }
  });

  // ✋ Cancel — drop the blocked prompt.
  bot.callbackQuery(/^forcecancel:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const topicId = Number(ctx.match[1]);
    if (chatId !== undefined) pendingForced.delete(`${chatId}:${topicId}`);
    await ctx.answerCallbackQuery({ text: 'Cancelled.' }).catch(() => undefined);
  });

  // A user created a topic by hand — offer to bind a repo right away.
  // Telegram lets you edit messages, but restarting an agent run on an edit
  // is dangerous — we honestly say the edit won't be picked up.
  bot.on('edited_message:text', async (ctx) => {
    const msg = ctx.editedMessage;
    if (!msg || ctx.chat?.type === 'private') return;
    const topicId = msg.is_topic_message ? msg.message_thread_id : undefined;
    if (topicId === undefined || !deps.store.get(ctx.chat.id, topicId)) return;
    await ctx.api
      .sendMessage(
        ctx.chat.id,
        "✏️ Message edits aren't picked up — send your correction as a new message.",
        { message_thread_id: topicId, disable_notification: true },
      )
      .catch(() => undefined);
  });

  bot.on('message:forum_topic_created', async (ctx) => {
    await sendRepoKeyboard(ctx, 'New topic 🎉 Bind a repository — this will become a separate session:');
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.msg.text.trim();
    if (!text) return;

    if (ctx.chat.type === 'private') {
      await reply(
        ctx,
        'I work in a forum supergroup: create a group, enable Topics, add me as an admin with the "Manage Topics" permission. Then run /help there.',
      );
      return;
    }

    const topicId = getTopicId(ctx);
    if (topicId === undefined) {
      // General topic: only known commands make sense; ignore other slashes.
      if (!text.startsWith('/')) {
        await reply(ctx, 'This is General — only commands work here (/help). To get to work, create a topic: /new owner/repo or /repos.');
      }
      return;
    }

    const session = store.get(ctx.chat.id, topicId);
    if (!session) {
      await sendRepoKeyboard(ctx, "Topic isn't bound to a repository. Pick one:");
      return;
    }

    // Unknown slash-commands intentionally fall through to the engine
    // (Claude Code custom slash commands like /review).
    const res = await manager.submitPrompt(session, text);
    if (res.status === 'queued') {
      // Run-lifecycle notice, not a direct command reply → send silently.
      await reply(ctx, `⏸ Queued (#${res.position}). Stop everything: /stop`, {
        disable_notification: true,
      });
    } else if (res.status === 'limit-blocked') {
      const pct = Math.round(res.usedPercent);
      const resetPart = res.resetsAt ? ` (reset ${fmtResetTime(res.resetsAt)})` : '';
      await sendForceConfirm(
        ctx,
        ctx.chat.id,
        topicId,
        text,
        `⚠️ Subscription window is ${pct}% full${resetPart}. Run anyway?`,
      );
    } else if (res.status === 'egress-blocked') {
      await sendForceConfirm(
        ctx,
        ctx.chat.id,
        topicId,
        text,
        `🌐 VM outbound traffic: ${res.usedMb} MB of ${res.freeMb} free (${res.usedPct}%). ` +
          'Over the limit ~$0.12/GB. Run?',
      );
    } else if (res.status === 'resource-blocked') {
      await reply(
        ctx,
        res.reason === 'memory'
          ? `⏳ Low memory on the VM (${res.detail} MB left) — wait for the current run to finish`
          : `💾 Disk is almost full (${res.detail}%) — clean up workspaces: /cleanup`,
      );
    }
  });
}
