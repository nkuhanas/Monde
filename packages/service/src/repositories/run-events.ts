import type { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";

export const RUN_OUTPUT_EVENT_RETENTION = 2000;
const outputEventTypes = new Set(["run_output", "run_error_output", "run_input"]);

export interface RunEvent {
  id: string;
  run_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface RunEventRow {
  id: string;
  run_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export class RunEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(runId: string, eventType: string, payload: Record<string, unknown>, now = new Date().toISOString()): RunEvent {
    const event: RunEvent = {
      id: `evt_${nanoid(12)}`,
      run_id: runId,
      event_type: eventType,
      payload,
      created_at: now
    };

    this.db
      .prepare(
        `INSERT INTO run_events (id, run_id, event_type, payload_json, created_at)
         VALUES (@id, @run_id, @event_type, @payload_json, @created_at)`
      )
      .run({
        id: event.id,
        run_id: event.run_id,
        event_type: event.event_type,
        payload_json: JSON.stringify(event.payload),
        created_at: event.created_at
      });

    if (outputEventTypes.has(eventType)) {
      this.trimOutputEvents(runId);
    }

    return event;
  }

  list(runId: string): RunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC, id ASC")
      .all(runId) as RunEventRow[];

    return rows.map((row) => ({
      id: row.id,
      run_id: row.run_id,
      event_type: row.event_type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      created_at: row.created_at
    }));
  }

  private trimOutputEvents(runId: string): void {
    const staleRows = this.db
      .prepare(
        `SELECT id FROM run_events
         WHERE run_id = ? AND event_type IN ('run_output', 'run_error_output', 'run_input')
         ORDER BY created_at DESC, id DESC
         LIMIT -1 OFFSET ?`
      )
      .all(runId, RUN_OUTPUT_EVENT_RETENTION) as Array<{ id: string }>;

    if (staleRows.length === 0) {
      return;
    }

    const deleteStatement = this.db.prepare("DELETE FROM run_events WHERE id = ?");
    for (const row of staleRows) {
      deleteStatement.run(row.id);
    }
  }
}
