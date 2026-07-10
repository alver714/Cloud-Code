#!/usr/bin/env bash
# Runs ON the VM (streamed via 02-install.sh). Idempotent.
set -euo pipefail

echo "== swap (required on e2-micro: 1GB RAM) =="
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 3G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo 'vm.swappiness=20' | sudo tee /etc/sysctl.d/99-swap.conf >/dev/null
  sudo sysctl -p /etc/sysctl.d/99-swap.conf
fi
free -h | head -3

echo "== apt base =="
sudo apt-get update -q
sudo apt-get install -yq git build-essential curl ca-certificates vnstat

echo "== vnstat (egress accounting for Resource Guard) =="
# idempotent: enable --now reinstalls the unit and starts the daemon if needed
sudo systemctl enable --now vnstat
systemctl is-active vnstat || true

echo "== cloudflared (tunnels for /preview) =="
if ! command -v cloudflared >/dev/null; then
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  sudo dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi
cloudflared --version | head -1

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
# the bot kills its own children on SIGTERM
KillMode=mixed
TimeoutStopSec=20
# hardening: the engines still run as the same user as the bot —
# full isolation (a separate non-sudo user) is a separate task.
# NoNewPrivileges: children cannot escalate privileges (sudo/setuid are cut off).
# ProtectSystem=strict: the whole FS is read-only, we write only to the bot code and $HOME
# (workspaces, logs, sessions, ~/.claude, ~/.codex); PrivateTmp gives its own /tmp.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/coding-bot $HOME
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable coding-bot

echo "✅ install done (the service starts after 03-push-auth.sh + 04-deploy.sh)"
