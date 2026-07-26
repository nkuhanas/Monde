#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.playwright-browsers}"

BROWSER_PATH="$(
  cd "$ROOT"
  node --input-type=module -e \
    "import { chromium } from '@playwright/test'; process.stdout.write(chromium.executablePath());"
)"

if [[ ! -x "$BROWSER_PATH" ]]; then
  echo "Workspace Chromium is missing. Run: npm run browser:install" >&2
  exit 1
fi

exec "$ROOT/node_modules/.bin/chrome-devtools-mcp" \
  --headless \
  --isolated \
  --executablePath "$BROWSER_PATH" \
  --viewport 1440x1000 \
  --allowedUrlPattern "http://127.0.0.1:*/*" \
  --allowedUrlPattern "ws://127.0.0.1:*/*" \
  --redactNetworkHeaders \
  --no-usage-statistics \
  --no-performance-crux
