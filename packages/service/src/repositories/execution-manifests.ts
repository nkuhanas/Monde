import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isInsidePath } from "@monde/core";
import { nanoid } from "nanoid";

export type ExecutionManifestAvailability = "available" | "deleted" | "expired";

export type ExecutionManifestStagingRef =
  | { type: "local_path"; path: string }
  | { type: "opaque"; value: unknown };

export interface ExecutionManifestOutputInput {
  logical_name: string;
  staging_ref: ExecutionManifestStagingRef;
  sha256: string;
  byte_size: number;
  media_type: string;
  integration_metadata?: unknown;
}

export interface ExecutionManifestOutputRecord extends ExecutionManifestOutputInput {
  producer_run_id: string;
  external_execution_key: string;
  created_at: string;
  availability: {
    status: ExecutionManifestAvailability;
    reason: string | null;
    updated_at: string;
  };
}

export interface ExecutionManifestRecord {
  id: string;
  external_execution_id: string;
  run_id: string;
  external_execution_key: string;
  manifest_digest: string;
  integration_metadata?: unknown;
  created_at: string;
  outputs: ExecutionManifestOutputRecord[];
}

export class ExecutionManifestConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "manifest_conflict"
      | "duplicate_output"
      | "output_verification_failed"
      | "manifest_ownership_conflict"
  ) {
    super(message);
  }
}

export interface ExecutionManifestFileVerificationHooks {
  afterOpen?(filePath: string): void;
}

