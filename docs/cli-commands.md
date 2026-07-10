# Claude Code CLI и Codex CLI — Полный справочник команд

**Версии:** claude 2.1.204, codex-cli 0.144.0

## Важное замечание: Режим Headless (для Telegram-бота и автоматизации)

Следующие команды работают в **headless-режиме** (без интерактивного интерфейса), что необходимо для Telegram-ботов и других автоматизированных сценариев:

### Claude Code CLI (Headless-режим)
- `claude -p "prompt"` — печать ответа и выход
- `claude -p` с stdin — анализ конвейеризованного ввода
- `claude --output-format json` или `stream-json` — структурированный вывод
- `claude --print --include-partial-messages` — потоковый вывод

### Codex CLI (Headless-режим)
- `codex exec "prompt"` — выполнение без интерактивного режима
- `codex exec --json` — вывод событий в формате JSONL
- `codex review` — неинтерактивный код-ревью
- `codex apply <TASK_ID>` — применение diff из предыдущей сессии

---

# Claude Code CLI

Интерактивный инструмент кодирования с ИИ, доступный в терминале, IDE, приложении и браузере. Читает вашу кодовую базу, редактирует файлы, запускает команды и интегрируется с инструментами разработки.

## Подкоманды CLI

| Команда | Описание |
|---------|---------|
| `agents` | Управление фоновыми агентами |
| `auth` | Управление аутентификацией (login, logout, status) |
| `auto-mode` | Проверка конфигурации классификатора автоматического режима |
| `doctor` | Проверка здоровья автоматического обновления Claude Code |
| `gateway` | Запуск шлюза аутентификации/телеметрии для корпоративных сетей |
| `install` | Установка нативной сборки Claude Code |
| `mcp` | Настройка и управление MCP-серверами |
| `plugin` / `plugins` | Управление плагинами Claude Code |
| `project` | Управление состоянием проекта Claude Code |
| `setup-token` | Установка долгосрочного токена аутентификации |
| `update` / `upgrade` | Проверка обновлений и установка если доступна |
| `ultrareview` | Облачный код-ревью с несколькими агентами текущей ветки или PR |

## Ключевые флаги CLI

### Режимы выполнения
| Флаг | Описание |
|------|---------|
| `-p, --print` | Печать ответа и выход (режим headless); пропускает диалог доверия рабочей области |
| `-c, --continue` | Продолжить самую последнюю беседу в текущей директории |
| `-r, --resume [value]` | Возобновить беседу по ID сессии или открыть интерактивный выбор |
| `--bg, --background` | Запустить сессию как фоновый агент и вернуться сразу |
| `-w, --worktree [name]` | Создать новый git worktree для этой сессии |
| `--from-pr [value]` | Возобновить сессию связанную с PR по номеру/URL или открыть выбор |

### Модель и параметры LLM
| Флаг | Описание |
|------|---------|
| `--model <model>` | Модель для текущей сессии (alias: fable, opus, sonnet или полное имя claude-*) |
| `--effort <level>` | Уровень усилий (low, medium, high, xhigh, max) |
| `--max-budget-usd <amount>` | Максимальная сумма в долларах для расходов на API (только --print) |
| `--fallback-model <model>` | Автоматический fallback на указанную модель при перегрузке (только --print) |

### Форматы ввода-вывода
| Флаг | Описание |
|------|---------|
| `--output-format <format>` | Формат вывода: text (по умолчанию), json, stream-json (только --print) |
| `--input-format <format>` | Формат ввода: text (по умолчанию), stream-json (только --print) |
| `--json-schema <schema>` | JSON Schema для валидации структурированного вывода |
| `--include-partial-messages` | Включать частичные фрагменты сообщений при потоковой передаче |
| `--replay-user-messages` | Переотправить пользовательские сообщения на stdout для подтверждения |

### Система разрешений
| Флаг | Описание |
|------|---------|
| `--permission-mode <mode>` | Режим разрешений: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan |
| `--dangerously-skip-permissions` | Обойти все проверки разрешений (только для изолированных сред) |
| `--allow-dangerously-skip-permissions` | Включить возможность пропуска разрешений как опцию |

