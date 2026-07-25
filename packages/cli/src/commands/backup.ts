import fs from "node:fs";
import path from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { getMondePlatformPaths, type BackupMetadataDto } from "@monde/core";

export function backupInfo(): void {
  const paths = getMondePlatformPaths();
  console.log(`SQLite DB: ${paths.dbPath}`);
  console.log(`Service token: ${paths.tokenPath}`);
  const latest = latestBackupPath(paths.dataDir);
  console.log(`Backup directory: ${backupDir(paths.dataDir)}`);
  console.log(`Latest backup: ${latest ?? "none"}`);
  console.log("Operational continuity depends on the SQLite DB.");
  console.log("Use `monde backup create` for a transactionally consistent online backup.");
  console.log("Full export/import or backup/restore is a post-MVP recovery path.");
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
  const metadata: BackupMetadataDto = {
    created_at: new Date().toISOString(),
    db_path: dbPath,
    backup_path: destination,
    schema_version: readSchemaVersion(destination),
    size: stat.size
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
