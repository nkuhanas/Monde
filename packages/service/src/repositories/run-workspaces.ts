import type { DatabaseSync } from "node:sqlite";

export type RunWorkspaceState = "active" | "sealed" | "cleanup_failed" | "cleaned";

export interface RunWorkspaceRecord {
  run_id: string;
  workspace_mode: "shared" | "isolated";
  scope_root: string;
  context_path: string | null;
  scratch_path: string | null;
  state: RunWorkspaceState;
  created_at: string;
  sealed_at: string | null;
  expires_at: string | null;
  cleaned_at: string | null;
  cleanup_attempts: number;
  cleanup_error: string | null;
}

export class RunWorkspaceRepository {
  constructor(private readonly db: DatabaseSync) {}

  register(record: {
    runId: string;
    workspaceMode: "shared" | "isolated";
    scopeRoot: string;
    contextPath?: string;
    scratchPath?: string;
    createdAt?: string;
  }): RunWorkspaceRecord {
    const createdAt = record.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO run_workspaces (
           run_id, workspace_mode, scope_root, context_path, scratch_path, state, created_at
         ) VALUES (
           @run_id, @workspace_mode, @scope_root, @context_path, @scratch_path, 'active', @created_at
         )
         ON CONFLICT(run_id) DO NOTHING`
      )
      .run({
        run_id: record.runId,
        workspace_mode: record.workspaceMode,
        scope_root: record.scopeRoot,
        context_path: record.contextPath ?? null,
        scratch_path: record.scratchPath ?? null,
        created_at: createdAt
      });
    return this.get(record.runId)!;
  }

  get(runId: string): RunWorkspaceRecord | undefined {
    return this.db.prepare("SELECT * FROM run_workspaces WHERE run_id = ?").get(runId) as
      | RunWorkspaceRecord
      | undefined;
  }

  seal(runId: string, sealedAt: string, expiresAt: string): void {
    this.db
      .prepare(
        `UPDATE run_workspaces
         SET state = CASE WHEN state = 'cleaned' THEN state ELSE 'sealed' END,
             sealed_at = COALESCE(sealed_at, @sealed_at),
             expires_at = COALESCE(expires_at, @expires_at),
             cleanup_error = NULL
         WHERE run_id = @run_id`
      )
      .run({ run_id: runId, sealed_at: sealedAt, expires_at: expiresAt });
  }

  listExpired(now: string): RunWorkspaceRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM run_workspaces
         WHERE state IN ('sealed', 'cleanup_failed')
           AND expires_at IS NOT NULL
           AND expires_at <= ?
         ORDER BY expires_at ASC, run_id ASC`
      )
      .all(now) as RunWorkspaceRecord[];
  }

  markCleaned(runId: string, cleanedAt: string): void {
    this.db
      .prepare(
        `UPDATE run_workspaces
         SET state = 'cleaned',
             cleaned_at = @cleaned_at,
             cleanup_attempts = cleanup_attempts + 1,
             cleanup_error = NULL
         WHERE run_id = @run_id`
      )
      .run({ run_id: runId, cleaned_at: cleanedAt });
  }

  markCleanupFailed(runId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE run_workspaces
         SET state = 'cleanup_failed',
             cleanup_attempts = cleanup_attempts + 1,
             cleanup_error = @cleanup_error
         WHERE run_id = @run_id`
      )
      .run({ run_id: runId, cleanup_error: error });
  }
}
