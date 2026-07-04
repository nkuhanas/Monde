#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/monde-beta-review-smoke"
OTHER_ROOT="${TMPDIR:-/tmp}/monde-beta-review-other"
STATE_ROOT="${TMPDIR:-/tmp}/monde-beta-review-state"
WEB_PORT="${MONDE_WEB_PORT:-4061}"
MCP_PORT="${MONDE_MCP_PORT:-4062}"

rm -rf "$TMP_ROOT" "$OTHER_ROOT" "$STATE_ROOT"
mkdir -p "$TMP_ROOT/apps/web" "$OTHER_ROOT/area" "$STATE_ROOT"

npm run build --prefix "$ROOT" >/dev/null

node "$ROOT/packages/cli/dist/index.js" init "$TMP_ROOT" --name "Beta Review Smoke"
mkdir -p "$TMP_ROOT/.monde/docs"
cat >"$TMP_ROOT/.monde/docs/runtime.md" <<'DOC'
# Beta Review Runtime

Operator console docs mention review flow, write evidence, plan evidence, MCP bridge, and artifact review.
DOC
cat >"$TMP_ROOT/apps/web/package.json" <<'JSON'
{"name":"beta-review-web","version":"0.0.0"}
JSON
(
  cd "$TMP_ROOT"
  git init -q
  git config user.email "smoke@example.test"
  git config user.name "Smoke Test"
  git add .
  git commit -qm "baseline"
)
node "$ROOT/packages/cli/dist/index.js" mon create frontend.mon --path "$TMP_ROOT/apps/web" --harness basic-process >/dev/null
node "$ROOT/packages/cli/dist/index.js" mon create closed.mon --path "$TMP_ROOT/apps/web" --harness basic-process >/dev/null

node "$ROOT/packages/cli/dist/index.js" init "$OTHER_ROOT" --name "Other Monde"
mkdir -p "$OTHER_ROOT/.monde/docs"
echo "# Other Monde" >"$OTHER_ROOT/.monde/docs/runtime.md"
node "$ROOT/packages/cli/dist/index.js" mon create other.mon --path "$OTHER_ROOT/area" --harness basic-process >/dev/null

export XDG_DATA_HOME="$STATE_ROOT/data"
export XDG_RUNTIME_DIR="$STATE_ROOT/run"
export MONDE_WEB_PORT="$WEB_PORT"
export MONDE_MCP_PORT="$MCP_PORT"
export MONDE_UI_PORT="${MONDE_UI_PORT:-5175}"

node "$ROOT/packages/service/dist/index.js" >"$STATE_ROOT/service.log" 2>&1 &
SERVICE_PID=$!
trap 'kill "$SERVICE_PID" >/dev/null 2>&1 || true' EXIT
sleep 1

TOKEN="$(cat "$XDG_DATA_HOME/monde/service.token")"
ADDR="http://127.0.0.1:$WEB_PORT"
MCP_ADDR="http://127.0.0.1:$MCP_PORT/mcp"
MONDE_ID="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).id)' "$TMP_ROOT/.monde/monde.json")"
OTHER_ID="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).id)' "$OTHER_ROOT/.monde/monde.json")"

echo "== package scripts and help =="
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const all = pkg.scripts["smoke:all"] || "";
for (const name of ["smoke:vertical-slice-1","smoke:local-alpha","smoke:harness-alpha","smoke:harness-beta","smoke:write-evidence","smoke:codex-write","smoke:beta-review"]) {
  if (!pkg.scripts[name] && name === "smoke:beta-review") throw new Error(`missing ${name}`);
  if (!all.includes(name)) throw new Error(`smoke:all does not call ${name}`);
}
' "$ROOT/package.json"
node "$ROOT/packages/cli/dist/index.js" --help | grep -q "Local Monde operator CLI"
node "$ROOT/packages/cli/dist/index.js" run --help | grep -q "Inspect and update runs"
node "$ROOT/packages/cli/dist/index.js" mon --help | grep -q "Manage filesystem mon identities"
node "$ROOT/packages/cli/dist/index.js" adapter --help | grep -q "Inspect harness adapters"
node "$ROOT/packages/cli/dist/index.js" service --help | grep -q "Inspect the local Monde service"

echo "== sync identities =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" doctor
) >"$STATE_ROOT/initial-doctor.txt"
! grep -q '^ERROR' "$STATE_ROOT/initial-doctor.txt"

