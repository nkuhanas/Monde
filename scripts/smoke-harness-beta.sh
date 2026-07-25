#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/monde-harness-beta-smoke"
WEB_PORT="${MONDE_WEB_PORT:-4021}"
MCP_PORT="${MONDE_MCP_PORT:-4022}"

rm -rf "$TMP_ROOT"
mkdir -p "$TMP_ROOT/apps/web"

if [[ "${MONDE_SMOKE_SKIP_BUILD:-0}" != "1" ]]; then
  npm run build --prefix "$ROOT" >/dev/null
fi

echo "== runtime prompt and attention logic =="
node --import tsx <<'NODE'
import { buildRuntimePrompt } from "./packages/core/dist/index.js";
import { compareRunsForNavigator, runRequiresAttention } from "./packages/web/src/features/runs/runViewModel.ts";

const prompt = buildRuntimePrompt(
  {
    id: "run_prompt",
    status: "starting",
    process_status: "spawning",
    outcome: "unknown",
    warnings: [],
    origin: { type: "operator", label: "Smoke" },
    intent: { title: "Prompt smoke", prompt: "Prompt smoke" }
  },
  { id: "frontend", name: "Frontend", role: "Web UI and operator console" },
  { id: "monde", name: "Monde" },
  {}
);
if (prompt.includes("Monde Monde") || prompt.includes("status = starting") || prompt.includes("process_status = spawning")) {
  throw new Error(prompt);
}
if (!prompt.includes("call runtime_scope() for current status")) {
  throw new Error(prompt);
}

const items = [
  { id: "finished", status: "finished", origin: { type: "operator" }, warnings: [], created_at: "2026-01-01T00:00:00Z" },
  { id: "queued-cron", status: "queued", origin: { type: "cron" }, warnings: [], created_at: "2026-01-01T00:00:01Z" },
  { id: "queued-plan", status: "queued", origin: { type: "plan" }, warnings: [], created_at: "2026-01-01T00:00:02Z" },
  { id: "blocked", status: "blocked", origin: { type: "operator" }, warnings: [], created_at: "2026-01-01T00:00:03Z" },
  { id: "warning", status: "finished", origin: { type: "operator" }, warnings: ["stale_scope"], created_at: "2026-01-01T00:00:04Z" },
  { id: "active", status: "active", origin: { type: "operator" }, warnings: [], created_at: "2026-01-01T00:00:05Z" }
].filter(runRequiresAttention).sort(compareRunsForNavigator);
const order = items.map((item) => item.id).join(",");
if (order !== "active,warning,blocked,queued-plan,queued-cron") {
  throw new Error(order);
}
NODE

node "$ROOT/packages/cli/dist/index.js" init "$TMP_ROOT" --name "Harness Beta Smoke"
mkdir -p "$TMP_ROOT/.monde/docs"
cat >"$TMP_ROOT/.monde/docs/runtime.md" <<'DOC'
# Runtime Scope

Harness beta docs mention runtime_scope, search_docs, write_log, register_artifact, and plan evidence.

## Operator Console

The console should show runs, mons, plans, artifacts, status, terminal output, scope, warnings, and result metadata.
DOC
node "$ROOT/packages/cli/dist/index.js" mon create frontend.mon --path "$TMP_ROOT/apps/web" --harness basic-process

export XDG_DATA_HOME="$TMP_ROOT/data"
export XDG_RUNTIME_DIR="$TMP_ROOT/run"
export MONDE_WEB_PORT="$WEB_PORT"
export MONDE_MCP_PORT="$MCP_PORT"
export MONDE_STALE_SCOPE_INTERVAL_MS=200

node "$ROOT/packages/service/dist/index.js" >"$TMP_ROOT/service.log" 2>&1 &
SERVICE_PID=$!
trap 'kill "$SERVICE_PID" >/dev/null 2>&1 || true' EXIT
sleep 1

TOKEN="$(cat "$XDG_DATA_HOME/monde/service.token")"
ADDR="http://127.0.0.1:$WEB_PORT"
MCP_ADDR="http://127.0.0.1:$MCP_PORT/mcp"

