import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMondePlatformPaths } from "@monde/core";

export function backupInfo(): void {
  const paths = getMondePlatformPaths();
  console.log(`SQLite DB: ${paths.dbPath}`);
  console.log(`Service token: ${paths.tokenPath}`);
  const latest = latestBackupPath(paths.dataDir);
  console.log(`Backup directory: ${backupDir(paths.dataDir)}`);
  console.log(`Latest backup: ${latest ?? "none"}`);
  console.log("Operational continuity depends on the SQLite DB.");
  console.log(`Suggested local copy: cp ${shellQuote(paths.dbPath)} ${shellQuote(`${paths.dbPath}.backup`)}`);
  console.log("Full export/import or backup/restore is a post-MVP recovery path.");
}

export function backupCreate(): void {
  const paths = getMondePlatformPaths();
  if (!fs.existsSync(paths.dbPath)) {
    throw new Error(`SQLite DB not found at ${paths.dbPath}`);
  }

  const dir = backupDir(paths.dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const destination = path.join(dir, `monde-${stamp}.sqlite`);
  fs.copyFileSync(paths.dbPath, destination);
  fs.chmodSync(destination, 0o600);
  const stat = fs.statSync(destination);
  const metadata = {
    created_at: new Date().toISOString(),
    db_path: paths.dbPath,
    backup_path: destination,
    schema_version: readSchemaVersion(paths.dbPath),
    size: stat.size
  };
  fs.writeFileSync(`${destination}.json`, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  console.log(destination);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