echo "== basic-process interactive input policy =="
node --input-type=module - "$ADDR" "$TOKEN" "$MONDE_ID" <<'NODE'
const [addr, token, mondeId] = process.argv.slice(2);
async function request(path, body) {
  const response = await fetch(`${addr}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(json)}`);
  return json;
}
async function get(path) {
  const response = await fetch(`${addr}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(json)}`);
  return json;
}
const script = "process.stdin.setEncoding('utf8'); process.stdout.write('ready\\n'); process.stdin.on('data', d => { process.stdout.write('got:' + d); if (d.includes('done')) process.exit(0); }); setTimeout(() => {}, 30000);";
const prompt = `node -e ${JSON.stringify(script)}`;
const created = await request("/runs/operator", { monde_id: mondeId, mon_id: "frontend", title: "Interactive smoke", prompt });
if (created.run.execution.input_mode !== "open" || created.run.execution.interaction_mode !== "interactive") {
  throw new Error(JSON.stringify(created.run.execution));
}
const appended = await request("/runs/operator", { monde_id: mondeId, mon_id: "frontend", title: "stdin turn", prompt: "done" });
if (!appended.attached_to_active_run || appended.run.id !== created.run.id) throw new Error(JSON.stringify(appended));
let run = appended.run;
for (let i = 0; i < 50 && run.status !== "finished"; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  run = (await get(`/runs/${created.run.id}`)).run;
}
if (run.status !== "finished") throw new Error(JSON.stringify(run));
const events = (await get(`/runs/${created.run.id}/events/history`)).events;
if (!events.some((event) => String(event.payload?.chunk ?? "").includes("got:done"))) {
  throw new Error(JSON.stringify(events));
}
NODE

