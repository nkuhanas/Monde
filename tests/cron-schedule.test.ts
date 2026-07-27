import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateDatabase } from "../packages/service/src/db.ts";
import {
  CronScheduleConflictError,
  CronScheduleRepository,
  nextCronFire,
  validateCronSchedule
} from "../packages/service/src/repositories/cron-schedules.ts";
import { ExternalExecutionRepository } from "../packages/service/src/repositories/external-executions.ts";

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrateDatabase(db);
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO mondes (id, name, root, docs, created_at, updated_at)
     VALUES ('m', 'M', '/tmp/m', '/tmp/m/docs', @now, @now)`
  ).run({ now });
  return { db, schedules: new CronScheduleRepository(db) };
}

test("cron validation requires five fields and honors IANA timezone transitions", () => {
  assert.throws(
    () => validateCronSchedule("0 9 * *", "UTC"),
    /exactly five fields/
  );
  assert.throws(
    () => validateCronSchedule("0 9 * * *", "Not/A_Timezone")
  );
  assert.equal(
    nextCronFire(
      "0 9 * * *",
      "America/Los_Angeles",
      "2026-03-08T08:00:00.000Z"
    ),
    "2026-03-08T16:00:00.000Z"
  );
});

test("a due cron schedule enqueues one ordinary run exactly once", async (t) => {
  const { db, schedules } = fixture(t);
  const schedule = schedules.create({
    id: "cron_once",
    mondeId: "m",
    monId: "seia",
    name: "Once per minute",
    expression: "* * * * *",
    timezone: "UTC",
    title: "Scheduled work",
    prompt: "Perform scheduled work.",
    now: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(schedule.next_fire_at, "2026-01-01T00:01:00.000Z");

  const ticks = await Promise.all(
    Array.from({ length: 20 }, () =>
      Promise.resolve().then(() =>
        schedules.tick("2026-01-01T00:01:00.000Z")
      )
    )
  );
  assert.equal(ticks.flat().length, 1);
  const [result] = ticks.flat();
  assert.equal(result.run.origin.type, "cron");
  assert.deepEqual(result.run.origin, {
    type: "cron",
    cron_id: schedule.id,
    scheduled_fire_time: "2026-01-01T00:01:00.000Z",
    fired_at: "2026-01-01T00:01:00.000Z"
  });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number })
      .count,
    1
  );
  assert.equal(schedules.listFires(schedule.id).length, 1);
});

test("missed activations coalesce to the latest due fire", (t) => {
  const { schedules } = fixture(t);
  const schedule = schedules.create({
    id: "cron_coalesce",
    mondeId: "m",
    monId: "seia",
    name: "Five minutes",
    expression: "*/5 * * * *",
    timezone: "UTC",
    title: "Coalesced work",
    prompt: "Run the latest activation.",
    now: "2026-01-01T00:00:00.000Z"
  });

  const [result] = schedules.tick("2026-01-01T00:22:00.000Z");
  assert.equal(result.fire.scheduled_fire_time, "2026-01-01T00:20:00.000Z");
  assert.equal(
    result.fire.coalesced_from_fire_time,
    "2026-01-01T00:05:00.000Z"
  );
  assert.equal(result.schedule.next_fire_at, "2026-01-01T00:25:00.000Z");
  assert.equal(result.schedule.pending_fire_at, null);
  assert.equal(
    result.run.origin.type === "cron"
      ? result.run.origin.scheduled_fire_time
      : undefined,
    "2026-01-01T00:20:00.000Z"
  );
  assert.equal(schedule.last_fired_at, null);
});

test("one outstanding run defers and coalesces later fires until a slot is needed", (t) => {
  const { db, schedules } = fixture(t);
  const schedule = schedules.create({
    id: "cron_pending",
    mondeId: "m",
    monId: "seia",
    name: "Pending",
    expression: "*/5 * * * *",
    timezone: "UTC",
    title: "Pending work",
    prompt: "Only one pending run.",
    now: "2026-01-01T00:00:00.000Z"
  });
  const [first] = schedules.tick("2026-01-01T00:05:00.000Z");
  assert.equal(schedules.tick("2026-01-01T00:22:00.000Z").length, 0);
  assert.equal(
    schedules.get(schedule.id)?.pending_fire_at,
    "2026-01-01T00:20:00.000Z"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number })
      .count,
    1
  );

  db.prepare(
    `UPDATE runs
     SET status = 'finished',
         process_status = 'exited',
         runtime_state = 'closed',
         ended_at = '2026-01-01T00:23:00.000Z',
         closed_at = '2026-01-01T00:23:00.000Z',
         updated_at = '2026-01-01T00:23:00.000Z'
     WHERE id = ?`
  ).run(first.run.id);
  const [second] = schedules.tick("2026-01-01T00:23:00.000Z");
  assert.equal(second.fire.scheduled_fire_time, "2026-01-01T00:20:00.000Z");
  assert.equal(
    second.fire.coalesced_from_fire_time,
    "2026-01-01T00:10:00.000Z"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number })
      .count,
    2
  );
});

test("disabled and archived schedules do not fire, while archived history remains", (t) => {
  const { db, schedules } = fixture(t);
  const disabled = schedules.create({
    id: "cron_disabled",
    mondeId: "m",
    monId: "seia",
    name: "Disabled",
    expression: "* * * * *",
    timezone: "UTC",
    title: "Disabled",
    prompt: "Do not run.",
    enabled: false,
    now: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(disabled.next_fire_at, null);
  assert.equal(schedules.tick("2026-01-01T12:00:00.000Z").length, 0);

  const enabled = schedules.update(
    disabled.id,
    { enabled: true },
    "2026-01-01T12:00:00.000Z"
  );
  assert.equal(enabled.next_fire_at, "2026-01-01T12:01:00.000Z");
  schedules.tick("2026-01-01T12:01:00.000Z");
  assert.equal(schedules.delete(enabled.id), true);
  assert.equal(schedules.list("m").length, 0);
  assert.ok(schedules.get(enabled.id)?.archived_at);
  assert.equal(schedules.listFires(enabled.id).length, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number })
      .count,
    1
  );
});

test("integration schedules are idempotent and create stable process-exit executions per fire", (t) => {
  const { db, schedules } = fixture(t);
  const contextPacket = {
    schema: { id: "example.scheduled-context", version: "1" },
    scheduleKey: "persona-review",
    scope: { kind: "persona", personaId: "persona-1" },
    objective: "Review this persona."
  };
  const input = {
    integrationId: "example",
    externalScheduleKey: "persona-review",
    requestDigest: "a".repeat(64),
    mondeId: "m",
    monId: "seia",
    name: "Persona review",
    expression: "* * * * *",
    timezone: "UTC",
    title: "Review persona",
    contextPacket,
    now: "2026-01-01T00:00:00.000Z"
  };

  const first = schedules.createIntegrationOrGet(input);
  const replay = schedules.createIntegrationOrGet(input);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.schedule.id, first.schedule.id);
  assert.throws(
    () =>
      schedules.createIntegrationOrGet({
        ...input,
        requestDigest: "b".repeat(64)
      }),
    CronScheduleConflictError
  );

  const [tick] = schedules.tick("2026-01-01T00:01:00.000Z");
  assert.ok(tick.external_execution);
  assert.equal(
    tick.fire.external_execution_key,
    "persona-review:2026-01-01T00:01:00.000Z"
  );
  assert.equal(tick.external_execution.completion_policy, "process_exit");
  assert.equal(tick.external_execution.run_id, tick.run.id);
  assert.deepEqual(tick.external_execution.external_context, contextPacket);
  assert.deepEqual(tick.external_execution.external_scope, contextPacket);
  assert.equal(tick.run.execution.externally_managed, true);
  assert.equal(tick.run.origin.type, "cron");

  const executions = new ExternalExecutionRepository(db);
  assert.equal(
    executions.getByKey(
      "example",
      "persona-review:2026-01-01T00:01:00.000Z"
    )?.run_id,
    tick.run.id
  );
});
