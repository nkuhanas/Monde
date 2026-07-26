import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalSha256, type RunRecord } from "@monde/core";
import { migrateDatabase } from "../packages/service/src/db.ts";
import {
  ExternalExecutionConflictError,
  ExternalExecutionRepository
} from "../packages/service/src/repositories/external-executions.ts";

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db);
  t.after(() => db.close());
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO mondes (id, name, root, docs, created_at, updated_at)
     VALUES ('m', 'M', '/tmp/m', '/tmp/m/docs', ?, ?)`
  ).run(now, now);
  return { db, executions: new ExternalExecutionRepository(db) };
}

function run(id: string): RunRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
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
    intent: { title: id, prompt: "execute" },
    execution: { externally_managed: true },
    result: {},
    created_at: now,
    updated_at: now
  };
}

function create(
  executions: ExternalExecutionRepository,
  input: {
    runId: string;
    key?: string;
    digest?: string;
    predecessorKey?: string;
    lineage?: unknown;
    completionPolicy?: "process_exit" | "external_receipt";
  }
) {
  return executions.createOrGet({
    integrationId: "tea-party",
    externalExecutionKey: input.key ?? "queue:1",
    requestDigest: input.digest ?? "a".repeat(64),
    run: run(input.runId),
    externalScope: "persona:1",
    externalContext: { queue: "q1" },
    completionPolicy: input.completionPolicy,
    externalLineage: input.lineage,
    predecessorExternalKey: input.predecessorKey
  });
}

test("twenty concurrent duplicate starts reserve one execution and one run", async (t) => {
  const { db, executions } = fixture(t);
  const starts = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      Promise.resolve().then(() => create(executions, { runId: `run_${index}` }))
    )
  );

  assert.equal(starts.filter((result) => result.created).length, 1);
  assert.equal(new Set(starts.map((result) => result.execution.id)).size, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 1);
});

test("same key with a different digest conflicts and lookup recovers the original run", (t) => {
  const { executions } = fixture(t);
  const original = create(executions, { runId: "run_original" }).execution;
  assert.throws(
    () => create(executions, { runId: "run_conflict", digest: "b".repeat(64) }),
    (error) => error instanceof ExternalExecutionConflictError && error.code === "digest_conflict"
  );
  assert.equal(executions.getByKey("tea-party", "queue:1")?.run_id, original.run_id);
});

test("caller lineage remains opaque and a remote predecessor resolves to null locally", (t) => {
  const { executions } = fixture(t);
  const lineage = { root: "global-root", attempt: 7, predecessor_node: "other-monde" };
  const remote = create(executions, {
    runId: "run_remote",
    key: "queue:7",
    predecessorKey: "queue:6",
    lineage
  }).execution;
  assert.deepEqual(remote.external_lineage, lineage);
  assert.equal(remote.local_predecessor_run_id, null);

  const predecessor = create(executions, { runId: "run_local_8", key: "queue:8" }).execution;
  const local = create(executions, {
    runId: "run_local_9",
    key: "queue:9",
    predecessorKey: predecessor.external_execution_key
  }).execution;
  assert.equal(local.local_predecessor_run_id, predecessor.run_id);
});

test("phase and outcome remain separate through clean exit and idempotent completion", (t) => {
  const { executions } = fixture(t);
  const execution = create(executions, { runId: "run_lifecycle" }).execution;
  executions.updatePhase(execution.id, "starting");
  executions.updatePhase(execution.id, "active");
  const exited = executions.recordProcessExit(
    execution.id,
    { code: 0, signal: null },
    86400,
    "2026-01-01T00:01:00.000Z"
  );
  assert.equal(exited.phase, "awaiting_completion");
  assert.equal(exited.outcome, null);

  const receipt = { proposal: "proposal_1", asserted_valid: true };
  const digest = canonicalSha256({ completion_receipt: receipt });
  const completed = executions.recordCompletion({
    id: execution.id,
    digest,
    receipt,
    now: "2026-01-01T00:02:00.000Z"
  });
  assert.equal(completed.phase, "terminal");
  assert.equal(completed.outcome, "succeeded");
  assert.equal(executions.recordCompletion({ id: execution.id, digest, receipt }).outcome, "succeeded");
  assert.throws(
    () => executions.recordCompletion({ id: execution.id, digest: "f".repeat(64), receipt }),
    (error) => error instanceof ExternalExecutionConflictError && error.code === "completion_conflict"
  );
});

test("process-exit completion succeeds cleanly without a receipt or manifest", (t) => {
  const { executions } = fixture(t);
  const execution = create(executions, {
    runId: "run_process_exit",
    key: "queue:process-exit",
    completionPolicy: "process_exit"
  }).execution;
  executions.updatePhase(execution.id, "starting");
  executions.updatePhase(execution.id, "active");

  const exited = executions.recordProcessExit(
    execution.id,
    { code: 0, signal: null },
    86400,
    "2026-01-01T00:01:00.000Z"
  );

  assert.equal(exited.completion_policy, "process_exit");
  assert.equal(exited.phase, "terminal");
  assert.equal(exited.outcome, "succeeded");
  assert.equal(exited.completion_digest, null);
  assert.equal(exited.completion_manifest_id, null);
  assert.equal(exited.completion_deadline_at, null);
});

test("completion before exit succeeds only after a clean exit", (t) => {
  const { executions } = fixture(t);
  const execution = create(executions, { runId: "run_completion_first" }).execution;
  executions.updatePhase(execution.id, "active");
  const digest = canonicalSha256({ completion_receipt: { receipt: 1 } });
  const recorded = executions.recordCompletion({ id: execution.id, digest, receipt: { receipt: 1 } });
  assert.equal(recorded.phase, "active");
  assert.equal(recorded.outcome, null);
  const exited = executions.recordProcessExit(execution.id, { code: 0, signal: null }, 86400);
  assert.equal(exited.phase, "terminal");
  assert.equal(exited.outcome, "succeeded");
});

test("cancellation remains observable until process exit acknowledgement", (t) => {
  const { executions } = fixture(t);
  const execution = create(executions, { runId: "run_cancel" }).execution;
  executions.updatePhase(execution.id, "active");
  const requested = executions.requestCancellation(execution.id, false);
  assert.equal(requested.phase, "cancelling");
  assert.equal(requested.cancellation_state, "requested");
  assert.equal(executions.markCancellationSignalled(execution.id).cancellation_state, "signalled");
  const acknowledged = executions.recordProcessExit(execution.id, { code: null, signal: "SIGTERM" }, 86400);
  assert.equal(acknowledged.phase, "terminal");
  assert.equal(acknowledged.outcome, "cancelled");
  assert.equal(acknowledged.cancellation_state, "acknowledged");
});

test("completion, cancellation, and exit ordering produces one deterministic outcome", (t) => {
  const { executions } = fixture(t);
  const cancelled = create(executions, {
    runId: "run_cancel_completion_race",
    key: "queue:cancel-completion-race"
  }).execution;
  executions.updatePhase(cancelled.id, "active");
  executions.requestCancellation(cancelled.id, false);
  executions.recordCompletion({
    id: cancelled.id,
    digest: canonicalSha256({ completion_receipt: { assertion: "valid" } }),
    receipt: { assertion: "valid" }
  });
  const cancellationWon = executions.recordProcessExit(
    cancelled.id,
    { code: 0, signal: null },
    86400
  );
  assert.equal(cancellationWon.phase, "terminal");
  assert.equal(cancellationWon.outcome, "cancelled");
  assert.equal(cancellationWon.cancellation_state, "acknowledged");

  const succeeded = create(executions, {
    runId: "run_completion_exit_race",
    key: "queue:completion-exit-race"
  }).execution;
  executions.updatePhase(succeeded.id, "active");
  executions.recordCompletion({
    id: succeeded.id,
    digest: canonicalSha256({ completion_receipt: { assertion: "valid" } }),
    receipt: { assertion: "valid" }
  });
  const completionWon = executions.recordProcessExit(
    succeeded.id,
    { code: 0, signal: null },
    86400
  );
  assert.equal(completionWon.phase, "terminal");
  assert.equal(completionWon.outcome, "succeeded");
  assert.throws(
    () => executions.requestCancellation(succeeded.id, false),
    (error) =>
      error instanceof ExternalExecutionConflictError &&
      error.code === "terminal_conflict"
  );
});

test("missing completion expires as a failed condition, not a lost outcome", (t) => {
  const { executions } = fixture(t);
  const execution = create(executions, { runId: "run_missing" }).execution;
  executions.updatePhase(execution.id, "active");
  executions.recordProcessExit(execution.id, { code: 0, signal: null }, 10, "2026-01-01T00:00:00.000Z");
  assert.equal(executions.expireMissingCompletions("2026-01-01T00:00:09.000Z").length, 0);
  const [expired] = executions.expireMissingCompletions("2026-01-01T00:00:10.000Z");
  assert.equal(expired.phase, "terminal");
  assert.equal(expired.outcome, "failed");
  assert.equal(expired.condition, "missing_completion");
});