echo "== plan-derived queued run evidence =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" plan create "Harness beta plan" \
    --mon frontend.mon \
    --prompt "printf 'plan beta evidence\\n'" \
    --objective "Prove plan-generated run evidence"
) >"$TMP_ROOT/plan.json"
PLAN_ID="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).id)' "$TMP_ROOT/plan.json")"
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" plan activate "$PLAN_ID"
) >"$TMP_ROOT/activation.json"
PLAN_RUN_ID="$(node -e '
const fs = require("node:fs");
const activation = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const run = activation.created_runs.find(Boolean);
if (!run || run.origin.type !== "plan" || run.status !== "queued") process.exit(1);
console.log(run.id);
' "$TMP_ROOT/activation.json")"
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" wake frontend.mon --run "$PLAN_RUN_ID"
)
node "$ROOT/packages/cli/dist/index.js" run show "$PLAN_RUN_ID" >"$TMP_ROOT/plan-run.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.origin.type !== "plan" || run.execution.runner_type !== "basic-process" || run.status !== "finished") {
  console.error(run);
  process.exit(1);
}
' "$TMP_ROOT/plan-run.json"

echo "== MCP JSON-RPC direct tools =="
cat >"$TMP_ROOT/apps/web/mcp-beta.mjs" <<'NODE'
import fs from "node:fs";

const endpoint = process.env.MONDE_MCP_ADDR;
const runId = process.env.MONDE_RUN_ID;
const runToken = process.env.MONDE_RUN_TOKEN;

async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-monde-run-id": runId,
      "x-monde-run-token": runToken
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
  });
  const json = await response.json();
  if (!response.ok || json.error) throw new Error(JSON.stringify(json));
  return json.result;
}

fs.writeFileSync(`${process.env.MONDE_WORK_ROOT}/beta-artifact.txt`, "beta artifact\n");

const initialize = await rpc("initialize");
const tools = await rpc("tools/list");
const scope = await rpc("tools/call", { name: "runtime_scope", arguments: {} });
const docs = await rpc("tools/call", { name: "search_docs", arguments: { query: "operator console" } });
const log = await rpc("tools/call", {
  name: "write_log",
  arguments: { entry: { event_type: "milestone", message: "harness beta mcp log" } }
});
const artifact = await rpc("tools/call", {
  name: "register_artifact",
  arguments: { type: "report", path: `${process.env.MONDE_WORK_ROOT}/beta-artifact.txt`, title: "Harness beta report" }
});
const run = await rpc("tools/call", { name: "get_run", arguments: {} });

fs.writeFileSync(
  `${process.env.MONDE_WORK_ROOT}/mcp-beta-proof.json`,
  JSON.stringify({ initialize, tools, scope, docs, log, artifact, run }, null, 2)
);
console.log("mcp beta proof written");
NODE
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "node ../mcp-beta.mjs"
)
MCP_RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
node -e '
const fs = require("node:fs");
const proof = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const scope = proof.scope.structuredContent;
const docs = proof.docs.structuredContent;
const log = proof.log.structuredContent.log;
const artifact = proof.artifact.structuredContent.artifact;
const run = proof.run.structuredContent.run;
if (proof.initialize.serverInfo.name !== "monde") throw new Error("bad initialize");
if (!proof.tools.tools.some((tool) => tool.name === "runtime_scope")) throw new Error("missing runtime_scope");
if (scope.run.id !== process.argv[2] || scope.run.runner_type !== "basic-process") throw new Error(JSON.stringify(scope));
if (!docs.results.length || !String(docs.results[0].snippet).includes("Operator Console")) throw new Error(JSON.stringify(docs));
if (log.event_type !== "milestone") throw new Error(JSON.stringify(log));
if (artifact.path_status !== "exists") throw new Error(JSON.stringify(artifact));
if (run.id !== process.argv[2] || !proof.run.structuredContent.recent_logs.length) throw new Error(JSON.stringify(proof.run.structuredContent));
' "$TMP_ROOT/apps/web/mcp-beta-proof.json" "$MCP_RUN_ID"

