import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { closeHitlThreadLifecycle, type RunRecord } from "@monde/core";
import { migrateDatabase, schemaVersion } from "../packages/service/src/db.ts";
import { RunRepository } from "../packages/service/src/repositories/runs.ts";

function closedThread(id: string, chatError: string | null): RunRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    monde_id: "m",
    mon_id: "frontend",
    status: "finished",
    process_status: "exited",
    outcome: "unknown",
    interaction_mode: "hitl_thread",
    runtime_state: "closed",
    outcome_state: "unknown",
    close_reason: "user_closed_widget",
    warnings: [],
    origin: { type: "operator" },
    intent: { title: "frontend chat", prompt: "Open-ended conversation." },
    execution: {
      chat_last_error: chatError,
      hitl_timeout_reason: null
    },
    result: {},
    created_at: now,
    updated_at: now,
    opened_at: now,
    closed_at: now,
    ended_at: now
  };
}

test("clean widget closure completes a thread without operator review", () => {
  const patch = closeHitlThreadLifecycle(
    "user_closed_widget",
    false,
    "2026-01-01T00:01:00.000Z"
  );

  assert.equal(patch.outcome, "completed");
  assert.equal(patch.outcome_state, "succeeded");
  assert.equal(patch.runtime_state, "closed");
});

test("an unresolved thread error preserves the unknown outcome for review", () => {
  const patch = closeHitlThreadLifecycle(
    "user_closed_widget",
    true,
    "2026-01-01T00:01:00.000Z"
  );

  assert.equal(patch.outcome, "unknown");
  assert.equal(patch.outcome_state, "unknown");
  assert.equal(patch.runtime_state, "closed");
});

test("schema migration backfills only clean historical thread closures", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrateDatabase(db);
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO mondes (id, name, root, docs, created_at, updated_at)
     VALUES ('m', 'M', '/tmp/m', '/tmp/m/docs', ?, ?)`
  ).run(now, now);
  const runs = new RunRepository(db);
  runs.insert(closedThread("run_clean", null));
  runs.insert(closedThread("run_error", "adapter turn failed"));
  migrateDatabase(db);

  assert.equal(schemaVersion, 14);
  assert.equal(runs.get("run_clean")?.outcome, "completed");
  assert.equal(runs.get("run_clean")?.outcome_state, "succeeded");
  assert.equal(runs.get("run_error")?.outcome, "unknown");
  assert.equal(runs.get("run_error")?.outcome_state, "unknown");
});
