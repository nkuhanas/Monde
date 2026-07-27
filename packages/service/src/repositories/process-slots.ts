import type { DatabaseSync } from "node:sqlite";

export interface ProcessSlotRecord {
  run_id: string;
  monde_id: string;
  mon_id: string;
  kind: "one_shot" | "hitl_turn";
  reserved_at: string;
}

export class ProcessSlotRepository {
  constructor(private readonly db: DatabaseSync) {}

  reserve(input: {
    runId: string;
    mondeId: string;
    monId: string;
    kind: ProcessSlotRecord["kind"];
    limit: number;
    now?: string;
  }): { reserved: boolean; activeRunIds: string[] } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT run_id FROM process_slots WHERE run_id = ?").get(input.runId) as
        | { run_id: string }
        | undefined;
      const slotRunIds = this.listForMon(input.mondeId, input.monId).map(
        (slot) => slot.run_id
      );
      const persistedProcessRunIds = (
        this.db
          .prepare(
            `SELECT id
             FROM runs
             WHERE monde_id = ? AND mon_id = ?
               AND status IN ('starting', 'active')
               AND interaction_mode != 'hitl_thread'
             ORDER BY started_at ASC, created_at ASC, id ASC`
          )
          .all(input.mondeId, input.monId) as Array<{ id: string }>
      ).map((run) => run.id);
      const activeRunIds = [
        ...new Set([...slotRunIds, ...persistedProcessRunIds])
      ];
      if (existing) {
        this.db.exec("COMMIT");
        return { reserved: true, activeRunIds };
      }

      if (activeRunIds.length >= input.limit) {
        this.db.exec("COMMIT");
        return { reserved: false, activeRunIds };
      }

      this.db
        .prepare(
          `INSERT INTO process_slots (run_id, monde_id, mon_id, kind, reserved_at)
           VALUES (@run_id, @monde_id, @mon_id, @kind, @reserved_at)`
        )
        .run({
          run_id: input.runId,
          monde_id: input.mondeId,
          mon_id: input.monId,
          kind: input.kind,
          reserved_at: input.now ?? new Date().toISOString()
        });
      this.db.exec("COMMIT");
      return { reserved: true, activeRunIds: [...activeRunIds, input.runId] };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  release(runId: string): boolean {
    const result = this.db.prepare("DELETE FROM process_slots WHERE run_id = ?").run(runId) as { changes: number };
    return result.changes > 0;
  }

  listForMon(mondeId: string, monId: string): ProcessSlotRecord[] {
    return this.db
      .prepare(
        `SELECT run_id, monde_id, mon_id, kind, reserved_at
         FROM process_slots
         WHERE monde_id = ? AND mon_id = ?
         ORDER BY reserved_at ASC, run_id ASC`
      )
      .all(mondeId, monId) as ProcessSlotRecord[];
  }

  releaseOrphans(): number {
    const result = this.db
      .prepare(
        `DELETE FROM process_slots
         WHERE NOT EXISTS (
           SELECT 1 FROM runs
           WHERE runs.id = process_slots.run_id
             AND runs.status IN ('starting', 'active')
         )`
      )
      .run() as { changes: number };
    return result.changes;
  }
}
