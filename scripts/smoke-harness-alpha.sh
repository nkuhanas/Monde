#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/monde-harness-alpha-smoke"
WEB_PORT="${MONDE_WEB_PORT:-4011}"
MCP_PORT="${MONDE_MCP_PORT:-4012}"

if [[ "${MONDE_HARNESS_ALPHA_SKIP_EXISTING:-0}" != "1" ]]; then
  echo "== existing smoke coverage =="
  npm run smoke:vertical-slice-1 --prefix "$ROOT"
  npm run smoke:local-alpha --prefix "$ROOT"
fi

rm -rf "$TMP_ROOT"
mkdir -p "$TMP_ROOT/apps/web"

npm run build --prefix "$ROOT" >/dev/null

node "$ROOT/packages/cli/dist/index.js" init "$TMP_ROOT" --name "Harness Alpha Smoke"
cat >"$TMP_ROOT/.monde/docs/runtime.md" <<'DOC'
# Runtime Harness Alpha

Searchable docs mention harness alpha runtime_scope, artifact registration, and frontend review guidance.
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

echo "== operator run and output history =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "printf 'harness alpha output\\n'"
)
RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
node "$ROOT/packages/cli/dist/index.js" run attach "$RUN_ID" | tee "$TMP_ROOT/history.txt"
grep -q "harness alpha output" "$TMP_ROOT/history.txt"
node -e '
const [addr, token, runId] = process.argv.slice(1);
async function main() {
  const response = await fetch(`${addr}/runs/${runId}/events/history`, { headers: { authorization: `Bearer ${token}` } });
  const json = await response.json();
  if (!json.events.some((event) => event.event_type === "run_output" && String(event.payload.chunk).includes("harness alpha output"))) {
    console.error(json);
    process.exit(1);
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
' "$ADDR" "$TOKEN" "$RUN_ID"

echo "== run-scoped MCP JSON-RPC and stdio bridge =="
cat >"$TMP_ROOT/apps/web/mcp-proof.mjs" <<'NODE'
import fs from "node:fs";
import { spawn } from "node:child_process";

const endpoint = process.env.MONDE_MCP_ADDR;
const runId = process.env.MONDE_RUN_ID;
const runToken = process.env.MONDE_RUN_TOKEN;
const cliPath = process.env.MONDE_CLI_PATH;

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

function bridge(message) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "mcp", "bridge"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `bridge exited ${code}`));
        return;
      }
      resolve(JSON.parse(stdout.trim()));
    });
    child.stdin.end(`${JSON.stringify(message)}\n`);
  });
}

function bridgeFramed(message) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "mcp", "bridge"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `framed bridge exited ${code}`));
        return;
      }
      const headerEnd = stdout.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        reject(new Error(`missing framed response: ${stdout.toString("utf8")}`));
        return;
      }
      const body = stdout.subarray(headerEnd + 4).toString("utf8");
      resolve(JSON.parse(body));
    });
    const payload = JSON.stringify(message);
    child.stdin.end(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  });
}

const initialize = await rpc("initialize", {});
const tools = await rpc("tools/list", {});
const scope = await rpc("tools/call", { name: "runtime_scope", arguments: {} });
const docs = await rpc("tools/call", { name: "search_docs", arguments: { query: "harness alpha" } });
const log = await rpc("tools/call", {
  name: "write_log",
  arguments: { entry: { event_type: "mcp_log", message: "harness alpha mcp log" } }
});
const artifact = await rpc("tools/call", {
  name: "register_artifact",
  arguments: { type: "report", path: "../mcp-proof.json", title: "MCP proof" }
});
const bridgeTools = await bridge({ jsonrpc: "2.0", id: "bridge-tools", method: "tools/list", params: {} });
const bridgeFramedTools = await bridgeFramed({ jsonrpc: "2.0", id: "bridge-framed-tools", method: "tools/list", params: {} });

fs.writeFileSync(
  "../mcp-proof.json",
  JSON.stringify({ initialize, tools, scope, docs, log, artifact, bridgeTools, bridgeFramedTools }, null, 2)
);
console.log("mcp proof written");
NODE
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "MONDE_CLI_PATH='$ROOT/packages/cli/dist/index.js' node ../mcp-proof.mjs"
)
MCP_RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
node -e '
const fs = require("node:fs");
const proof = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const scope = proof.scope.structuredContent;
const docs = proof.docs.structuredContent;
if (proof.initialize.serverInfo.name !== "monde") throw new Error("bad initialize");
if (!proof.tools.tools.some((tool) => tool.name === "runtime_scope")) throw new Error("missing runtime_scope");
if (scope.run.id !== process.argv[2] || scope.mon.id !== "frontend" || scope.monde.id !== "harness-alpha-smoke") throw new Error(JSON.stringify(scope));
if (!docs.results.length) throw new Error(JSON.stringify(docs));
if (!proof.bridgeTools.result.tools.some((tool) => tool.name === "search_docs")) throw new Error("bridge tools/list failed");
if (!proof.bridgeFramedTools.result.tools.some((tool) => tool.name === "runtime_scope")) throw new Error("framed bridge tools/list failed");
' "$TMP_ROOT/apps/web/mcp-proof.json" "$MCP_RUN_ID"

