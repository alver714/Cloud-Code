# Claude Code CLI and Codex CLI — Full Command Reference

**Versions:** claude 2.1.204, codex-cli 0.144.0

## Important note: Headless mode (for the Telegram bot and automation)

The following commands work in **headless mode** (no interactive interface), which is required for Telegram bots and other automated scenarios:

### Claude Code CLI (headless mode)
- `claude -p "prompt"` — print the response and exit
- `claude -p` with stdin — analyze piped input
- `claude --output-format json` or `stream-json` — structured output
- `claude --print --include-partial-messages` — streaming output

### Codex CLI (headless mode)
- `codex exec "prompt"` — run without an interactive mode
- `codex exec --json` — output events in JSONL format
- `codex review` — non-interactive code review
- `codex apply <TASK_ID>` — apply the diff from a previous session

---

# Claude Code CLI

An interactive AI coding tool available in the terminal, IDE, app and browser. Reads your codebase, edits files, runs commands and integrates with development tools.

## CLI subcommands

| Command | Description |
|---------|---------|
| `agents` | Manage background agents |
| `auth` | Manage authentication (login, logout, status) |
| `auto-mode` | Check the auto mode classifier configuration |
| `doctor` | Check the health of Claude Code auto-update |
| `gateway` | Run an authentication/telemetry gateway for corporate networks |
| `install` | Install a native Claude Code build |
| `mcp` | Configure and manage MCP servers |
| `plugin` / `plugins` | Manage Claude Code plugins |
| `project` | Manage Claude Code project state |
| `setup-token` | Set up a long-lived authentication token |
| `update` / `upgrade` | Check for updates and install if available |
| `ultrareview` | Cloud multi-agent code review of the current branch or PR |

## Key CLI flags

### Execution modes
| Flag | Description |
|------|---------|
| `-p, --print` | Print the response and exit (headless mode); skips the workspace trust dialog |
| `-c, --continue` | Continue the most recent conversation in the current directory |
| `-r, --resume [value]` | Resume a conversation by session ID or open the interactive picker |
| `--bg, --background` | Start the session as a background agent and return immediately |
| `-w, --worktree [name]` | Create a new git worktree for this session |
| `--from-pr [value]` | Resume the session linked to a PR by number/URL, or open the picker |

### Model and LLM parameters
| Flag | Description |
|------|---------|
| `--model <model>` | Model for the current session (alias: fable, opus, sonnet, or the full claude-* name) |
| `--effort <level>` | Reasoning effort level (low, medium, high, xhigh, max) |
| `--max-budget-usd <amount>` | Maximum dollar amount to spend on API calls (--print only) |
| `--fallback-model <model>` | Automatic fallback to the given model on overload (--print only) |

### Input/output formats
| Flag | Description |
|------|---------|
| `--output-format <format>` | Output format: text (default), json, stream-json (--print only) |
| `--input-format <format>` | Input format: text (default), stream-json (--print only) |
| `--json-schema <schema>` | JSON Schema for validating structured output |
| `--include-partial-messages` | Include partial message chunks while streaming |
| `--replay-user-messages` | Re-emit user messages to stdout for confirmation |

### Permission system
| Flag | Description |
|------|---------|
| `--permission-mode <mode>` | Permission mode: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan |
| `--dangerously-skip-permissions` | Bypass all permission checks (isolated environments only) |
| `--allow-dangerously-skip-permissions` | Enable the ability to skip permissions as an option |

### Tool configuration and restrictions
| Flag | Description |
|------|---------|
| `--tools <tools...>` | List of available tools: "" (disable all), "default", or names (Bash,Edit,Read) |
| `--allowedTools, --allowed-tools <tools...>` | Allow specific tools (e.g. "Bash(git *) Edit") |
| `--disallowedTools, --disallowed-tools <tools...>` | Disallow specific tools |
| `--add-dir <directories...>` | Additional directories for tool access |

