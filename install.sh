#!/usr/bin/env bash
# Cloud Code one-line installer (macOS / Linux).
#   curl -fsSL https://raw.githubusercontent.com/alver714/Cloud-Code/main/install.sh | bash
# Clones the public repo, installs deps, and launches the setup wizard.
set -euo pipefail

REPO="https://github.com/alver714/Cloud-Code.git"
DIR="${CLOUD_CODE_DIR:-$HOME/cloud-code}"

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "Cloud Code installer"

command -v git  >/dev/null 2>&1 || die "git is required. Install it (macOS: xcode-select --install · Linux: your package manager) and re-run."
command -v node >/dev/null 2>&1 || die "Node.js 22+ is required. Install from https://nodejs.org (or nvm/fnm) and re-run."

NODE_MAJOR="$(node -v | sed 's/^v//;s/\..*//')"
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || warn "Node $(node -v) detected — 22+ is recommended; continuing anyway."

if [ -d "$DIR/.git" ]; then
  say "Updating existing checkout at $DIR"
  git -C "$DIR" pull --ff-only || warn "Could not fast-forward; using the existing checkout."
else
  say "Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
say "Installing dependencies…"
npm install --no-audit --no-fund

# The wizard is interactive; under `curl | bash` our stdin is the pipe, so
# hand the wizard the real terminal.
say "Starting the setup wizard…"
# A controlling terminal must be actually openable (it exists as a device node
# even when there is none — check readability, not existence).
if { : < /dev/tty; } 2>/dev/null; then
  npm run --silent setup < /dev/tty
else
  warn "No interactive terminal detected. Finish setup manually:"
  echo "  cd \"$DIR\" && npm run setup"
fi