echo "== closed-input active message policy =="
node --input-type=module - "$STATE_ROOT/data/monde/monde.sqlite" "$MONDE_ID" <<'NODE'
import { DatabaseSync } from "node:sqlite";
const [dbPath, mondeId] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
const now = new Date().toISOString();
db.prepare(`INSERT INTO runs (
  id, monde_id, mon_id, status, process_status, outcome, warnings_json,
  origin_json, intent_json, execution_json, scope_snapshot_json, result_json, blocked_reason,
  created_at, started_at, ended_at
) VALUES (
  'run_closed_fake', @monde_id, 'closed', 'active', 'running', 'unknown', '[]',
  @origin, @intent, @execution, NULL, '{}', NULL, @now, @now, NULL
)`).run({
  monde_id: mondeId,
  origin: JSON.stringify({ type: "operator", label: "closed input fake" }),
  intent: JSON.stringify({ title: "Closed input fake", prompt: "fake" }),
  execution: JSON.stringify({ runner: "codex", runner_type: "codex", interaction_mode: "single-shot", input_mode: "closed", output_mode: "json-events" }),
  now
});
db.close();
NODE
node --input-type=module - "$ADDR" "$TOKEN" "$MONDE_ID" <<'NODE'
const [addr, token, mondeId] = process.argv.slice(2);
async function post(body) {
  const response = await fetch(`${addr}/runs/operator`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}
const created = await post({ monde_id: mondeId, mon_id: "closed", title: "new message", prompt: "do not append" });
if (created.status !== 202 || created.json.started !== false || created.json.run.status !== "queued" || created.json.attached_to_active_run !== false) {
  throw new Error(JSON.stringify(created));
}
const rejected = await post({ monde_id: mondeId, mon_id: "closed", title: "attach", prompt: "must fail", attach_active: true });
if (rejected.status !== 409 || rejected.json.error !== "active_run_input_closed") {
  throw new Error(JSON.stringify(rejected));
}
NODE
node --input-type=module - "$STATE_ROOT/data/monde/monde.sqlite" <<'NODE'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.prepare("UPDATE runs SET status = 'finished', process_status = 'lost', outcome = 'interrupted', ended_at = @now WHERE id = 'run_closed_fake'").run({ now: new Date().toISOString() });
db.close();
NODE

echo "== write evidence, artifact excerpts, and review =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "printf 'beta write evidence\n' > \"\$MONDE_WORK_ROOT/beta-write.txt\""
) >"$STATE_ROOT/write-run.txt"
WRITE_RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
node "$ROOT/packages/cli/dist/index.js" run show "$WRITE_RUN_ID" --artifacts >"$STATE_ROOT/write-run.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.execution.runner_type !== "basic-process" || run.execution.input_mode !== "open" || run.execution.output_mode !== "terminal") throw new Error(JSON.stringify(run.execution));
if (run.execution.can_write !== true || !run.execution.diff_capture?.completed) throw new Error(JSON.stringify(run.execution.diff_capture));
if (!run.artifacts.some((artifact) => artifact.type === "diff" && artifact.path_status === "exists")) throw new Error(JSON.stringify(run.artifacts));
if (!run.artifacts.some((artifact) => artifact.type === "file" && artifact.title.endsWith("beta-write.txt"))) throw new Error(JSON.stringify(run.artifacts));
' "$STATE_ROOT/write-run.json"
DIFF_ARTIFACT_ID="$(node -e 'const fs=require("node:fs"); const run=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(run.artifacts.find((artifact)=>artifact.type==="diff").id)' "$STATE_ROOT/write-run.json")"
node "$ROOT/packages/cli/dist/index.js" artifact show "$DIFF_ARTIFACT_ID" >"$STATE_ROOT/artifact-show.json"
grep -q '"path_status": "exists"' "$STATE_ROOT/artifact-show.json"
grep -q '"content_excerpt"' "$STATE_ROOT/artifact-show.json"
node "$ROOT/packages/cli/dist/index.js" run close "$WRITE_RUN_ID" --outcome completed --summary "Beta review accepted" --notes "Diff evidence reviewed." >"$STATE_ROOT/closed.json"
node -e '
const fs = require("node:fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (run.outcome !== "completed" || run.result.summary !== "Beta review accepted" || !run.result.reviewed_at) throw new Error(JSON.stringify(run));
' "$STATE_ROOT/closed.json"

echo "== plan evidence endpoint =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" plan create "Beta evidence plan" --mon frontend.mon --prompt "printf 'plan beta review\n'" --objective "Aggregate evidence"
) >"$STATE_ROOT/plan.json"
PLAN_ID="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).id)' "$STATE_ROOT/plan.json")"
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" plan activate "$PLAN_ID"
) >"$STATE_ROOT/activation.json"
PLAN_RUN_ID="$(node -e 'const fs=require("node:fs"); const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(a.created_runs[0].id)' "$STATE_ROOT/activation.json")"
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" wake frontend.mon --run "$PLAN_RUN_ID"
) >"$STATE_ROOT/plan-run.txt"
echo "plan artifact" >"$TMP_ROOT/apps/web/plan-artifact.txt"
node --input-type=module - "$ADDR" "$TOKEN" "$PLAN_ID" "$PLAN_RUN_ID" "$TMP_ROOT/apps/web/plan-artifact.txt" <<'NODE'
const [addr, token, planId, runId, artifactPath] = process.argv.slice(2);
async function post(path, body) {
  const response = await fetch(`${addr}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(json));
  return json;
}
async function get(path) {
  const response = await fetch(`${addr}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const json = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(json));
  return json;
}
await post("/tools/write_log", { run_id: runId, entry: { event_type: "milestone", message: "plan evidence milestone" } });
await post("/tools/register_artifact", { run_id: runId, type: "report", path: artifactPath, title: "Plan evidence artifact" });
await post(`/runs/${runId}/review`, { outcome: "completed", summary: "Plan run reviewed" });
const evidence = (await get(`/plans/${planId}/evidence`)).evidence;
if (evidence.summary.linked_runs < 1 || evidence.summary.artifacts < 1 || evidence.summary.logs < 1 || evidence.summary.result_summaries < 1) {
  throw new Error(JSON.stringify(evidence.summary));
}
if (!evidence.assignments[0].runs.some((entry) => entry.run.id === runId && entry.artifacts.length && entry.logs.length)) {
  throw new Error(JSON.stringify(evidence.assignments));
}
NODE

