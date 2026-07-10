import path from 'node:path';
import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { Config } from '../config.js';
import { CLAUDE_MODELS, CODEX_MODELS, resolveModel } from '../engines/models.js';
import type { EngineKind } from '../engines/types.js';
import { cloneRepo, gitDiff, gitStatusShort, isValidRepo, listRepos, repoShort, workdirName } from '../github/gh.js';
import { parseBudget } from '../sessions/guard.js';
import type { SessionManager } from '../sessions/manager.js';
import type { SessionStore } from '../sessions/store.js';
import type { Session } from '../sessions/types.js';
import type { DayTotals, UsageAccounting } from '../usage/accounting.js';
import {
  readClaudeLimits,
  readCodexLimits,
  type ClaudeLimits,
  type ClaudeWindow,
  type CodexLimits,
  type CodexWindow,
} from '../usage/limits.js';
import { chunkHtmlBlocks, escapeHtml, formatTok, truncate, truncateHtml } from './format.js';

export interface BotDeps {
  cfg: Config;
  store: SessionStore;
  manager: SessionManager;
  accounting: UsageAccounting;
}

/**
 * /repos inline keyboards reference repos by index into this cache.
 * Keyed by `${chatId}:${keyboardMessageId}` so a stale keyboard can't resolve
 * an index against a newer /repos list (which would clone the wrong repo).
 */
const repoCache = new Map<string, string[]>();
const REPO_CACHE_MAX = 50;

function rememberRepos(key: string, repos: string[]): void {
  repoCache.set(key, repos);
  while (repoCache.size > REPO_CACHE_MAX) {
    const oldest = repoCache.keys().next().value;
    if (oldest === undefined) break;
    repoCache.delete(oldest);
  }
}

export const HELP = `🤖 <b>Cloud Code</b> — агентное программирование в облаке

Каждый топик этой форум-группы — отдельная сессия Claude Code или Codex в склонированном GitHub-репозитории. Пиши промпт в топик — агент работает автономно, весь прогресс стримится сюда же. Разные топики работают параллельно, переключение топиков ничего не прерывает.

<b>Команды</b>
/new owner/repo [claude|codex] — новая сессия (топик + клон репозитория)
/repos — выбрать репозиторий из списка GitHub
/engine claude|codex — сменить движок (краткая история разговора переносится)
/model [имя|default] — модель сессии; без имени — кнопки. В пределах движка контекст сохраняется, при смене движка — перенос истории
/usage — лимиты подписок Claude и Codex + расход бота за сегодня
/budget [500k|off|default] — лимит «токенов работы» на запуск для этой сессии (Token Guard)
/verbose [on|off] — подробный/компактный вывод прогресса
/stop — остановить текущий запуск
/reset — начать разговор заново (файлы остаются)
/status — состояние сессии и git status
/diff — текущий git diff
/sessions — все сессии
/help — эта справка

Неизвестные /команды в топике уходят движку как промпт (например /review для Claude).`;

export function getTopicId(ctx: Context): number | undefined {
  const msg = ctx.msg;
  return msg?.is_topic_message ? msg.message_thread_id : undefined;
}

export function reply(ctx: Context, text: string, extra: Record<string, unknown> = {}) {
  return ctx.reply(text, {
    parse_mode: 'HTML',
    message_thread_id: getTopicId(ctx),
    ...extra,
  });
}

function statusGlyph(s: Session): string {
  switch (s.status) {
    case 'running':
      return '🟢';
    case 'error':
      return '🔴';
    default:
      return '⚪';
  }
}

function requireSession(ctx: Context, deps: BotDeps): Session | undefined {
  const topicId = getTopicId(ctx);
  if (!ctx.chat || topicId === undefined) {
    void reply(ctx, 'Эта команда работает внутри топика-сессии.').catch(() => undefined);
    return undefined;
  }
  const session = deps.store.get(ctx.chat.id, topicId);
  if (!session) {
    void reply(ctx, 'Топик не привязан к репозиторию — /repos или /new owner/repo.').catch(
      () => undefined,
    );
    return undefined;
  }
  return session;
}

