import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createBackup } from "../packages/cli/src/commands/backup.ts";

test("online backup contains WAL-resident records and can be restored", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-backup-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, "data");
  const sourcePath = path.join(dataDir, "source.sqlite");
  fs.mkdirSync(dataDir, { recursive: true });

  const source = new DatabaseSync(sourcePath);
  t.after(() => source.close());
  source.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '5');
    CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO evidence (value) VALUES ('wal-backed durable state');
  `);

  assert.equal(fs.existsSync(`${sourcePath}-wal`), true);
  assert.ok(fs.statSync(`${sourcePath}-wal`).size > 0);

  const metadata = await createBackup(sourcePath, dataDir);
  assert.equal(metadata.schema_version, 5);
  assert.equal(fs.statSync(metadata.backup_path).mode & 0o777, 0o600);

  const backup = new DatabaseSync(metadata.backup_path, { readOnly: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    assert.deepEqual(Object.values(integrity), ["ok"]);
    const row = backup.prepare("SELECT value FROM evidence WHERE id = 1").get() as { value: string };
    assert.equal(row.value, "wal-backed durable state");
  } finally {
    backup.close();
  }

  const restoredPath = path.join(tempRoot, "restored.sqlite");
  fs.copyFileSync(metadata.backup_path, restoredPath);
  const restored = new DatabaseSync(restoredPath, { readOnly: true });
  try {
    const row = restored.prepare("SELECT value FROM evidence WHERE id = 1").get() as { value: string };
    assert.equal(row.value, "wal-backed durable state");
  } finally {
    restored.close();
  }
});