echo "== MCP direct and Content-Length bridge regressions =="
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message frontend.mon "node -e \"require('node:fs').writeFileSync(process.env.MONDE_WORK_ROOT + '/run-token.txt', process.env.MONDE_RUN_TOKEN); console.log('token captured')\""
) >"$STATE_ROOT/token-run.txt"
TOKEN_RUN_ID="$(cd "$TMP_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
RUN_TOKEN="$(cat "$TMP_ROOT/apps/web/run-token.txt")"
node --input-type=module - "$MCP_ADDR" "$TOKEN_RUN_ID" "$RUN_TOKEN" "$OTHER_ROOT" <<'NODE'
const [mcpAddr, runId, runToken, otherRoot] = process.argv.slice(2);
async function rpc(method, params = {}, token = runToken, id = method) {
  const response = await fetch(mcpAddr, {
    method: "POST",
    headers: { "content-type": "application/json", "x-monde-run-id": runId, "x-monde-run-token": token },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  return response.json();
}
let json = await rpc("initialize");
if (json.result?.serverInfo?.name !== "monde") throw new Error(JSON.stringify(json));
json = await rpc("tools/list");
if (!json.result?.tools?.every((tool) => tool.inputSchema?.type === "object")) throw new Error(JSON.stringify(json));
for (const name of ["runtime_scope", "search_docs", "write_log", "register_artifact"]) {
  const args = name === "search_docs"
    ? { query: "operator console" }
    : name === "write_log"
      ? { entry: { event_type: "milestone", message: "mcp beta review" } }
      : name === "register_artifact"
        ? { type: "report", path: `${otherRoot}/missing-from-current-run.txt`, title: "MCP beta artifact" }
        : {};
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.error || result.result?.isError) throw new Error(JSON.stringify({ name, result }));
}
json = await rpc("tools/list", {}, "bad-token", "bad-auth");
if (json.error?.code !== -32001) throw new Error(JSON.stringify(json));
const missing = await fetch(mcpAddr, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "missing", method: "tools/list", params: {} }) }).then((response) => response.json());
if (missing.error?.code !== -32602) throw new Error(JSON.stringify(missing));
NODE

node -e 'const msg=JSON.stringify({jsonrpc:"2.0",id:"bridge-tools",method:"tools/list",params:{}}); process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`)' \
  | MONDE_MCP_ADDR="$MCP_ADDR" node "$ROOT/packages/cli/dist/index.js" mcp bridge --run "$TOKEN_RUN_ID" --token "$RUN_TOKEN" >"$STATE_ROOT/bridge.out"
node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(process.argv[1], "utf8");
const body = raw.split(/\r?\n\r?\n/).at(-1);
const json = JSON.parse(body);
if (!json.result.tools.some((tool) => tool.name === "runtime_scope")) throw new Error(raw);
' "$STATE_ROOT/bridge.out"

echo "== no cross-Monde leakage =="
(
  cd "$OTHER_ROOT"
  node "$ROOT/packages/cli/dist/index.js" message other.mon "echo other monde"
) >"$STATE_ROOT/other-run.txt"
OTHER_RUN_ID="$(cd "$OTHER_ROOT" && node "$ROOT/packages/cli/dist/index.js" run list --origin operator | awk 'NR == 1 { print $1 }')"
node --input-type=module - "$MCP_ADDR" "$TOKEN_RUN_ID" "$RUN_TOKEN" "$OTHER_ID" "$OTHER_RUN_ID" <<'NODE'
const [mcpAddr, runId, runToken, otherId, otherRunId] = process.argv.slice(2);
const response = await fetch(mcpAddr, {
  method: "POST",
  headers: { "content-type": "application/json", "x-monde-run-id": runId, "x-monde-run-token": runToken },
  body: JSON.stringify({ jsonrpc: "2.0", id: "list-runs", method: "tools/call", params: { name: "list_runs", arguments: { monde_id: otherId } } })
});
const json = await response.json();
const runs = json.result.structuredContent.runs;
if (runs.some((run) => run.monde_id === otherId || run.id === otherRunId)) throw new Error(JSON.stringify(runs));
NODE

echo "== adapter inspect, backup, and doctor =="
node "$ROOT/packages/cli/dist/index.js" adapter inspect codex >"$STATE_ROOT/codex-inspect.json" || true
grep -q '"interaction_mode"' "$STATE_ROOT/codex-inspect.json"
grep -q '"input_mode"' "$STATE_ROOT/codex-inspect.json"
grep -q '"output_mode"' "$STATE_ROOT/codex-inspect.json"
node "$ROOT/packages/cli/dist/index.js" backup create | tee "$STATE_ROOT/backup-create.txt"
test -f "$(cat "$STATE_ROOT/backup-create.txt")"
test -f "$(cat "$STATE_ROOT/backup-create.txt").json"
node "$ROOT/packages/cli/dist/index.js" backup list | tee "$STATE_ROOT/backup-list.txt"
grep -q "schema=" "$STATE_ROOT/backup-list.txt"
(
  cd "$TMP_ROOT"
  node "$ROOT/packages/cli/dist/index.js" doctor
) | tee "$STATE_ROOT/doctor.txt"
! grep -q '^ERROR' "$STATE_ROOT/doctor.txt"
grep -q "Latest backup:" "$STATE_ROOT/doctor.txt"

echo "Beta review smoke passed. Temp root: $TMP_ROOT"
