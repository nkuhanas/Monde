import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import {
  getMondePlatformPaths,
  isInsidePath,
  type BackupMetadataDto,
  type BackupRestoreRehearsalDto,
  type BackupVerificationDto
} from "@monde/core";

export function backupInfo(): void {
  const paths = getMondePlatformPaths();
  console.log(`SQLite DB: ${paths.dbPath}`);
  console.log(`Service token: ${paths.tokenPath}`);
  const latest = latestBackupPath(paths.dataDir);
  console.log(`Backup directory: ${backupDir(paths.dataDir)}`);
  console.log(`Latest backup: ${latest ?? "none"}`);
  console.log("Operational continuity depends on the SQLite DB.");
  console.log("Use `monde backup create` for a transactionally consistent online backup.");
  console.log("Use `monde backup verify <path>` to check a recorded checksum and SQLite integrity.");
  console.log("Use `monde backup rehearse <path> --destination <new-directory>` for an isolated restore rehearsal.");
}

export async function backupCreate(): Promise<void> {
  const paths = getMondePlatformPaths();
  const metadata = await createBackup(paths.dbPath, paths.dataDir);
  console.log(metadata.backup_path);
}

export async function createBackup(dbPath: string, dataDir: string): Promise<BackupMetadataDto> {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite DB not found at ${dbPath}`);
  }

  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const destination = path.join(dir, `monde-${stamp}.sqlite`);
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await sqliteBackup(source, destination);
  } catch (error) {
    if (fs.existsSync(destination)) {
      fs.unlinkSync(destination);
    }
    throw error;
  } finally {
    source.close();
  }

  fs.chmodSync(destination, 0o600);
  const stat = fs.statSync(destination);
  let verification: ReturnType<typeof inspectDatabase>;
  try {
    verification = inspectDatabase(destination);
  } catch (error) {
    fs.unlinkSync(destination);
    throw error;
  }
  if (verification.integrityCheck !== "ok" || verification.foreignKeyViolations > 0) {
    fs.unlinkSync(destination);
    throw new Error(
      `Created backup failed integrity verification: ${verification.integrityCheck}`
    );
  }
  const metadata: BackupMetadataDto = {
    created_at: new Date().toISOString(),
    db_path: dbPath,
    backup_path: destination,
    schema_version: verification.schemaVersion,
    size: stat.size,
    sha256: hashFile(destination),
    checksum_algorithm: "sha256",
    integrity_check: "ok"
  };
  fs.writeFileSync(`${destination}.json`, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return metadata;
}

export function backupList(): void {
  const paths = getMondePlatformPaths();
  const entries = listBackups(paths.dataDir);
  if (entries.length === 0) {
    console.log("No backups found.");
    return;
  }

  for (const entry of entries) {
    console.log(
      [
        entry.created_at ?? "unknown",
        `schema=${String(entry.schema_version ?? "unknown")}`,
        `size=${String(entry.size ?? "unknown")}`,
        entry.backup_path
      ].join("\t")
    );
  }
}

export function backupVerify(backupPath: string): void {
  const verification = verifyBackup(backupPath);
  console.log(JSON.stringify(verification, null, 2));
  if (!verification.valid) {
    throw new Error(`Backup verification failed for ${verification.backup_path}`);
  }
}

export function backupRehearse(
  backupPath: string,
  options: { destination: string }
): void {
  const paths = getMondePlatformPaths();
  const rehearsal = rehearseRestore(
    backupPath,
    options.destination,
    paths.dataDir
  );
  console.log(JSON.stringify(rehearsal, null, 2));
}

export function verifyBackup(backupPath: string): BackupVerificationDto {
  const resolved = path.resolve(backupPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Backup not found at ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Backup path is not a file: ${resolved}`);
  }
  const metadataPath = `${resolved}.json`;
  const metadata = readBackupMetadata(metadataPath);
  const sha256 = hashFile(resolved);
  const recordedSha256 =
    typeof metadata?.sha256 === "string" ? metadata.sha256 : null;
  const checksumMatches = recordedSha256 !== null && recordedSha256 === sha256;
  let inspection: ReturnType<typeof inspectDatabase>;
  try {
    inspection = inspectDatabase(resolved);
  } catch (error) {
    inspection = {
      schemaVersion: "unknown",
      integrityCheck: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      foreignKeyViolations: -1
    };
  }
  return {
    backup_path: resolved,
    metadata_path: metadata ? metadataPath : null,
    schema_version: inspection.schemaVersion,
    size: fs.statSync(resolved).size,
    sha256,
    recorded_sha256: recordedSha256,
    checksum_matches: checksumMatches,
    integrity_check: inspection.integrityCheck,
    foreign_key_violations: inspection.foreignKeyViolations,
    valid:
      checksumMatches &&
      inspection.integrityCheck === "ok" &&
      inspection.foreignKeyViolations === 0
  };
}

