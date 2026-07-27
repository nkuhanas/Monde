import type { DatabaseSync } from "node:sqlite";
import { CronExpressionParser } from "cron-parser";
import { nanoid } from "nanoid";
import { canonicalSha256, type RunRecord } from "@monde/core";
import {
  createExternalRun,
  integrationContextPrompt
} from "../external-runs.js";
import {
  ExternalExecutionRepository,
  type ExternalExecutionRecord
} from "./external-executions.js";
import { RunRepository } from "./runs.js";

export interface CronScheduleRecord {
  id: string;
  monde_id: string;
  mon_id: string;
  name: string;
  expression: string;
  timezone: string;
  title: string;
  prompt: string;
  harness_override: string | null;
  sandbox_mode: string | null;
  integration_id: string | null;
  external_schedule_key: string | null;
  request_digest: string | null;
  context_packet?: unknown;
  enabled: boolean;
  next_fire_at: string | null;
  pending_first_fire_at: string | null;
  pending_fire_at: string | null;
  last_scheduled_fire_at: string | null;
  last_fired_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CronFireRecord {
  id: string;
  cron_id: string;
  scheduled_fire_time: string;
  coalesced_from_fire_time: string | null;
  fired_at: string;
  run_id: string;
  external_execution_key: string | null;
}

export interface CronTickResult {
  schedule: CronScheduleRecord;
  fire: CronFireRecord;
  run: RunRecord;
  external_execution?: ExternalExecutionRecord;
}

export class CronScheduleConflictError extends Error {
  readonly code = "schedule_digest_conflict";
}

export class CronScheduleRepository {
  private readonly runs: RunRepository;
  private readonly externalExecutions: ExternalExecutionRepository;

  constructor(private readonly db: DatabaseSync) {
    this.runs = new RunRepository(db);
    this.externalExecutions = new ExternalExecutionRepository(db);
  }

  create(input: {
    id?: string;
    mondeId: string;
    monId: string;
    name: string;
    expression: string;
    timezone: string;
    title: string;
    prompt: string;
    harnessOverride?: string;
    sandboxMode?: string;
    enabled?: boolean;
    now?: string;
  }): CronScheduleRecord {
    const now = input.now ?? new Date().toISOString();
    const enabled = input.enabled ?? true;
    const nextFireAt = enabled
      ? nextCronFire(input.expression, input.timezone, now)
      : null;
    const id = input.id ?? `cron_${nanoid(12)}`;
    this.db
      .prepare(
        `INSERT INTO cron_schedules (
           id, monde_id, mon_id, name, expression, timezone, title, prompt,
           harness_override, sandbox_mode, enabled, next_fire_at,
           pending_first_fire_at, pending_fire_at, last_scheduled_fire_at,
           last_fired_at, archived_at, created_at, updated_at
         ) VALUES (
           @id, @monde_id, @mon_id, @name, @expression, @timezone, @title, @prompt,
           @harness_override, @sandbox_mode, @enabled, @next_fire_at,
           NULL, NULL, NULL, NULL, NULL, @created_at, @updated_at
         )`
      )
      .run({
        id,
        monde_id: input.mondeId,
        mon_id: input.monId,
        name: input.name,
        expression: input.expression,
        timezone: input.timezone,
        title: input.title,
        prompt: input.prompt,
        harness_override: input.harnessOverride ?? null,
        sandbox_mode: input.sandboxMode ?? null,
        enabled: enabled ? 1 : 0,
        next_fire_at: nextFireAt,
        created_at: now,
        updated_at: now
      });
    return this.get(id)!;
  }

