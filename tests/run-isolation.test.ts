import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { codexAdapter } from "@monde/adapters";
import { MonConfigSchema, type RunRecord } from "@monde/core";
import { migrateDatabase } from "../packages/service/src/db.ts";
import { RunWorkspaceRepository } from "../packages/service/src/repositories/run-workspaces.ts";
import { RunRepository } from "../packages/service/src/repositories/runs.ts";
import { RunManager } from "../packages/service/src/run-manager.ts";
import { materializeRunScope, resolveRunScope } from "../packages/service/src/scope.ts";
import type { MonRow } from "../packages/service/src/repositories/mons.ts";
import type { MondeRow } from "../packages/service/src/repositories/mondes.ts";

function scopeFixture(t: test.TestContext) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-isolated-scope-"));
  t.after(() => {
    makeWritable(tempRoot);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const mondeRoot = path.join(tempRoot, "world");
  const monRoot = path.join(mondeRoot, "seia.mon");
  const workRoot = path.join(mondeRoot, "work");
  const docsRoot = path.join(mondeRoot, ".monde", "docs");
  fs.mkdirSync(path.join(monRoot, "doctrine"), { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(docsRoot, { recursive: true });
  fs.writeFileSync(path.join(monRoot, "SOUL.md"), "stable soul\n");
  fs.writeFileSync(path.join(monRoot, "doctrine", "b.md"), "doctrine b\n");
  fs.writeFileSync(path.join(monRoot, "doctrine", "a.md"), "doctrine a\n");
  fs.writeFileSync(
    path.join(mondeRoot, ".monde", "monde.json"),
    JSON.stringify({
      id: "test",
      name: "Test",
      version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      root: mondeRoot,
      docs: docsRoot
    })
  );
  fs.writeFileSync(
    path.join(monRoot, "mon.json"),
    JSON.stringify({
      id: "seia",
      name: "Seia",
      role: "actor",
      version: 1,
      default_harness: "codex",
      default_model: null,
      work_root: path.relative(monRoot, workRoot),
      max_active_runs: 2,
      run_workspace: { mode: "isolated", recovery_window_seconds: 86400 },
      actor_context: [
        { root: "mon", path: "SOUL.md" },
        { root: "mon", path: "doctrine" }
      ],
      read_mounts: [],
      capabilities: [],
      created_at: "2026-01-01T00:00:00.000Z"
    })
  );
  const monde: MondeRow = {
    id: "test",
    name: "Test",
    root: mondeRoot,
    docs: docsRoot,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  };
  const mon: MonRow = {
    id: "seia",
    monde_id: "test",
    name: "Seia",
    role: "actor",
    mon_root: monRoot,
    work_root: workRoot,
    default_harness: "codex",
    default_model: null,
    capabilities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  };
  return { tempRoot, mondeRoot, monRoot, workRoot, monde, mon };
}

function makeWritable(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o700);
    for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
  } else if (stat.isFile()) {
    fs.chmodSync(target, 0o600);
  }
}

test("concurrent shared workspaces are rejected while legacy one-slot configs remain valid", () => {
  const base = {
    id: "mon",
    name: "Mon",
    role: "test",
    version: 1,
    default_harness: "codex",
    default_model: null,
    work_root: "..",
    capabilities: [],
    created_at: "2026-01-01T00:00:00.000Z"
  };
  assert.equal(MonConfigSchema.safeParse(base).success, true);
  assert.equal(
    MonConfigSchema.safeParse({ ...base, max_active_runs: 2, run_workspace: { mode: "shared" } }).success,
    false
  );
});

test("actor context is copied in configured order and remains stable after source changes", (t) => {
  const fixture = scopeFixture(t);
  const base = resolveRunScope(fixture.monde, fixture.mon);
  const scope = materializeRunScope(base, "run_snapshot", path.join(fixture.tempRoot, "data"));

  assert.deepEqual(
    scope.actor_context_files.map((file) => file.logical_path),
    ["SOUL.md", "a.md", "b.md"]
  );
  fs.writeFileSync(path.join(fixture.monRoot, "SOUL.md"), "changed soul\n");
  assert.equal(fs.readFileSync(scope.actor_context_files[0].snapshot_path, "utf8"), "stable soul\n");
  assert.equal(scope.actor_context_files[0].content, "stable soul\n");
  assert.notEqual(scope.scratch_path, undefined);
  assert.notEqual(scope.context_snapshot_path, undefined);
});

test("isolated Codex command uses a permission profile without implicit source-root grants", (t) => {
  const fixture = scopeFixture(t);
  const scope = materializeRunScope(
    resolveRunScope(fixture.monde, fixture.mon),
    "run_command",
    path.join(fixture.tempRoot, "data")
  );
  const command = codexAdapter.buildCommand({
    runId: "run_command",
    runToken: "token",
    monRoot: scope.mon_root,
    workRoot: scope.work_root,
    prompt: "test",
    runtimePrompt: "runtime",
    serviceAddr: "http://127.0.0.1:3761",
    mcpAddr: "http://127.0.0.1:3762/mcp",
    workspaceMode: "isolated",
    scratchPath: scope.scratch_path,
    contextSnapshotPath: scope.context_snapshot_path,
    readMounts: scope.read_mounts,
    runScopesRoot: path.dirname(scope.scope_root!)
  });
  const args = command.args.join("\n");
  assert.equal(command.cwd, scope.scratch_path);
  assert.equal(command.args.includes("--sandbox"), false);
  assert.match(args, /default_permissions/);
  assert.match(args, /run-scopes/);
  assert.doesNotMatch(args, new RegExp(`filesystem.*${fixture.monRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(args, new RegExp(`filesystem.*${fixture.workRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("cleanup failures are retained and retried without deleting run metadata", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrateDatabase(db);
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO mondes (id, name, root, docs, created_at, updated_at)
     VALUES ('m', 'M', '/tmp/m', '/tmp/m/docs', ?, ?)`
  ).run(now, now);
  const runs = new RunRepository(db);
  const run: RunRecord = {
    id: "run_cleanup",
    monde_id: "m",
    mon_id: "mon",
    status: "finished",
    process_status: "exited",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "closed",
    outcome_state: "unknown",
    close_reason: "process_exited",
    warnings: [],
    origin: { type: "operator" },
    intent: { title: "cleanup", prompt: "cleanup" },
    execution: {},
    result: {},
    created_at: now,
    updated_at: now
  };
  runs.insert(run);
  const workspaces = new RunWorkspaceRepository(db);
  workspaces.register({
    runId: run.id,
    workspaceMode: "isolated",
    scopeRoot: "/outside/allowed/run-scopes/run_cleanup"
  });
  workspaces.seal(run.id, now, now);
  const events: Array<{ type: string }> = [];
  const manager = new RunManager({
    mondes: {} as never,
    mons: {} as never,
    runs,
    runWorkspaces: workspaces,
    logs: {} as never,
    artifacts: {} as never,
    events: { publish: (_runId: string, type: string) => events.push({ type }) } as never,
    config: {
      serviceAddr: "http://127.0.0.1:3761",
      mcpAddr: "http://127.0.0.1:3762/mcp",
      dataDir: "/allowed"
    }
  });

  manager.sweepExpiredRunScopes(now);
  manager.sweepExpiredRunScopes(now);
  assert.equal(workspaces.get(run.id)?.state, "cleanup_failed");
  assert.equal(workspaces.get(run.id)?.cleanup_attempts, 2);
  assert.equal(runs.get(run.id)?.intent.prompt, "cleanup");
  assert.equal(events.filter((event) => event.type === "run_scope_cleanup_failed").length, 2);
});