### Конфигурация инструментов и ограничения
| Флаг | Описание |
|------|---------|
| `--tools <tools...>` | Список доступных инструментов: "" (отключить все), "default", или имена (Bash,Edit,Read) |
| `--allowedTools, --allowed-tools <tools...>` | Разрешить конкретные инструменты (например, "Bash(git *) Edit") |
| `--disallowedTools, --disallowed-tools <tools...>` | Запретить конкретные инструменты |
| `--add-dir <directories...>` | Дополнительные директории для доступа инструментов |

### Система подсказок и контекста
| Флаг | Описание |
|------|---------|
| `--system-prompt <prompt>` | Системный промпт для сессии |
| `--append-system-prompt <prompt>` | Добавить к системному промпту по умолчанию |
| `--system-prompt-file <path>` | Загрузить системный промпт из файла |
| `--append-system-prompt-file <path>` | Загрузить и добавить системный промпт из файла |
| `--exclude-dynamic-system-prompt-sections` | Переместить разделы (cwd, env, git status) в первое пользовательское сообщение |

### Настройки и конфигурация
| Флаг | Описание |
|------|---------|
| `--settings <file-or-json>` | Загрузить дополнительные настройки из JSON файла или строки |
| `--setting-sources <sources>` | Источники настроек для загрузки: user, project, local (через запятую) |
| `--agent <agent>` | Агент для текущей сессии (переопределяет настройку 'agent') |
| `--agents <json>` | JSON объект с определением пользовательских агентов |
| `--effort <level>` | Уровень усилий для этой сессии |

### MCP (Model Context Protocol)
| Флаг | Описание |
|------|---------|
| `--mcp-config <configs...>` | Загрузить MCP-серверы из JSON файлов или строк |
| `--strict-mcp-config` | Использовать только MCP-серверы из --mcp-config |

### Плагины
| Флаг | Описание |
|------|---------|
| `--plugin-dir <path>` | Загрузить плагин из директории или .zip (повторяемо) |
| `--plugin-url <url>` | Загрузить плагин .zip по URL (повторяемо) |

### Режимы работы
| Флаг | Описание |
|------|---------|
| `--bare` | Минимальный режим: без hooks, LSP, синхронизации плагинов, автопамяти и т.д. |
| `--safe-mode` | Запустить со всеми кастомизациями отключёнными (для отладки конфигурации) |
| `--ide` | Автоматически подключиться к IDE при запуске если доступна |
| `--chrome` | Включить интеграцию Claude in Chrome |
| `--no-chrome` | Отключить интеграцию Claude in Chrome |
| `--ax-screen-reader` | Вывод, дружественный скринридерам (плоский текст, без границ) |
| `--verbose` | Переопределить режим verbose из конфигурации |

### Отладка и логирование
| Флаг | Описание |
|------|---------|
| `-d, --debug [filter]` | Включить режим отладки с опциональной фильтрацией (например, "api,hooks" или "!1p,!file") |
| `--debug-file <path>` | Писать логи отладки в конкретный файл (включает режим отладки) |

### Интеграция и расширенные опции
| Флаг | Описание |
|------|---------|
| `--remote-control [name]` | Запустить интерактивную сессию с Remote Control включённым |
| `--remote-control-session-name-prefix <prefix>` | Префикс для автогенерируемых имён Remote Control сессий |
| `--brief` | Включить SendUserMessage tool для коммуникации агент-пользователь |
| `--tmux` | Создать tmux сессию для worktree (требует --worktree) |
| `--chrome` | Включить интеграцию Claude in Chrome |

### Другие опции
| Флаг | Описание |
|------|---------|
| `--file <specs...>` | Файловые ресурсы для загрузки при запуске (file_id:relative_path) |
| `--fork-session` | При резюме создать новый ID сессии вместо переиспользования |
| `--session-id <uuid>` | Использовать конкретный ID сессии для беседы |
| `--name <name>` | Установить отображаемое имя для этой сессии |
| `--no-session-persistence` | Отключить сохранение сессий на диск (только --print) |
| `-h, --help` | Показать справку |
| `-v, --version` | Вывести номер версии |