  createIntegrationOrGet(input: {
    integrationId: string;
    externalScheduleKey: string;
    requestDigest: string;
    mondeId: string;
    monId: string;
    name: string;
    expression: string;
    timezone: string;
    title: string;
    contextPacket: unknown;
    harnessOverride?: string;
    sandboxMode?: string;
    enabled?: boolean;
    now?: string;
  }): { schedule: CronScheduleRecord; created: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getByExternalKey(
        input.integrationId,
        input.externalScheduleKey
      );
      if (existing) {
        if (existing.request_digest !== input.requestDigest) {
          throw new CronScheduleConflictError(
            `Schedule key ${input.integrationId}/${input.externalScheduleKey} already has a different digest.`
          );
        }
        this.db.exec("COMMIT");
        return { schedule: existing, created: false };
      }

      const now = input.now ?? new Date().toISOString();
      const enabled = input.enabled ?? true;
      const id = `cron_${nanoid(12)}`;
      this.db
        .prepare(
          `INSERT INTO cron_schedules (
             id, monde_id, mon_id, name, expression, timezone, title, prompt,
             harness_override, sandbox_mode, integration_id,
             external_schedule_key, request_digest, context_packet_json,
             enabled, next_fire_at, pending_first_fire_at, pending_fire_at,
             last_scheduled_fire_at, last_fired_at, archived_at, created_at, updated_at
           ) VALUES (
             @id, @monde_id, @mon_id, @name, @expression, @timezone, @title, @prompt,
             @harness_override, @sandbox_mode, @integration_id,
             @external_schedule_key, @request_digest, @context_packet_json,
             @enabled, @next_fire_at, NULL, NULL, NULL, NULL, NULL, @created_at, @updated_at
           )`
        )
        .run({
          id,
          monde_id: input.mondeId,
          mon_id: input.monId,
          name: input.name,
          expression: input.expression,
          timezone: input.timezone,
          title: input.title,
          prompt: integrationContextPrompt(input.contextPacket),
          harness_override: input.harnessOverride ?? null,
          sandbox_mode: input.sandboxMode ?? null,
          integration_id: input.integrationId,
          external_schedule_key: input.externalScheduleKey,
          request_digest: input.requestDigest,
          context_packet_json: JSON.stringify(input.contextPacket),
          enabled: enabled ? 1 : 0,
          next_fire_at: enabled
            ? nextCronFire(input.expression, input.timezone, now)
            : null,
          created_at: now,
          updated_at: now
        });
      const schedule = this.get(id)!;
      this.db.exec("COMMIT");
      return { schedule, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getByExternalKey(
    integrationId: string,
    externalScheduleKey: string
  ): CronScheduleRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM cron_schedules
         WHERE integration_id = ? AND external_schedule_key = ?`
      )
      .get(integrationId, externalScheduleKey) as
      | CronScheduleRow
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  get(id: string): CronScheduleRecord | undefined {
    const row = this.db.prepare("SELECT * FROM cron_schedules WHERE id = ?").get(id) as
      | CronScheduleRow
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(mondeId?: string): CronScheduleRecord[] {
    const rows = mondeId
      ? this.db
          .prepare(
            "SELECT * FROM cron_schedules WHERE monde_id = ? AND archived_at IS NULL ORDER BY name, id"
          )
          .all(mondeId)
      : this.db
          .prepare(
            "SELECT * FROM cron_schedules WHERE archived_at IS NULL ORDER BY monde_id, name, id"
          )
          .all();
    return (rows as CronScheduleRow[]).map(fromRow);
  }

  update(
    id: string,
    patch: Partial<{
      monId: string;
      name: string;
      expression: string;
      timezone: string;
      title: string;
      prompt: string;
      harnessOverride: string | null;
      sandboxMode: string | null;
      enabled: boolean;
    }>,
    now = new Date().toISOString()
  ): CronScheduleRecord {
    const current = this.require(id);
    if (current.archived_at) {
      throw new Error(`Cron schedule is archived: ${id}`);
    }
    const expression = patch.expression ?? current.expression;
    const timezone = patch.timezone ?? current.timezone;
    const enabled = patch.enabled ?? current.enabled;
    const scheduleChanged =
      patch.expression !== undefined ||
      patch.timezone !== undefined ||
      (patch.enabled === true && !current.enabled);
    const nextFireAt = !enabled
      ? null
      : scheduleChanged
        ? nextCronFire(expression, timezone, now)
        : current.next_fire_at;
    this.db
      .prepare(
        `UPDATE cron_schedules
         SET mon_id = @mon_id,
             name = @name,
             expression = @expression,
             timezone = @timezone,
             title = @title,
             prompt = @prompt,
             harness_override = @harness_override,
             sandbox_mode = @sandbox_mode,
             enabled = @enabled,
             next_fire_at = @next_fire_at,
             pending_first_fire_at = @pending_first_fire_at,
             pending_fire_at = @pending_fire_at,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        mon_id: patch.monId ?? current.mon_id,
        name: patch.name ?? current.name,
        expression,
        timezone,
        title: patch.title ?? current.title,
        prompt: patch.prompt ?? current.prompt,
        harness_override:
          patch.harnessOverride === undefined
            ? current.harness_override
            : patch.harnessOverride,
        sandbox_mode:
          patch.sandboxMode === undefined
            ? current.sandbox_mode
            : patch.sandboxMode,
        enabled: enabled ? 1 : 0,
        next_fire_at: nextFireAt,
        pending_first_fire_at:
          !enabled || scheduleChanged ? null : current.pending_first_fire_at,
        pending_fire_at:
          !enabled || scheduleChanged ? null : current.pending_fire_at,
        updated_at: now
      });
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE cron_schedules
         SET enabled = 0,
             next_fire_at = NULL,
             pending_first_fire_at = NULL,
             pending_fire_at = NULL,
             archived_at = COALESCE(archived_at, @archived_at),
             updated_at = @archived_at
         WHERE id = @id AND archived_at IS NULL`
      )
      .run({ id, archived_at: now }) as { changes: number };
    return result.changes > 0;
  }

  disableForMon(
    mondeId: string,
    monId: string,
    now = new Date().toISOString()
  ): number {
    const result = this.db
      .prepare(
        `UPDATE cron_schedules
         SET enabled = 0,
             next_fire_at = NULL,
             pending_first_fire_at = NULL,
             pending_fire_at = NULL,
             updated_at = @updated_at
         WHERE monde_id = @monde_id
           AND mon_id = @mon_id
           AND archived_at IS NULL
           AND enabled = 1`
      )
      .run({
        monde_id: mondeId,
        mon_id: monId,
        updated_at: now
      }) as { changes: number };
    return result.changes;
  }

  listFires(id: string): CronFireRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM cron_fires
         WHERE cron_id = ?
         ORDER BY fired_at DESC, id DESC`
      )
      .all(id) as CronFireRecord[];
  }

  tick(now = new Date().toISOString()): CronTickResult[] {
    const candidates = this.db
      .prepare(
        `SELECT id
         FROM cron_schedules
         WHERE enabled = 1
           AND archived_at IS NULL
           AND (
             pending_fire_at IS NOT NULL OR
             (next_fire_at IS NOT NULL AND next_fire_at <= @now)
           )
         ORDER BY COALESCE(pending_fire_at, next_fire_at), id`
      )
      .all({ now }) as Array<{ id: string }>;
    const results: CronTickResult[] = [];
    for (const candidate of candidates) {
      const result = this.tickSchedule(candidate.id, now);
      if (result) {
        results.push(result);
      }
    }
    return results;
  }

  private tickSchedule(id: string, now: string): CronTickResult | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let schedule = this.get(id);
      if (!schedule || !schedule.enabled) {
        this.db.exec("COMMIT");
        return undefined;
      }

      if (schedule.next_fire_at && schedule.next_fire_at <= now) {
        const firstDue = schedule.next_fire_at;
        const latestDue = cronFireAtOrBefore(
          schedule.expression,
          schedule.timezone,
          now
        );
        const nextFireAt = nextCronFire(
          schedule.expression,
          schedule.timezone,
          now
        );
        this.db
          .prepare(
            `UPDATE cron_schedules
             SET next_fire_at = @next_fire_at,
                 pending_first_fire_at = COALESCE(pending_first_fire_at, @first_due),
                 pending_fire_at = @latest_due,
                 updated_at = @updated_at
             WHERE id = @id`
          )
          .run({
            id,
            next_fire_at: nextFireAt,
            first_due: firstDue,
            latest_due: latestDue,
            updated_at: now
          });
        schedule = this.require(id);
      }

      if (!schedule.pending_fire_at) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const outstanding = this.db
        .prepare(
          `SELECT cron_fires.run_id
           FROM cron_fires
           JOIN runs ON runs.id = cron_fires.run_id
           WHERE cron_fires.cron_id = ?
             AND runs.status IN ('queued', 'starting', 'active')
           LIMIT 1`
        )
        .get(id) as { run_id: string } | undefined;
      if (outstanding) {
        this.db.exec("COMMIT");
        return undefined;
      }

      const externalExecutionKey =
        schedule.integration_id &&
        schedule.external_schedule_key &&
        schedule.context_packet !== undefined
          ? cronExternalExecutionKey(
              schedule.external_schedule_key,
              schedule.pending_fire_at
            )
          : null;
      const run =
        externalExecutionKey &&
        schedule.integration_id &&
        schedule.context_packet !== undefined
          ? createExternalRun({
              integrationId: schedule.integration_id,
              externalExecutionKey,
              mondeId: schedule.monde_id,
              monId: schedule.mon_id,
              prompt: integrationContextPrompt(schedule.context_packet),
              completionPolicy: "process_exit",
              contextPacketDigest: canonicalSha256(schedule.context_packet),
              harnessOverride: schedule.harness_override ?? undefined,
              sandboxMode: schedule.sandbox_mode ?? undefined,
              origin: {
                type: "cron",
                cron_id: schedule.id,
                scheduled_fire_time: schedule.pending_fire_at,
                fired_at: now
              },
              title: schedule.title,
              createdAt: now
            })
          : cronRun(schedule, now);
      const externalExecution =
        externalExecutionKey &&
        schedule.integration_id &&
        schedule.context_packet !== undefined
          ? this.externalExecutions.createOrGetInTransaction({
              integrationId: schedule.integration_id,
              externalExecutionKey,
              requestDigest: canonicalSha256({
                integration_id: schedule.integration_id,
                external_execution_key: externalExecutionKey,
                monde_id: schedule.monde_id,
                mon_id: schedule.mon_id,
                schedule_digest: schedule.request_digest,
                scheduled_fire_time: schedule.pending_fire_at,
                context_packet: schedule.context_packet
              }),
              run,
              externalScope: schedule.context_packet,
              externalContext: schedule.context_packet,
              completionPolicy: "process_exit",
              now
            }).execution
          : undefined;
      if (!externalExecution) {
        this.runs.insert(run);
      }
      const persistedRun = externalExecution
        ? this.runs.get(externalExecution.run_id)!
        : run;
      const fire: CronFireRecord = {
        id: `cron_fire_${nanoid(12)}`,
        cron_id: schedule.id,
        scheduled_fire_time: schedule.pending_fire_at,
        coalesced_from_fire_time:
          schedule.pending_first_fire_at &&
          schedule.pending_first_fire_at !== schedule.pending_fire_at
            ? schedule.pending_first_fire_at
            : null,
        fired_at: now,
        run_id: persistedRun.id,
        external_execution_key: externalExecutionKey
      };
      this.db
        .prepare(
          `INSERT INTO cron_fires (
             id, cron_id, scheduled_fire_time, coalesced_from_fire_time, fired_at,
             run_id, external_execution_key
           ) VALUES (
             @id, @cron_id, @scheduled_fire_time, @coalesced_from_fire_time, @fired_at,
             @run_id, @external_execution_key
           )`
        )
        .run(fire);
      this.db
        .prepare(
          `UPDATE cron_schedules
           SET pending_first_fire_at = NULL,
               pending_fire_at = NULL,
               last_scheduled_fire_at = @scheduled_fire_time,
               last_fired_at = @fired_at,
               updated_at = @fired_at
           WHERE id = @id`
        )
        .run({
          id,
          scheduled_fire_time: fire.scheduled_fire_time,
          fired_at: now
        });
      const updated = this.require(id);
      this.db.exec("COMMIT");
      return {
        schedule: updated,
        fire,
        run: persistedRun,
        ...(externalExecution ? { external_execution: externalExecution } : {})
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private require(id: string): CronScheduleRecord {
    const schedule = this.get(id);
    if (!schedule) {
      throw new Error(`Cron schedule not found: ${id}`);
    }
    return schedule;
  }
}

