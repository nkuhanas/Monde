import type { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import type { RetryCondition, RunAttemptDto, RunAttemptStatus } from "@monde/core";

export type RunAttemptRecord = RunAttemptDto;

export class RunAttemptRepository {
  constructor(private readonly db: DatabaseSync) {}

  begin(runId: string, now = new Date().toISOString()): RunAttemptRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.latest(runId);
      if (latest && (latest.status === "starting" || latest.status === "active")) {
        this.db.exec("COMMIT");
        return latest;
      }
      const attemptNumber = (latest?.attempt_number ?? 0) + 1;
      const id = `attempt_${nanoid(14)}`;
      this.db
        .prepare(
          `INSERT INTO run_attempts (
             id, run_id, attempt_number, status, condition, pid, exit_code,
             exit_signal, error, retry_at, started_at, spawned_at, ended_at,
             created_at, updated_at
           ) VALUES (
             @id, @run_id, @attempt_number, 'starting', NULL, NULL, NULL,
             NULL, NULL, NULL, @started_at, NULL, NULL, @created_at, @updated_at
           )`
        )
        .run({
          id,
          run_id: runId,
          attempt_number: attemptNumber,
          started_at: now,
          created_at: now,
          updated_at: now
        });
      this.db.exec("COMMIT");
      return this.get(runId, attemptNumber)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markActive(
    runId: string,
    attemptNumber: number,
    pid?: number,
    now = new Date().toISOString()
  ): RunAttemptRecord {
    this.db
      .prepare(
        `UPDATE run_attempts
         SET status = 'active',
             pid = @pid,
             spawned_at = COALESCE(spawned_at, @spawned_at),
             updated_at = @updated_at
         WHERE run_id = @run_id AND attempt_number = @attempt_number
           AND status IN ('starting', 'active')`
      )
      .run({
        run_id: runId,
        attempt_number: attemptNumber,
        pid: pid ?? null,
        spawned_at: now,
        updated_at: now
      });
    return this.require(runId, attemptNumber);
  }

  finish(
    runId: string,
    attemptNumber: number,
    input: {
      status: Exclude<RunAttemptStatus, "starting" | "active">;
      condition?: RetryCondition | string;
      exitCode?: number | null;
      exitSignal?: string | null;
      error?: string;
      retryAt?: string;
      now?: string;
    }
  ): RunAttemptRecord {
    const now = input.now ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE run_attempts
         SET status = @status,
             condition = @condition,
             exit_code = @exit_code,
             exit_signal = @exit_signal,
             error = @error,
             retry_at = @retry_at,
             ended_at = COALESCE(ended_at, @ended_at),
             updated_at = @updated_at
         WHERE run_id = @run_id AND attempt_number = @attempt_number
           AND status IN ('starting', 'active')`
      )
      .run({
        run_id: runId,
        attempt_number: attemptNumber,
        status: input.status,
        condition: input.condition ?? null,
        exit_code: input.exitCode ?? null,
        exit_signal: input.exitSignal ?? null,
        error: input.error ?? null,
        retry_at: input.retryAt ?? null,
        ended_at: now,
        updated_at: now
      });
    return this.require(runId, attemptNumber);
  }

  get(runId: string, attemptNumber: number): RunAttemptRecord | undefined {
    return this.db
      .prepare(
        `SELECT * FROM run_attempts
         WHERE run_id = ? AND attempt_number = ?`
      )
      .get(runId, attemptNumber) as RunAttemptRecord | undefined;
  }

  latest(runId: string): RunAttemptRecord | undefined {
    return this.db
      .prepare(
        `SELECT * FROM run_attempts
         WHERE run_id = ?
         ORDER BY attempt_number DESC
         LIMIT 1`
      )
      .get(runId) as RunAttemptRecord | undefined;
  }

  list(runId: string): RunAttemptRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM run_attempts
         WHERE run_id = ?
         ORDER BY attempt_number ASC`
      )
      .all(runId) as RunAttemptRecord[];
  }

  private require(runId: string, attemptNumber: number): RunAttemptRecord {
    const attempt = this.get(runId, attemptNumber);
    if (!attempt) {
      throw new Error(`Run attempt not found: ${runId}/${attemptNumber}`);
    }
    return attempt;
  }
}