## Подкоманды: Детальный справочник

### `claude agents`
Управление фоновыми агентами

**Основные флаги:**
- `--json` — вывести активные сессии как JSON массив (для скриптов)
- `--all` — с --json: включить завершённые сессии
- `--cwd <path>` — показывать только сессии запущенные в <path>
- `--model <model>` — модель по умолчанию для сессий
- `--effort <level>` — уровень усилий по умолчанию
- `--agent <agent>` — агент по умолчанию
- `--mcp-config <config>` — конфигурация MCP (повторяемо)
- `--plugin-dir <path>` — директория плагинов (повторяемо)
- `--settings <file-or-json>` — файл или JSON с настройками

### `claude auth`
Управление аутентификацией

**Подкоманды:**
- `login` — Войти в аккаунт Anthropic
  - `--claudeai` — Использовать Claude subscription (по умолчанию)
  - `--console` — Использовать Anthropic Console вместо Claude subscription
  - `--sso` — Принудительный SSO flow
  - `--email <email>` — Предзаполнить email на странице логина
- `logout` — Выйти из аккаунта
- `status` — Показать статус аутентификации
  - `--json` — Вывод как JSON (по умолчанию)
  - `--text` — Человекочитаемый вывод

### `claude auto-mode`
Проверка конфигурации автоматического режима

**Подкоманды:**
- `config` — Вывести эффективную конфигурацию auto mode как JSON
- `defaults` — Вывести стандартную конфигурацию (allow, soft_deny, hard_deny правила)
- `critique` — Получить AI feedback на кастомные auto mode правила

### `claude doctor`
Проверка здоровья автоматического обновления Claude Code

Используется для диагностики проблем. Пропускает диалог доверия рабочей области и запускает stdio серверы из .mcp.json для проверки здоровья.

### `claude mcp`
Настройка и управление MCP-серверами

**Подкоманды:**
- `add <name> <commandOrUrl> [args...]` — Добавить MCP-сервер
  - `--transport http` — Использовать HTTP транспорт
  - `--header "Header: value"` — Добавить HTTP заголовок
- `add-from-claude-desktop` — Импортировать MCP-серверы из Claude Desktop (Mac, WSL)
- `add-json <name> <json>` — Добавить MCP-сервер (stdio/SSE) с JSON
- `list` — Показать все настроенные MCP-серверы
- `get <name>` — Показать детали MCP-сервера
- `login <name>` — Аутентификация с MCP-сервером (HTTP, SSE, claude.ai connector)
- `logout <name>` — Удалить сохранённые OAuth credentials
- `remove <name>` — Удалить MCP-сервер
  - `-f, --force` — Без подтверждения
- `reset-project-choices` — Сбросить одобренные/отклонённые .mcp.json серверы проекта
- `serve` — Запустить Claude Code MCP-сервер
  - `--port <port>` — Порт для слушания
  - `--stdio` — Использовать stdio вместо WebSocket

### `claude plugin` / `claude plugins`
Управление плагинами Claude Code

**Подкоманды:**
- `list` — Показать установленные плагины
- `install <plugin>` — Установить плагин из marketplace (используй `plugin@marketplace` для конкретного marketplace)
- `uninstall <plugin>` — Удалить плагин
- `enable <plugin>` — Включить отключённый плагин
- `disable <plugin>` — Отключить включённый плагин
- `init <name>` / `new <name>` — Создать новый плагин в ~/.claude/skills/<name>/
- `update <plugin>` — Обновить плагин на последнюю версию
- `details <name>` — Показать инвентарь компонентов и прогноз стоимости токенов
- `tag [path]` — Создать git tag для релиза плагина
- `validate [path]` — Валидировать манифест плагина
- `eval` — Запустить eval cases для плагина
- `marketplace` — Управление Claude Code marketplaces
- `prune` / `autoremove` — Удалить ненужные автоустановленные зависимости