export async function sendRepoKeyboard(ctx: Context, title: string): Promise<void> {
  if (!ctx.chat) return;
  try {
    const repos = await listRepos(30);
    if (repos.length === 0) {
      await reply(ctx, 'gh не вернул ни одного репозитория. Проверь <code>gh auth status</code>.');
      return;
    }
    const kb = new InlineKeyboard();
    repos.forEach((r, i) => kb.text(r, `repo:${i}`).row());
    const sent = await reply(ctx, title, { reply_markup: kb });
    rememberRepos(`${ctx.chat.id}:${sent.message_id}`, repos);
  } catch (err) {
    await reply(ctx, `❌ Не смог получить список репозиториев:\n<pre>${truncateHtml(escapeHtml(String(err)), 800)}</pre>`);
  }
}

/**
 * Creates (or binds) a session: in General — creates a new forum topic;
 * inside an unbound topic — binds that topic. Then clones the repo.
 */
export async function startSessionFlow(
  ctx: Context,
  deps: BotDeps,
  repo: string,
  engine: EngineKind,
): Promise<void> {
  const { cfg, store } = deps;
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;

  let topicId = getTopicId(ctx);
  if (topicId !== undefined && store.get(chatId, topicId)) {
    await reply(ctx, `Этот топик уже привязан к <code>${escapeHtml(store.get(chatId, topicId)!.repoUrl)}</code>.`);
    return;
  }

  let name = `${repoShort(repo)} · ${engine}`;
  if (topicId === undefined) {
    if (ctx.chat.type !== 'supergroup') {
      await reply(ctx, 'Мне нужна форум-супергруппа с включёнными темами (Topics), где я админ с правом «Manage Topics».');
      return;
    }
    try {
      const topic = await ctx.api.createForumTopic(chatId, name);
      topicId = topic.message_thread_id;
    } catch (err) {
      await reply(
        ctx,
        `❌ Не смог создать топик — проверь, что в группе включены темы и у меня право «Manage Topics».\n<pre>${truncateHtml(escapeHtml(String(err)), 500)}</pre>`,
      );
      return;
    }
  }

  const note = await ctx.api.sendMessage(chatId, `⏳ Клонирую <code>${escapeHtml(repo)}</code>…`, {
    message_thread_id: topicId,
    parse_mode: 'HTML',
  });

  const workdir = path.join(cfg.workspacesDir, workdirName(repo, topicId));
  let cloneResult: 'cloned' | 'reused';
  try {
    cloneResult = await cloneRepo(repo, workdir);
  } catch (err) {
    await ctx.api.editMessageText(
      chatId,
      note.message_id,
      `❌ Клонирование <code>${escapeHtml(repo)}</code> не удалось:\n<pre>${truncateHtml(escapeHtml(String(err)), 1500)}</pre>`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const session: Session = {
    chatId,
    topicId,
    name,
    engine,
    repoUrl: repo,
    workdir,
    status: 'idle',
    createdAt: new Date().toISOString(),
  };
  await store.upsert(session);

  await ctx.api.editMessageText(
    chatId,
    note.message_id,
    [
      `✅ <b>Сессия готова</b>`,
      `📦 <code>${escapeHtml(repo)}</code>${cloneResult === 'reused' ? ' (workspace переиспользован)' : ''}`,
      `🤖 ${engine}`,
      '',
      'Отправь промпт сообщением в этот топик.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}

const HANDOFF_HEADER =
  'Это продолжение разговора, который вёлся с другим ИИ-агентом в этом же репозитории. Краткая история:';
const HANDOFF_BUDGET = 12_000;

/**
 * Build a short natural-language recap of the recent conversation for a
 * cross-engine handoff (native memory can't cross engines). Newest exchanges
 * get priority; the whole thing is kept within ~HANDOFF_BUDGET chars.
 * Returns undefined when there is nothing to carry.
 */
function buildPendingContext(history?: Array<{ prompt: string; answer: string }>): string | undefined {
  if (!history || history.length === 0) return undefined;
  const blocks: string[] = [];
  let total = HANDOFF_HEADER.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const block = `Пользователь: ${history[i]!.prompt}\nАссистент: ${history[i]!.answer}`;
    if (total + block.length + 2 > HANDOFF_BUDGET) {
      // Even the newest exchange overflows — carry a truncated slice of it.
      if (blocks.length === 0) blocks.unshift(block.slice(0, Math.max(0, HANDOFF_BUDGET - total - 2)));
      break;
    }
    blocks.unshift(block);
    total += block.length + 2;
  }
  return `${HANDOFF_HEADER}\n\n${blocks.join('\n\n')}`;
}

/** Switch engine (and optionally model), resetting native context but carrying a recap. */
async function crossEngineHandoff(
  ctx: Context,
  store: SessionStore,
  s: Session,
  targetEngine: EngineKind,
  model?: string,
): Promise<void> {
  s.engine = targetEngine;
  s.model = model;
  s.engineSessionId = undefined;
  s.pendingContext = buildPendingContext(s.history);
  await store.upsert(s);
  await reply(
    ctx,
    `🔁 Движок: <b>${escapeHtml(targetEngine)}</b>, модель: <b>${escapeHtml(model ?? 'дефолт CLI')}</b>. ` +
      'Контекст перенесён кратким пересказом (нативная память между движками невозможна).',
  );
}

/** Set the model within the current engine — native context is preserved. */
async function setSameEngineModel(
  ctx: Context,
  store: SessionStore,
  s: Session,
  name: string | undefined,
  unknown = false,
): Promise<void> {
  s.model = name;
  await store.upsert(s);
  const shown = escapeHtml(name ?? 'дефолт CLI');
  const note = unknown ? ' (неизвестная модель — передам движку как есть)' : '';
  await reply(ctx, `Модель: <b>${shown}</b> — контекст сохранён, применится со следующего промпта${note}.`);
}

async function sendModelKeyboard(ctx: Context, s: Session): Promise<void> {
  const kb = new InlineKeyboard();
  const mark = (engine: EngineKind, m: string) =>
    s.engine === engine && s.model?.toLowerCase() === m ? '✅ ' : '';
  for (const m of CLAUDE_MODELS) kb.text(`${mark('claude', m)}${m}`, `model:claude:${m}`).row();
  for (const m of CODEX_MODELS) kb.text(`${mark('codex', m)}${m}`, `model:codex:${m}`).row();
  const current = s.model ?? 'дефолт CLI';
  await reply(
    ctx,
    `Текущая: <b>${escapeHtml(current)}</b> (${escapeHtml(s.engine)}). ` +
      'Внутри движка контекст сохраняется; при смене движка бот перенесёт краткую историю разговора.',
    { reply_markup: kb },
  );
}

/* ── /usage rendering ─────────────────────────────────────────────────── */

function progressBar(fraction: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

export function fmtResetTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relFromNow(epochSec: number): string {
  const diffMs = epochSec * 1000 - Date.now();
  if (diffMs <= 0) return '';
  const totalMin = Math.round(diffMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? ` (+${h}ч ${m}м)` : ` (+${m}м)`;
}

function resetSuffix(epochSec?: number): string {
  return epochSec ? ` · сброс ${fmtResetTime(epochSec)}${relFromNow(epochSec)}` : '';
}

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-часовое окно',
  seven_day: 'неделя',
};

function orderClaudeWindows(windows: ClaudeWindow[]): ClaudeWindow[] {
  const order = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);
  return [...windows].sort((a, b) => order(a.key) - order(b.key));
}

function renderClaudeWindow(w: ClaudeWindow): string {
  const label = CLAUDE_WINDOW_LABELS[w.key] ?? w.key;
  const pct = Math.round(w.utilization * 100);
  return `${escapeHtml(label)}: ${progressBar(w.utilization)} ${pct}%${resetSuffix(w.resetsAt)}`;
}

function renderCodexWindow(label: string, w: CodexWindow): string {
  const pct = Math.round(w.usedPercent);
  return `${label}: ${progressBar(w.usedPercent / 100)} ${pct}%${resetSuffix(w.resetsAt)}`;
}

/** «Бот сегодня: claude N работ. токенов / M запусков; codex …». */
function renderDailyLine(today: DayTotals): string {
  const parts: string[] = [];
  for (const engine of ['claude', 'codex'] as const) {
    const e = today[engine];
    if (!e) continue;
    let p = `${engine} ${formatTok(e.workTokens)} работ. токенов / ${e.runs} зап.`;
    if (e.guardStops > 0) p += ` · ⛔${e.guardStops}`;
    parts.push(p);
  }
  return parts.length > 0 ? `🤖 <b>Бот сегодня:</b> ${parts.join('; ')}` : '🤖 <b>Бот сегодня:</b> пока пусто';
}

function renderUsage(opts: {
  claude: ClaudeLimits | null;
  claudeTokenMissing: boolean;
  codex: CodexLimits | null;
  today: DayTotals;
}): string {
  const lines: string[] = ['📊 <b>Лимиты подписок</b>', '', '<b>Claude</b>'];
  if (opts.claudeTokenMissing) {
    lines.push('недоступно локально (токен в Keychain) — на VM работает');
  } else if (!opts.claude) {
    lines.push('не удалось получить');
  } else {
    for (const w of orderClaudeWindows(opts.claude.windows)) lines.push(renderClaudeWindow(w));
  }

  lines.push('', '<b>Codex</b>');
  const c = opts.codex;
  if (!c) {
    lines.push('не удалось получить');
  } else {
    if (c.primary) lines.push(renderCodexWindow('5-часовое окно', c.primary));
    if (c.secondary) lines.push(renderCodexWindow('неделя', c.secondary));
    if (c.planType) lines.push(`план: ${escapeHtml(c.planType)}`);
    if (c.resetCreditsAvailable > 0) lines.push(`💳 доступно сбросов лимита: ${c.resetCreditsAvailable}`);
  }

  lines.push('', renderDailyLine(opts.today));
  return lines.join('\n');
}

export function registerCommands(bot: Bot, deps: BotDeps): void {
  const { cfg, store, manager } = deps;

  bot.command(['help', 'start'], (ctx) => reply(ctx, HELP));

  bot.command('new', async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const repo = parts[0] ?? '';
    const engineArg = parts[1];
    const engine = (engineArg ?? cfg.defaultEngine) as EngineKind;
    if (!isValidRepo(repo) || (engineArg && engineArg !== 'claude' && engineArg !== 'codex')) {
      await reply(ctx, 'Формат: <code>/new owner/repo [claude|codex]</code>');
      return;
    }
    await startSessionFlow(ctx, deps, repo, engine);
  });

  bot.command('repos', (ctx) => sendRepoKeyboard(ctx, 'Выбери репозиторий:'));

  bot.callbackQuery(/^repo:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const idx = Number(ctx.match[1]);
    const key = chatId !== undefined ? `${chatId}:${ctx.msg?.message_id}` : undefined;
    const repo = key !== undefined ? repoCache.get(key)?.[idx] : undefined;
    // "query is too old" (клик по старой кнопке) не должен ронять весь flow
    if (!repo) {
      await ctx.answerCallbackQuery({ text: 'Список устарел — вызови /repos ещё раз.' }).catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery().catch(() => undefined);
    await startSessionFlow(ctx, deps, repo, cfg.defaultEngine);
  });

  bot.command('sessions', async (ctx) => {
    const sessions = store.all();
    if (sessions.length === 0) {
      await reply(ctx, 'Сессий пока нет. Создай: /new owner/repo или /repos.');
      return;
    }
    const lines = sessions.map((s) => {
      const queued = manager.queueLength(s.chatId, s.topicId);
      return `${statusGlyph(s)} <b>${escapeHtml(s.name)}</b> — <code>${escapeHtml(s.repoUrl)}</code> — ${s.engine}${
        s.status === 'running' ? ' · выполняется' : ''
      }${queued ? ` · в очереди: ${queued}` : ''}`;
    });
    await reply(ctx, lines.join('\n'));
  });

  bot.command('status', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    let git = '';
    try {
      git = await gitStatusShort(s.workdir);
    } catch (err) {
      git = String(err);
    }
    await reply(
      ctx,
      [
        `${statusGlyph(s)} <b>${escapeHtml(s.name)}</b>`,
        `📦 <code>${escapeHtml(s.repoUrl)}</code>`,
        `🤖 ${s.engine}${s.model ? ` · ${escapeHtml(s.model)}` : ''}`,
        `📂 <code>${escapeHtml(s.workdir)}</code>`,
        `🧵 контекст: ${s.engineSessionId ? `<code>${escapeHtml(s.engineSessionId.slice(0, 8))}…</code>` : 'новый'}`,
        `⏳ очередь: ${manager.queueLength(s.chatId, s.topicId)}`,
        '',
        `<pre>${truncateHtml(escapeHtml(git || 'git: пусто'), 1500)}</pre>`,
      ].join('\n'),
    );
  });

  bot.command('engine', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim();
    if (arg !== 'claude' && arg !== 'codex') {
      await reply(ctx, `Сейчас: <b>${s.engine}</b>. Сменить: <code>/engine claude|codex</code>`);
      return;
    }
    if (arg === s.engine) {
      await reply(ctx, `Уже ${arg}.`);
      return;
    }
    await crossEngineHandoff(ctx, store, s, arg);
  });

  bot.command('model', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim();
    if (!arg) {
      await sendModelKeyboard(ctx, s);
      return;
    }
    if (arg.toLowerCase() === 'default') {
      await setSameEngineModel(ctx, store, s, undefined);
      return;
    }
    const resolved = resolveModel(arg);
    if (!resolved) {
      await setSameEngineModel(ctx, store, s, arg, true);
      return;
    }
    if (resolved.engine === s.engine) {
      await setSameEngineModel(ctx, store, s, resolved.name);
      return;
    }
    await crossEngineHandoff(ctx, store, s, resolved.engine, resolved.name);
  });

  bot.callbackQuery(/^model:(claude|codex):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const s = requireSession(ctx, deps);
    if (!s) return;
    const engine = ctx.match[1] as EngineKind;
    const name = ctx.match[2]!;
    if (engine === s.engine) {
      await setSameEngineModel(ctx, store, s, name);
      return;
    }
    await crossEngineHandoff(ctx, store, s, engine, name);
  });

  bot.command('usage', async (ctx) => {
    const chatId = ctx.chat?.id;
    const note = await reply(ctx, '📊 Собираю лимиты подписок…').catch(() => undefined);
    const claudeTokenMissing = !process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const [claude, codex] = await Promise.all([
      claudeTokenMissing ? Promise.resolve(null) : readClaudeLimits(),
      readCodexLimits(),
    ]);
    const text = renderUsage({ claude, claudeTokenMissing, codex, today: deps.accounting.today() });
    if (chatId !== undefined && note) {
      await ctx.api
        .editMessageText(chatId, note.message_id, text, { parse_mode: 'HTML' })
        .catch(() => reply(ctx, text).catch(() => undefined));
    } else {
      await reply(ctx, text).catch(() => undefined);
    }
  });

  bot.command('budget', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim();
    const globalLabel =
      cfg.guardHardTokens === 0 ? 'выключен' : `${formatTok(cfg.guardHardTokens)} токенов работы`;

    if (!arg) {
      let text: string;
      if (s.budgetTokens === undefined) {
        text = `💰 Бюджет запуска: глобальный лимит (${globalLabel}). Задать свой: <code>/budget 500k</code> · <code>/budget off</code>`;
      } else if (s.budgetTokens === 0) {
        text =
          '💰 Бюджет запуска: <b>выключен</b> для этой сессии (Token Guard по токенам не остановит). ' +
          '<code>/budget 500k</code> — задать лимит, <code>/budget default</code> — вернуть глобальный.';
      } else {
        text =
          `💰 Бюджет запуска: <b>${formatTok(s.budgetTokens)}</b> токенов работы (override сессии). ` +
          '<code>/budget off</code> — выключить, <code>/budget default</code> — вернуть глобальный.';
      }
      await reply(ctx, text);
      return;
    }

    if (arg.toLowerCase() === 'default') {
      s.budgetTokens = undefined;
      await store.upsert(s);
      await reply(ctx, `💰 Бюджет запуска: вернул глобальный лимит (${globalLabel}).`);
      return;
    }

    const parsed = parseBudget(arg);
    if (parsed === null) {
      await reply(
        ctx,
        'Формат: <code>/budget 500k</code> | <code>/budget 500000</code> | <code>/budget off</code> | <code>/budget default</code>',
      );
      return;
    }
    s.budgetTokens = parsed;
    await store.upsert(s);
    await reply(
      ctx,
      parsed === 0
        ? '💰 Token Guard по токенам <b>выключен</b> для этой сессии (шаговый предохранитель, если включён, остаётся).'
        : `💰 Бюджет запуска: <b>${formatTok(parsed)}</b> токенов работы. Превышение остановит запуск — контекст сохранится.`,
    );
  });

  bot.command('stop', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const droppedQueue = manager.clearQueue(s.chatId, s.topicId);
    const stopped = manager.cancel(s.chatId, s.topicId);
    await reply(
      ctx,
      stopped
        ? `⏹ Останавливаю…${droppedQueue ? ` Очередь очищена (${droppedQueue}).` : ''}`
        : droppedQueue
          ? `Очередь очищена (${droppedQueue}), активного запуска не было.`
          : 'Сейчас ничего не запущено.',
    );
  });

  bot.command('verbose', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    const arg = ctx.match.trim().toLowerCase();
    let next: boolean;
    if (arg === 'on') next = true;
    else if (arg === 'off') next = false;
    else if (arg === '') next = !(s.verbose ?? false);
    else {
      await reply(ctx, 'Формат: <code>/verbose</code> | <code>/verbose on</code> | <code>/verbose off</code>');
      return;
    }
    s.verbose = next;
    await store.upsert(s);
    await reply(ctx, `Подробный режим: ${next ? 'вкл' : 'выкл'}`);
  });

  bot.command('reset', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    s.engineSessionId = undefined;
    await store.upsert(s);
    await reply(ctx, '🧹 Контекст сброшен — следующий промпт начнёт новый разговор в том же workspace.');
  });

  bot.command('diff', async (ctx) => {
    const s = requireSession(ctx, deps);
    if (!s) return;
    try {
      const { stat, diff } = await gitDiff(s.workdir);
      if (!stat && !diff) {
        await reply(ctx, 'Изменений нет (git diff пуст).');
        return;
      }
      const blocks: string[] = [];
      if (stat) blocks.push(`<pre><code>${escapeHtml(truncate(stat, 3000))}</code></pre>`);
      if (diff) blocks.push(`<pre><code>${escapeHtml(truncate(diff, 12000))}</code></pre>`);
      for (const chunk of chunkHtmlBlocks(blocks)) {
        await reply(ctx, chunk);
      }
    } catch (err) {
      await reply(ctx, `❌ git diff не сработал:\n<pre>${truncateHtml(escapeHtml(String(err)), 800)}</pre>`);
    }
  });
}
