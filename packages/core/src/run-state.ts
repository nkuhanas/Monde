export const runStatuses = ["queued", "blocked", "starting", "active", "finished"] as const;
export const processStatuses = [
  "not_started",
  "spawning",
  "running",
  "exited",
  "crashed",
  "lost",
  "killed"
] as const;
export const runOutcomes = [
  "unknown",
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "canceled"
] as const;
export const runInteractionModes = ["one_shot", "hitl_thread"] as const;
export const runRuntimeStates = [
  "queued",
  "running",
  "waiting_for_user",
  "idle_open",
  "awaiting_completion",
  "cancelling",
  "closing",
  "closed",
  "failed",
  "cancelled"
] as const;
export const runOutcomeStates = ["unknown", "succeeded", "failed", "partial", "abandoned", "superseded"] as const;
export const runCloseReasons = [
  "process_exited",
  "user_closed_widget",
  "user_marked_resolved",
  "user_abandoned",
  "system_cancelled",
  "error"
] as const;

export type RunStatus = (typeof runStatuses)[number];
export type ProcessStatus = (typeof processStatuses)[number];
export type RunOutcome = (typeof runOutcomes)[number];
export type RunInteractionMode = (typeof runInteractionModes)[number];
export type RunRuntimeState = (typeof runRuntimeStates)[number];
export type RunOutcomeState = (typeof runOutcomeStates)[number];
export type RunCloseReason = (typeof runCloseReasons)[number];

export interface RunLifecycleView {
  status: RunStatus;
  process_status: ProcessStatus;
  outcome: RunOutcome;
  warnings: string[];
}

export interface RunLifecyclePatch {
  status?: RunStatus;
  process_status?: ProcessStatus;
  outcome?: RunOutcome;
  warnings?: string[];
  interaction_mode?: RunInteractionMode;
  runtime_state?: RunRuntimeState;
  outcome_state?: RunOutcomeState;
  close_reason?: RunCloseReason | null;
  started_at?: string | null;
  ended_at?: string | null;
  updated_at?: string;
  opened_at?: string | null;
  closed_at?: string | null;
  blocked_reason?: string | null;
}

const allowedTransitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["starting", "blocked", "finished"],
  blocked: ["queued", "starting", "finished"],
  starting: ["active", "finished"],
  active: ["finished"],
  finished: []
};

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertRunStatusTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRunStatus(from, to)) {
    throw new Error(`Invalid run status transition: ${from} -> ${to}`);
  }
}

export function startRunLifecycle(run: RunLifecycleView, now = new Date().toISOString()): RunLifecyclePatch {
  assertRunStatusTransition(run.status, "starting");
  return {
    status: "starting",
    process_status: "spawning",
    outcome: "unknown",
    runtime_state: "running",
    outcome_state: "unknown",
    started_at: now,
    ended_at: null,
    updated_at: now,
    blocked_reason: null
  };
}

export function markRunActive(run: RunLifecycleView): RunLifecyclePatch {
  assertRunStatusTransition(run.status, "active");
  return {
    status: "active",
    process_status: "running",
    outcome: "unknown",
    runtime_state: "running",
    outcome_state: "unknown",
    updated_at: new Date().toISOString()
  };
}

export function finishRunFromExit(
  run: RunLifecycleView,
  exit: { code: number | null; signal: string | null },
  now = new Date().toISOString()
): RunLifecyclePatch {
  assertRunStatusTransition(run.status, "finished");

  if (exit.signal) {
    return {
      status: "finished",
      process_status: "crashed",
      outcome: "interrupted",
      runtime_state: "failed",
      outcome_state: "failed",
      close_reason: "error",
      ended_at: now,
      closed_at: now,
      updated_at: now
    };
  }

  return {
    status: "finished",
    process_status: "exited",
    outcome: exit.code === 0 ? "unknown" : "failed",
    runtime_state: exit.code === 0 ? "closed" : "failed",
    outcome_state: exit.code === 0 ? "unknown" : "failed",
    close_reason: "process_exited",
    ended_at: now,
    closed_at: now,
    updated_at: now
  };
}

export function finishRunInterrupted(
  run: RunLifecycleView,
  processStatus: Extract<ProcessStatus, "crashed" | "lost">,
  now = new Date().toISOString()
): RunLifecyclePatch {
  assertRunStatusTransition(run.status, "finished");
  return {
    status: "finished",
    process_status: processStatus,
    outcome: "interrupted",
    runtime_state: "failed",
    outcome_state: "failed",
    close_reason: "error",
    ended_at: now,
    closed_at: now,
    updated_at: now
  };
}

export function finishRunStopped(run: RunLifecycleView, now = new Date().toISOString()): RunLifecyclePatch {
  assertRunStatusTransition(run.status, "finished");
  return {
    status: "finished",
    process_status: "killed",
    outcome: "stopped",
    runtime_state: "cancelled",
    outcome_state: "unknown",
    close_reason: "system_cancelled",
    ended_at: now,
    closed_at: now,
    updated_at: now
  };
}

export function cancelQueuedRun(run: RunLifecycleView, now = new Date().toISOString()): RunLifecyclePatch {
  if (run.status !== "queued" && run.status !== "blocked") {
    throw new Error(`Only queued or blocked runs can be canceled; got ${run.status}`);
  }

  assertRunStatusTransition(run.status, "finished");
  return {
    status: "finished",
    process_status: "not_started",
    outcome: "canceled",
    runtime_state: "cancelled",
    outcome_state: "unknown",
    close_reason: "system_cancelled",
    ended_at: now,
    closed_at: now,
    updated_at: now
  };
}

export function closeHitlThreadLifecycle(
  closeReason: RunCloseReason,
  hasUnresolvedError: boolean,
  now = new Date().toISOString()
): RunLifecyclePatch {
  const cleanWidgetClose = closeReason === "user_closed_widget" && !hasUnresolvedError;
  const succeeded = closeReason === "user_marked_resolved" || cleanWidgetClose;
  const failed = closeReason === "error";
  const abandoned = closeReason === "user_abandoned";

  return {
    status: "finished",
    process_status: closeReason === "system_cancelled" ? "killed" : "exited",
    outcome: succeeded ? "completed" : failed ? "failed" : abandoned ? "stopped" : "unknown",
    runtime_state: failed ? "failed" : closeReason === "system_cancelled" ? "cancelled" : "closed",
    outcome_state: succeeded ? "succeeded" : failed ? "failed" : abandoned ? "abandoned" : "unknown",
    close_reason: closeReason,
    closed_at: now,
    ended_at: now,
    updated_at: now
  };
}

export function addRunWarning(run: RunLifecycleView, warning: string): RunLifecyclePatch {
  if (run.warnings.includes(warning)) {
    return { warnings: run.warnings };
  }

  return { warnings: [...run.warnings, warning] };
}
