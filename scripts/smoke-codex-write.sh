#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/monde-codex-write-smoke"
STATE_ROOT="${TMPDIR:-/tmp}/monde-codex-write-smoke-state"
WEB_PORT="${MONDE_WEB_PORT:-4041}"
MCP_PORT="${MONDE_MCP_PORT:-4042}"

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex missing; skipping write-capable Codex smoke."
  exit 0
fi

rm -rf "$TMP_ROOT" "$STATE_ROOT"
mkdir -p "$TMP_ROOT/apps/web"

if [[ "${MONDE_SMOKE_SKIP_BUILD:-0}" != "1" ]]; then
  npm run build --prefix "$ROOT" >/dev/null
fi

git init "$TMP_ROOT" >/dev/null
git -C "$TMP_ROOT" config user.email "smoke@monde.local"
git -C "$TMP_ROOT" config user.name "Monde Smoke"

node "$ROOT/packages/cli/dist/index.js" init "$TMP_ROOT" --name "Codex Write Smoke"
cat >"$TMP_ROOT/.monde/docs/operator-console.md" <<'DOC'
# Operator Console

Codex write smoke docs mention operator console, runtime scope, write evidence, and artifact review.
DOC
node "$ROOT/packages/cli/dist/index.js" mon create frontend.mon --path "$TMP_ROOT/apps/web" --harness basic-process
printf 'before codex write\n' >"$TMP_ROOT/apps/web/codex-write.txt"
git -C "$TMP_ROOT" add .
git -C "$TMP_ROOT" commit -m "baseline" >/dev/null

export XDG_DATA_HOME="$STATE_ROOT/data"
export XDG_RUNTIME_DIR="$STATE_ROOT/run"
export MONDE_WEB_PORT="$WEB_PORT"
export MONDE_MCP_PORT="$MCP_PORT"

mkdir -p "$STATE_ROOT"
node "$ROOT/packages/service/dist/index.js" >"$STATE_ROOT/service.log" 2>&1 &
SERVICE_PID=$!
trap 'kill "$SERVICE_PID" >/dev/null 2>&1 || true' EXIT
sleep 1
TOKEN="$(cat "$XDG_DATA_HOME/monde/service.token")"
ADDR="http://127.0.0.1:$WEB_PORT"

echo "== write-capable Codex run =="
(
  cd "$TMP_ROOT"
  timeout 180s node "$ROOT/packages/cli/dist/index.js" message --harness codex --write frontend.mon \
    "Use the Monde MCP tools before editing: call runtime_scope(), then search_docs(\"operator console\"), then write_log with event_type \"milestone\" and message \"codex_write_smoke\". Edit the file codex-write.txt in the current work root so it contains exactly MONDE_CODEX_WRITE_SMOKE_OK followed by a newline. Register that file as a file artifact with title \"Codex write proof\". Do not edit any other files. Finish with a one-line summary."
) | tee "$TMP_ROOT/codex-run.txt"

RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
node "$ROOT/packages/cli/dist/index.js" run show "$RUN_ID" >"$TMP_ROOT/run.json"
grep -q "MONDE_CODEX_WRITE_SMOKE_OK" "$TMP_ROOT/apps/web/codex-write.txt"

node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.execution.runner !== "codex" || run.execution.can_write !== true || run.execution.sandbox_mode !== "workspace-write") {
  throw new Error(JSON.stringify(run.execution));
}
const diff = run.execution.diff_capture;
if (!diff || diff.available !== true || diff.completed !== true || !diff.changed_files.includes("apps/web/codex-write.txt")) {
  throw new Error(JSON.stringify(diff));
}
' "$TMP_ROOT/run.json"

node -e '
const [addr, token, runId] = process.argv.slice(1);
async function main() {
  const [logsResponse, artifactsResponse] = await Promise.all([
    fetch(`${addr}/logs?run_id=${runId}`, { headers: { authorization: `Bearer ${token}` } }),
    fetch(`${addr}/artifacts?run_id=${runId}`, { headers: { authorization: `Bearer ${token}` } })
  ]);
  const logs = await logsResponse.json();
  const artifacts = await artifactsResponse.json();
  if (!logs.logs.some((log) => JSON.stringify(log).includes("codex_write_smoke"))) {
    throw new Error(JSON.stringify(logs));
  }
  if (!artifacts.artifacts.some((artifact) => artifact.title === "Codex write proof" && artifact.path_status === "exists")) {
    throw new Error(JSON.stringify(artifacts));
  }
  if (!artifacts.artifacts.some((artifact) => artifact.type === "diff")) {
    throw new Error(JSON.stringify(artifacts));
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
' "$ADDR" "$TOKEN" "$RUN_ID"

node "$ROOT/packages/cli/dist/index.js" run review "$RUN_ID" --outcome completed --summary "Codex write smoke completed" >/dev/null
echo "Codex write smoke passed. Temp root: $TMP_ROOT"