### `claude project`
Управление состоянием проекта Claude Code

**Подкоманды:**
- `purge [path]` — Удалить все состояние Claude Code проекта (транскрипты, задачи, историю файлов, запись конфига)

### `claude setup-token`
Установка долгосрочного токена аутентификации (требует Claude subscription)

Используется для создания токенов для автоматизированных окружений, CI/CD, etc.

### `claude update` / `claude upgrade`
Проверка обновлений и установка если доступна

**Флаги:**
- Нет специальных флагов

### `claude install`
Установка нативной сборки Claude Code

**Параметры:**
- `[target]` — Версия для установки (stable, latest, или конкретная версия)

**Флаги:**
- `--force` — Принудительно установить даже если уже установлена

### `claude gateway`
Запуск шлюза аутентификации/телеметрии для корпоративных сетей

**Флаги:**
- `--config <path>` — Путь к YAML конфигу шлюза

### `claude ultrareview`
Облачный код-ревью с несколькими агентами текущей ветки (или PR/base branch)

**Параметры:**
- `[target]` — PR номер, URL или base branch (опционально)

**Флаги:**
- `--json` — Вывести сырую bugs.json вместо форматированного вывода
- `--timeout <minutes>` — Максимум минут ожидания завершения ревью (по умолчанию: 30)

---

# Slash-команды (интерактивный режим Claude Code)

При запуске `claude` интерактивного режима доступны следующие slash-команды (введите `/` чтобы увидеть полный список в сессии):

| Команда | Описание |
|---------|---------|
| `/help` | Показать список доступных команд и помощь |
| `/login` | Войти в аккаунт (переаутентификация) |
| `/logout` | Выйти из аккаунта |
| `/resume [id]` | Возобновить предыдущую беседу по ID или открыть выбор |
| `/continue` | Продолжить последнюю беседу |
| `/clear` | Очистить историю беседы |
| `/model [name]` | Показать или изменить текущую модель |
| `/effort [level]` | Показать или изменить уровень усилий (low/medium/high/xhigh/max) |
| `/permission-mode [mode]` | Изменить режим разрешений (auto/manual/dontAsk/plan/bypassPermissions) |
| `/exit` | Выход из Claude Code (также Ctrl+D) |
| `/usage` | Показать использование токенов и стоимость в текущей сессии |
| `/cost` | Показать стоимость последней операции |
| `/compact` | Переключить компактный режим отображения |
| `/desktop` | Передать сессию в Desktop app для визуального просмотра дифов |
| `/remote-control [name]` | Включить Remote Control для этой сессии |
| `/schedule` | Запланировать задачу для повторяющегося выполнения (создаёт Routine) |
| `/loop [interval]` | Повторить текущий промпт каждые N секунд/минут в этой сессии |
| `/agents` | Показать статус фоновых агентов |
| `/skill <name>` | Выполнить кастомный skill (пример: `/review-pr`, `/deploy-staging`) |
| `/mcp-add [name] [url]` | Добавить MCP-сервер для текущей сессии |
| `/mcp-list` | Показать подключённые MCP-серверы |
| `/git` | Выполнить git операцию (интерактивный режим для `git` команд) |
| `/review` | Запустить code review на текущих изменениях |
| `/hooks` | Показать настроенные hooks и их статус |
| `/memory` | Показать CLAUDE.md инструкции и автопамять проекта |

**Примечание:** Полный список slash-команд в вашей версии можно увидеть, введя `/` без параметров в интерактивной сессии.

---

# Codex CLI

OpenAI Codex CLI для интерактивной и неинтерактивной работы с кодовой базой. Подходит для локального использования и интеграции в CI/CD.

## Подкоманды CLI