export function validateCronSchedule(expression: string, timezone: string): void {
  if (expression.trim().split(/\s+/).length !== 5) {
    throw new Error("Cron expressions must contain exactly five fields.");
  }
  CronExpressionParser.parse(expression, {
    currentDate: new Date(),
    tz: timezone
  });
}

export function nextCronFire(
  expression: string,
  timezone: string,
  after: string
): string {
  validateCronSchedule(expression, timezone);
  const next = CronExpressionParser.parse(expression, {
    currentDate: new Date(after),
    tz: timezone
  })
    .next()
    .toISOString();
  if (!next) {
    throw new Error("Cron schedule has no next occurrence.");
  }
  return next;
}

function cronFireAtOrBefore(
  expression: string,
  timezone: string,
  at: string
): string {
  validateCronSchedule(expression, timezone);
  const previous = CronExpressionParser.parse(expression, {
    currentDate: new Date(Date.parse(at) + 1),
    tz: timezone
  })
    .prev()
    .toISOString();
  if (!previous) {
    throw new Error("Cron schedule has no previous occurrence.");
  }
  return previous;
}

function cronRun(schedule: CronScheduleRecord, firedAt: string): RunRecord {
  return {
    id: `run_${nanoid(10)}`,
    monde_id: schedule.monde_id,
    mon_id: schedule.mon_id,
    status: "queued",
    process_status: "not_started",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "queued",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: {
      type: "cron",
      cron_id: schedule.id,
      scheduled_fire_time: schedule.pending_fire_at ?? undefined,
      fired_at: firedAt
    },
    intent: {
      title: schedule.title,
      prompt: schedule.prompt
    },
    execution: {
      cron_schedule_id: schedule.id,
      ...(schedule.harness_override
        ? { harness_override: schedule.harness_override }
        : {}),
      ...(schedule.sandbox_mode
        ? { sandbox_mode: schedule.sandbox_mode }
        : {})
    },
    result: {},
    created_at: firedAt,
    updated_at: firedAt
  };
}

interface CronScheduleRow extends Omit<CronScheduleRecord, "enabled"> {
  enabled: number;
  context_packet_json: string | null;
}

function fromRow(row: CronScheduleRow): CronScheduleRecord {
  const { context_packet_json: contextPacketJson, ...record } = row;
  return {
    ...record,
    enabled: row.enabled === 1,
    ...(contextPacketJson !== null
      ? { context_packet: JSON.parse(contextPacketJson) }
      : {})
  };
}

function cronExternalExecutionKey(
  externalScheduleKey: string,
  scheduledFireTime: string
): string {
  return `${externalScheduleKey}:${scheduledFireTime}`;
}
