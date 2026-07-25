#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/monde-write-evidence-smoke"
STATE_ROOT="${TMPDIR:-/tmp}/monde-write-evidence-smoke-state"
WEB_PORT="${MONDE_WEB_PORT:-4031}"
MCP_PORT="${MONDE_MCP_PORT:-4032}"

rm -rf "$TMP_ROOT" "$STATE_ROOT"
mkdir -p "$TMP_ROOT/apps/web"

if [[ "${MONDE_SMOKE_SKIP_BUILD:-0}" != "1" ]]; then
  npm run build --prefix "$ROOT" >/dev/null
fi

git init "$TMP_ROOT" >/dev/null
git -C "$TMP_ROOT" config user.email "smoke@monde.local"
git -C "$TMP_ROOT" config user.name "Monde Smoke"

node "$ROOT/packages/cli/dist/index.js" init "$TMP_ROOT" --name "Write Evidence Smoke"
cat >"$TMP_ROOT/.monde/docs/operator-console.md" <<'DOC'
# Operator Console

Write evidence smokes cover diff artifacts, changed file artifacts, and run review outcomes.
DOC
node "$ROOT/packages/cli/dist/index.js" mon create frontend.mon --path "$TMP_ROOT/apps/web" --harness basic-process
printf 'before\n' >"$TMP_ROOT/apps/web/proof.txt"
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

echo "== write-capable basic-process run =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "printf 'after write evidence\n' > \"\$MONDE_WORK_ROOT/proof.txt\""
)
RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
node "$ROOT/packages/cli/dist/index.js" run show "$RUN_ID" >"$TMP_ROOT/run.json"
TOKEN="$(cat "$XDG_DATA_HOME/monde/service.token")"
ADDR="http://127.0.0.1:$WEB_PORT"
MCP_ADDR="http://127.0.0.1:$MCP_PORT/mcp"
node -e '
const [mcpAddr, runId] = process.argv.slice(1);
async function main() {
  const response = await fetch(mcpAddr, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-monde-run-id": runId,
      "x-monde-run-token": "bad-token"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "bad-auth", method: "tools/list", params: {} })
  });
  const json = await response.json();
  if (!json.error || json.error.code !== -32001) throw new Error(JSON.stringify(json));
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
' "$MCP_ADDR" "$RUN_ID"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.status !== "finished" || run.process_status !== "exited" || run.outcome !== "unknown") throw new Error(JSON.stringify(run));
if (run.execution.can_write !== true || run.execution.write_scope !== `${process.argv[2]}/apps/web`) throw new Error(JSON.stringify(run.execution));
const diff = run.execution.diff_capture;
if (!diff || diff.available !== true || diff.completed !== true || !diff.changed_files.includes("apps/web/proof.txt")) {
  throw new Error(JSON.stringify(diff));
}
' "$TMP_ROOT/run.json" "$TMP_ROOT"

grep -q "after write evidence" "$TMP_ROOT/apps/web/proof.txt"
node "$ROOT/packages/cli/dist/index.js" artifact list --run "$RUN_ID" | tee "$TMP_ROOT/artifacts.txt"
grep -q "diff" "$TMP_ROOT/artifacts.txt"
grep -q "proof.txt" "$TMP_ROOT/artifacts.txt"

echo "== review finished run =="
node "$ROOT/packages/cli/dist/index.js" run review "$RUN_ID" --outcome completed --summary "Write evidence smoke reviewed" --notes "Diff artifact captured." >"$TMP_ROOT/reviewed.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.outcome !== "completed") throw new Error(JSON.stringify(run));
if (run.result.summary !== "Write evidence smoke reviewed" || !run.result.reviewed_at || run.result.reviewed_by !== "operator") {
  throw new Error(JSON.stringify(run.result));
}
' "$TMP_ROOT/reviewed.json"
node "$ROOT/packages/cli/dist/index.js" run summarize "$RUN_ID" | tee "$TMP_ROOT/summary.txt"
grep -q "Write evidence smoke reviewed" "$TMP_ROOT/summary.txt"

echo "Write evidence smoke passed. Temp root: $TMP_ROOT"
