import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  codexAdapter,
  codexIsolationAttestationMatches,
  codexIsolationAttestationPath,
  currentCodexIsolationFingerprint,
  readCodexIsolationAttestation,
  type CodexIsolationAttestation,
  type CodexIsolationFingerprint
} from "@monde/adapters";
import { MonConfigSchema, type RunRecord } from "@monde/core";
import { migrateDatabase } from "../packages/service/src/db.ts";
import { ArtifactRepository } from "../packages/service/src/repositories/artifacts.ts";
import { LogRepository } from "../packages/service/src/repositories/logs.ts";
import { MonRepository } from "../packages/service/src/repositories/mons.ts";
import { MondeRepository } from "../packages/service/src/repositories/mondes.ts";
import { ProcessSlotRepository } from "../packages/service/src/repositories/process-slots.ts";
import { RunEventRepository } from "../packages/service/src/repositories/run-events.ts";
import { RunWorkspaceRepository } from "../packages/service/src/repositories/run-workspaces.ts";
import { RunRepository } from "../packages/service/src/repositories/runs.ts";
import { RunEventBus } from "../packages/service/src/run-events.ts";
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

test("isolation attestation rejects stale binaries, policy, and runtime fingerprints", () => {
  const fingerprint: CodexIsolationFingerprint = {
    codex_version: "codex 1.0.0",
    codex_binary_sha256: "a".repeat(64),
    bwrap_version: "bubblewrap 1.0.0",
    bwrap_binary_sha256: "b".repeat(64),
    sandbox_policy_sha256: "c".repeat(64),
    node_version: "v22.0.0",
    platform: "linux",
    release: "1.0.0",
    arch: "x64"
  };
  const attestation: CodexIsolationAttestation = {
    verified_at: "2026-01-01T00:00:00.000Z",
    fingerprint,
    command_probe: "passed",
    stdio_child_probe: "passed"
  };

  assert.equal(codexIsolationAttestationMatches(attestation, fingerprint), true);
  for (const stale of [
    { ...fingerprint, codex_binary_sha256: "d".repeat(64) },
    { ...fingerprint, bwrap_binary_sha256: "e".repeat(64) },
    { ...fingerprint, sandbox_policy_sha256: "f".repeat(64) },
    { ...fingerprint, node_version: "v23.0.0" },
    { ...fingerprint, release: "2.0.0" }
  ]) {
    assert.equal(codexIsolationAttestationMatches(attestation, stale), false);
  }
});

test("stale policy attestation prevents isolated Codex admission", async (t) => {
  const previousDataHome = process.env.XDG_DATA_HOME;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-stale-attestation-"));
  process.env.XDG_DATA_HOME = tempRoot;
  t.after(() => {
    if (previousDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousDataHome;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const fingerprint = currentCodexIsolationFingerprint();
  if (!fingerprint) {
    t.skip("Codex and bubblewrap are required for admission fingerprinting.");
    return;
  }
  const stale: CodexIsolationAttestation = {
    verified_at: "2026-01-01T00:00:00.000Z",
    fingerprint: {
      ...fingerprint,
      sandbox_policy_sha256: "0".repeat(64)
    },
    command_probe: "passed",
    stdio_child_probe: "passed"
  };
  const attestationPath = codexIsolationAttestationPath();
  fs.mkdirSync(path.dirname(attestationPath), { recursive: true });
  fs.writeFileSync(attestationPath, JSON.stringify(stale));

  assert.equal(readCodexIsolationAttestation(), undefined);
  assert.equal(codexAdapter.detect().supports_isolated_runs, false);
  assert.equal(codexAdapter.detect().isolation_status, "verification_required");

  const fixture = scopeFixture(t);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrateDatabase(db);
  const mondes = new MondeRepository(db);
  const mons = new MonRepository(db);
  const runs = new RunRepository(db);
  mondes.upsert({
    id: fixture.monde.id,
    name: fixture.monde.name,
    root: fixture.monde.root,
    docs: fixture.monde.docs
  });
  mons.upsert({
    id: fixture.mon.id,
    monde_id: fixture.mon.monde_id,
    name: fixture.mon.name,
    role: fixture.mon.role,
    mon_root: fixture.mon.mon_root,
    work_root: fixture.mon.work_root,
    default_harness: fixture.mon.default_harness,
    default_model: fixture.mon.default_model,
    capabilities: fixture.mon.capabilities
  });
  const now = "2026-01-01T00:00:00.000Z";
  const run: RunRecord = {
    id: "run_stale_attestation",
    monde_id: "test",
    mon_id: "seia",
    status: "queued",
    process_status: "not_started",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "queued",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "system", label: "isolation-admission-test" },
    intent: { title: "Isolation admission", prompt: "Test." },
    execution: {},
    result: {},
    created_at: now,
    updated_at: now
  };
  runs.insert(run);
  const manager = new RunManager({
    mondes,
    mons,
    processSlots: new ProcessSlotRepository(db),
    runs,
    logs: new LogRepository(db),
    artifacts: new ArtifactRepository(db),
    events: new RunEventBus(new RunEventRepository(db)),
    config: {
      serviceAddr: "http://127.0.0.1:3761",
      mcpAddr: "http://127.0.0.1:3762/mcp",
      dataDir: path.join(fixture.tempRoot, "data")
    }
  });

  await assert.rejects(
    () => manager.startRun(run.id),
    /cannot enforce isolated runs: verification_required/
  );
});
