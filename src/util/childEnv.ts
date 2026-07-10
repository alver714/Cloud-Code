/**
 * Single source of truth for subprocess environment sanitization. Every place
 * the bot spawns a child (engines, gh/git, du, cloudflared, preview servers,
 * the memory extractor, `codex app-server`, `<engine> mcp list`) must build its
 * env through this helper — the deny-list used to be duplicated in ~5 files
 * with divergent lists, which is exactly how the codex app-server ended up
 * seeing Claude credentials.
 *
 * Rules:
 * - The bot's own secrets (TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS) are ALWAYS
 *   stripped: no child ever has business reading them.
 * - Provider credentials are stripped unless the child is (or drives) that
 *   engine: a codex process must not see the Claude OAuth token and vice versa.
 */
export interface ChildEnvOptions {
  /** Keep Claude credentials (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY). */
  keepClaude?: boolean;
  /** Keep Codex credentials (OPENAI_API_KEY). */
  keepCodex?: boolean;
  /** Extra variables to set on top of the sanitized environment. */
  extra?: Record<string, string>;
}

export function sanitizedChildEnv(opts: ChildEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.extra };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.ALLOWED_USER_IDS;
  if (!opts.keepClaude) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  }
  if (!opts.keepCodex) {
    delete env.OPENAI_API_KEY;
  }
  return env;
}
