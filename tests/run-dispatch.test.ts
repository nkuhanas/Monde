import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateDatabase } from "../packages/service/src/db.ts";
import { ProcessSlotRepository } from "../packages/service/src/repositories/process-slots.ts";
import { RunRepository } from "../packages/service/src/repositories/runs.ts";
import type { RunRecord } from "@monde/core";

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db);
  t.after(() => db.close());
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO mondes (id, name, root, docs, created_at, updated_at)
     VALUES ('m', 'M', '/tmp/m', '/tmp/m/docs', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO mons (
       id, monde_id, name, role, mon_root, work_root, default_harness,
       default_model, capabilities_json, created_at, updated_at
     ) VALUES ('mon', 'm', 'Mon', 'test', '/tmp/m/mon', '/tmp/m', 'codex', NULL, '[]', ?, ?)`
  ).run(now, now);
  return {
    db,
    slots: new ProcessSlotRepository(db),
    runs: new RunRepository(db)
  };
}

function run(id: string, createdAt: string): RunRecord {
  return {
    id,
    monde_id: "m",
    mon_id: "mon",
    status: "queued",
    process_status: "not_started",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "queued",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "operator" },
    intent: { title: id, prompt: id },
    execution: {},
    result: {},
    created_at: createdAt,
    updated_at: createdAt
  };
}

test("process slot reservation atomically enforces the configured limit", (t) => {
  const { slots, runs } = fixture(t);
  for (const id of ["run_a", "run_b", "run_c"]) {
    runs.insert(run(id, `2026-01-01T00:00:0${id.at(-1) === "a" ? "1" : id.at(-1) === "b" ? "2" : "3"}.000Z`));
  }

  assert.equal(slots.reserve({ runId: "run_a", mondeId: "m", monId: "mon", kind: "one_shot", limit: 2 }).reserved, true);
  assert.equal(slots.reserve({ runId: "run_b", mondeId: "m", monId: "mon", kind: "one_shot", limit: 2 }).reserved, true);
  const denied = slots.reserve({ runId: "run_c", mondeId: "m", monId: "mon", kind: "one_shot", limit: 2 });
  assert.equal(denied.reserved, false);
  assert.deepEqual(denied.activeRunIds, ["run_a", "run_b"]);
});

test("active lookup returns all process runs and queue lookup remains oldest-first", (t) => {
  const { runs } = fixture(t);
  const first = run("run_first", "2026-01-01T00:00:01.000Z");
  const second = run("run_second", "2026-01-01T00:00:02.000Z");
  runs.insert(first);
  runs.insert(second);
  assert.equal(runs.getOldestQueuedForMon("m", "mon")?.id, "run_first");

  runs.updateLifecycle(first.id, { status: "starting", process_status: "spawning" });
  runs.updateLifecycle(second.id, { status: "starting", process_status: "spawning" });
  assert.deepEqual(runs.listActiveForMon("m", "mon").map((candidate) => candidate.id), ["run_first", "run_second"]);
});

test("orphan reconciliation releases slots whose process lifecycle is no longer active", (t) => {
  const { slots, runs } = fixture(t);
  runs.insert(run("run_finished", "2026-01-01T00:00:01.000Z"));
  slots.reserve({ runId: "run_finished", mondeId: "m", monId: "mon", kind: "one_shot", limit: 1 });

  assert.equal(slots.releaseOrphans(), 1);
  assert.deepEqual(slots.listForMon("m", "mon"), []);
});
