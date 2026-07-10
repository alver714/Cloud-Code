# Contributing

Thanks for your interest. Cloud Code is AGPL-3.0-or-later — by contributing you agree your
changes are licensed under it.

## Getting started

```bash
git clone https://github.com/alver714/Cloud-Code.git
cd Cloud-Code
npm install
scripts/install-hooks.sh   # installs the pre-push secret guard — please do this
```

## Before you push

```bash
npm run typecheck   # tsc --noEmit — must be clean
npm test            # vitest — keep it green (and add tests for new logic)
npm run build       # must compile
```

The pure logic lives in small, unit-tested modules; the bot/engine/system layers are thin
over them. New behaviour should come with tests, mirroring the existing `test/` fixtures and
`MockEngine` patterns.

## Ground rules

- **Never commit secrets.** Not even a real token with the middle masked — use synthetic
  fixtures (`FAKE…`, `EXAMPLE…`, `0000…`). The pre-push hook enforces this locally; CI runs
  gitleaks. See [SECURITY.md](SECURITY.md).
- Keep user-facing strings and comments in English.
- Match the surrounding style; don't reformat unrelated code.
- Security issues go through private disclosure, not public issues — see
  [SECURITY.md](SECURITY.md).

## Reporting bugs / ideas

Open an issue with steps to reproduce (for bugs) or the use case (for features). The bot can
run against its own repo, so "the bot fixed this" PRs are welcome and on-brand.