### Prompt and context system
| Flag | Description |
|------|---------|
| `--system-prompt <prompt>` | System prompt for the session |
| `--append-system-prompt <prompt>` | Append to the default system prompt |
| `--system-prompt-file <path>` | Load a system prompt from a file |
| `--append-system-prompt-file <path>` | Load and append a system prompt from a file |
| `--exclude-dynamic-system-prompt-sections` | Move sections (cwd, env, git status) into the first user message |

### Settings and configuration
| Flag | Description |
|------|---------|
| `--settings <file-or-json>` | Load additional settings from a JSON file or string |
| `--setting-sources <sources>` | Settings sources to load: user, project, local (comma-separated) |
| `--agent <agent>` | Agent for the current session (overrides the 'agent' setting) |
| `--agents <json>` | JSON object defining custom agents |
| `--effort <level>` | Reasoning effort level for this session |

### MCP (Model Context Protocol)
| Flag | Description |
|------|---------|
| `--mcp-config <configs...>` | Load MCP servers from JSON files or strings |
| `--strict-mcp-config` | Use only MCP servers from --mcp-config |

### Plugins
| Flag | Description |
|------|---------|
| `--plugin-dir <path>` | Load a plugin from a directory or .zip (repeatable) |
| `--plugin-url <url>` | Load a plugin .zip from a URL (repeatable) |

### Operating modes
| Flag | Description |
|------|---------|
| `--bare` | Minimal mode: no hooks, LSP, plugin sync, auto-memory, etc. |
| `--safe-mode` | Start with all customizations disabled (for debugging configuration) |
| `--ide` | Automatically connect to the IDE at startup if available |
| `--chrome` | Enable the Claude in Chrome integration |
| `--no-chrome` | Disable the Claude in Chrome integration |
| `--ax-screen-reader` | Screen-reader-friendly output (plain text, no borders) |
| `--verbose` | Override the verbose mode from configuration |

### Debugging and logging
| Flag | Description |
|------|---------|
| `-d, --debug [filter]` | Enable debug mode with optional filtering (e.g. "api,hooks" or "!1p,!file") |
| `--debug-file <path>` | Write debug logs to a specific file (enables debug mode) |

### Integration and advanced options
| Flag | Description |
|------|---------|
| `--remote-control [name]` | Start an interactive session with Remote Control enabled |
| `--remote-control-session-name-prefix <prefix>` | Prefix for auto-generated Remote Control session names |
| `--brief` | Enable the SendUserMessage tool for agent-user communication |
| `--tmux` | Create a tmux session for the worktree (requires --worktree) |
| `--chrome` | Enable the Claude in Chrome integration |

### Other options
| Flag | Description |
|------|---------|
| `--file <specs...>` | File resources to load at startup (file_id:relative_path) |
| `--fork-session` | On resume, create a new session ID instead of reusing the old one |
| `--session-id <uuid>` | Use a specific session ID for the conversation |
| `--name <name>` | Set the display name for this session |
| `--no-session-persistence` | Disable saving sessions to disk (--print only) |
| `-h, --help` | Show help |
| `-v, --version` | Print the version number |

## Subcommands: detailed reference

### `claude agents`
Manage background agents

**Main flags:**
- `--json` — output active sessions as a JSON array (for scripts)
- `--all` — with --json: include completed sessions
- `--cwd <path>` — show only sessions started in <path>
- `--model <model>` — default model for sessions
- `--effort <level>` — default effort level
- `--agent <agent>` — default agent
- `--mcp-config <config>` — MCP configuration (repeatable)
- `--plugin-dir <path>` — plugin directory (repeatable)
- `--settings <file-or-json>` — settings file or JSON

### `claude auth`
Manage authentication

**Subcommands:**
- `login` — Sign in to an Anthropic account
  - `--claudeai` — Use Claude subscription (default)
  - `--console` — Use Anthropic Console instead of Claude subscription
  - `--sso` — Force the SSO flow
  - `--email <email>` — Pre-fill the email on the login page