echo "== input to active run =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon 'read line; echo input:$line'
) >"$TMP_ROOT/input-run.log" 2>&1 &
INPUT_PID=$!
for _ in $(seq 1 40); do
  ACTIVE_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --status active | awk 'NR == 1 { print $1 }')" || true
  [[ -n "${ACTIVE_ID:-}" ]] && break
  sleep 0.2
done
node "$ROOT/packages/cli/dist/index.js" run input "$ACTIVE_ID" "from harness alpha"
wait "$INPUT_PID" || true
node "$ROOT/packages/cli/dist/index.js" run attach "$ACTIVE_ID" | tee "$TMP_ROOT/input-history.txt"
grep -q "input:from harness alpha" "$TMP_ROOT/input-history.txt"

echo "== stopping active run =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "sleep 30"
) >"$TMP_ROOT/stop-run.log" 2>&1 &
STOP_PID=$!
for _ in $(seq 1 40); do
  STOP_RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --status active | awk 'NR == 1 { print $1 }')" || true
  [[ -n "${STOP_RUN_ID:-}" ]] && break
  sleep 0.2
done
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" sleep frontend.mon
)
wait "$STOP_PID" || true
node "$ROOT/packages/cli/dist/index.js" run show "$STOP_RUN_ID" >"$TMP_ROOT/stopped.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.status !== "finished" || run.process_status !== "killed" || run.outcome !== "stopped") {
  console.error(run);
  process.exit(1);
}
' "$TMP_ROOT/stopped.json"

echo "== stale scope warning =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "sleep 20"
) >"$TMP_ROOT/stale-run.log" 2>&1 &
STALE_PID=$!
for _ in $(seq 1 40); do
  STALE_RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --status active | awk 'NR == 1 { print $1 }')" || true
  [[ -n "${STALE_RUN_ID:-}" ]] && break
  sleep 0.2
done
touch "$TMP_ROOT/apps/web/frontend.mon/mon.json"
for _ in $(seq 1 40); do
  node "$ROOT/packages/cli/dist/index.js" run show "$STALE_RUN_ID" >"$TMP_ROOT/stale.json"
  if grep -q "stale_scope" "$TMP_ROOT/stale.json"; then
    break
  fi
  sleep 0.2
done
grep -q "stale_scope" "$TMP_ROOT/stale.json"
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" sleep frontend.mon
)
wait "$STALE_PID" || true

echo "== artifact registration and typed logs =="
echo "artifact body" >"$TMP_ROOT/report.txt"
node "$ROOT/packages/cli/dist/index.js" artifact register "$RUN_ID" --type report --path "$TMP_ROOT/report.txt" --title "Harness Report" >/dev/null
node "$ROOT/packages/cli/dist/index.js" artifact list --run "$RUN_ID" | tee "$TMP_ROOT/artifacts.txt"
grep -q "exists" "$TMP_ROOT/artifacts.txt"
node -e '
const [addr, token, runId] = process.argv.slice(1);
async function main() {
  const response = await fetch(`${addr}/logs?run_id=${runId}`, { headers: { authorization: `Bearer ${token}` } });
  const json = await response.json();
  if (!json.logs.some((log) => JSON.stringify(log.payload).includes("harness alpha mcp log"))) {
    console.error(json);
    process.exit(1);
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
' "$ADDR" "$TOKEN" "$MCP_RUN_ID"

echo "== plan activation and queued run start =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" plan create "Harness alpha plan" \
    --mon frontend.mon \
    --prompt "printf 'plan harness alpha\\n'" \
    --objective "Exercise plan-origin queued run"
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
  node "$ROOT/packages/cli/dist/index.js" run start "$PLAN_RUN_ID" --attach
)
node "$ROOT/packages/cli/dist/index.js" run show "$PLAN_RUN_ID" >"$TMP_ROOT/plan-run.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.origin.type !== "plan" || run.status !== "finished" || run.process_status !== "exited") {
  console.error(run);
  process.exit(1);
}
' "$TMP_ROOT/plan-run.json"

echo "== adapters, doctor, backup =="
node "$ROOT/packages/cli/dist/index.js" adapter list | tee "$TMP_ROOT/adapters.txt"
grep -q "basic-process" "$TMP_ROOT/adapters.txt"
grep -q "codex" "$TMP_ROOT/adapters.txt"
grep -q "opencode" "$TMP_ROOT/adapters.txt"
node "$ROOT/packages/cli/dist/index.js" adapter inspect codex >/dev/null
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" doctor
) | tee "$TMP_ROOT/doctor.txt"
grep -q "SQLite DB path" "$TMP_ROOT/doctor.txt"
grep -q "MCP address" "$TMP_ROOT/doctor.txt"
grep -q "Basic shell process" "$TMP_ROOT/doctor.txt"
node "$ROOT/packages/cli/dist/index.js" backup info | tee "$TMP_ROOT/backup.txt"
grep -q "Operational continuity depends" "$TMP_ROOT/backup.txt"

echo "Harness alpha smoke passed. Temp root: $TMP_ROOT"