| Команда | Описание |
|---------|---------|
| `exec` | Запустить Codex в неинтерактивном режиме с промптом |
| `exec resume` | Возобновить предыдущую неинтерактивную сессию |
| `exec review` | Запустить code review в неинтерактивном режиме |
| `review` | Запустить code review на текущем repository |
| `login` | Управление логином и аутентификацией |
| `logout` | Удалить сохранённые credentials |
| `mcp` | Управление внешними MCP-серверами |
| `plugin` | Управление плагинами Codex |
| `mcp-server` | Запустить Codex как MCP-сервер (stdio) |
| `app-server` | Запустить app server или связанные инструменты |
| `remote-control` | Управление app-server daemon с remote control |
| `app` | Запустить Codex Desktop приложение |
| `completion` | Сгенерировать скрипты автодополнения shell |
| `update` | Обновить Codex на последнюю версию |
| `doctor` | Диагностика установки, конфига, аутентификации и здоровья |
| `sandbox` | Запустить команды в Codex-предоставленном sandbox |
| `debug` | Инструменты отладки (models, app-server, prompt-input) |
| `apply` | Применить последний diff от Codex агента через `git apply` |
| `resume` | Возобновить предыдущую интерактивную сессию |
| `archive` | Архивировать сохранённую сессию |
| `delete` | Окончательно удалить сохранённую сессию |
| `unarchive` | Разархивировать сохранённую сессию |
| `fork` | Создать ветку предыдущей интерактивной сессии |
| `cloud` | Работать с задачами Codex Cloud |
| `exec-server` | Запустить standalone exec-server сервис |
| `features` | Инспектировать feature flags |

## Ключевые флаги CLI

### Основные опции выполнения
| Флаг | Описание |
|------|---------|
| `[PROMPT]` | Опциональный пользовательский промпт для запуска сессии |
| `-c, --config <key=value>` | Переопределить значение конфигурации (использует dotted path для вложенных значений) |
| `--strict-config` | Ошибка если config.toml содержит неизвестные поля |

### Модель и провайдер
| Флаг | Описание |
|------|---------|
| `-m, --model <MODEL>` | Модель для агента |
| `--oss` | Использовать open-source провайдер |
| `--local-provider <OSS_PROVIDER>` | Выбрать локальный провайдер (lmstudio или ollama) |

### Профили и конфигурация
| Флаг | Описание |
|------|---------|
| `-p, --profile <CONFIG_PROFILE>` | Наложить $CODEX_HOME/<name>.config.toml на базовую конфигурацию |
| `--enable <FEATURE>` | Включить feature (повторяемо; эквивалент `-c features.<name>=true`) |
| `--disable <FEATURE>` | Отключить feature (повторяемо; эквивалент `-c features.<name>=false`) |

### Sandbox и выполнение команд
| Флаг | Описание |
|------|---------|
| `-s, --sandbox <SANDBOX_MODE>` | Политика sandbox: read-only, workspace-write, danger-full-access |
| `--dangerously-bypass-approvals-and-sandbox` | Пропустить все подтверждения и выполнить без sandbox (опасно) |
| `--dangerously-bypass-hook-trust` | Запустить hooks без требуемого доверия (опасно) |
| `-a, --ask-for-approval <APPROVAL_POLICY>` | Когда требовать одобрение: untrusted, on-request, never |

### Контекст и директории
| Флаг | Описание |
|------|---------|
| `-C, --cd <DIR>` | Использовать указанную директорию как рабочую директорию |
| `--add-dir <DIR>` | Дополнительные директории для доступа (повторяемо) |

