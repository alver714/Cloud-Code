#!/usr/bin/env bash
# Installs node/gh/claude/codex, directories and the systemd unit on the VM.
cd "$(dirname "$0")"
source ./env.sh

# The first ssh to a new VM generates keys and may ask questions —
# warm up the connection before we take over stdin with the script.
VSSH true

VSSH 'bash -s' < remote-install.sh

echo
echo "✅ Installation finished. Next: ./03-push-auth.sh"
