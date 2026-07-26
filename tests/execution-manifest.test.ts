import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalSha256, type RunRecord } from "@monde/core";
import { migrateDatabase } from "../packages/service/src/db.ts";
import { ArtifactRepository } from "../packages/service/src/repositories/artifacts.ts";
import { ExternalExecutionRepository } from "../packages/service/src/repositories/external-executions.ts";
import {
  ExecutionManifestConflictError,
  ExecutionManifestRepository,
  type ExecutionManifestOutputInput
} from "../packages/service/src/repositories/execution-manifests.ts";
import { LogRepository } from "../packages/service/src/repositories/logs.ts";
import { RunEventRepository } from "../packages/service/src/repositories/run-events.ts";
import { RunRepository } from "../packages/service/src/repositories/runs.ts";
import { RunWorkspaceRepository } from "../packages/service/src/repositories/run-workspaces.ts";
import { RunEventBus } from "../packages/service/src/run-events.ts";
import { RunManager } from "../packages/service/src/run-manager.ts";

function fixture(t: test.TestContext) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-manifest-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, "data");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrateDatabase(db);
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO mondes (id, name, root, docs, created_at, updated_at)
     VALUES ('m', 'M', @root, @docs, @now, @now)`
  ).run({
    root: tempRoot,
    docs: path.join(tempRoot, "docs"),
    now
  });
  return {
    db,
    dataDir,
    executions: new ExternalExecutionRepository(db),
    manifests: new ExecutionManifestRepository(db),
    workspaces: new RunWorkspaceRepository(db)
  };
}

function createExecution(
  executions: ExternalExecutionRepository,
  input: {
    runId: string;
    key: string;
    workspaceRoot?: string;
  }
) {
  const now = "2026-01-01T00:00:00.000Z";
  const run: RunRecord = {
    id: input.runId,
    monde_id: "m",
    mon_id: "seia",
    status: "queued",
    process_status: "not_started",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "queued",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "system", label: "external:test" },
    intent: { title: input.key, prompt: "produce outputs" },
    execution: { externally_managed: true },
    ...(input.workspaceRoot
      ? {
          scope_snapshot: {
            workspace_mode: "isolated",
            scratch_path: input.workspaceRoot,
            execution_root: input.workspaceRoot,
            recovery_window_seconds: 86400
          }
        }
      : {}),
    result: {},
    created_at: now,
    updated_at: now
  };
  return executions.createOrGet({
    integrationId: "tea-party",
    externalExecutionKey: input.key,
    requestDigest: createHash("sha256").update(input.key).digest("hex"),
    run,
    externalScope: { persona: "seia" },
    externalContext: { queue_item: input.key }
  }).execution;
}

function opaqueOutput(logicalName = "result"): ExecutionManifestOutputInput {
  return {
    logical_name: logicalName,
    staging_ref: {
      type: "opaque",
      value: {
        provider: "tea-party-stage",
        object_key: `stage/${logicalName}`
      }
    },
    sha256: "a".repeat(64),
    byte_size: 42,
    media_type: "application/json"
  };
}

test("manifest registration is immutable and idempotent while availability stays mutable", (t) => {
  const { executions, manifests } = fixture(t);
  const execution = createExecution(executions, {
    runId: "run_manifest",
    key: "filius:manifest"
  });
  const outputs = [opaqueOutput()];
  const digest = canonicalSha256({ outputs });
  const first = manifests.register({
    externalExecutionId: execution.id,
    manifestDigest: digest,
    outputs
  });
  const replay = manifests.register({
    externalExecutionId: execution.id,
    manifestDigest: digest,
    outputs
  });

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.manifest.id, first.manifest.id);
  assert.deepEqual(first.manifest.outputs[0].staging_ref, outputs[0].staging_ref);
  assert.equal(first.manifest.outputs[0].producer_run_id, execution.run_id);
  assert.equal(first.manifest.outputs[0].external_execution_key, execution.external_execution_key);
  assert.throws(
    () =>
      manifests.register({
        externalExecutionId: execution.id,
        manifestDigest: "b".repeat(64),
        outputs
      }),
    (error) =>
      error instanceof ExecutionManifestConflictError &&
      error.code === "manifest_conflict"
  );

  const deleted = manifests.updateAvailability({
    externalExecutionId: execution.id,
    logicalName: "result",
    status: "deleted",
    reason: "staging object removed"
  });
  assert.equal(deleted.manifest_digest, digest);
  assert.equal(deleted.outputs[0].availability.status, "deleted");
});

test("logical output identity is scoped to one external execution", (t) => {
  const { executions, manifests } = fixture(t);
  const first = createExecution(executions, {
    runId: "run_one",
    key: "filius:one"
  });
  const second = createExecution(executions, {
    runId: "run_two",
    key: "filius:two"
  });
  const outputs = [opaqueOutput("proposal")];

  assert.equal(
    manifests.register({
      externalExecutionId: first.id,
      manifestDigest: canonicalSha256({ execution: first.id, outputs }),
      outputs
    }).created,
    true
  );
  assert.equal(
    manifests.register({
      externalExecutionId: second.id,
      manifestDigest: canonicalSha256({ execution: second.id, outputs }),
      outputs
    }).created,
    true
  );
});

test("completion accepts only a manifest owned by the same external execution", (t) => {
  const { db, executions, manifests } = fixture(t);
  const first = createExecution(executions, {
    runId: "run_completion_manifest_one",
    key: "filius:completion-one"
  });
  const second = createExecution(executions, {
    runId: "run_completion_manifest_two",
    key: "filius:completion-two"
  });
  const firstManifest = manifests.register({
    externalExecutionId: first.id,
    manifestDigest: "a".repeat(64),
    outputs: [opaqueOutput()]
  }).manifest;
  const secondManifest = manifests.register({
    externalExecutionId: second.id,
    manifestDigest: "b".repeat(64),
    outputs: [opaqueOutput()]
  }).manifest;
  executions.updatePhase(first.id, "active");
  executions.recordProcessExit(
    first.id,
    { code: 0, signal: null },
    86400,
    "2026-01-01T00:01:00.000Z"
  );
  const manager = new RunManager({
    mondes: {} as never,
    externalExecutions: executions,
    executionManifests: manifests,
    mons: {} as never,
    runs: new RunRepository(db),
    logs: new LogRepository(db),
    artifacts: new ArtifactRepository(db),
    events: new RunEventBus(new RunEventRepository(db)),
    config: {
      serviceAddr: "http://127.0.0.1:3761",
      mcpAddr: "http://127.0.0.1:3762/mcp"
    }
  });

  assert.throws(
    () =>
      manager.completeExternalExecution({
        executionId: first.id,
        completionDigest: canonicalSha256({ manifest_id: secondManifest.id }),
        manifestId: secondManifest.id
      }),
    (error) =>
      error instanceof ExecutionManifestConflictError &&
      error.code === "manifest_ownership_conflict"
  );
  const completed = manager.completeExternalExecution({
    executionId: first.id,
    completionDigest: canonicalSha256({ manifest_id: firstManifest.id }),
    manifestId: firstManifest.id
  });
  assert.equal(completed.outcome, "succeeded");
  assert.equal(completed.completion_manifest_id, firstManifest.id);
  assert.equal(
    manager.completeExternalExecution({
      executionId: first.id,
      completionDigest: canonicalSha256({ manifest_id: firstManifest.id }),
      manifestId: firstManifest.id
    }).outcome,
    "succeeded"
  );
});

test("local manifest verification rejects escapes and symbolic links", (t) => {
  const { executions, manifests } = fixture(t);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "monde-manifest-scratch-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const execution = createExecution(executions, {
    runId: "run_local_security",
    key: "filius:local-security",
    workspaceRoot: scratch
  });
  executions.recordProcessExit(
    execution.id,
    { code: 0, signal: null },
    86400,
    "2026-01-01T00:01:00.000Z"
  );
  const outside = path.join(path.dirname(scratch), "outside-output.txt");
  fs.writeFileSync(outside, "outside\n");
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(scratch, "linked.txt"));

  for (const localPath of ["../outside-output.txt", "linked.txt"]) {
    assert.throws(
      () =>
        manifests.register({
          externalExecutionId: execution.id,
          manifestDigest: createHash("sha256").update(localPath).digest("hex"),
          outputs: [
            {
              logical_name: "unsafe",
              staging_ref: { type: "local_path", path: localPath },
              sha256: createHash("sha256").update("outside\n").digest("hex"),
              byte_size: 8,
              media_type: "text/plain"
            }
          ]
        }),
      (error) =>
        error instanceof ExecutionManifestConflictError &&
        error.code === "output_verification_failed"
    );
  }
});

test("local manifest verification rejects a rename and replacement race", (t) => {
  const { db, executions } = fixture(t);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "monde-manifest-swap-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const filePath = path.join(scratch, "result.txt");
  fs.writeFileSync(filePath, "original\n");
  const execution = createExecution(executions, {
    runId: "run_local_swap",
    key: "filius:local-swap",
    workspaceRoot: scratch
  });
  executions.recordProcessExit(
    execution.id,
    { code: 0, signal: null },
    86400,
    "2026-01-01T00:01:00.000Z"
  );
  const manifests = new ExecutionManifestRepository(db, {
    afterOpen(candidate) {
      fs.renameSync(candidate, `${candidate}.old`);
      fs.writeFileSync(candidate, "replacement\n");
    }
  });

  assert.throws(
    () =>
      manifests.register({
        externalExecutionId: execution.id,
        manifestDigest: "c".repeat(64),
        outputs: [
          {
            logical_name: "result",
            staging_ref: { type: "local_path", path: "result.txt" },
            sha256: createHash("sha256").update("original\n").digest("hex"),
            byte_size: 9,
            media_type: "text/plain"
          }
        ]
      }),
    (error) =>
      error instanceof ExecutionManifestConflictError &&
      error.code === "output_verification_failed"
  );
});

test("scratch cleanup expires local references but preserves immutable manifest metadata", (t) => {
  const { db, dataDir, executions, manifests, workspaces } = fixture(t);
  const scopeRoot = path.join(dataDir, "run-scopes", "run_cleanup_manifest");
  const scratch = path.join(scopeRoot, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const content = "temporary output\n";
  fs.writeFileSync(path.join(scratch, "result.txt"), content);
  const execution = createExecution(executions, {
    runId: "run_cleanup_manifest",
    key: "filius:cleanup",
    workspaceRoot: scratch
  });
  executions.recordProcessExit(
    execution.id,
    { code: 0, signal: null },
    86400,
    "2026-01-01T00:01:00.000Z"
  );
  const output: ExecutionManifestOutputInput = {
    logical_name: "result",
    staging_ref: { type: "local_path", path: "result.txt" },
    sha256: createHash("sha256").update(content).digest("hex"),
    byte_size: Buffer.byteLength(content),
    media_type: "text/plain"
  };
  const registered = manifests.register({
    externalExecutionId: execution.id,
    manifestDigest: canonicalSha256({ outputs: [output] }),
    outputs: [output]
  }).manifest;
  workspaces.register({
    runId: execution.run_id,
    workspaceMode: "isolated",
    scopeRoot,
    scratchPath: scratch
  });
  const expiresAt = "2026-01-01T00:02:00.000Z";
  workspaces.seal(execution.run_id, "2026-01-01T00:01:00.000Z", expiresAt);
  const manager = new RunManager({
    mondes: {} as never,
    externalExecutions: executions,
    executionManifests: manifests,
    mons: {} as never,
    runs: new RunRepository(db),
    runWorkspaces: workspaces,
    logs: new LogRepository(db),
    artifacts: new ArtifactRepository(db),
    events: new RunEventBus(new RunEventRepository(db)),
    config: {
      serviceAddr: "http://127.0.0.1:3761",
      mcpAddr: "http://127.0.0.1:3762/mcp",
      dataDir
    }
  });

  manager.sweepExpiredRunScopes(expiresAt);

  assert.equal(fs.existsSync(scopeRoot), false);
  const retained = manifests.get(registered.id);
  assert.equal(retained?.manifest_digest, registered.manifest_digest);
  assert.equal(retained?.outputs[0].availability.status, "expired");
  assert.equal(workspaces.get(execution.run_id)?.state, "cleaned");
});
