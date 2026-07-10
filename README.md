# Cloud Code — Telegram-бот для агентного программирования в облаке

Пишешь промпт в Telegram → на GCP VM автономно работает **Claude Code** или **Codex** в отдельном workspace, а весь ход работы — текст агента, вызовы инструментов, команды и ошибки — стримится обратно в чат.

- **Каждый топик форум-группы = отдельная сессия.** Сессии работают параллельно, у каждой свой workspace, очередь и контекст разговора.
- **Многоходовость.** Следующий промпт продолжает тот же разговор через `claude --resume` или `codex exec resume`.
- **Два режима работы.** Можно подключить существующий GitHub-репозиторий, создать новый или открыть обычный агентный чат без репозитория.
- **Полная автономия.** Движки запускаются с `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`: агент сам выполняет команды, правит файлы, коммитит и открывает PR через авторизованный `gh`.
- **Контроль ресурсов и токенов.** Перед запуском проверяются лимиты подписок, память, диск и egress; Token Guard останавливает runaway-запуски.

## Архитектура

```text
Telegram (форум-группа, long polling)
   │
   ▼
grammY bot (Node 22+, systemd на GCP VM)
   │
   ▼
SessionManager (топик → сессия) ──► sessions.json (атомарная запись + .bak)
   │   FIFO-очередь промптов, глобальный лимит параллельных запусков
   │   Token Guard, Resource Guard, учёт usage
   │
   ▼
Engine (AsyncIterable<AgentEvent>)
   ├── claude -p --verbose --output-format stream-json --dangerously-skip-permissions [--resume id]
   └── codex exec [resume id] --json --dangerously-bypass-approvals-and-sandbox
   │
   ▼
Workspace: ~/workspaces/<owner>-<repo>-<topicId>/
```

Для `/chat` создаётся отдельный пустой git-initialized workspace, потому что Codex требует запуск внутри git-репозитория.

Прогресс показывается живыми сообщениями в Telegram. Когда сообщение приближается к лимиту 4096 символов, оно замораживается и вывод продолжается следующим сообщением. Финальный ответ агента приходит отдельно.

## Подготовка

1. Создай бота через [@BotFather](https://t.me/BotFather) и сохрани токен.
2. Создай супергруппу Telegram, включи **Topics** и добавь бота администратором с правом **Manage Topics**.
3. Узнай свой Telegram user id, например через [@userinfobot](https://t.me/userinfobot).
4. Установи и авторизуй локально `gcloud`, `gh`, Claude Code и Codex CLI.

## Локальный запуск

```bash
npm install
cp .env.example .env
# заполни TELEGRAM_BOT_TOKEN и ALLOWED_USER_IDS
npm run dev
```

На macOS `CLAUDE_CODE_OAUTH_TOKEN` обычно не нужен: Claude Code использует Keychain. Codex берёт авторизацию из `~/.codex/auth.json`, а GitHub CLI — из своего логина.

## Деплой на GCP

Скрипты используют текущий `gcloud`-проект. Параметры можно переопределить через env: `VM_NAME`, `GCP_PROJECT`, `GCP_ZONE`, `MACHINE_TYPE`, `BOOT_DISK_SIZE`, `BOOT_DISK_TYPE`.

По умолчанию используется free-tier профиль: `e2-micro`, Ubuntu 24.04 и 30 GB `pd-standard` в поддерживаемом регионе.

```bash
./deploy/01-create-vm.sh    # создать VM
./deploy/02-install.sh      # Node, gh, Claude, Codex, systemd
./deploy/03-push-auth.sh    # .env, Codex auth, gh auth и smoke-тесты
./deploy/04-deploy.sh       # build → upload → restart сервиса
```

Перед `03-push-auth.sh` сгенерируй Claude-токен локально:

```bash
claude setup-token
```

Обновление кода:

```bash
./deploy/04-deploy.sh
```

Логи сервиса:

```bash
sudo journalctl -u coding-bot -f
```

Сырые JSONL-логи движков хранятся в `~/logs/session-*.jsonl`.

## Команды бота

| Команда | Действие |
|---|---|
| `/new owner/repo [claude|codex]` | Создать топик и сессию для существующего репозитория |
| `/create name [private|public] [claude|codex]` | Создать новый GitHub-репозиторий и сразу открыть сессию |
| `/chat [claude|codex]` | Открыть агентный чат без репозитория |
| `/repos` | Выбрать репозиторий из списка GitHub |
| `/sessions` | Показать все сессии и их состояние |
| `/status` | Показать состояние текущей сессии и `git status` |
| `/diff` | Показать текущий `git diff` |
| `/engine claude|codex` | Сменить движок; история переносится кратким handoff-summary |
| `/model [name|default]` | Выбрать модель; внутри одного движка контекст сохраняется |
| `/context` | Показать окно контекста модели и занятое место |
| `/usage` | Показать лимиты подписок, расход бота и состояние VM |
| `/budget 500k|off|default` | Установить per-session лимит Token Guard |
| `/verbose on|off` | Переключить компактный и подробный режим вывода |
| `/stop` | Остановить текущий запуск и очистить очередь сессии |
| `/reset` | Начать новый разговор в том же workspace |
| `/cleanup` | Удалить неиспользуемые workspaces |
| `/help` | Показать справку |

Обычное сообщение в топике отправляется агенту как промпт. Неизвестные slash-команды также передаются движку, поэтому работают кастомные команды Claude Code вроде `/review`.

## Вывод, Token Guard и Resource Guard

### Компактный режим

По умолчанию бот показывает текст агента и короткие строки действий: изменённые файлы, команды, reasoning-заметки и ошибки. Промежуточные сообщения отправляются без звука; уведомление приходит только на финальный итог.

`/verbose on` включает более сырой вывод команд и результатов.

### Token Guard

«Рабочие токены» считаются так:

```text
fresh input + cache creation + output + 0.1 × cache read
```

Дефолтные пороги:

- 100k — тихое предупреждение;
- 250k — жёсткая остановка запуска;
- 200 шагов — дополнительный предохранитель, главным образом для Codex;
- при заполнении 5-часового окна подписки на 90% бот просит подтверждение перед стартом.

Пороги задаются через `GUARD_*` в `.env`, а жёсткий лимит конкретной сессии — через `/budget`.

### Resource Guard

Перед стартом бот может проверять:

- `MemAvailable + SwapFree`;
- заполненность диска workspace;
- месячный исходящий трафик относительно free-tier бюджета.

Настройки находятся в `.env.example`: `RESOURCE_GUARD`, `MIN_FREE_MEM_MB`, `DISK_WARN_PCT`, `DISK_BLOCK_PCT`, `EGRESS_FREE_MB`, `EGRESS_WARN_PCT`.

## Безопасность

- Бот отвечает только пользователям из `ALLOWED_USER_IDS`; остальные апдейты отбрасываются первым middleware.
- `TELEGRAM_BOT_TOKEN` и allowlist удаляются из окружения дочерних процессов.
- Claude не получает ключи Codex/OpenAI, а Codex не получает Claude/Anthropic credentials.
- Полная автономия ограничена отдельной VM. На ней не должно быть важных данных, лишних credentials или широких прав GCP service account.
- Сырые логи могут содержать фрагменты файлов, прочитанных агентом, поэтому каталог логов создаётся с правами `0700`.

## Разработка

```bash
npm run typecheck
npm test
npm run engine-cli -- claude /path/to/repo "промпт"
npm run engine-cli -- codex /path/to/repo "промпт"
```

Тесты покрывают мапперы событий, JSONL fixtures, чанкинг сообщений, store, guards, session manager и GitHub/workspace helpers.
