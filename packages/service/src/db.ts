import { DatabaseSync } from "node:sqlite";
import { ensureDirectory, getPlatformPaths } from "./platform.js";

export const schemaVersion = 5;

export interface MondeDatabase {
  db: DatabaseSync;
  close(): void;
}

export function openDatabase(): MondeDatabase {
  const paths = getPlatformPaths();
  ensureDirectory(paths.dataDir);
  const db = new DatabaseSync(paths.dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);

  return {
    db,
    close() {
      db.close();
    }
  };
}

function migrate(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const schemaRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    const current = Number.parseInt(
      schemaRow?.value ?? "0",
      10
    );

    if (current > schemaVersion) {
      throw new Error(`Database schema version ${current} is newer than service schema ${schemaVersion}`);
    }

    if (current < 1) {
      db.exec(`
        CREATE TABLE mondes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root TEXT NOT NULL,
          docs TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE mons (
          id TEXT NOT NULL,
          monde_id TEXT NOT NULL REFERENCES mondes(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          mon_root TEXT NOT NULL,
          work_root TEXT NOT NULL,
          default_harness TEXT,
          default_model TEXT,
          capabilities_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (monde_id, id)
        );

        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          monde_id TEXT NOT NULL REFERENCES mondes(id) ON DELETE CASCADE,
          mon_id TEXT NOT NULL,
          status TEXT NOT NULL,
          process_status TEXT NOT NULL,
          outcome TEXT NOT NULL,
          interaction_mode TEXT NOT NULL DEFAULT 'one_shot',
          runtime_state TEXT NOT NULL DEFAULT 'queued',
          outcome_state TEXT NOT NULL DEFAULT 'unknown',
          close_reason TEXT,
          warnings_json TEXT NOT NULL,
          origin_json TEXT NOT NULL,
          intent_json TEXT NOT NULL,
          execution_json TEXT NOT NULL DEFAULT '{}',
          scope_snapshot_json TEXT,
          result_json TEXT NOT NULL,
          blocked_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT '',
          opened_at TEXT,
          closed_at TEXT,
          started_at TEXT,
          ended_at TEXT
        );

        CREATE TABLE logs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          monde_id TEXT NOT NULL REFERENCES mondes(id) ON DELETE CASCADE,
          mon_id TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          path TEXT,
          title TEXT NOT NULL,
          summary TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE plans (
          id TEXT PRIMARY KEY,
          monde_id TEXT NOT NULL REFERENCES mondes(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          prompt TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE plan_assignments (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          phase TEXT,
          mon_id TEXT NOT NULL,
          intent_title TEXT NOT NULL,
          intent_prompt TEXT NOT NULL,
          trigger TEXT NOT NULL,
          depends_on TEXT,
          generated_run_ids_json TEXT NOT NULL,
          generation_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }

    if (current >= 1 && current < 2) {
      db.exec(`
        ALTER TABLE runs ADD COLUMN execution_json TEXT NOT NULL DEFAULT '{}';

        CREATE TABLE IF NOT EXISTS run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    }

    if (current >= 2 && current < 3) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY,
          monde_id TEXT NOT NULL REFERENCES mondes(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          prompt TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS plan_assignments (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          phase TEXT,
          mon_id TEXT NOT NULL,
          intent_title TEXT NOT NULL,
          intent_prompt TEXT NOT NULL,
          trigger TEXT NOT NULL,
          depends_on TEXT,
          generated_run_ids_json TEXT NOT NULL,
          generation_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }

    if (current >= 3 && current < 4) {
      db.exec(`
        ALTER TABLE runs ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'one_shot';
        ALTER TABLE runs ADD COLUMN runtime_state TEXT NOT NULL DEFAULT 'queued';
        ALTER TABLE runs ADD COLUMN outcome_state TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE runs ADD COLUMN close_reason TEXT;
        ALTER TABLE runs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
        ALTER TABLE runs ADD COLUMN opened_at TEXT;
        ALTER TABLE runs ADD COLUMN closed_at TEXT;

        UPDATE runs
           SET updated_at = COALESCE(ended_at, started_at, created_at)
         WHERE updated_at = '';

        UPDATE runs
           SET runtime_state = CASE
             WHEN status IN ('queued', 'blocked') THEN 'queued'
             WHEN status IN ('starting', 'active') THEN 'running'
             WHEN status = 'finished' AND outcome IN ('failed', 'interrupted') THEN 'failed'
             WHEN status = 'finished' AND outcome = 'canceled' THEN 'cancelled'
             ELSE 'closed'
           END,
               outcome_state = CASE
             WHEN outcome = 'completed' THEN 'succeeded'
             WHEN outcome IN ('failed', 'interrupted') THEN 'failed'
             ELSE 'unknown'
           END,
               close_reason = CASE
             WHEN status = 'finished' AND outcome = 'canceled' THEN 'system_cancelled'
             WHEN status = 'finished' AND outcome IN ('failed', 'interrupted') THEN 'error'
             WHEN status = 'finished' THEN 'process_exited'
             ELSE NULL
           END,
               closed_at = CASE
             WHEN status = 'finished' THEN ended_at
             ELSE NULL
           END
         WHERE interaction_mode = 'one_shot';
      `);
    }

    if (current >= 4 && current < 5) {
      db.exec(`
        UPDATE runs
           SET outcome_state = 'unknown'
         WHERE interaction_mode = 'one_shot'
           AND outcome = 'unknown'
           AND outcome_state = 'succeeded';
      `);
    }

    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(String(schemaVersion));

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
