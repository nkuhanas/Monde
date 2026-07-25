#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/monde-vertical-slice-1-smoke"
WEB_PORT="${MONDE_WEB_PORT:-3971}"
MCP_PORT="${MONDE_MCP_PORT:-3972}"

rm -rf "$TMP_ROOT"
mkdir -p "$TMP_ROOT/apps/web"

if [[ "${MONDE_SMOKE_SKIP_BUILD:-0}" != "1" ]]; then
  npm run build --prefix "$ROOT" >/dev/null
fi

node "$ROOT/packages/cli/dist/index.js" init "$TMP_ROOT" --name "Vertical Slice Smoke"
node "$ROOT/packages/cli/dist/index.js" mon create frontend.mon --path "$TMP_ROOT/apps/web"
echo "hello from docs" >"$TMP_ROOT/.monde/docs/smoke.md"

export XDG_DATA_HOME="$TMP_ROOT/data"
export XDG_RUNTIME_DIR="$TMP_ROOT/run"
export MONDE_WEB_PORT="$WEB_PORT"
export MONDE_MCP_PORT="$MCP_PORT"

node "$ROOT/packages/service/dist/index.js" >"$TMP_ROOT/service.log" 2>&1 &
SERVICE_PID=$!
trap 'kill "$SERVICE_PID" >/dev/null 2>&1 || true' EXIT
sleep 1

echo "== clean exit run =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "echo hello from Monde"
)

RUN_ID="$(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" run list | awk 'NR == 1 { print $1 }'
)"
TOKEN="$(cat "$XDG_DATA_HOME/monde/service.token")"

node "$ROOT/packages/cli/dist/index.js" run show "$RUN_ID" >"$TMP_ROOT/run.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.status !== "finished" || run.process_status !== "exited" || run.outcome !== "unknown") {
  console.error(run);
  process.exit(1);
}
' "$TMP_ROOT/run.json"

node -e '
const [addr, token, runId] = process.argv.slice(1);
async function main() {
  const scope = await fetch(`${addr}/tools/runtime_scope`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ run_id: runId })
  }).then((response) => response.json());
  if (!scope.run || scope.run.id !== runId || !scope.mon || !scope.mon.work_root) {
    console.error(scope);
    process.exit(1);
  }
  const docs = await fetch(`${addr}/tools/search_docs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ run_id: runId, query: "hello" })
  }).then((response) => response.json());
  if (!Array.isArray(docs.results) || docs.results.length === 0) {
    console.error(docs);
    process.exit(1);
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
' "http://127.0.0.1:$WEB_PORT" "$TOKEN" "$RUN_ID"

echo "== active input run =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon 'read line; echo active:$line'
) >"$TMP_ROOT/active-input.log" 2>&1 &
ACTIVE_INPUT_PID=$!

for _ in $(seq 1 30); do
  if (cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list | grep -q "active/running/unknown"); then
    break
  fi
  sleep 0.2
done

(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "hello active input"
) >"$TMP_ROOT/active-input-foreground.log" 2>&1
wait "$ACTIVE_INPUT_PID" || true
grep -q "active:hello active input" "$TMP_ROOT/active-input.log" "$TMP_ROOT/active-input-foreground.log"

echo "== stopped run =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "sleep 30"
) >"$TMP_ROOT/long-run.log" 2>&1 &
LONG_RUN_PID=$!

for _ in $(seq 1 30); do
  if (cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list | grep -q "active/running/unknown"); then
    break
  fi
  sleep 0.2
done

(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" sleep frontend.mon
)

wait "$LONG_RUN_PID" || true
STOPPED_RUN_ID="$(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" run list | awk 'NR == 1 { print $1 }'
)"
node "$ROOT/packages/cli/dist/index.js" run show "$STOPPED_RUN_ID" >"$TMP_ROOT/stopped-run.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.status !== "finished" || run.process_status !== "killed" || run.outcome !== "stopped") {
  console.error(run);
  process.exit(1);
}
' "$TMP_ROOT/stopped-run.json"

echo "Smoke passed. Temp root: $TMP_ROOT"