echo "== API visibility =="
node -e '
const [addr, token] = process.argv.slice(1);
async function get(path) {
  const response = await fetch(`${addr}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
}
const [mondes, mons, plans, runs, artifacts] = await Promise.all([
  get("/mondes"),
  get("/mons?monde_id=harness-beta-smoke"),
  get("/plans?monde_id=harness-beta-smoke"),
  get("/runs?monde_id=harness-beta-smoke"),
  get("/artifacts?monde_id=harness-beta-smoke")
]);
if (!mondes.mondes.length || !mons.mons.length || !plans.plans.length || !runs.runs.length || !artifacts.artifacts.length) {
  console.error({ mondes, mons, plans, runs, artifacts });
  process.exit(1);
}
' "$ADDR" "$TOKEN"

echo "== adapter detection and real harness attempts =="
node "$ROOT/packages/cli/dist/index.js" adapter list | tee "$TMP_ROOT/adapters.txt"
grep -q "basic-process" "$TMP_ROOT/adapters.txt"
grep -q "codex" "$TMP_ROOT/adapters.txt"
grep -q "opencode" "$TMP_ROOT/adapters.txt"
node "$ROOT/packages/cli/dist/index.js" adapter inspect codex >"$TMP_ROOT/codex-inspect.json" || true
node "$ROOT/packages/cli/dist/index.js" adapter inspect opencode >"$TMP_ROOT/opencode-inspect.json" || true

if [[ "${MONDE_ENABLE_EXTERNAL_CODEX_SMOKE:-0}" == "1" ]] && command -v codex >/dev/null 2>&1; then
  echo "Codex installed; attempting bounded real adapter launch."
  (
    cd "$TMP_ROOT"
    timeout 90s node "$ROOT/packages/cli/dist/index.js" message --harness codex frontend.mon "Call mcp__monde__runtime_scope, then call mcp__monde__search_docs with query \"operator console\", then print exactly MONDE_CODEX_SMOKE_OK and do not edit files."
  ) >"$TMP_ROOT/codex-run.txt" 2>&1 || true
  ! grep -q "Run identity:" "$TMP_ROOT/codex-run.txt"
  ! grep -q "Your identity root is:" "$TMP_ROOT/codex-run.txt"
  grep -q "MONDE_CODEX_SMOKE_OK" "$TMP_ROOT/codex-run.txt"
  grep -q "mcp_tool_call completed" "$TMP_ROOT/codex-run.txt"
  CODEX_RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
  if [[ -n "${CODEX_RUN_ID:-}" ]]; then
    node "$ROOT/packages/cli/dist/index.js" run show "$CODEX_RUN_ID" >"$TMP_ROOT/codex-run.json"
    node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.execution.runner !== "codex" || run.execution.runner_type !== "codex" || run.execution.input_mode !== "closed") {
  console.error(run);
  process.exit(1);
}
' "$TMP_ROOT/codex-run.json"
    if node -e 'const fs=require("node:fs"); const run=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(run.status === "active" || run.status === "starting" ? 0 : 1)' "$TMP_ROOT/codex-run.json"; then
      node "$ROOT/packages/cli/dist/index.js" run close "$CODEX_RUN_ID" --outcome stopped >/dev/null || true
    fi
  fi
elif [[ "${MONDE_ENABLE_EXTERNAL_CODEX_SMOKE:-0}" == "1" ]]; then
  echo "Codex missing; adapter reports missing honestly."
else
  echo "External Codex smoke disabled; use npm run smoke:external to opt in."
fi

if command -v opencode >/dev/null 2>&1; then
  echo "opencode installed; adapter detection captured. Automatic MCP setup may be manual-required in MVP."
else
  grep -q "opencode" "$TMP_ROOT/adapters.txt"
fi

echo "== backup and doctor =="
node "$ROOT/packages/cli/dist/index.js" backup create | tee "$TMP_ROOT/backup-create.txt"
test -f "$(cat "$TMP_ROOT/backup-create.txt")"
node "$ROOT/packages/cli/dist/index.js" backup info | tee "$TMP_ROOT/backup-info.txt"
grep -q "Latest backup:" "$TMP_ROOT/backup-info.txt"
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" doctor
) | tee "$TMP_ROOT/doctor.txt"
! grep -q '^ERROR' "$TMP_ROOT/doctor.txt"
grep -q "Latest backup:" "$TMP_ROOT/doctor.txt"

echo "Harness beta smoke passed. Temp root: $TMP_ROOT"
