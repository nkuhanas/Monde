import type { DatabaseSync } from "node:sqlite";
import type { RunInteractionMode, RunLifecyclePatch, RunRecord, RunRuntimeState, RunStatus } from "@monde/core";
import { RunRecordSchema } from "@monde/core";

export interface RunListFilters {
  mondeId?: string;
  monId?: string;
  status?: RunStatus;
  interactionMode?: RunInteractionMode;
  runtimeState?: RunRuntimeState | "open";
  originType?: string;
}

export class RunRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(filters: RunListFilters = {}): RunRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.mondeId) {
      clauses.push("monde_id = @monde_id");
      params.monde_id = filters.mondeId;
    }

    if (filters.monId) {
      clauses.push("mon_id = @mon_id");
      params.mon_id = filters.monId;
    }

    if (filters.status) {
      clauses.push("status = @status");
      params.status = filters.status;
    }
    if (filters.interactionMode) {
      clauses.push("interaction_mode = @interaction_mode");
      params.interaction_mode = filters.interactionMode;
    }
    if (filters.runtimeState && filters.runtimeState !== "open") {
      clauses.push("runtime_state = @runtime_state");
      params.runtime_state = filters.runtimeState;
    }
    if (filters.runtimeState === "open") {
      clauses.push("runtime_state IN ('queued', 'running', 'waiting_for_user', 'idle_open')");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const statement = this.db.prepare(`SELECT * FROM runs ${where} ORDER BY updated_at DESC, created_at DESC`);
    const rows = clauses.length > 0 ? statement.all(params) : statement.all();

    return rows.map((row) => this.fromRow(row as RunRow)).filter((run) => {
      return !filters.originType || run.origin.type === filters.originType;
    });
  }

  get(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  listActiveForMon(mondeId: string, monId: string): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE monde_id = ? AND mon_id = ? AND status IN ('starting', 'active') AND interaction_mode != 'hitl_thread'
         ORDER BY started_at ASC, created_at ASC, id ASC`
      )
      .all(mondeId, monId) as RunRow[];

    return rows.map((row) => this.fromRow(row));
  }

  getActiveForMon(mondeId: string, monId: string): RunRecord | undefined {
    return this.listActiveForMon(mondeId, monId)[0];
  }

  getOldestQueuedForMon(
    mondeId: string,
    monId: string,
    runnableAt = new Date().toISOString()
  ): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE monde_id = ? AND mon_id = ? AND status = 'queued'
           AND COALESCE((
             SELECT retry_at
             FROM run_attempts
             WHERE run_attempts.run_id = runs.id
             ORDER BY attempt_number DESC
             LIMIT 1
           ), '') <= ?
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(mondeId, monId, runnableAt) as RunRow | undefined;

    return row ? this.fromRow(row) : undefined;
  }

  listQueued(): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status = 'queued' AND interaction_mode != 'hitl_thread'
         ORDER BY created_at ASC, id ASC`
      )
      .all() as RunRow[];
    return rows.map((row) => this.fromRow(row));
  }

  nextRetryAt(runId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT retry_at
         FROM run_attempts
         WHERE run_id = ?
         ORDER BY attempt_number DESC
         LIMIT 1`
      )
      .get(runId) as { retry_at: string | null } | undefined;
    return row?.retry_at ?? undefined;
  }

  insert(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, monde_id, mon_id, status, process_status, outcome,
          interaction_mode, runtime_state, outcome_state, close_reason, warnings_json,
          origin_json, intent_json, execution_json, scope_snapshot_json, result_json, blocked_reason,
          created_at, updated_at, opened_at, closed_at, started_at, ended_at
        ) VALUES (
          @id, @monde_id, @mon_id, @status, @process_status, @outcome,
          @interaction_mode, @runtime_state, @outcome_state, @close_reason, @warnings_json,
          @origin_json, @intent_json, @execution_json, @scope_snapshot_json, @result_json, @blocked_reason,
          @created_at, @updated_at, @opened_at, @closed_at, @started_at, @ended_at
        )`
      )
      .run({
        id: run.id,
        monde_id: run.monde_id,
        mon_id: run.mon_id,
        status: run.status,
        process_status: run.process_status,
        outcome: run.outcome,
        interaction_mode: run.interaction_mode,
        runtime_state: run.runtime_state,
        outcome_state: run.outcome_state,
        close_reason: run.close_reason ?? null,
        warnings_json: JSON.stringify(run.warnings),
        origin_json: JSON.stringify(run.origin),
        intent_json: JSON.stringify(run.intent),
        execution_json: JSON.stringify(run.execution ?? {}),
        scope_snapshot_json: run.scope_snapshot ? JSON.stringify(run.scope_snapshot) : null,
        result_json: JSON.stringify(run.result ?? {}),
        blocked_reason: run.blocked_reason ?? null,
        created_at: run.created_at,
        updated_at: run.updated_at ?? run.created_at,
        opened_at: run.opened_at ?? null,
        closed_at: run.closed_at ?? null,
        started_at: run.started_at ?? null,
        ended_at: run.ended_at ?? null
      });
  }

  updateLifecycle(id: string, patch: RunLifecyclePatch): void {
    const assignments: string[] = [];
    const params: Record<string, unknown> = { id };

    if (patch.status !== undefined) {
      assignments.push("status = @status");
      params.status = patch.status;
    }
    if (patch.process_status !== undefined) {
      assignments.push("process_status = @process_status");
      params.process_status = patch.process_status;
    }
    if (patch.outcome !== undefined) {
      assignments.push("outcome = @outcome");
      params.outcome = patch.outcome;
    }
    if (patch.interaction_mode !== undefined) {
      assignments.push("interaction_mode = @interaction_mode");
      params.interaction_mode = patch.interaction_mode;
    }
    if (patch.runtime_state !== undefined) {
      assignments.push("runtime_state = @runtime_state");
      params.runtime_state = patch.runtime_state;
    }
    if (patch.outcome_state !== undefined) {
      assignments.push("outcome_state = @outcome_state");
      params.outcome_state = patch.outcome_state;
    }
    if (patch.close_reason !== undefined) {
      assignments.push("close_reason = @close_reason");
      params.close_reason = patch.close_reason;
    }
    if (patch.warnings !== undefined) {
      assignments.push("warnings_json = @warnings_json");
      params.warnings_json = JSON.stringify(patch.warnings);
    }
    if (patch.started_at !== undefined) {
      assignments.push("started_at = @started_at");
      params.started_at = patch.started_at;
    }
    if (patch.ended_at !== undefined) {
      assignments.push("ended_at = @ended_at");
      params.ended_at = patch.ended_at;
    }
    if (patch.updated_at !== undefined) {
      assignments.push("updated_at = @updated_at");
      params.updated_at = patch.updated_at;
    }
    if (patch.opened_at !== undefined) {
      assignments.push("opened_at = @opened_at");
      params.opened_at = patch.opened_at;
    }
    if (patch.closed_at !== undefined) {
      assignments.push("closed_at = @closed_at");
      params.closed_at = patch.closed_at;
    }
    if (patch.blocked_reason !== undefined) {
      assignments.push("blocked_reason = @blocked_reason");
      params.blocked_reason = patch.blocked_reason;
    }

    if (assignments.length === 0) {
      return;
    }

    this.db
      .prepare(`UPDATE runs SET ${assignments.join(", ")} WHERE id = @id`)
      .run(params);
  }

  updateScopeAndExecution(id: string, scopeSnapshot: Record<string, unknown>, execution: Record<string, unknown>): void {
    this.db
      .prepare(
        `UPDATE runs
         SET scope_snapshot_json = @scope_snapshot_json,
             execution_json = @execution_json,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        scope_snapshot_json: JSON.stringify(scopeSnapshot),
        execution_json: JSON.stringify(execution),
        updated_at: new Date().toISOString()
      });
  }

  updateExecution(id: string, execution: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE runs SET execution_json = @execution_json, updated_at = @updated_at WHERE id = @id")
      .run({ id, execution_json: JSON.stringify(execution), updated_at: new Date().toISOString() });
  }

  updateResult(id: string, result: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE runs SET result_json = @result_json, updated_at = @updated_at WHERE id = @id")
      .run({ id, result_json: JSON.stringify(result), updated_at: new Date().toISOString() });
  }

  private fromRow(row: RunRow): RunRecord {
    return RunRecordSchema.parse({
      id: row.id,
      monde_id: row.monde_id,
      mon_id: row.mon_id,
      status: row.status,
      process_status: row.process_status,
      outcome: row.outcome,
      interaction_mode: row.interaction_mode ?? "one_shot",
      runtime_state: row.runtime_state ?? legacyRuntimeState(row.status, row.outcome),
      outcome_state: row.outcome_state ?? legacyOutcomeState(row.outcome),
      close_reason: row.close_reason ?? undefined,
      warnings: JSON.parse(row.warnings_json) as unknown,
      origin: JSON.parse(row.origin_json) as unknown,
      intent: JSON.parse(row.intent_json) as unknown,
      execution: JSON.parse(row.execution_json) as unknown,
      scope_snapshot: row.scope_snapshot_json ? (JSON.parse(row.scope_snapshot_json) as Record<string, unknown>) : undefined,
      result: JSON.parse(row.result_json) as unknown,
      blocked_reason: row.blocked_reason ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at || row.ended_at || row.started_at || row.created_at,
      opened_at: row.opened_at,
      closed_at: row.closed_at,
      started_at: row.started_at,
      ended_at: row.ended_at
    });
  }
}

interface RunRow {
  id: string;
  monde_id: string;
  mon_id: string;
  status: string;
  process_status: string;
  outcome: string;
  interaction_mode: string;
  runtime_state: string;
  outcome_state: string;
  close_reason: string | null;
  warnings_json: string;
  origin_json: string;
  intent_json: string;
  execution_json: string;
  scope_snapshot_json: string | null;
  result_json: string;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  opened_at: string | null;
  closed_at: string | null;
  started_at: string | null;
  ended_at: string | null;
}

function legacyRuntimeState(status: string, outcome: string): string {
  if (status === "queued" || status === "blocked") return "queued";
  if (status === "starting" || status === "active") return "running";
  if (outcome === "failed" || outcome === "interrupted") return "failed";
  if (outcome === "canceled") return "cancelled";
  return "closed";
}

function legacyOutcomeState(outcome: string): string {
  if (outcome === "completed") return "succeeded";
  if (outcome === "failed" || outcome === "interrupted") return "failed";
  return "unknown";
}
