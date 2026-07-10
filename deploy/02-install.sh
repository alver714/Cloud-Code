#!/usr/bin/env bash
# Ставит на VM node/gh/claude/codex, каталоги и systemd-юнит.
cd "$(dirname "$0")"
source ./env.sh

# Первый ssh к новой VM генерирует ключи и может задавать вопросы —
# прогреваем соединение до того, как займём stdin скриптом.
VSSH true

VSSH 'bash -s' < remote-install.sh

echo
echo "✅ Установка завершена. Дальше: ./03-push-auth.sh"
