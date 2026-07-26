import type { CronScheduleRepository } from "./repositories/cron-schedules.js";
import type { RunManager } from "./run-manager.js";

export class CronScheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly schedules: CronScheduleRepository,
    private readonly runManager: RunManager,
    private readonly intervalMs = 15_000,
    private readonly onError: (error: unknown) => void = () => {}
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    void this.tick().catch(this.onError);
    this.timer = setInterval(
      () => void this.tick().catch(this.onError),
      this.intervalMs
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(now = new Date().toISOString()): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const enqueued = this.schedules.tick(now);
      const targets = new Set(
        enqueued.map((result) => `${result.run.monde_id}\0${result.run.mon_id}`)
      );
      for (const target of targets) {
        const [mondeId, monId] = target.split("\0");
        try {
          await this.runManager.dispatchQueuedForMon(mondeId, monId);
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
