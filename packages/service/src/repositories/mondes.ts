import type { DatabaseSync } from "node:sqlite";

export interface MondeUpsert {
  id: string;
  name: string;
  root: string;
  docs: string;
}

export interface MondeRow extends MondeUpsert {
  created_at: string;
  updated_at: string;
}

export class MondeRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(monde: MondeUpsert): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mondes (id, name, root, docs, created_at, updated_at)
         VALUES (@id, @name, @root, @docs, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root = excluded.root,
           docs = excluded.docs,
           updated_at = excluded.updated_at`
      )
      .run({ ...monde, now });
  }

  get(id: string): MondeRow | undefined {
    return this.db.prepare("SELECT * FROM mondes WHERE id = ?").get(id) as MondeRow | undefined;
  }

  list(): MondeRow[] {
    return this.db.prepare("SELECT * FROM mondes ORDER BY updated_at DESC").all() as MondeRow[];
  }
}