- `logout` — Sign out of the account
- `status` — Show authentication status
  - `--json` — Output as JSON (default)
  - `--text` — Human-readable output

### `claude auto-mode`
Check the auto mode configuration

**Subcommands:**
- `config` — Print the effective auto mode configuration as JSON
- `defaults` — Print the default configuration (allow, soft_deny, hard_deny rules)
- `critique` — Get AI feedback on custom auto mode rules

### `claude doctor`
Check the health of Claude Code auto-update

Used to diagnose issues. Skips the workspace trust dialog and starts stdio servers from .mcp.json to run health checks.

### `claude mcp`
Configure and manage MCP servers

**Subcommands:**
- `add <name> <commandOrUrl> [args...]` — Add an MCP server
  - `--transport http` — Use HTTP transport
  - `--header "Header: value"` — Add an HTTP header
- `add-from-claude-desktop` — Import MCP servers from Claude Desktop (Mac, WSL)
- `add-json <name> <json>` — Add an MCP server (stdio/SSE) via JSON
- `list` — Show all configured MCP servers
- `get <name>` — Show details of an MCP server
- `login <name>` — Authenticate with an MCP server (HTTP, SSE, claude.ai connector)
- `logout <name>` — Remove saved OAuth credentials
- `remove <name>` — Remove an MCP server
  - `-f, --force` — Skip confirmation
- `reset-project-choices` — Reset the project's approved/rejected .mcp.json servers
- `serve` — Start the Claude Code MCP server
  - `--port <port>` — Port to listen on
  - `--stdio` — Use stdio instead of WebSocket

### `claude plugin` / `claude plugins`
Manage Claude Code plugins

**Subcommands:**
- `list` — Show installed plugins
- `install <plugin>` — Install a plugin from a marketplace (use `plugin@marketplace` for a specific marketplace)
- `uninstall <plugin>` — Remove a plugin
- `enable <plugin>` — Enable a disabled plugin
- `disable <plugin>` — Disable an enabled plugin
- `init <name>` / `new <name>` — Create a new plugin at ~/.claude/skills/<name>/
- `update <plugin>` — Update a plugin to the latest version
- `details <name>` — Show the component inventory and estimated token cost
- `tag [path]` — Create a git tag for a plugin release
- `validate [path]` — Validate the plugin manifest
- `eval` — Run eval cases for the plugin
- `marketplace` — Manage Claude Code marketplaces
- `prune` / `autoremove` — Remove unneeded auto-installed dependencies

### `claude project`
Manage Claude Code project state

**Subcommands:**
- `purge [path]` — Remove all Claude Code project state (transcripts, tasks, file history, config record)

### `claude setup-token`
Set up a long-lived authentication token (requires a Claude subscription)

Used to create tokens for automated environments, CI/CD, etc.

### `claude update` / `claude upgrade`
Check for updates and install if available

**Flags:**
- No special flags

### `claude install`
Install a native Claude Code build

**Parameters:**
- `[target]` — Version to install (stable, latest, or a specific version)

**Flags:**
- `--force` — Force install even if already installed

### `claude gateway`
Run an authentication/telemetry gateway for corporate networks

**Flags:**
- `--config <path>` — Path to the gateway's YAML config

### `claude ultrareview`
Cloud multi-agent code review of the current branch (or PR/base branch)

**Parameters:**
- `[target]` — PR number, URL, or base branch (optional)

**Flags:**
- `--json` — Print the raw bugs.json instead of formatted output
- `--timeout <minutes>` — Maximum minutes to wait for the review to finish (default: 30)

---

# Slash commands (Claude Code interactive mode)

When running `claude` in interactive mode, the following slash commands are available (type `/` to see the full list in a session):

