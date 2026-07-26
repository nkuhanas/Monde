import type { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import type {
  ExternalExecutionCompletionPolicy,
  ExternalCancellationState,
  ExternalExecutionOutcome,
  ExternalExecutionPhase,
  RunRecord
} from "@monde/core";
import { RunRepository } from "./runs.js";

export interface ExternalExecutionRecord {
  id: string;
  integration_id: string;
  external_execution_key: string;
  request_digest: string;
  run_id: string;
  monde_id: string;
  mon_id: string;
  completion_policy: ExternalExecutionCompletionPolicy;
  external_scope: unknown;
  external_context: unknown;
  artifact_sink_ref?: unknown;
  external_lineage?: unknown;
  predecessor_integration_id: string | null;
  predecessor_external_key: string | null;
  local_predecessor_run_id: string | null;
  phase: ExternalExecutionPhase;
  outcome: ExternalExecutionOutcome;
  condition: string | null;
  process_exit_code: number | null;
  process_exit_signal: string | null;
  process_exited_at: string | null;
  completion_digest: string | null;
  completion_receipt?: unknown;
  completion_manifest_id: string | null;
  completion_received_at: string | null;
  completion_deadline_at: string | null;
  cancellation_state: ExternalCancellationState;
  cancellation_requested_at: string | null;
  cancellation_signalled_at: string | null;
  cancellation_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ExternalExecutionConflictError extends Error {
  constructor(
    message: string,
    readonly code: "digest_conflict" | "completion_conflict" | "terminal_conflict"
  ) {
    super(message);
  }
}

export class ExternalExecutionRepository {
  private readonly runs: RunRepository;

  constructor(private readonly db: DatabaseSync) {
    this.runs = new RunRepository(db);
  }

  createOrGet(input: {
    integrationId: string;
    externalExecutionKey: string;
    requestDigest: string;
    run: RunRecord;
    externalScope: unknown;
    externalContext: unknown;
    completionPolicy?: ExternalExecutionCompletionPolicy;
    artifactSinkRef?: unknown;
    externalLineage?: unknown;
    predecessorIntegrationId?: string;
    predecessorExternalKey?: string;
    now?: string;
  }): { execution: ExternalExecutionRecord; created: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getByKey(input.integrationId, input.externalExecutionKey);
      if (existing) {
        if (existing.request_digest !== input.requestDigest) {
          throw new ExternalExecutionConflictError(
            `External execution key ${input.integrationId}/${input.externalExecutionKey} already has a different digest.`,
            "digest_conflict"
          );
        }
        if (
          input.completionPolicy !== undefined &&
          existing.completion_policy !== input.completionPolicy
        ) {
          throw new ExternalExecutionConflictError(
            `External execution key ${input.integrationId}/${input.externalExecutionKey} already uses completion policy ${existing.completion_policy}.`,
            "digest_conflict"
          );
        }
        this.db.exec("COMMIT");
        return { execution: existing, created: false };
      }

      const predecessor =
        input.predecessorExternalKey
          ? this.getByKey(input.predecessorIntegrationId ?? input.integrationId, input.predecessorExternalKey)
          : undefined;
      const now = input.now ?? new Date().toISOString();
      const id = `ext_${nanoid(14)}`;
      this.runs.insert(input.run);
      this.db
        .prepare(
          `INSERT INTO external_executions (
             id, integration_id, external_execution_key, request_digest, run_id, monde_id, mon_id,
             completion_policy,
             external_scope_json, external_context_json, artifact_sink_ref_json, external_lineage_json,
             predecessor_integration_id, predecessor_external_key, local_predecessor_run_id,
             phase, outcome, condition, cancellation_state, created_at, updated_at
           ) VALUES (
             @id, @integration_id, @external_execution_key, @request_digest, @run_id, @monde_id, @mon_id,
             @completion_policy,
             @external_scope_json, @external_context_json, @artifact_sink_ref_json, @external_lineage_json,
             @predecessor_integration_id, @predecessor_external_key, @local_predecessor_run_id,
             'queued', NULL, NULL, 'none', @created_at, @updated_at
           )`
        )
        .run({
          id,
          integration_id: input.integrationId,
          external_execution_key: input.externalExecutionKey,
          request_digest: input.requestDigest,
          run_id: input.run.id,
          monde_id: input.run.monde_id,
          mon_id: input.run.mon_id,
          completion_policy: input.completionPolicy ?? "external_receipt",
          external_scope_json: JSON.stringify(input.externalScope),
          external_context_json: JSON.stringify(input.externalContext),
          artifact_sink_ref_json: input.artifactSinkRef === undefined ? null : JSON.stringify(input.artifactSinkRef),
          external_lineage_json: input.externalLineage === undefined ? null : JSON.stringify(input.externalLineage),
          predecessor_integration_id: input.predecessorIntegrationId ?? (input.predecessorExternalKey ? input.integrationId : null),
          predecessor_external_key: input.predecessorExternalKey ?? null,
          local_predecessor_run_id: predecessor?.run_id ?? null,
          created_at: now,
          updated_at: now
        });
      const execution = this.get(id)!;
      this.db.exec("COMMIT");
      return { execution, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string): ExternalExecutionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM external_executions WHERE id = ?").get(id) as ExternalExecutionRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getByKey(integrationId: string, externalExecutionKey: string): ExternalExecutionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM external_executions WHERE integration_id = ? AND external_execution_key = ?")
      .get(integrationId, externalExecutionKey) as ExternalExecutionRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getByRunId(runId: string): ExternalExecutionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM external_executions WHERE run_id = ?").get(runId) as
      | ExternalExecutionRow
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  updatePhase(id: string, phase: Extract<ExternalExecutionPhase, "starting" | "active">): ExternalExecutionRecord {
    this.db
      .prepare(
        `UPDATE external_executions
         SET phase = @phase, updated_at = @updated_at
         WHERE id = @id AND phase != 'terminal'`
      )
      .run({ id, phase, updated_at: new Date().toISOString() });
    return this.get(id)!;
  }

  recordProcessExit(
    id: string,
    exit: { code: number | null; signal: string | null },
    recoveryWindowSeconds: number,
    now = new Date().toISOString()
  ): ExternalExecutionRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.require(id);
      if (current.phase === "terminal") {
        this.db.exec("COMMIT");
        return current;
      }

      const cancellation = current.cancellation_state === "requested" || current.cancellation_state === "signalled";
      const clean = exit.code === 0 && !exit.signal;
      const processExitSuccess = clean && current.completion_policy === "process_exit";
      const phase: ExternalExecutionPhase = cancellation
        ? "terminal"
        : processExitSuccess || (clean && current.completion_digest)
          ? "terminal"
          : clean
            ? "awaiting_completion"
            : "terminal";
      const outcome: ExternalExecutionOutcome = cancellation
        ? "cancelled"
        : processExitSuccess || (clean && current.completion_digest)
          ? "succeeded"
          : clean
            ? null
            : "failed";
      const condition = cancellation
        ? null
        : clean
          ? null
          : exit.signal
            ? "process_interrupted"
            : "process_exit_nonzero";
      const deadline = clean && current.completion_policy === "external_receipt" && !current.completion_digest
        ? new Date(Date.parse(now) + recoveryWindowSeconds * 1000).toISOString()
        : null;
      this.db
        .prepare(
          `UPDATE external_executions
           SET phase = @phase,
               outcome = @outcome,
               condition = @condition,
               process_exit_code = @process_exit_code,
               process_exit_signal = @process_exit_signal,
               process_exited_at = @process_exited_at,
               completion_deadline_at = @completion_deadline_at,
               cancellation_state = @cancellation_state,
               cancellation_acknowledged_at = @cancellation_acknowledged_at,
               updated_at = @updated_at
           WHERE id = @id`
        )
        .run({
          id,
          phase,
          outcome,
          condition,
          process_exit_code: exit.code,
          process_exit_signal: exit.signal,
          process_exited_at: now,
          completion_deadline_at: deadline,
          cancellation_state: cancellation ? "acknowledged" : current.cancellation_state,
          cancellation_acknowledged_at: cancellation ? now : current.cancellation_acknowledged_at,
          updated_at: now
        });
      const updated = this.require(id);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordCompletion(input: {
    id: string;
    digest: string;
    receipt?: unknown;
    manifestId?: string;
    now?: string;
  }): ExternalExecutionRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.require(input.id);
      if (current.completion_digest) {
        if (current.completion_digest !== input.digest) {
          throw new ExternalExecutionConflictError("Completion was already recorded with a different digest.", "completion_conflict");
        }
        this.db.exec("COMMIT");
        return current;
      }
      if (current.phase === "terminal") {
        throw new ExternalExecutionConflictError("Terminal execution cannot be completed.", "terminal_conflict");
      }
      const now = input.now ?? new Date().toISOString();
      const processExitedCleanly =
        current.process_exited_at !== null &&
        current.process_exit_code === 0 &&
        current.process_exit_signal === null;
      this.db
        .prepare(
          `UPDATE external_executions
           SET completion_digest = @completion_digest,
               completion_receipt_json = @completion_receipt_json,
               completion_manifest_id = @completion_manifest_id,
               completion_received_at = @completion_received_at,
               phase = @phase,
               outcome = @outcome,
               condition = NULL,
               completion_deadline_at = NULL,
               updated_at = @updated_at
           WHERE id = @id`
        )
        .run({
          id: input.id,
          completion_digest: input.digest,
          completion_receipt_json: input.receipt === undefined ? null : JSON.stringify(input.receipt),
          completion_manifest_id: input.manifestId ?? null,
          completion_received_at: now,
          phase: processExitedCleanly ? "terminal" : current.phase,
          outcome: processExitedCleanly ? "succeeded" : current.outcome,
          updated_at: now
        });
      const updated = this.require(input.id);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  requestCancellation(id: string, queued: boolean, now = new Date().toISOString()): ExternalExecutionRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.require(id);
      if (current.phase === "terminal") {
        if (current.outcome === "cancelled") {
          this.db.exec("COMMIT");
          return current;
        }
        throw new ExternalExecutionConflictError("Terminal execution cannot be cancelled.", "terminal_conflict");
      }
      this.db
        .prepare(
          `UPDATE external_executions
           SET phase = @phase,
               outcome = @outcome,
               condition = NULL,
               cancellation_state = @cancellation_state,
               cancellation_requested_at = COALESCE(cancellation_requested_at, @requested_at),
               cancellation_acknowledged_at = @acknowledged_at,
               updated_at = @updated_at
           WHERE id = @id`
        )
        .run({
          id,
          phase: queued ? "terminal" : "cancelling",
          outcome: queued ? "cancelled" : null,
          cancellation_state: queued ? "acknowledged" : "requested",
          requested_at: now,
          acknowledged_at: queued ? now : current.cancellation_acknowledged_at,
          updated_at: now
        });
      const updated = this.require(id);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markCancellationSignalled(id: string, now = new Date().toISOString()): ExternalExecutionRecord {
    this.db
      .prepare(
        `UPDATE external_executions
         SET cancellation_state = 'signalled',
             cancellation_signalled_at = @now,
             updated_at = @now
         WHERE id = @id AND phase = 'cancelling' AND cancellation_state = 'requested'`
      )
      .run({ id, now });
    return this.require(id);
  }

  markProcessLostByRun(runId: string, now = new Date().toISOString()): ExternalExecutionRecord | undefined {
    const current = this.getByRunId(runId);
    if (!current || current.phase === "terminal") {
      return current;
    }
    const cancellationLost = current.cancellation_state === "requested" || current.cancellation_state === "signalled";
    this.db
      .prepare(
        `UPDATE external_executions
         SET phase = 'terminal',
             outcome = 'failed',
             condition = @condition,
             cancellation_state = @cancellation_state,
             updated_at = @updated_at
         WHERE run_id = @run_id`
      )
      .run({
        run_id: runId,
        condition: cancellationLost ? "cancellation_lost" : "process_lost",
        cancellation_state: cancellationLost ? "lost" : current.cancellation_state,
        updated_at: now
      });
    return this.getByRunId(runId);
  }

  markFailedByRun(
    runId: string,
    condition: string,
    cancellationState?: Extract<ExternalCancellationState, "failed" | "lost">,
    now = new Date().toISOString()
  ): ExternalExecutionRecord | undefined {
    const current = this.getByRunId(runId);
    if (!current || current.phase === "terminal") {
      return current;
    }
    this.db
      .prepare(
        `UPDATE external_executions
         SET phase = 'terminal',
             outcome = 'failed',
             condition = @condition,
             cancellation_state = @cancellation_state,
             updated_at = @updated_at
         WHERE run_id = @run_id`
      )
      .run({
        run_id: runId,
        condition,
        cancellation_state: cancellationState ?? current.cancellation_state,
        updated_at: now
      });
    return this.getByRunId(runId);
  }

  setTerminalConditionByRun(runId: string, condition: string, now = new Date().toISOString()): ExternalExecutionRecord | undefined {
    this.db
      .prepare(
        `UPDATE external_executions
         SET condition = @condition, updated_at = @updated_at
         WHERE run_id = @run_id AND phase = 'terminal' AND outcome = 'failed'`
      )
      .run({ run_id: runId, condition, updated_at: now });
    return this.getByRunId(runId);
  }

  expireMissingCompletions(now = new Date().toISOString()): ExternalExecutionRecord[] {
    const candidates = this.db
      .prepare(
        `SELECT id FROM external_executions
         WHERE phase = 'awaiting_completion'
           AND completion_deadline_at IS NOT NULL
           AND completion_deadline_at <= ?
         ORDER BY completion_deadline_at ASC, id ASC`
      )
      .all(now) as Array<{ id: string }>;
    const updated: ExternalExecutionRecord[] = [];
    for (const candidate of candidates) {
      this.db
        .prepare(
          `UPDATE external_executions
           SET phase = 'terminal',
               outcome = 'failed',
               condition = 'missing_completion',
               updated_at = @updated_at
           WHERE id = @id AND phase = 'awaiting_completion'`
        )
        .run({ id: candidate.id, updated_at: now });
      updated.push(this.require(candidate.id));
    }
    return updated;
  }

  private require(id: string): ExternalExecutionRecord {
    const execution = this.get(id);
    if (!execution) {
      throw new Error(`External execution not found: ${id}`);
    }
    return execution;
  }
}

interface ExternalExecutionRow {
  id: string;
  integration_id: string;
  external_execution_key: string;
  request_digest: string;
  run_id: string;
  monde_id: string;
  mon_id: string;
  completion_policy: ExternalExecutionCompletionPolicy;
  external_scope_json: string;
  external_context_json: string;
  artifact_sink_ref_json: string | null;
  external_lineage_json: string | null;
  predecessor_integration_id: string | null;
  predecessor_external_key: string | null;
  local_predecessor_run_id: string | null;
  phase: ExternalExecutionPhase;
  outcome: ExternalExecutionOutcome;
  condition: string | null;
  process_exit_code: number | null;
  process_exit_signal: string | null;
  process_exited_at: string | null;
  completion_digest: string | null;
  completion_receipt_json: string | null;
  completion_manifest_id: string | null;
  completion_received_at: string | null;
  completion_deadline_at: string | null;
  cancellation_state: ExternalCancellationState;
  cancellation_requested_at: string | null;
  cancellation_signalled_at: string | null;
  cancellation_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: ExternalExecutionRow): ExternalExecutionRecord {
  return {
    id: row.id,
    integration_id: row.integration_id,
    external_execution_key: row.external_execution_key,
    request_digest: row.request_digest,
    run_id: row.run_id,
    monde_id: row.monde_id,
    mon_id: row.mon_id,
    completion_policy: row.completion_policy,
    external_scope: JSON.parse(row.external_scope_json),
    external_context: JSON.parse(row.external_context_json),
    artifact_sink_ref: row.artifact_sink_ref_json ? JSON.parse(row.artifact_sink_ref_json) : undefined,
    external_lineage: row.external_lineage_json ? JSON.parse(row.external_lineage_json) : undefined,
    predecessor_integration_id: row.predecessor_integration_id,
    predecessor_external_key: row.predecessor_external_key,
    local_predecessor_run_id: row.local_predecessor_run_id,
    phase: row.phase,
    outcome: row.outcome,
    condition: row.condition,
    process_exit_code: row.process_exit_code,
    process_exit_signal: row.process_exit_signal,
    process_exited_at: row.process_exited_at,
    completion_digest: row.completion_digest,
    completion_receipt: row.completion_receipt_json ? JSON.parse(row.completion_receipt_json) : undefined,
    completion_manifest_id: row.completion_manifest_id,
    completion_received_at: row.completion_received_at,
    completion_deadline_at: row.completion_deadline_at,
    cancellation_state: row.cancellation_state,
    cancellation_requested_at: row.cancellation_requested_at,
    cancellation_signalled_at: row.cancellation_signalled_at,
    cancellation_acknowledged_at: row.cancellation_acknowledged_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