export function rehearseRestore(
  backupPath: string,
  destinationDirectory: string,
  liveDataDir = getMondePlatformPaths().dataDir
): BackupRestoreRehearsalDto {
  const sourceVerification = verifyBackup(backupPath);
  if (!sourceVerification.valid) {
    throw new Error(
      `Refusing to rehearse an invalid or checksum-less backup: ${sourceVerification.backup_path}`
    );
  }

  const destination = path.resolve(destinationDirectory);
  const liveDataRoot = canonicalExistingDirectory(liveDataDir, "Live data directory");
  const existingParent = nearestExistingParent(destination);
  const canonicalParent = fs.realpathSync.native(existingParent);
  const canonicalDestination = path.join(
    canonicalParent,
    path.relative(existingParent, destination)
  );
  if (
    canonicalDestination === liveDataRoot ||
    isInsidePath(liveDataRoot, canonicalDestination)
  ) {
    throw new Error(
      `Restore rehearsal destination must be outside live Monde data: ${liveDataRoot}`
    );
  }
  if (fs.existsSync(destination)) {
    throw new Error(
      `Restore rehearsal destination already exists; refusing to overwrite: ${destination}`
    );
  }

  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const restoredDbPath = path.join(destination, "monde.sqlite");
  fs.copyFileSync(
    sourceVerification.backup_path,
    restoredDbPath,
    fs.constants.COPYFILE_EXCL
  );
  fs.chmodSync(restoredDbPath, 0o600);
  const restoredSha256 = hashFile(restoredDbPath);
  const inspection = inspectDatabase(restoredDbPath);
  const restoredVerification: BackupVerificationDto = {
    backup_path: restoredDbPath,
    metadata_path: null,
    schema_version: inspection.schemaVersion,
    size: fs.statSync(restoredDbPath).size,
    sha256: restoredSha256,
    recorded_sha256: sourceVerification.sha256,
    checksum_matches: restoredSha256 === sourceVerification.sha256,
    integrity_check: inspection.integrityCheck,
    foreign_key_violations: inspection.foreignKeyViolations,
    valid:
      restoredSha256 === sourceVerification.sha256 &&
      inspection.integrityCheck === "ok" &&
      inspection.foreignKeyViolations === 0
  };
  if (!restoredVerification.valid) {
    throw new Error(
      `Restored database failed verification in isolated destination ${destination}`
    );
  }

  const rehearsedAt = new Date().toISOString();
  const reportPath = path.join(destination, "restore-rehearsal.json");
  const report: BackupRestoreRehearsalDto = {
    source_backup_path: sourceVerification.backup_path,
    destination_directory: destination,
    restored_db_path: restoredDbPath,
    report_path: reportPath,
    source_verification: sourceVerification,
    restored_verification: restoredVerification,
    rehearsed_at: rehearsedAt
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  return report;
}

function backupDir(dataDir: string): string {
  return path.join(dataDir, "backups");
}

function latestBackupPath(dataDir: string): string | undefined {
  return listBackups(dataDir).at(-1)?.backup_path;
}

function listBackups(dataDir: string): Array<Record<string, unknown> & { backup_path: string }> {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".sqlite"))
    .map((entry) => path.join(dir, entry))
    .sort()
    .map((backupPath) => {
      const metadataPath = `${backupPath}.json`;
      if (fs.existsSync(metadataPath)) {
        try {
          return JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown> & { backup_path: string };
        } catch {
          // Fall through to filesystem metadata.
        }
      }

      const stat = fs.statSync(backupPath);
      return {
        created_at: stat.mtime.toISOString(),
        backup_path: backupPath,
        schema_version: readSchemaVersion(backupPath),
        size: stat.size
      };
    });
}

function readSchemaVersion(dbPath: string): number | string {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
      const parsed = Number.parseInt(row?.value ?? "", 10);
      return Number.isFinite(parsed) ? parsed : "unknown";
    } finally {
      db.close();
    }
  } catch {
    return "unknown";
  }
}

function inspectDatabase(dbPath: string): {
  schemaVersion: number | string;
  integrityCheck: string;
  foreignKeyViolations: number;
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrityRows = db.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    const integrityCheck = integrityRows
      .flatMap((row) => Object.values(row).map(String))
      .join("; ");
    const foreignKeyViolations = (
      db.prepare("PRAGMA foreign_key_check").all() as unknown[]
    ).length;
    return {
      schemaVersion: readSchemaVersionFromDatabase(db),
      integrityCheck,
      foreignKeyViolations
    };
  } finally {
    db.close();
  }
}

function readSchemaVersionFromDatabase(
  db: DatabaseSync
): number | string {
  try {
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    const parsed = Number.parseInt(row?.value ?? "", 10);
    return Number.isFinite(parsed) ? parsed : "unknown";
  } catch {
    return "unknown";
  }
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        null
      );
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function readBackupMetadata(
  metadataPath: string
): BackupMetadataDto | undefined {
  if (!fs.existsSync(metadataPath)) {
    return undefined;
  }
  try {
    return JSON.parse(
      fs.readFileSync(metadataPath, "utf8")
    ) as BackupMetadataDto;
  } catch {
    return undefined;
  }
}

function canonicalExistingDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} does not exist or is not a directory: ${resolved}`);
  }
  return fs.realpathSync.native(resolved);
}

function nearestExistingParent(value: string): string {
  let current = path.dirname(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Cannot find an existing parent for restore destination: ${value}`
      );
    }
    current = parent;
  }
  if (!fs.statSync(current).isDirectory()) {
    throw new Error(
      `Restore destination parent is not a directory: ${current}`
    );
  }
  return current;
}
