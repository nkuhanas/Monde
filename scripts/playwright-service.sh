#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="${MONDE_WEB_TEST_ROOT:-${TMPDIR:-/tmp}/monde-playwright-preview}"
TEST_ROOT_PARENT="$(dirname "$TEST_ROOT")"
TEST_ROOT_NAME="$(basename "$TEST_ROOT")"

if [[ "$TEST_ROOT_NAME" != monde-playwright-preview* || "$TEST_ROOT_PARENT" == "/" ]]; then
  echo "Refusing to reset unexpected Playwright runtime root: $TEST_ROOT" >&2
  exit 1
fi

rm -rf "$TEST_ROOT"
mkdir -p "$TEST_ROOT/data" "$TEST_ROOT/run"

export XDG_DATA_HOME="$TEST_ROOT/data"
export XDG_RUNTIME_DIR="$TEST_ROOT/run"

cd "$ROOT"
exec npm run dev:service
