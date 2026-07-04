export interface AttentionRunLike {
  id: string;
  status: string;
  origin: Record<string, unknown>;
  warnings?: string[];
  created_at: string;
  started_at?: string | null;
}

export interface AttentionItem<T extends AttentionRunLike = AttentionRunLike> {
  run: T;
  reason: string;
  priority: number;
}

export function deriveAttentionRuns<T extends AttentionRunLike>(runs: T[]): AttentionItem<T>[] {
  return runs
    .map((run) => {
      const item = attentionItemForRun(run);
      return item ? { run, ...item } : null;
    })
    .filter((item): item is AttentionItem<T> => item !== null)
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return runTime(right.run).localeCompare(runTime(left.run));
    });
}

function attentionItemForRun(run: AttentionRunLike): Pick<AttentionItem, "reason" | "priority"> | undefined {
  if (run.status === "active" || run.status === "starting") {
    return { reason: "active", priority: 0 };
  }

  if (run.warnings?.length) {
    return { reason: "warning", priority: 1 };
  }

  if (run.status === "blocked") {
    return { reason: "blocked", priority: 2 };
  }

  if (run.status === "queued" && run.origin.type === "plan") {
    return { reason: "queued plan", priority: 3 };
  }

  if (run.status === "queued" && run.origin.type === "cron") {
    return { reason: "queued cron", priority: 4 };
  }

  return undefined;
}

function runTime(run: AttentionRunLike): string {
  return run.started_at ?? run.created_at;
}