### Интеграция и подключения
| Флаг | Описание |
|------|---------|
| `--remote <ADDR>` | Подключиться к удалённому app server (ws://host:port, wss://, unix://, unix://PATH) |
| `--remote-auth-token-env <ENV_VAR>` | Переменная окружения с bearer token для удалённого подключения |
| `--search` | Включить live web search (доступен web_search tool без per-call approval) |

### Ввод и вывод
| Флаг | Описание |
|------|---------|
| `-i, --image <FILE>...` | Опциональные изображения к начальному промпту |
| `--json` | Выводить события в stdout как JSONL |
| `--no-alt-screen` | Отключить режим альтернативного экрана (inline mode) |
| `--color <COLOR>` | Параметры цвета (always, never, auto) |

### Для `codex exec` дополнительно
| Флаг | Описание |
|------|---------|
| `--ephemeral` | Запустить без сохранения файлов сессии на диск |
| `--ignore-user-config` | Не загружать `$CODEX_HOME/config.toml` (auth всё ещё использует CODEX_HOME) |
| `--ignore-rules` | Не загружать файлы execpolicy `.rules` |
| `--skip-git-repo-check` | Разрешить запуск Codex вне Git repository |
| `--output-schema <FILE>` | Путь к JSON Schema файлу для финального ответа модели |
| `-o, --output-last-message <FILE>` | Сохранить последнее сообщение от агента в файл |

## Подкоманды: Детальный справочник

### `codex exec [OPTIONS] [PROMPT]`
Запустить Codex в неинтерактивном режиме

**Подкоманды:**
- `resume` — Возобновить предыдущую сессию по ID или выбрать самую последнюю с --last
- `review` — Запустить code review репозитория

**Основные флаги:**
- Все флаги из основного набора плюс:
- `--ephemeral` — Запустить без сохранения сессии
- `--ignore-user-config` — Не загружать конфиг пользователя
- `--skip-git-repo-check` — Разрешить вне Git репо
- `--output-schema <FILE>` — JSON Schema для валидации ответа
- `-o, --output-last-message <FILE>` — Сохранить последнее сообщение

### `codex exec review [OPTIONS]`
Запустить code review репозитория в `codex exec`

**Флаги:**
- `--uncommitted` — Ревью staged, unstaged и untracked changes
- `--base <BRANCH>` — Ревью изменений против base branch
- `--commit <SHA>` — Ревью изменений из коммита
- `--title <TITLE>` — Опциональное название коммита для отображения

### `codex review [OPTIONS] [PROMPT]`
Запустить code review в неинтерактивном режиме

**Параметры:**
- `[PROMPT]` — Опциональные кастомные инструкции ревью (или `-` для чтения из stdin)

**Флаги:**
- `--uncommitted` — Ревью staged, unstaged и untracked changes
- `--base <BRANCH>` — Ревью против base branch
- `--commit <SHA>` — Ревью коммита
- `--title <TITLE>` — Название для отображения

### `codex login [OPTIONS] [COMMAND]`
Управление логином и аутентификацией

**Подкоманды:**
- `status` — Показать статус логина

**Флаги:**
- `--with-api-key` — Читать API key из stdin (например, `printenv OPENAI_API_KEY | codex login --with-api-key`)
- `--with-access-token` — Читать access token из stdin
- `--device-auth` — Device flow аутентификация

### `codex apply [OPTIONS] <TASK_ID>`
Применить последний diff от Codex агента через `git apply` в локальное дерево

**Параметры:**
- `<TASK_ID>` — ID задачи с diff для применения

### `codex sandbox [OPTIONS] [COMMAND]...`
Запустить команды внутри Codex-предоставленного sandbox

**Параметры:**
- `[COMMAND]...` — Полные аргументы команды для запуска под seatbelt

**Основные флаги:**
- `--sandbox-state-json <JSON>` — JSON из `codex/sandbox-state-meta`
- `--permission-profile <NAME>` — Именованный профиль разрешений
- `--sandbox-state-readable-root <PATH>` — Добавить читаемый root (повторяемо)
- `--sandbox-state-disable-network` — Отключить прямой сетевой доступ
- `--allow-unix-socket <PATH>` — Разрешить AF_UNIX сокеты
- `--log-denials` — Захватить и вывести sandbox denials

### `codex mcp [OPTIONS] [COMMAND]`
Управление внешними MCP-серверами для Codex

**Подкоманды:**
- `list` — Показать MCP-серверы
- `get` — Показать детали MCP-сервера
- `add` — Добавить MCP-сервер
- `remove` — Удалить MCP-сервер
- `login` — Аутентификация с MCP-сервером
- `logout` — Удалить OAuth credentials

### `codex plugin [OPTIONS] [COMMAND]`
Управление плагинами Codex

**Подкоманды:**
- `list` — Показать доступные плагины из marketplace
- `add` — Установить плагин из marketplace
- `remove` — Удалить установленный плагин
- `marketplace` — Управление plugin marketplaces

### `codex debug [OPTIONS] <COMMAND>`
Инструменты отладки

**Подкоманды:**
- `models` — Рендер сырого каталога моделей как JSON
- `app-server` — Инструменты помощи в отладке app server
- `prompt-input` — Рендер модели-видимого списка ввода как JSON

### `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`
Возобновить предыдущую интерактивную сессию

**Параметры:**
- `[SESSION_ID]` — UUID или имя сессии (если пропущено, использовать --last)
- `[PROMPT]` — Опциональный промпт для сессии

**Флаги:**
- `--last` — Продолжить самую последнюю сессию без выбора
- `--all` — Показать все сессии (отключает фильтрацию по cwd)
- `--include-non-interactive` — Включить неинтерактивные сессии

### `codex archive [OPTIONS] <SESSION>`
Архивировать сохранённую сессию

**Параметры:**
- `<SESSION>` — Session ID (UUID) или имя

### `codex delete [OPTIONS] <SESSION>`
Окончательно удалить сохранённую сессию

**Параметры:**
- `<SESSION>` — Session ID или имя

**Флаги:**
- `--force` — Удалить без подтверждения (требует UUID)

### `codex fork [OPTIONS] [SESSION_ID] [PROMPT]`
Создать ветку предыдущей интерактивной сессии

**Параметры:**
- `[SESSION_ID]` — UUID сессии для ветвления
- `[PROMPT]` — Опциональный промпт для новой сессии

**Флаги:**
- `--last` — Создать ветку самой последней сессии
- `--all` — Показать все сессии

### `codex unarchive [OPTIONS] <SESSION>`
Разархивировать сохранённую сессию

**Параметры:**
- `<SESSION>` — Session ID или имя

### `codex app-server [OPTIONS] [COMMAND]`
Запустить app server или связанные инструменты (экспериментально)

**Подкоманды:**
- `daemon` — Управление локальным app-server daemon
- `proxy` — Proxy stdio байтов на running app-server control socket
- `generate-ts` — Сгенерировать TypeScript bindings
- `generate-json-schema` — Сгенерировать JSON Schema

**Флаги:**
- `--listen <URL>` — Endpoint URL (stdio://, unix://, ws://IP:PORT, off)
- `--stdio` — Использовать stdio (эквивалент `--listen stdio://`)
- `--ws-auth <MODE>` — WebSocket auth mode (capability-token, signed-bearer-token)

### `codex remote-control [OPTIONS] [COMMAND]`
Управление app-server daemon с remote control (экспериментально)

**Подкоманды:**
- `start` — Запустить app-server daemon с remote control
- `stop` — Остановить app-server daemon
- `pair` — Создать и вывести short-lived pairing code

**Флаги:**
- `--json` — Вывести машиночитаемый JSON

### `codex app [OPTIONS] [PATH]`
Запустить Codex Desktop приложение

**Параметры:**
- `[PATH]` — Путь рабочей области для открытия (по умолчанию: .)

**Флаги:**
- `--download-url <URL>` — Переопределить URL загрузки инсталлятора

### `codex cloud [OPTIONS] [COMMAND]`
Работать с задачами Codex Cloud (экспериментально)

**Подкоманды:**
- `exec` — Отправить новую Codex Cloud задачу без открытия TUI
- `status` — Показать статус Codex Cloud задачи
- `list` — Показать список Codex Cloud задач
- `apply` — Применить diff Codex Cloud задачи локально
- `diff` — Показать unified diff Codex Cloud задачи

### `codex exec-server [OPTIONS]`
Запустить standalone exec-server сервис (экспериментально)

**Флаги:**
- `--listen <URL>` — Endpoint URL (ws://IP:PORT по умолчанию, stdio, unix://)
- `--remote <URL>` — Зарегистрировать как remote environment
- `--environment-id <ID>` — Environment ID для attach
- `--name <NAME>` — Человекочитаемое имя окружения
- `--use-agent-identity-auth` — Использовать Agent Identity auth

### `codex completion [OPTIONS] [SHELL]`
Сгенерировать скрипты автодополнения shell

**Параметры:**
- `[SHELL]` — Shell для генерации (bash, fish, zsh, elvish, powershell; по умолчанию: bash)

### `codex update [OPTIONS]`
Обновить Codex на последнюю версию

### `codex doctor [OPTIONS]`
Диагностика локальной установки, конфига, аутентификации и здоровья

**Флаги:**
- `--json` — Вывести машиночитаемый отчёт (редактированный)
- `--summary` — Показать только сгруппированные строки и итоговый подсчёт
- `--all` — Развернуть длинные списки в детальном выводе
- `--no-color` — Отключить ANSI цвета
- `--ascii` — Использовать ASCII статусы и сепараторы

### `codex features [OPTIONS] [COMMAND]`
Инспектировать feature flags

**Подкоманды:**
- `list` — Показать known features с их stage и эффективным статусом
- `enable <FEATURE>` — Включить feature в config.toml
- `disable <FEATURE>` — Отключить feature в config.toml

---

# Slash-команды (интерактивный режим Codex)

При запуске интерактивной сессии Codex (без `exec`, `review` и т.д.) доступны следующие slash-команды:

| Команда | Описание |
|---------|---------|
| `/status` | Показать текущий статус сессии |
| `/model` | Показать или изменить модель |
| `/approvals` | Управление запросами одобрения в текущей сессии |
| `/help` | Показать справку по доступным командам |
| `/exit` | Выход из сессии |

**Примечание:** Точный список slash-команд может отличаться в зависимости от версии Codex. Проверьте внутри сессии, введя `/help`.

---

# Сравнение: Claude Code vs Codex

| Аспект | Claude Code | Codex |
|--------|-------------|-------|
| **Провайдер** | Anthropic | OpenAI |
| **Модель** | Claude (2, 3+) | GPT-4, o3 и другие OpenAI модели |
| **Headless режим** | `-p/--print` с stdin/stdout | `exec`, `review` |
| **Sandbox** | Встроенный permission system | Явный sandbox mode (read-only, workspace-write, danger-full-access) |
| **Интерактивные команды** | Slash-команды (/help, /model, /usage, etc.) | Slash-команды (/status, /model, /approvals, etc.) |
| **Плагины** | Plugin system из marketplace | Plugin system из marketplace |
| **MCP** | Встроенная поддержка MCP | MCP support |
| **Cloud режим** | Routines на облачной инфраструктуре | `codex cloud` (экспериментально) |
| **Desktop приложение** | Встроенное Codex Desktop app | Опциональное `codex app` |
| **CI/CD** | GitHub Actions, GitLab, команды CLI | `codex exec` в CI/CD pipelines |

---

# Примеры использования Headless-режима (для Telegram-бота)

## Claude Code
```bash
# Одиночный запрос с выводом
claude -p "Explain this code" < input.py

# Структурированный JSON вывод
claude -p "Find bugs" --output-format json < code.js

# Потоковый вывод
claude -p "Analyze this" --output-format stream-json < data.log

# Максимум бюджета
claude -p "Code review" --max-budget-usd 5
```

## Codex
```bash
# Неинтерактивное выполнение
codex exec "fix this code" < broken.py

# JSON вывод событий
codex exec "refactor" --json < source.js > events.jsonl

# Code review
codex review --uncommitted

# Применение результатов
codex apply <TASK_ID>
```

---

**Источник документации:** Claude Code CLI v2.1.204 и Codex CLI v0.144.0  
**Дата компиляции:** июль 2026
**Язык документации:** Русский
