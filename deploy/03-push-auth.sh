#!/usr/bin/env bash
# Переносит авторизацию на VM: .env (телеграм + Claude token), ~/.codex/auth.json, gh.
# Секреты не попадают ни в репозиторий, ни в argv удалённых команд.
cd "$(dirname "$0")"
source ./env.sh

echo "Понадобятся:"
echo "  1) TELEGRAM_BOT_TOKEN — от @BotFather"
echo "  2) ALLOWED_USER_IDS  — твой Telegram user id (можно несколько через запятую)"
echo "  3) CLAUDE_CODE_OAUTH_TOKEN — сгенерируй локально: claude setup-token"
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
# e2-micro (1GB RAM): строго один параллельный запуск
MAX_CONCURRENT_RUNS=1
GUARD_SOFT_TOKENS=100000
GUARD_HARD_TOKENS=250000
GUARD_MAX_STEPS=200
GUARD_PREFLIGHT_PCT=90
# Resource Guard — удержание в пределах Always Free tier (e2-micro)
RESOURCE_GUARD=on
EGRESS_FREE_MB=1024
EGRESS_WARN_PCT=80
MIN_FREE_MEM_MB=300
DISK_WARN_PCT=85
DISK_BLOCK_PCT=95
EOF

echo "== .env → VM =="
# -p сохраняет права 0600 у mktemp-файла — без окна world-readable на VM
GC compute scp --scp-flag="-p" "$TMP_ENV" "$VM_NAME:/opt/coding-bot/.env" --zone="$GCP_ZONE"
VSSH 'chmod 600 /opt/coding-bot/.env'

echo "== codex auth → VM =="
if [[ -f "$HOME/.codex/auth.json" ]]; then
  VSSH 'mkdir -p ~/.codex && chmod 700 ~/.codex'
  GC compute scp --scp-flag="-p" "$HOME/.codex/auth.json" "$VM_NAME:.codex/auth.json" --zone="$GCP_ZONE"
  VSSH 'chmod 600 ~/.codex/auth.json'
else
  echo "⚠️  ~/.codex/auth.json не найден — Codex на VM работать не будет (залогинься локально в codex и перезапусти скрипт)"
fi

echo "== gh auth → VM =="
gh auth token | VSSH 'gh auth login --with-token && gh auth setup-git && gh auth status'

echo "== git identity (иначе коммиты агентов уйдут от user@hostname) =="
VSSH 'login=$(gh api user -q .login) &&
  git config --global user.name "$login" &&
  git config --global user.email "$login@users.noreply.github.com" &&
  echo "git identity: $login"'

echo "== smoke-тесты на VM =="
VSSH 'set -a; . /opt/coding-bot/.env; set +a
  echo "--- claude:"; claude -p "Reply with exactly: ok" --output-format text || echo "CLAUDE FAILED"
  echo "--- codex:";  codex exec --skip-git-repo-check "Reply with exactly: ok" 2>/dev/null | tail -2 || echo "CODEX FAILED"'

echo
echo "✅ Auth готов. Дальше: ./04-deploy.sh"
