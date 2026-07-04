import type { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";

export interface LogEvent {
  id: string;
  run_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface LogRow {
  id: string;
  run_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export class LogRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(runId: string, entry: Record<string, unknown>, eventType = "tool_log"): LogEvent {
    const log: LogEvent = {
      id: `log_${nanoid(12)}`,
      run_id: runId,
      event_type: eventType,
      payload: entry,
      created_at: new Date().toISOString()
    };

    this.db
      .prepare(
        `INSERT INTO logs (id, run_id, event_type, payload_json, created_at)
         VALUES (@id, @run_id, @event_type, @payload_json, @created_at)`
      )
      .run({
        id: log.id,
        run_id: log.run_id,
        event_type: log.event_type,
        payload_json: JSON.stringify(log.payload),
        created_at: log.created_at
      });

    return log;
  }

  list(runId: string): LogEvent[] {
    const rows = this.db.prepare("SELECT * FROM logs WHERE run_id = ? ORDER BY created_at ASC").all(runId) as LogRow[];
    return rows.map((row) => ({
      id: row.id,
      run_id: row.run_id,
      event_type: row.event_type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      created_at: row.created_at
    }));
  }
}
