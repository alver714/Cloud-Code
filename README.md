# Cloud Code — Telegram bot for agentic coding in the cloud

> **Do one thing and do it well.**
> One channel (Telegram), one job (autonomous coding), done deeply — not twenty integrations done shallowly.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Tests](https://img.shields.io/badge/tests-289%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![Engines](https://img.shields.io/badge/engines-Claude%20Code%20%2B%20Codex-8a63d2)

You write a prompt in Telegram → **Claude Code** or **Codex** runs autonomously on a GCP VM in a dedicated workspace, and the whole run — the agent's text, tool calls, commands and errors — streams back into the chat.

- **Each topic in a forum group = a separate session.** Sessions run in parallel, each with its own workspace, queue and conversation context.
- **Multi-turn.** The next prompt continues the same conversation via `claude --resume` or `codex exec resume`.
- **Two modes of operation.** You can connect an existing GitHub repository, create a new one, or open a plain agentic chat without a repository.
- **Full autonomy.** Engines run with `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`: the agent runs commands, edits files, commits and opens PRs on its own via an authorized `gh`.
- **Resource and token control.** Before a run starts, subscription limits, memory, disk and egress are checked; Token Guard stops runaway runs.

## Philosophy

*Do one thing and do it well.* Cloud Code is not a everything-bridge. It picks **one channel** (Telegram — a mature mobile client you already have), **one job** (autonomous coding on your own cloud), and goes deep: a real verify loop (preview + CI + fix), subscription-aware spend discipline, cross-engine context, and a security posture treated as a feature rather than an afterthought — see [SECURITY.md](SECURITY.md). Focused, self-hosted, and yours.

## Architecture

```text
Telegram (forum group, long polling)
   │
   ▼
grammY bot (Node 22+, systemd on GCP VM)
   │
   ▼
SessionManager (topic → session) ──► sessions.json (atomic write + .bak)
   │   FIFO prompt queue, global limit on concurrent runs
   │   Token Guard, Resource Guard, usage tracking
   │
   ▼
Engine (AsyncIterable<AgentEvent>)
   ├── claude -p --verbose --output-format stream-json --dangerously-skip-permissions [--resume id]
   └── codex exec [resume id] --json --dangerously-bypass-approvals-and-sandbox
   │
   ▼
Workspace: ~/workspaces/<owner>-<repo>-<topicId>/
```

For `/chat`, a separate empty git-initialized workspace is created, because Codex requires running inside a git repository.

Progress is shown via live-updating messages in Telegram. When a message approaches the 4096-character limit, it is frozen and output continues in the next message. The agent's final response arrives as a separate message.

## Quick start

One line from a fresh machine — clones the repo, installs dependencies and launches the setup wizard:

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/alver714/Cloud-Code/main/install.sh | bash
```

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/alver714/Cloud-Code/main/install.ps1 | iex
```

Already have the repo? Just run:
```bash
npm install && npm run setup
```

`npm run setup` is an interactive wizard that walks you from zero to a working bot: it picks your deployment target, checks prerequisites and auth, guides you through creating the Telegram bot and group (and verifies them live), generates `.env`, and hands you the launch/deploy commands. You only set up **one** engine (Claude Code **or** Codex) — it offers the second one optionally at the end.

The one-liner clones the public repo into `~/cloud-code` (override with `CLOUD_CODE_DIR`) and runs only the local wizard — no hidden network calls.

**Cloud (a GCP VM) is the recommended, intended way to run Cloud Code** — an agent that runs 24/7 without your machine. Running locally with `npm run dev` is for quick evaluation and development only, not the intended mode _(Better Call Steinberger)_.

## Prerequisites

- A **Telegram** account (to create the bot via @BotFather and a supergroup).
- **One** of a **Claude** or a **Codex** subscription — you only need the engine you choose to set up first.
- A **GitHub** account (the bot uses an authorized `gh` to clone, commit and open PRs).
- **Node 22+**.
- **gcloud** — only for the recommended cloud deployment.

## Setup (manual, if you skip the wizard)

1. Create a bot via [@BotFather](https://t.me/BotFather) and save the token.
2. Create a Telegram supergroup, enable **Topics** and add the bot as an administrator with the **Manage Topics** permission.
3. Find out your Telegram user id, e.g. via [@userinfobot](https://t.me/userinfobot).
4. Install and authorize `gcloud`, `gh`, Claude Code and the Codex CLI locally.

## Running locally (quick evaluation only)

Local is **not** the intended mode — use it to try the bot or hack on it, then deploy to the cloud for real use _(Better Call Steinberger)_.

```bash
npm install
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS  (or just run `npm run setup`)
npm run dev
```

On macOS `CLAUDE_CODE_OAUTH_TOKEN` is usually not needed: Claude Code uses the Keychain. Codex takes its authorization from `~/.codex/auth.json`, and the GitHub CLI from its own login.

## Deploying to GCP (recommended)

This is the intended way to run Cloud Code — a bot that stays up 24/7 independently of your machine. The scripts use the current `gcloud` project. Parameters can be overridden via env vars: `VM_NAME`, `GCP_PROJECT`, `GCP_ZONE`, `MACHINE_TYPE`, `BOOT_DISK_SIZE`, `BOOT_DISK_TYPE`.

By default, the free-tier profile is used: `e2-micro`, Ubuntu 24.04 and 30 GB `pd-standard` in a supported region.

```bash
./deploy/01-create-vm.sh    # create the VM
./deploy/02-install.sh      # Node, gh, Claude, Codex, systemd
./deploy/03-push-auth.sh    # .env, Codex auth, gh auth and smoke tests
./deploy/04-deploy.sh       # build → upload → restart the service
```

Before `03-push-auth.sh`, generate a Claude token locally:

```bash
claude setup-token
```

Updating the code:

```bash
./deploy/04-deploy.sh
```

`04-deploy.sh` also bakes the deployed commit SHA into `/opt/coding-bot/VERSION`, which the in-bot updater uses (below).

### In-bot updates (`/update`)

You can update the running bot straight from Telegram, without SSH:

- `/update check` — reports the current vs. latest `main` SHA (from the public GitHub repo) without changing anything.
- `/update` — clones the latest `main` into a temp dir, runs `npm ci` + `npm run build` there, and only after a **verified build** swaps the new `dist/` into `/opt/coding-bot`, syncs prod deps, and restarts. The restart is delegated to systemd (`Restart=always`) — the bot just exits and is relaunched into the new code (the hardened unit can't `sudo systemctl`). `/update` refuses while any run is active (the self-exit would kill it).

Safety: if a build fails, the running bot is left completely untouched. The previous build is kept at `/opt/coding-bot/dist.bak`, so a crash-looping new version can be rolled back over SSH:

```bash
cd /opt/coding-bot && cp -r dist.bak dist && sudo systemctl restart coding-bot
```

Service logs:

```bash
sudo journalctl -u coding-bot -f
```

Raw JSONL engine logs are stored in `~/logs/session-*.jsonl`.

## Bot commands

| Command | Action |
|---|---|
| `/new owner/repo [claude\|codex]` | new session: topic + repository clone |
| `/create name [private\|public] [claude\|codex]` | brand-new GitHub repository from scratch + session |
| `/chat [claude\|codex]` | agentic chat without a repository |
| `/repos` | pick a repository from a GitHub list (inline buttons) |
| `/model` | model keyboard for both engines; switching within an engine happens WITHOUT losing context, switching between engines carries over a brief history summary |
| `/effort [low\|medium\|high\|xhigh\|max\|default]` | reasoning effort for the session (both engines); with no argument — inline buttons |
| `/context` | the selected model's context window and how many tokens are used |
| `/engine claude\|codex` | switch engine (conversation history is carried over as a summary) |
| `/verbose` | verbose mode: raw commands and results (default is compact) |
| `/compact` | condense the conversation into a brief summary and start a fresh session with the same engine (files are untouched) |
| `/goal [text\|off]` | autonomous loop: the agent works in iterations until it answers `GOAL_ACHIEVED` (capped by `GOAL_MAX_ITERATIONS`) |
| `/note <text>` (`/btw`) | a note to the agent for the next run (does not trigger a run itself), one-time |
| `/branch on\|off` | agent works on a `topic-N` branch, main only via PR — protection against conflicts between parallel sessions |
| `/ci` | status of the last CI run; after the agent pushes, the bot watches CI on its own and offers "🔧 Fix it" if it fails |
| `/preview [port] [command]` | live preview: finds a running server / spins up a dev script or static site, public link via Cloudflare tunnel |
| `/fork` | branch the conversation into a new topic (fresh clone/chat workspace, the original topic is untouched) |
| `/export` | export the session history as a Markdown file (no tokens spent) |
| `/review [focus]` | code review of the current changes (native `/review` for Claude, a crafted prompt for Codex) |
| `/init` | create an instructions file for the agent (`CLAUDE.md` for Claude, `AGENTS.md` for Codex) |
| `/memory` | show the repository's instructions file (`CLAUDE.md` / `AGENTS.md`) |
| `/memories [add\|forget]` | the bot's memory: durable facts about you/projects, accumulated across sessions (extracted with Haiku, or GPT-5.4 mini when Claude isn't connected; `BOT_MEMORY=off` disables it) |
| `/skills` | available skills: repository (`.claude/skills`) and global |
| `/mcp` | connected MCP servers for both engines |
| `/usage` | percentage of the 5-hour/weekly windows for both subscriptions + the bot's spend for today |
| `/budget 500k\|off` | per-session Token Guard cap |
| `/stop` | stop the current run + clear the queue |
| `/reset` (`/clear`) | new conversation in the same workspace |
| `/status` | session state + git status |
| `/diff` | current git diff |
| `/sessions` | all sessions with their statuses |
| `/cleanup` | remove unused workspaces |
| `/update [check]` | update the bot itself from GitHub (build + swap + restart); `check` only compares versions |
| `/help` | short help with examples; `/help all` — full catalog |

A regular message in a topic is sent to the agent as a prompt. Unknown slash commands are also passed through to the engine, so custom Claude Code commands like the ones under `.claude/commands` work too.

## Output, Token Guard and Resource Guard

### Compact mode

By default, the bot shows the agent's text and short action lines: changed files, commands, reasoning notes and errors. Intermediate messages are sent silently; a notification is fired only for the final result.

`/verbose on` enables more raw output of commands and results.

### Token Guard

"Work tokens" are counted as:

```text
fresh input + cache creation + output + 0.1 × cache read
```

Default thresholds:

- 100k — silent warning;
- 250k — hard stop of the run;
- 200 steps — an additional safeguard, mainly for Codex;
- when the subscription's 5-hour window reaches 90% full, the bot asks for confirmation before starting.

Thresholds are set via `GUARD_*` in `.env`, and a hard limit for a specific session via `/budget`.

### Resource Guard

Before starting, the bot can check:

- `MemAvailable + SwapFree`;
- how full the workspace disk is;
- monthly outbound traffic against the free-tier budget.

Settings live in `.env.example`: `RESOURCE_GUARD`, `MIN_FREE_MEM_MB`, `DISK_WARN_PCT`, `DISK_BLOCK_PCT`, `EGRESS_FREE_MB`, `EGRESS_WARN_PCT`.

## Security

- The bot only responds to users from `ALLOWED_USER_IDS`; other updates are dropped by the first middleware.
- `TELEGRAM_BOT_TOKEN` and the allowlist are stripped from child processes' environment.
- Claude does not get Codex/OpenAI keys, and Codex does not get Claude/Anthropic credentials.
- Full autonomy is confined to a dedicated VM. It should hold no important data, no extraneous credentials, and no broad GCP service account permissions.
- Raw logs may contain fragments of files read by the agent, so the log directory is created with `0700` permissions.

## Development

```bash
npm run typecheck
npm test
npm run engine-cli -- claude /path/to/repo "prompt"
npm run engine-cli -- codex /path/to/repo "prompt"
```

Tests cover event mappers, JSONL fixtures, message chunking, the store, guards, the session manager and GitHub/workspace helpers.

## License

[AGPL-3.0-or-later](LICENSE). You may use, study, modify and self-host it freely; if you run a modified version as a network service, the AGPL requires you to offer your changes' source to its users. As the sole copyright holder, the author can also grant commercial/dual licenses on request.
