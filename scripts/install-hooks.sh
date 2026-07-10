#!/usr/bin/env bash
# Install the local git hooks (secret-scan pre-push guard).
set -euo pipefail
cd "$(dirname "$0")/.."
cp scripts/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
echo "✅ pre-push secret guard installed (.git/hooks/pre-push)"
