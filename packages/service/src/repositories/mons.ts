import type { DatabaseSync } from "node:sqlite";

export interface MonUpsert {
  id: string;
  monde_id: string;
  name: string;
  role: string;
  mon_root: string;
  work_root: string;
  default_harness: string | null;
  default_model: string | null;
  capabilities: string[];
}

export interface MonRow extends Omit<MonUpsert, "capabilities"> {
  capabilities: string[];
  created_at: string;
  updated_at: string;
}

export class MonRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(mon: MonUpsert): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mons (
           id, monde_id, name, role, mon_root, work_root, default_harness,
           default_model, capabilities_json, created_at, updated_at
         )
         VALUES (
           @id, @monde_id, @name, @role, @mon_root, @work_root, @default_harness,
           @default_model, @capabilities_json, @now, @now
         )
         ON CONFLICT(monde_id, id) DO UPDATE SET
           name = excluded.name,
           role = excluded.role,
           mon_root = excluded.mon_root,
           work_root = excluded.work_root,
           default_harness = excluded.default_harness,
           default_model = excluded.default_model,
           capabilities_json = excluded.capabilities_json,
           updated_at = excluded.updated_at`
      )
      .run({
        id: mon.id,
        monde_id: mon.monde_id,
        name: mon.name,
        role: mon.role,
        mon_root: mon.mon_root,
        work_root: mon.work_root,
        default_harness: mon.default_harness,
        default_model: mon.default_model,
        capabilities_json: JSON.stringify(mon.capabilities),
        now
      });
  }

  get(mondeId: string, monId: string): MonRow | undefined {
    const row = this.db.prepare("SELECT * FROM mons WHERE monde_id = ? AND id = ?").get(mondeId, monId) as
      | (Omit<MonRow, "capabilities"> & { capabilities_json: string })
      | undefined;

    return row
      ? {
          id: row.id,
          monde_id: row.monde_id,
          name: row.name,
          role: row.role,
          mon_root: row.mon_root,
          work_root: row.work_root,
          default_harness: row.default_harness,
          default_model: row.default_model,
          capabilities: JSON.parse(row.capabilities_json) as string[],
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      : undefined;
  }

  list(mondeId?: string): MonRow[] {
    const rows = mondeId
      ? this.db.prepare("SELECT * FROM mons WHERE monde_id = ? ORDER BY id").all(mondeId)
      : this.db.prepare("SELECT * FROM mons ORDER BY monde_id, id").all();

    return rows.map((row) => {
      const mon = row as Omit<MonRow, "capabilities"> & { capabilities_json: string };
      return {
        id: mon.id,
        monde_id: mon.monde_id,
        name: mon.name,
        role: mon.role,
        mon_root: mon.mon_root,
        work_root: mon.work_root,
        default_harness: mon.default_harness,
        default_model: mon.default_model,
        capabilities: JSON.parse(mon.capabilities_json) as string[],
        created_at: mon.created_at,
        updated_at: mon.updated_at
      };
    });
  }

  delete(mondeId: string, monId: string): boolean {
    const result = this.db.prepare("DELETE FROM mons WHERE monde_id = ? AND id = ?").run(mondeId, monId) as { changes: number };
    return result.changes > 0;
  }
}
