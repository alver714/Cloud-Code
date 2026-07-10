#!/usr/bin/env bash
# Builds the bot locally, uploads dist to the VM, installs prod dependencies, restarts the service.
cd "$(dirname "$0")/.."
source deploy/env.sh

echo "== local build =="
npm run build

echo "== upload → VM =="
tar czf - dist package.json package-lock.json |
  VSSH 'mkdir -p /opt/coding-bot && tar xzf - -C /opt/coding-bot &&
        cd /opt/coding-bot &&
        npm ci --omit=dev --no-audit --no-fund &&
        sudo systemctl restart coding-bot'

echo "== status =="
sleep 2
VSSH 'sudo systemctl --no-pager -l status coding-bot | head -12; echo; sudo journalctl -u coding-bot -n 10 --no-pager'

echo
echo "✅ Deployed."
