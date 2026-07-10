#!/usr/bin/env bash
# Transfers authorization to the VM: .env (telegram + Claude token), ~/.codex/auth.json, gh.
# Secrets never land in the repository or in the argv of remote commands.
cd "$(dirname "$0")"
source ./env.sh

echo "You will need:"
echo "  1) TELEGRAM_BOT_TOKEN — from @BotFather"
echo "  2) ALLOWED_USER_IDS  — your Telegram user id (comma-separated if several)"
echo "  3) CLAUDE_CODE_OAUTH_TOKEN — generate locally: claude setup-token"
echo

read -rp  "TELEGRAM_BOT_TOKEN: " TG_TOKEN
read -rp  "ALLOWED_USER_IDS: " USER_IDS
read -rsp "CLAUDE_CODE_OAUTH_TOKEN: " CLAUDE_TOKEN
echo

TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"' EXIT
cat > "$TMP_ENV" <<EOF
TELEGRAM_BOT_TOKEN=$TG_TOKEN
ALLOWED_USER_IDS=$USER_IDS
CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_TOKEN
WORKSPACES_DIR=~/workspaces
SESSIONS_FILE=~/.coding-bot/sessions.json
LOGS_DIR=~/logs
DEFAULT_ENGINE=claude
DEFAULT_MODEL_CLAUDE=sonnet
DEFAULT_MODEL_CODEX=
DEFAULT_EFFORT_CLAUDE=medium
# e2-micro (1GB RAM): strictly one concurrent run
MAX_CONCURRENT_RUNS=1
GUARD_SOFT_TOKENS=150000
GUARD_HARD_TOKENS=250000
GUARD_MAX_STEPS=200
GUARD_PREFLIGHT_PCT=90
# Resource Guard — staying within the Always Free tier (e2-micro)
RESOURCE_GUARD=on
EGRESS_FREE_MB=1024
EGRESS_WARN_PCT=80
MIN_FREE_MEM_MB=300
DISK_WARN_PCT=85
DISK_BLOCK_PCT=95
EOF

echo "== .env → VM =="
# -p preserves the 0600 perms of the mktemp file — no world-readable window on the VM
GC compute scp --scp-flag="-p" "$TMP_ENV" "$VM_NAME:/opt/coding-bot/.env" --zone="$GCP_ZONE"
VSSH 'chmod 600 /opt/coding-bot/.env'

echo "== codex auth → VM =="
if [[ -f "$HOME/.codex/auth.json" ]]; then
  VSSH 'mkdir -p ~/.codex && chmod 700 ~/.codex'
  GC compute scp --scp-flag="-p" "$HOME/.codex/auth.json" "$VM_NAME:.codex/auth.json" --zone="$GCP_ZONE"
  VSSH 'chmod 600 ~/.codex/auth.json'
else
  echo "⚠️  ~/.codex/auth.json not found — Codex will not work on the VM (log in to codex locally and re-run the script)"
fi

echo "== gh auth → VM =="
gh auth token | VSSH 'gh auth login --with-token && gh auth setup-git && gh auth status'

echo "== git identity (otherwise agent commits go out as user@hostname) =="
VSSH 'login=$(gh api user -q .login) &&
  git config --global user.name "$login" &&
  git config --global user.email "$login@users.noreply.github.com" &&
  echo "git identity: $login"'

echo "== smoke tests on the VM =="
VSSH 'set -a; . /opt/coding-bot/.env; set +a
  echo "--- claude:"; claude -p "Reply with exactly: ok" --output-format text || echo "CLAUDE FAILED"
  echo "--- codex:";  codex exec --skip-git-repo-check "Reply with exactly: ok" 2>/dev/null | tail -2 || echo "CODEX FAILED"'

echo
echo "✅ Auth ready. Next: ./04-deploy.sh"