| Command | Description |
|---------|---------|
| `/help` | Show the list of available commands and help |
| `/login` | Sign in to an account (re-authentication) |
| `/logout` | Sign out of the account |
| `/resume [id]` | Resume a previous conversation by ID or open the picker |
| `/continue` | Continue the last conversation |
| `/clear` | Clear the conversation history |
| `/model [name]` | Show or change the current model |
| `/effort [level]` | Show or change the reasoning effort level (low/medium/high/xhigh/max) |
| `/permission-mode [mode]` | Change the permission mode (auto/manual/dontAsk/plan/bypassPermissions) |
| `/exit` | Exit Claude Code (also Ctrl+D) |
| `/usage` | Show token usage and cost for the current session |
| `/cost` | Show the cost of the last operation |
| `/compact` | Toggle compact display mode |
| `/desktop` | Hand the session off to the Desktop app for visual diff review |
| `/remote-control [name]` | Enable Remote Control for this session |
| `/schedule` | Schedule a task for recurring execution (creates a Routine) |
| `/loop [interval]` | Repeat the current prompt every N seconds/minutes in this session |
| `/agents` | Show the status of background agents |
| `/skill <name>` | Run a custom skill (example: `/review-pr`, `/deploy-staging`) |
| `/mcp-add [name] [url]` | Add an MCP server for the current session |
| `/mcp-list` | Show connected MCP servers |
| `/git` | Perform a git operation (interactive mode for `git` commands) |
| `/review` | Run a code review on the current changes |
| `/hooks` | Show configured hooks and their status |
| `/memory` | Show CLAUDE.md instructions and the project's auto-memory |

**Note:** The full list of slash commands in your version can be seen by typing `/` with no arguments in an interactive session.

---

# Codex CLI

The OpenAI Codex CLI for interactive and non-interactive work with a codebase. Suitable for local use and CI/CD integration.

## CLI subcommands

| Command | Description |
|---------|---------|
| `exec` | Run Codex in non-interactive mode with a prompt |
| `exec resume` | Resume a previous non-interactive session |
| `exec review` | Run a code review in non-interactive mode |
| `review` | Run a code review on the current repository |
| `login` | Manage login and authentication |
| `logout` | Remove saved credentials |
| `mcp` | Manage external MCP servers |
| `plugin` | Manage Codex plugins |
| `mcp-server` | Run Codex as an MCP server (stdio) |
| `app-server` | Run the app server or related tools |
| `remote-control` | Manage the app-server daemon with remote control |
| `app` | Launch the Codex Desktop application |
| `completion` | Generate shell completion scripts |
| `update` | Update Codex to the latest version |
| `doctor` | Diagnose the install, config, authentication and health |
| `sandbox` | Run commands inside a Codex-provided sandbox |
| `debug` | Debugging tools (models, app-server, prompt-input) |
| `apply` | Apply the last diff from a Codex agent via `git apply` |
| `resume` | Resume a previous interactive session |
| `archive` | Archive a saved session |
| `delete` | Permanently delete a saved session |
| `unarchive` | Unarchive a saved session |
| `fork` | Branch off a previous interactive session |
| `cloud` | Work with Codex Cloud tasks |
| `exec-server` | Run a standalone exec-server service |
| `features` | Inspect feature flags |

## Key CLI flags

### Core execution options
| Flag | Description |
|------|---------|
| `[PROMPT]` | Optional user prompt to start the session |
| `-c, --config <key=value>` | Override a configuration value (uses a dotted path for nested values) |
| `--strict-config` | Error out if config.toml contains unknown fields |

### Model and provider
| Flag | Description |
|------|---------|
| `-m, --model <MODEL>` | Model for the agent |
| `--oss` | Use the open-source provider |
| `--local-provider <OSS_PROVIDER>` | Choose the local provider (lmstudio or ollama) |

### Profiles and configuration
| Flag | Description |
|------|---------|
| `-p, --profile <CONFIG_PROFILE>` | Overlay $CODEX_HOME/<name>.config.toml onto the base configuration |
| `--enable <FEATURE>` | Enable a feature (repeatable; equivalent to `-c features.<name>=true`) |
| `--disable <FEATURE>` | Disable a feature (repeatable; equivalent to `-c features.<name>=false`) |

