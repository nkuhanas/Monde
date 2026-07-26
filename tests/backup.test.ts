import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createBackup,
  rehearseRestore,
  verifyBackup
} from "../packages/cli/src/commands/backup.ts";

test("online backup contains WAL-resident records and can be restored", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-backup-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, "data");
  const sourcePath = path.join(dataDir, "source.sqlite");
  fs.mkdirSync(dataDir, { recursive: true });
  const scratchSecret = "scratch-only-content-must-not-enter-backup";
  const scratchPath = path.join(dataDir, "run-scopes", "run_1", "scratch");
  fs.mkdirSync(scratchPath, { recursive: true });
  fs.writeFileSync(path.join(scratchPath, "secret.txt"), scratchSecret);

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
  assert.match(metadata.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(metadata.integrity_check, "ok");
  assert.equal(
    fs.readFileSync(metadata.backup_path).includes(Buffer.from(scratchSecret)),
    false
  );
  const verification = verifyBackup(metadata.backup_path);
  assert.equal(verification.valid, true);
  assert.equal(verification.checksum_matches, true);
  assert.equal(verification.integrity_check, "ok");

  const backup = new DatabaseSync(metadata.backup_path, { readOnly: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    assert.deepEqual(Object.values(integrity), ["ok"]);
    const row = backup.prepare("SELECT value FROM evidence WHERE id = 1").get() as { value: string };
    assert.equal(row.value, "wal-backed durable state");
  } finally {
    backup.close();
  }

  const rehearsalDestination = path.join(tempRoot, "isolated-rehearsal");
  const rehearsal = rehearseRestore(
    metadata.backup_path,
    rehearsalDestination,
    dataDir
  );
  assert.equal(rehearsal.source_verification.valid, true);
  assert.equal(rehearsal.restored_verification.valid, true);
  assert.equal(fs.existsSync(rehearsal.report_path), true);
  const restored = new DatabaseSync(rehearsal.restored_db_path, {
    readOnly: true
  });
  try {
    const row = restored.prepare("SELECT value FROM evidence WHERE id = 1").get() as { value: string };
    assert.equal(row.value, "wal-backed durable state");
  } finally {
    restored.close();
  }

  assert.throws(
    () =>
      rehearseRestore(metadata.backup_path, rehearsalDestination, dataDir),
    /already exists/
  );
  assert.throws(
    () =>
      rehearseRestore(
        metadata.backup_path,
        path.join(dataDir, "restore-attempt"),
        dataDir
      ),
    /outside live Monde data/
  );

  const tamperedPath = path.join(tempRoot, "tampered.sqlite");
  fs.copyFileSync(metadata.backup_path, tamperedPath);
  fs.copyFileSync(
    `${metadata.backup_path}.json`,
    `${tamperedPath}.json`
  );
  const descriptor = fs.openSync(tamperedPath, "r+");
  try {
    const byte = Buffer.alloc(1);
    fs.readSync(descriptor, byte, 0, 1, 100);
    byte[0] ^= 0xff;
    fs.writeSync(descriptor, byte, 0, 1, 100);
  } finally {
    fs.closeSync(descriptor);
  }
  assert.equal(verifyBackup(tamperedPath).valid, false);
});
