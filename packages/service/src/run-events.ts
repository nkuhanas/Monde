import { EventEmitter } from "node:events";
import { RunEventRepository, type RunEvent } from "./repositories/run-events.js";

export class RunEventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly events: RunEventRepository) {
    this.emitter.setMaxListeners(1000);
  }

  publish(runId: string, eventType: string, payload: Record<string, unknown>): RunEvent {
    const event = this.events.append(runId, eventType, payload);
    this.emitter.emit(runId, event);
    return event;
  }

  list(runId: string): RunEvent[] {
    return this.events.list(runId);
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }
}