### Sandbox and command execution
| Flag | Description |
|------|---------|
| `-s, --sandbox <SANDBOX_MODE>` | Sandbox policy: read-only, workspace-write, danger-full-access |
| `--dangerously-bypass-approvals-and-sandbox` | Skip all confirmations and run without a sandbox (dangerous) |
| `--dangerously-bypass-hook-trust` | Run hooks without the required trust (dangerous) |
| `-a, --ask-for-approval <APPROVAL_POLICY>` | When to require approval: untrusted, on-request, never |

### Context and directories
| Flag | Description |
|------|---------|
| `-C, --cd <DIR>` | Use the given directory as the working directory |
| `--add-dir <DIR>` | Additional directories for access (repeatable) |

### Integration and connections
| Flag | Description |
|------|---------|
| `--remote <ADDR>` | Connect to a remote app server (ws://host:port, wss://, unix://, unix://PATH) |
| `--remote-auth-token-env <ENV_VAR>` | Environment variable holding the bearer token for the remote connection |
| `--search` | Enable live web search (the web_search tool becomes available without per-call approval) |

### Input and output
| Flag | Description |
|------|---------|
| `-i, --image <FILE>...` | Optional images attached to the initial prompt |
| `--json` | Output events to stdout as JSONL |
| `--no-alt-screen` | Disable the alternate screen mode (inline mode) |
| `--color <COLOR>` | Color options (always, never, auto) |

### Additional flags for `codex exec`
| Flag | Description |
|------|---------|
| `--ephemeral` | Run without saving session files to disk |
| `--ignore-user-config` | Don't load `$CODEX_HOME/config.toml` (auth still uses CODEX_HOME) |
| `--ignore-rules` | Don't load execpolicy `.rules` files |
| `--skip-git-repo-check` | Allow running Codex outside a Git repository |
| `--output-schema <FILE>` | Path to a JSON Schema file for the model's final response |
| `-o, --output-last-message <FILE>` | Save the agent's last message to a file |

## Subcommands: detailed reference

### `codex exec [OPTIONS] [PROMPT]`
Run Codex in non-interactive mode

**Subcommands:**
- `resume` — Resume a previous session by ID or select the most recent one with --last
- `review` — Run a code review of the repository

**Main flags:**
- All flags from the core set, plus:
- `--ephemeral` — Run without saving the session
- `--ignore-user-config` — Don't load the user's config
- `--skip-git-repo-check` — Allow running outside a Git repo
- `--output-schema <FILE>` — JSON Schema for validating the response
- `-o, --output-last-message <FILE>` — Save the last message

### `codex exec review [OPTIONS]`
Run a code review of the repository within `codex exec`

**Flags:**
- `--uncommitted` — Review staged, unstaged and untracked changes
- `--base <BRANCH>` — Review changes against a base branch
- `--commit <SHA>` — Review changes from a commit
- `--title <TITLE>` — Optional commit title to display

### `codex review [OPTIONS] [PROMPT]`
Run a code review in non-interactive mode

**Parameters:**
- `[PROMPT]` — Optional custom review instructions (or `-` to read from stdin)

**Flags:**
- `--uncommitted` — Review staged, unstaged and untracked changes
- `--base <BRANCH>` — Review against a base branch
- `--commit <SHA>` — Review a commit
- `--title <TITLE>` — Title to display

### `codex login [OPTIONS] [COMMAND]`
Manage login and authentication

**Subcommands:**
- `status` — Show login status

**Flags:**
- `--with-api-key` — Read the API key from stdin (e.g. `printenv OPENAI_API_KEY | codex login --with-api-key`)
- `--with-access-token` — Read the access token from stdin
- `--device-auth` — Device flow authentication

### `codex apply [OPTIONS] <TASK_ID>`
Apply the last diff from a Codex agent via `git apply` to the local tree

**Parameters:**
- `<TASK_ID>` — ID of the task whose diff to apply

### `codex sandbox [OPTIONS] [COMMAND]...`
Run commands inside a Codex-provided sandbox

**Parameters:**
- `[COMMAND]...` — Full command arguments to run under seatbelt

**Main flags:**
- `--sandbox-state-json <JSON>` — JSON from `codex/sandbox-state-meta`
- `--permission-profile <NAME>` — Named permission profile
- `--sandbox-state-readable-root <PATH>` — Add a readable root (repeatable)
- `--sandbox-state-disable-network` — Disable direct network access
- `--allow-unix-socket <PATH>` — Allow AF_UNIX sockets
- `--log-denials` — Capture and print sandbox denials

### `codex mcp [OPTIONS] [COMMAND]`
Manage external MCP servers for Codex

**Subcommands:**
- `list` — Show MCP servers
- `get` — Show details of an MCP server
- `add` — Add an MCP server
- `remove` — Remove an MCP server
- `login` — Authenticate with an MCP server
- `logout` — Remove OAuth credentials

### `codex plugin [OPTIONS] [COMMAND]`
Manage Codex plugins

**Subcommands:**
- `list` — Show available plugins from the marketplace
- `add` — Install a plugin from the marketplace
- `remove` — Remove an installed plugin
- `marketplace` — Manage plugin marketplaces

### `codex debug [OPTIONS] <COMMAND>`
Debugging tools

**Subcommands:**
- `models` — Render the raw model catalog as JSON
- `app-server` — App server debugging helper tools
- `prompt-input` — Render the model-visible input list as JSON

### `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`
Resume a previous interactive session

**Parameters:**
- `[SESSION_ID]` — Session UUID or name (if omitted, use --last)
- `[PROMPT]` — Optional prompt for the session

**Flags:**
- `--last` — Continue the most recent session without a picker
- `--all` — Show all sessions (disables cwd filtering)
- `--include-non-interactive` — Include non-interactive sessions

### `codex archive [OPTIONS] <SESSION>`
Archive a saved session

**Parameters:**
- `<SESSION>` — Session ID (UUID) or name

### `codex delete [OPTIONS] <SESSION>`
Permanently delete a saved session

**Parameters:**
- `<SESSION>` — Session ID or name

**Flags:**
- `--force` — Delete without confirmation (requires UUID)

### `codex fork [OPTIONS] [SESSION_ID] [PROMPT]`
Branch off a previous interactive session

**Parameters:**
- `[SESSION_ID]` — Session UUID to branch from
- `[PROMPT]` — Optional prompt for the new session

**Flags:**
- `--last` — Branch off the most recent session
- `--all` — Show all sessions

### `codex unarchive [OPTIONS] <SESSION>`
Unarchive a saved session

**Parameters:**
- `<SESSION>` — Session ID or name

### `codex app-server [OPTIONS] [COMMAND]`
Run the app server or related tools (experimental)

**Subcommands:**
- `daemon` — Manage the local app-server daemon
- `proxy` — Proxy stdio bytes to a running app-server control socket
- `generate-ts` — Generate TypeScript bindings
- `generate-json-schema` — Generate a JSON Schema

**Flags:**
- `--listen <URL>` — Endpoint URL (stdio://, unix://, ws://IP:PORT, off)
- `--stdio` — Use stdio (equivalent to `--listen stdio://`)
- `--ws-auth <MODE>` — WebSocket auth mode (capability-token, signed-bearer-token)

### `codex remote-control [OPTIONS] [COMMAND]`
Manage the app-server daemon with remote control (experimental)

**Subcommands:**
- `start` — Start the app-server daemon with remote control
- `stop` — Stop the app-server daemon
- `pair` — Create and print a short-lived pairing code

**Flags:**
- `--json` — Print machine-readable JSON

### `codex app [OPTIONS] [PATH]`
Launch the Codex Desktop application

**Parameters:**
- `[PATH]` — Workspace path to open (default: .)

**Flags:**
- `--download-url <URL>` — Override the installer download URL

### `codex cloud [OPTIONS] [COMMAND]`
Work with Codex Cloud tasks (experimental)

**Subcommands:**
- `exec` — Submit a new Codex Cloud task without opening the TUI
- `status` — Show the status of a Codex Cloud task
- `list` — List Codex Cloud tasks
- `apply` — Apply a Codex Cloud task's diff locally
- `diff` — Show the unified diff of a Codex Cloud task

### `codex exec-server [OPTIONS]`
Run a standalone exec-server service (experimental)

**Flags:**
- `--listen <URL>` — Endpoint URL (ws://IP:PORT by default, stdio, unix://)
- `--remote <URL>` — Register as a remote environment
- `--environment-id <ID>` — Environment ID to attach to
- `--name <NAME>` — Human-readable environment name
- `--use-agent-identity-auth` — Use Agent Identity auth

### `codex completion [OPTIONS] [SHELL]`
Generate shell completion scripts

**Parameters:**
- `[SHELL]` — Shell to generate for (bash, fish, zsh, elvish, powershell; default: bash)

### `codex update [OPTIONS]`
Update Codex to the latest version

### `codex doctor [OPTIONS]`
Diagnose the local install, config, authentication and health

**Flags:**
- `--json` — Print a machine-readable report (redacted)
- `--summary` — Show only grouped lines and the total count
- `--all` — Expand long lists in the detailed output
- `--no-color` — Disable ANSI colors
- `--ascii` — Use ASCII statuses and separators

### `codex features [OPTIONS] [COMMAND]`
Inspect feature flags

**Subcommands:**
- `list` — Show known features with their stage and effective status
- `enable <FEATURE>` — Enable a feature in config.toml
- `disable <FEATURE>` — Disable a feature in config.toml

---

# Slash commands (Codex interactive mode)

When running an interactive Codex session (without `exec`, `review`, etc.) the following slash commands are available:

| Command | Description |
|---------|---------|
| `/status` | Show the current session status |
| `/model` | Show or change the model |
| `/approvals` | Manage approval requests in the current session |
| `/help` | Show help on available commands |
| `/exit` | Exit the session |

**Note:** The exact list of slash commands may differ by Codex version. Check inside the session by typing `/help`.

---

# Comparison: Claude Code vs Codex

| Aspect | Claude Code | Codex |
|--------|-------------|-------|
| **Provider** | Anthropic | OpenAI |
| **Model** | Claude (2, 3+) | GPT-4, o3 and other OpenAI models |
| **Headless mode** | `-p/--print` with stdin/stdout | `exec`, `review` |
| **Sandbox** | Built-in permission system | Explicit sandbox mode (read-only, workspace-write, danger-full-access) |
| **Interactive commands** | Slash commands (/help, /model, /usage, etc.) | Slash commands (/status, /model, /approvals, etc.) |
| **Plugins** | Marketplace plugin system | Marketplace plugin system |
| **MCP** | Built-in MCP support | MCP support |
| **Cloud mode** | Routines on cloud infrastructure | `codex cloud` (experimental) |
| **Desktop app** | Built-in Codex Desktop app | Optional `codex app` |
| **CI/CD** | GitHub Actions, GitLab, CLI commands | `codex exec` in CI/CD pipelines |

---

# Headless mode usage examples (for the Telegram bot)

## Claude Code
```bash
# Single request with output
claude -p "Explain this code" < input.py

# Structured JSON output
claude -p "Find bugs" --output-format json < code.js

# Streaming output
claude -p "Analyze this" --output-format stream-json < data.log

# Maximum budget
claude -p "Code review" --max-budget-usd 5
```

## Codex
```bash
# Non-interactive execution
codex exec "fix this code" < broken.py

# JSON event output
codex exec "refactor" --json < source.js > events.jsonl

# Code review
codex review --uncommitted

# Applying results
codex apply <TASK_ID>
```

---

**Documentation source:** Claude Code CLI v2.1.204 and Codex CLI v0.144.0
**Compiled:** July 2026
**Documentation language:** English
