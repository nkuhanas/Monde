import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";

export type ArtifactPathStatus = "exists" | "missing" | "inaccessible" | "unknown";

export interface ArtifactRecord {
  id: string;
  monde_id: string;
  mon_id: string;
  run_id: string;
  type: string;
  path?: string | null;
  title: string;
  summary?: string | null;
  created_at: string;
  path_exists: boolean;
  path_status: ArtifactPathStatus;
}

interface ArtifactRow {
  id: string;
  monde_id: string;
  mon_id: string;
  run_id: string;
  type: string;
  path: string | null;
  title: string;
  summary: string | null;
  created_at: string;
}

export class ArtifactRepository {
  constructor(private readonly db: DatabaseSync) {}

  register(input: {
    monde_id: string;
    mon_id: string;
    run_id: string;
    type: string;
    path?: string | null;
    title?: string;
    summary?: string | null;
  }): ArtifactRecord {
    const record = {
      id: `art_${nanoid(12)}`,
      monde_id: input.monde_id,
      mon_id: input.mon_id,
      run_id: input.run_id,
      type: input.type,
      path: input.path ?? null,
      title: input.title ?? input.path ?? input.type,
      summary: input.summary ?? null,
      created_at: new Date().toISOString()
    };

    this.db
      .prepare(
        `INSERT INTO artifacts (id, monde_id, mon_id, run_id, type, path, title, summary, created_at)
         VALUES (@id, @monde_id, @mon_id, @run_id, @type, @path, @title, @summary, @created_at)`
      )
      .run(record);

    return this.withPathStatus(record);
  }

  list(filters: { mondeId?: string; runId?: string; monId?: string } = {}): ArtifactRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.mondeId) {
      clauses.push("monde_id = @monde_id");
      params.monde_id = filters.mondeId;
    }
    if (filters.runId) {
      clauses.push("run_id = @run_id");
      params.run_id = filters.runId;
    }
    if (filters.monId) {
      clauses.push("mon_id = @mon_id");
      params.mon_id = filters.monId;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const statement = this.db.prepare(`SELECT * FROM artifacts ${where} ORDER BY created_at DESC`);
    const rows = (clauses.length > 0 ? statement.all(params) : statement.all()) as ArtifactRow[];
    return rows.map((row) => this.withPathStatus(row));
  }

  get(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    return row ? this.withPathStatus(row) : undefined;
  }

  private withPathStatus(row: ArtifactRow): ArtifactRecord {
    const pathStatus = getPathStatus(row.path);
    return {
      ...row,
      path_exists: pathStatus === "exists",
      path_status: pathStatus
    };
  }
}

function getPathStatus(pathValue: string | null): ArtifactPathStatus {
  if (!pathValue) {
    return "unknown";
  }

  try {
    return fs.existsSync(pathValue) ? "exists" : "missing";
  } catch {
    return "inaccessible";
  }
}
