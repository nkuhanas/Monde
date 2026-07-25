#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/monde-local-alpha-smoke"
WEB_PORT="${MONDE_WEB_PORT:-3991}"
MCP_PORT="${MONDE_MCP_PORT:-3992}"

rm -rf "$TMP_ROOT"
mkdir -p "$TMP_ROOT/apps/web"

if [[ "${MONDE_SMOKE_SKIP_BUILD:-0}" != "1" ]]; then
  npm run build --prefix "$ROOT" >/dev/null
fi

node "$ROOT/packages/cli/dist/index.js" init "$TMP_ROOT" --name "Local Alpha Smoke"
cat >"$TMP_ROOT/.monde/docs/test.md" <<'DOC'
# Runtime Scope Resolution

Monde local alpha docs contain searchable auth review guidance.
DOC
node "$ROOT/packages/cli/dist/index.js" mon create frontend.mon --path "$TMP_ROOT/apps/web"

export XDG_DATA_HOME="$TMP_ROOT/data"
export XDG_RUNTIME_DIR="$TMP_ROOT/run"
export MONDE_WEB_PORT="$WEB_PORT"
export MONDE_MCP_PORT="$MCP_PORT"

node "$ROOT/packages/service/dist/index.js" >"$TMP_ROOT/service.log" 2>&1 &
SERVICE_PID=$!
trap 'kill "$SERVICE_PID" >/dev/null 2>&1 || true' EXIT
sleep 1
TOKEN="$(cat "$XDG_DATA_HOME/monde/service.token")"
ADDR="http://127.0.0.1:$WEB_PORT"

echo "== operator run =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "echo operator alpha"
)
RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
node "$ROOT/packages/cli/dist/index.js" run show "$RUN_ID" >"$TMP_ROOT/operator-run.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.status !== "finished" || run.process_status !== "exited" || run.outcome !== "unknown" || run.origin.type !== "operator") {
  console.error(run);
  process.exit(1);
}
' "$TMP_ROOT/operator-run.json"

echo "== tools =="
echo "artifact content" >"$TMP_ROOT/report.txt"
node -e '
const [addr, token, runId, artifactPath] = process.argv.slice(1);
async function post(tool, body) {
  const response = await fetch(`${addr}/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ run_id: runId, ...body })
  });
  const json = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(json));
  return json;
}
async function main() {
  const scope = await post("runtime_scope", {});
  if (scope.run.id !== runId || !scope.mon.work_root || !scope.monde.docs_root) throw new Error(JSON.stringify(scope));
  const docs = await post("search_docs", { query: "auth review" });
  if (!Array.isArray(docs.results) || docs.results.length === 0 || !docs.results[0].heading) throw new Error(JSON.stringify(docs));
  await post("write_log", { entry: { message: "alpha log", kind: "smoke" } });
  const artifact = await post("register_artifact", { type: "file", path: artifactPath, title: "Alpha Report" });
  if (!artifact.artifact.path_exists || artifact.artifact.path_status !== "exists") throw new Error(JSON.stringify(artifact));
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
' "$ADDR" "$TOKEN" "$RUN_ID" "$TMP_ROOT/report.txt"

node "$ROOT/packages/cli/dist/index.js" artifact list --run "$RUN_ID" | tee "$TMP_ROOT/artifacts.txt"
grep -q "exists" "$TMP_ROOT/artifacts.txt"
node "$ROOT/packages/cli/dist/index.js" run summarize "$RUN_ID" | tee "$TMP_ROOT/summary.txt"
grep -q "alpha log" "$TMP_ROOT/summary.txt"

echo "== plan activation =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" plan create "Review frontend auth changes" \
    --mon frontend.mon \
    --prompt "echo plan alpha" \
    --objective "Review frontend auth changes"
) >"$TMP_ROOT/plan.json"
PLAN_ID="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).id)' "$TMP_ROOT/plan.json")"
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" plan activate "$PLAN_ID"
) >"$TMP_ROOT/activation.json"
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" plan activate "$PLAN_ID"
) >"$TMP_ROOT/activation-again.json"
PLAN_RUN_ID="$(node -e '
const fs = require("node:fs");
const activation = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const run = activation.created_runs.find(Boolean) || activation.existing_runs.find(Boolean);
if (!run || run.origin.type !== "plan") process.exit(1);
console.log(run.id);
' "$TMP_ROOT/activation.json")"
node -e '
const fs = require("node:fs");
const again = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (again.created_runs.length !== 0 || !again.existing_runs.find((run) => run && run.id === process.argv[2])) {
  console.error(again);
  process.exit(1);
}
' "$TMP_ROOT/activation-again.json" "$PLAN_RUN_ID"

(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" run list --status queued --origin plan
) | tee "$TMP_ROOT/queued-plan-runs.txt"
grep -q "$PLAN_RUN_ID" "$TMP_ROOT/queued-plan-runs.txt"

(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" run start "$PLAN_RUN_ID" --attach
)
node "$ROOT/packages/cli/dist/index.js" run show "$PLAN_RUN_ID" >"$TMP_ROOT/plan-run.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.origin.type !== "plan" || run.status !== "finished" || run.process_status !== "exited" || run.outcome !== "unknown") {
  console.error(run);
  process.exit(1);
}
' "$TMP_ROOT/plan-run.json"

node -e '
const [addr, token, planId, runId] = process.argv.slice(1);
async function main() {
  const plans = await fetch(`${addr}/plans?monde_id=local-alpha-smoke`, {
    headers: { authorization: `Bearer ${token}` }
  }).then((response) => response.json());
  const plan = plans.plans.find((candidate) => candidate.id === planId);
  if (!plan || !JSON.stringify(plan).includes(runId)) {
    console.error(plans);
    process.exit(1);
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
' "$ADDR" "$TOKEN" "$PLAN_ID" "$PLAN_RUN_ID"

echo "== doctor =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" doctor
) | tee "$TMP_ROOT/doctor.txt"
grep -q "Service reachable" "$TMP_ROOT/doctor.txt"
grep -q "Operational continuity depends" "$TMP_ROOT/doctor.txt"

echo "Local alpha smoke passed. Temp root: $TMP_ROOT"
