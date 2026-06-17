#!/usr/bin/env bash
# secret-scan.sh — pre-push guard. Aborts (exit 2) if any secret-shaped string
# is tracked in the repo. Patterns adapted from collection-refs-deploy.sh.
# Bash 3.2 compatible (macOS default). Run before every push: npm run secret-scan
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN='AQ\.[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|EAA[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

if git rev-parse --git-dir >/dev/null 2>&1; then
  LIST=$(git ls-files)
else
  LIST=$(find . -type f -not -path './.git/*' -not -path './node_modules/*')
fi

if [ -z "$LIST" ]; then echo "secret-scan: no files"; exit 0; fi

# NUL-delimit so filenames with spaces are safe; grep -I skips binaries, -l lists hits.
HITS=$(printf '%s\n' "$LIST" | tr '\n' '\0' | xargs -0 grep -lEI "$PATTERN" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "🛑 ABORT: secret-shaped string found in:"
  echo "$HITS"
  echo "Secrets belong in GitHub Encrypted Secrets, never in the repo."
  exit 2
fi
echo "✅ secret-scan: clean ($(printf '%s\n' "$LIST" | grep -c .) tracked files)"
