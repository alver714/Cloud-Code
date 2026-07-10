# Security

Cloud Code runs coding agents with **full autonomy** (`--dangerously-skip-permissions` /
`--dangerously-bypass-approvals-and-sandbox`) that can push to GitHub, spend subscription
credits and touch the host. That power is deliberate — so the design treats the trust
boundary seriously. This document explains the threat model, the hardening in place, and
how to report a vulnerability.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately via GitHub
Security Advisories ("Report a vulnerability" on the Security tab) or by direct message to
the maintainer. We aim to acknowledge within a few days.

## Trust model

The single hard boundary is the **owner allowlist**: `ALLOWED_USER_IDS`. Only those
Telegram user ids can drive the bot — every other update (messages, edits, callbacks,
channel posts, forum events) is dropped by the first middleware. Telegram signs `from.id`,
so it cannot be spoofed via the Bot API.

Everything an allowlisted owner asks the agent to do is, by design, a privileged action.
So the security work focuses on the places where **untrusted input (a cloned repo, the
public network) crosses that privilege** and could act without the owner.

## Hardening in place

- **Isolated, single-purpose VM.** The intended deployment is a dedicated GCP VM created
  with `--no-service-account --no-scopes`, so a compromised agent cannot pull a GCP
  service-account token from the metadata server and pivot into the cloud project. No
  public control plane, no secrets worth stealing beyond the bot's own credentials.
- **systemd sandboxing.** The service runs with `NoNewPrivileges=true`, `ProtectSystem=strict`,
  `PrivateTmp=true` and a narrow `ReadWritePaths`, so an agent run cannot overwrite the
  bot's own code/control plane or escalate via `sudo`.
- **Engine env isolation.** A single `sanitizedChildEnv()` helper strips the bot token and
  cross-provider credentials from every subprocess: a Codex run never sees the Claude
  token and vice versa; `gh`/`git`/preview servers/CI/cleanup never inherit the bot token.
- **Prompt-injection resistance for cross-session memory.** Facts mined from runs are
  sanitized (URLs, shell metacharacters, imperative commands and system paths are rejected),
  repo-scoped, and injected framed explicitly as **data, not instructions** — so a poisoned
  repo cannot plant a durable instruction that steers unrelated future sessions. The memory
  extractor runs in a neutral working directory so a repo's `CLAUDE.md`/`AGENTS.md` cannot
  steer it.
- **Spend and resource guards.** Token Guard caps per-run "work tokens" (soft warn + hard
  stop) and a pre-flight gate declines to start when the subscription window is nearly
  exhausted. Resource Guard keeps a free-tier VM inside its RAM/disk/egress limits.
- **No secrets in argv, logs or history.** Tokens are passed via stdin/`0600` files during
  deploy, stripped from child environments, and masked in any user-facing output. `.env*`
  and `auth.json` are gitignored; a pre-push hook (`scripts/install-hooks.sh`) plus a
  gitleaks CI config (`scripts/secret-scan.workflow.yml`) block secret-shaped strings.
- **Preview exposure is bounded.** `/preview` only tunnels/proxies dev-server ports
  (privileged and well-known service ports like SSH/22 or Postgres/5432 are refused), and
  every preview auto-stops on a TTL.

## Known residual risks (by design or acknowledged)

- A malicious repository the agent is pointed at can still, within a single run, abuse the
  agent's autonomy (that is the inherent nature of full autonomy). Only point the bot at
  repositories you trust, exactly as you would with any coding agent you run yourself.
- Raw engine logs under `~/logs` may contain file contents the agent read; the directory is
  `0700` and stays off the repo.
- The owner's own subscription token lives on the VM because the engine needs it; a repo
  compromise could exfiltrate it. Rotate it if you suspect exposure.

## For contributors

Never commit real credentials, even "masked" ones — a real token with the middle blanked out
is still a real secret. Use obviously-synthetic fixtures (`FAKE…`, `EXAMPLE…`, `0000…`) in
tests. Install the local guard with `scripts/install-hooks.sh`.