export class ExecutionManifestRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly verificationHooks: ExecutionManifestFileVerificationHooks = {}
  ) {}

  register(input: {
    externalExecutionId: string;
    manifestDigest: string;
    outputs: ExecutionManifestOutputInput[];
    integrationMetadata?: unknown;
    now?: string;
  }): { manifest: ExecutionManifestRecord; created: boolean } {
    const existing = this.getByExecution(input.externalExecutionId);
    if (existing) {
      if (existing.manifest_digest !== input.manifestDigest) {
        throw new ExecutionManifestConflictError(
          `External execution ${input.externalExecutionId} already has a different manifest.`,
          "manifest_conflict"
        );
      }
      return { manifest: existing, created: false };
    }

    assertUniqueOutputNames(input.outputs);
    const execution = this.requireExecution(input.externalExecutionId);
    const normalizedOutputs = input.outputs.map((output) =>
      output.staging_ref.type === "local_path"
        ? this.verifyLocalOutput(execution, output)
        : output
    );
    const now = input.now ?? new Date().toISOString();
    const id = `manifest_${nanoid(14)}`;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.getByExecution(input.externalExecutionId);
      if (raced) {
        if (raced.manifest_digest !== input.manifestDigest) {
          throw new ExecutionManifestConflictError(
            `External execution ${input.externalExecutionId} already has a different manifest.`,
            "manifest_conflict"
          );
        }
        this.db.exec("COMMIT");
        return { manifest: raced, created: false };
      }

      this.db
        .prepare(
          `INSERT INTO execution_manifests (
             id, external_execution_id, run_id, manifest_digest, integration_metadata_json, created_at
           ) VALUES (
             @id, @external_execution_id, @run_id, @manifest_digest, @integration_metadata_json, @created_at
           )`
        )
        .run({
          id,
          external_execution_id: execution.id,
          run_id: execution.run_id,
          manifest_digest: input.manifestDigest,
          integration_metadata_json:
            input.integrationMetadata === undefined ? null : JSON.stringify(input.integrationMetadata),
          created_at: now
        });

      const insertOutput = this.db.prepare(
        `INSERT INTO execution_manifest_outputs (
           manifest_id, logical_name, ref_kind, staging_ref_json, sha256, byte_size,
           media_type, integration_metadata_json, created_at
         ) VALUES (
           @manifest_id, @logical_name, @ref_kind, @staging_ref_json, @sha256, @byte_size,
           @media_type, @integration_metadata_json, @created_at
         )`
      );
      const insertAvailability = this.db.prepare(
        `INSERT INTO execution_manifest_availability (
           manifest_id, logical_name, status, reason, updated_at
         ) VALUES (
           @manifest_id, @logical_name, 'available', NULL, @updated_at
         )`
      );
      for (const output of normalizedOutputs) {
        insertOutput.run({
          manifest_id: id,
          logical_name: output.logical_name,
          ref_kind: output.staging_ref.type,
          staging_ref_json: JSON.stringify(output.staging_ref),
          sha256: output.sha256,
          byte_size: output.byte_size,
          media_type: output.media_type,
          integration_metadata_json:
            output.integration_metadata === undefined ? null : JSON.stringify(output.integration_metadata),
          created_at: now
        });
        insertAvailability.run({
          manifest_id: id,
          logical_name: output.logical_name,
          updated_at: now
        });
      }
      const manifest = this.get(id)!;
      this.db.exec("COMMIT");
      return { manifest, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string): ExecutionManifestRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT execution_manifests.*, external_executions.external_execution_key
         FROM execution_manifests
         JOIN external_executions
           ON external_executions.id = execution_manifests.external_execution_id
         WHERE execution_manifests.id = ?`
      )
      .get(id) as ManifestRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  getByExecution(externalExecutionId: string): ExecutionManifestRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT execution_manifests.*, external_executions.external_execution_key
         FROM execution_manifests
         JOIN external_executions
           ON external_executions.id = execution_manifests.external_execution_id
         WHERE execution_manifests.external_execution_id = ?`
      )
      .get(externalExecutionId) as ManifestRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  getByRun(runId: string): ExecutionManifestRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT execution_manifests.*, external_executions.external_execution_key
         FROM execution_manifests
         JOIN external_executions
           ON external_executions.id = execution_manifests.external_execution_id
         WHERE execution_manifests.run_id = ?`
      )
      .get(runId) as ManifestRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  assertOwnedByExecution(manifestId: string, externalExecutionId: string): ExecutionManifestRecord {
    const manifest = this.get(manifestId);
    if (!manifest || manifest.external_execution_id !== externalExecutionId) {
      throw new ExecutionManifestConflictError(
        `Manifest ${manifestId} does not belong to external execution ${externalExecutionId}.`,
        "manifest_ownership_conflict"
      );
    }
    return manifest;
  }

  updateAvailability(input: {
    externalExecutionId: string;
    logicalName: string;
    status: ExecutionManifestAvailability;
    reason?: string;
    now?: string;
  }): ExecutionManifestRecord {
    const manifest = this.getByExecution(input.externalExecutionId);
    if (!manifest) {
      throw new Error(`Manifest not found for external execution ${input.externalExecutionId}.`);
    }
    const output = manifest.outputs.find((candidate) => candidate.logical_name === input.logicalName);
    if (!output) {
      throw new Error(`Manifest output not found: ${input.logicalName}`);
    }
    this.db
      .prepare(
        `UPDATE execution_manifest_availability
         SET status = @status, reason = @reason, updated_at = @updated_at
         WHERE manifest_id = @manifest_id AND logical_name = @logical_name`
      )
      .run({
        manifest_id: manifest.id,
        logical_name: input.logicalName,
        status: input.status,
        reason: input.reason ?? null,
        updated_at: input.now ?? new Date().toISOString()
      });
    return this.get(manifest.id)!;
  }

  markLocalOutputsExpiredByRun(runId: string, now = new Date().toISOString()): number {
    const result = this.db
      .prepare(
        `UPDATE execution_manifest_availability
         SET status = 'expired',
             reason = COALESCE(reason, 'run_workspace_expired'),
             updated_at = @updated_at
         WHERE manifest_id IN (
           SELECT id FROM execution_manifests WHERE run_id = @run_id
         )
           AND logical_name IN (
             SELECT logical_name
             FROM execution_manifest_outputs
             WHERE execution_manifest_outputs.manifest_id = execution_manifest_availability.manifest_id
               AND ref_kind = 'local_path'
           )
           AND status != 'expired'`
      )
      .run({ run_id: runId, updated_at: now }) as { changes: number };
    return result.changes;
  }

  private verifyLocalOutput(
    execution: ExecutionRow,
    output: ExecutionManifestOutputInput
  ): ExecutionManifestOutputInput {
    if (output.staging_ref.type !== "local_path") {
      return output;
    }
    if (execution.process_exited_at === null) {
      throw new ExecutionManifestConflictError(
        "Local manifest outputs can only be verified after the producer process exits.",
        "output_verification_failed"
      );
    }
    if (path.isAbsolute(output.staging_ref.path)) {
      throw new ExecutionManifestConflictError(
        "Local manifest paths must be relative to the run workspace.",
        "output_verification_failed"
      );
    }
    const workspaceRoot = workspaceRootFromScope(execution.scope_snapshot_json);
    if (!workspaceRoot) {
      throw new ExecutionManifestConflictError(
        "The run has no recorded workspace for local manifest verification.",
        "output_verification_failed"
      );
    }
    const verified = verifyLocalManifestFile(
      workspaceRoot,
      output.staging_ref.path,
      this.verificationHooks
    );
    if (verified.sha256 !== output.sha256 || verified.byteSize !== output.byte_size) {
      throw new ExecutionManifestConflictError(
        `Local output ${output.logical_name} does not match its declared checksum and byte size.`,
        "output_verification_failed"
      );
    }
    return {
      ...output,
      staging_ref: {
        type: "local_path",
        path: verified.relativePath
      }
    };
  }

  private requireExecution(id: string): ExecutionRow {
    const row = this.db
      .prepare(
        `SELECT external_executions.id, external_executions.run_id,
                external_executions.external_execution_key,
                external_executions.process_exited_at,
                runs.scope_snapshot_json
         FROM external_executions
         JOIN runs ON runs.id = external_executions.run_id
         WHERE external_executions.id = ?`
      )
      .get(id) as ExecutionRow | undefined;
    if (!row) {
      throw new Error(`External execution not found: ${id}`);
    }
    return row;
  }

  private fromRow(row: ManifestRow): ExecutionManifestRecord {
    const outputRows = this.db
      .prepare(
        `SELECT execution_manifest_outputs.*, execution_manifest_availability.status,
                execution_manifest_availability.reason,
                execution_manifest_availability.updated_at
         FROM execution_manifest_outputs
         JOIN execution_manifest_availability
           ON execution_manifest_availability.manifest_id = execution_manifest_outputs.manifest_id
          AND execution_manifest_availability.logical_name = execution_manifest_outputs.logical_name
         WHERE execution_manifest_outputs.manifest_id = ?
         ORDER BY execution_manifest_outputs.logical_name ASC`
      )
      .all(row.id) as OutputRow[];
    return {
      id: row.id,
      external_execution_id: row.external_execution_id,
      run_id: row.run_id,
      external_execution_key: row.external_execution_key,
      manifest_digest: row.manifest_digest,
      ...(row.integration_metadata_json === null
        ? {}
        : { integration_metadata: JSON.parse(row.integration_metadata_json) }),
      created_at: row.created_at,
      outputs: outputRows.map((output) => ({
        logical_name: output.logical_name,
        staging_ref: JSON.parse(output.staging_ref_json) as ExecutionManifestStagingRef,
        sha256: output.sha256,
        byte_size: output.byte_size,
        media_type: output.media_type,
        ...(output.integration_metadata_json === null
          ? {}
          : { integration_metadata: JSON.parse(output.integration_metadata_json) }),
        producer_run_id: row.run_id,
        external_execution_key: row.external_execution_key,
        created_at: output.created_at,
        availability: {
          status: output.status,
          reason: output.reason,
          updated_at: output.updated_at
        }
      }))
    };
  }
}

export function verifyLocalManifestFile(
  workspaceRoot: string,
  relativePath: string,
  hooks: ExecutionManifestFileVerificationHooks = {}
): { relativePath: string; sha256: string; byteSize: number } {
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(workspaceRoot);
  } catch (error) {
    throw verificationError(`Run workspace cannot be resolved: ${errorMessage(error)}`);
  }
  try {
    if (!fs.statSync(canonicalRoot).isDirectory()) {
      throw verificationError("Run workspace is not a directory.");
    }
  } catch (error) {
    if (error instanceof ExecutionManifestConflictError) {
      throw error;
    }
    throw verificationError(`Run workspace cannot be inspected: ${errorMessage(error)}`);
  }
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    path.normalize(relativePath) !== relativePath
  ) {
    throw verificationError("Local manifest path must be a normalized relative path.");
  }

  const candidate = path.resolve(canonicalRoot, relativePath);
  if (candidate === canonicalRoot || !isInsidePath(canonicalRoot, candidate)) {
    throw verificationError("Local manifest path escapes the run workspace.");
  }
  rejectSymlinkComponents(canonicalRoot, candidate);

  let canonicalBefore: string;
  try {
    canonicalBefore = fs.realpathSync.native(candidate);
  } catch (error) {
    throw verificationError(`Local manifest path cannot be resolved: ${errorMessage(error)}`);
  }
  if (!isInsidePath(canonicalRoot, canonicalBefore)) {
    throw verificationError("Local manifest path resolves outside the run workspace.");
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw verificationError(`Local manifest file cannot be opened safely: ${errorMessage(error)}`);
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw verificationError("Local manifest output is not a regular file.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteSize = 0;
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      byteSize += bytesRead;
    }

    hooks.afterOpen?.(candidate);

    const after = fs.fstatSync(descriptor, { bigint: true });
    let canonicalAfter: string;
    let pathStat: fs.BigIntStats;
    try {
      canonicalAfter = fs.realpathSync.native(candidate);
      pathStat = fs.statSync(candidate, { bigint: true });
    } catch (error) {
      throw verificationError(`Local manifest path changed during verification: ${errorMessage(error)}`);
    }
    if (!isInsidePath(canonicalRoot, canonicalAfter)) {
      throw verificationError("Local manifest path escaped during verification.");
    }
    rejectSymlinkComponents(canonicalRoot, candidate);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== pathStat.dev ||
      after.ino !== pathStat.ino
    ) {
      throw verificationError("Local manifest file changed during verification.");
    }

    return {
      relativePath: path.relative(canonicalRoot, canonicalAfter),
      sha256: hash.digest("hex"),
      byteSize
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

interface ManifestRow {
  id: string;
  external_execution_id: string;
  run_id: string;
  external_execution_key: string;
  manifest_digest: string;
  integration_metadata_json: string | null;
  created_at: string;
}

interface OutputRow {
  manifest_id: string;
  logical_name: string;
  ref_kind: ExecutionManifestStagingRef["type"];
  staging_ref_json: string;
  sha256: string;
  byte_size: number;
  media_type: string;
  integration_metadata_json: string | null;
  created_at: string;
  status: ExecutionManifestAvailability;
  reason: string | null;
  updated_at: string;
}

interface ExecutionRow {
  id: string;
  run_id: string;
  external_execution_key: string;
  process_exited_at: string | null;
  scope_snapshot_json: string | null;
}

function assertUniqueOutputNames(outputs: ExecutionManifestOutputInput[]): void {
  const names = new Set<string>();
  for (const output of outputs) {
    if (names.has(output.logical_name)) {
      throw new ExecutionManifestConflictError(
        `Manifest output name is duplicated: ${output.logical_name}`,
        "duplicate_output"
      );
    }
    names.add(output.logical_name);
  }
}

function workspaceRootFromScope(scopeSnapshotJson: string | null): string | undefined {
  if (!scopeSnapshotJson) {
    return undefined;
  }
  const snapshot = JSON.parse(scopeSnapshotJson) as Record<string, unknown>;
  if (snapshot.workspace_mode === "isolated" && typeof snapshot.scratch_path === "string") {
    return snapshot.scratch_path;
  }
  return typeof snapshot.execution_root === "string" ? snapshot.execution_root : undefined;
}

function rejectSymlinkComponents(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      throw verificationError(`Local manifest path cannot be inspected: ${errorMessage(error)}`);
    }
    if (stat.isSymbolicLink()) {
      throw verificationError("Local manifest paths cannot contain symbolic links.");
    }
  }
}

function verificationError(message: string): ExecutionManifestConflictError {
  return new ExecutionManifestConflictError(message, "output_verification_failed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
