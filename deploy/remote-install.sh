#!/usr/bin/env bash
# Выполняется НА VM (стрим через 02-install.sh). Идемпотентен.
set -euo pipefail

echo "== apt base =="
sudo apt-get update -q
sudo apt-get install -yq git build-essential curl ca-certificates

echo "== node 22 LTS =="
if command -v node >/dev/null; then
  NODE_MAJOR="$(node -v | sed 's/^v//;s/\..*//')"
else
  NODE_MAJOR=0
fi
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -yq nodejs
fi
node -v

echo "== gh CLI =="
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg |
    sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
    sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -q
  sudo apt-get install -yq gh
fi
gh --version | head -1

echo "== engines =="
sudo npm install -g @anthropic-ai/claude-code @openai/codex
claude --version || true
codex --version || true

echo "== layout =="
sudo mkdir -p /opt/coding-bot
sudo chown "$USER" /opt/coding-bot
mkdir -p "$HOME/workspaces" "$HOME/.coding-bot" "$HOME/.codex"
mkdir -p -m 700 "$HOME/logs"

echo "== systemd unit =="
sudo tee /etc/systemd/system/coding-bot.service >/dev/null <<EOF
[Unit]
Description=Cloud Code Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/coding-bot
ExecStart=/usr/bin/node /opt/coding-bot/dist/index.js
EnvironmentFile=/opt/coding-bot/.env
Environment=HOME=$HOME
User=$USER
Restart=always
RestartSec=5
# бот сам гасит детей на SIGTERM
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable coding-bot

echo "✅ install done (сервис стартует после 03-push-auth.sh + 04-deploy.sh)"
