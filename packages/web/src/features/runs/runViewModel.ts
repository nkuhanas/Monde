import type { ArtifactDto, RunDto, RunEventDto } from "@monde/core";
import type { BadgeTone } from "../../components/ui";
import { isRecord } from "../../lib/guards";

export type RunAttentionKind = "active" | "warning" | "blocked" | "review" | "queued";
export type RunVisualState =
  | "starting"
  | "active"
  | "queued"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "stopped"
  | "closed"
  | "neutral";

export function runAcceptsInput(run: RunDto): boolean {
  return run.execution?.input_mode === "open" || run.execution?.interaction_mode === "interactive";
}

export function runNeedsReview(run: RunDto): boolean {
  return run.status === "finished" && run.outcome === "unknown" && typeof run.result?.reviewed_at !== "string";
}

export function runAttentionKind(run: RunDto): RunAttentionKind | null {
  if (run.status === "active" || run.status === "starting") return "active";
  if (run.warnings?.length) return "warning";
  if (run.status === "blocked") return "blocked";
  if (runNeedsReview(run)) return "review";
  if (run.status === "queued") return "queued";
  return null;
}

export function runRequiresAttention(run: RunDto): boolean {
  return runAttentionKind(run) !== null;
}

export function runVisualState(run: RunDto): RunVisualState {
  if (run.status === "starting") return "starting";
  if (run.status === "active") return "active";
  if (run.status === "queued") return "queued";
  if (run.status === "blocked") return "blocked";
  if (runNeedsReview(run)) return "review";
  if (run.outcome === "completed" || run.outcome_state === "succeeded") return "completed";
  if (run.outcome_state === "partial") return "review";
  if (
    run.outcome === "failed" ||
    run.outcome === "interrupted" ||
    run.outcome_state === "failed" ||
    run.runtime_state === "failed"
  ) return "failed";
  if (
    run.outcome === "stopped" ||
    run.outcome === "canceled" ||
    run.outcome_state === "abandoned" ||
    run.runtime_state === "cancelled"
  ) return "stopped";
  if (run.runtime_state === "closed" || run.status === "finished") return "closed";
  return "neutral";
}

export function runStateLabel(run: RunDto): string {
  if (run.status !== "finished") return run.status;
  if (runNeedsReview(run)) return "review";
  if (run.outcome !== "unknown") return run.outcome;
  if (run.outcome_state !== "unknown") return run.outcome_state;
  if (run.runtime_state === "cancelled") return "canceled";
  if (run.runtime_state !== "queued" && run.runtime_state !== "running") return run.runtime_state;
  return "closed";
}

export function runStateTone(run: RunDto): BadgeTone {
  const state = runVisualState(run);
  if (state === "starting") return "cyan";
  if (state === "active" || state === "completed") return "green";
  if (state === "queued") return "blue";
  if (state === "review") return "amber";
  if (state === "blocked" || state === "failed") return "red";
  if (state === "stopped") return "pink";
  if (state === "closed") return "purple";
  return "default";
}

export function runAttentionLabel(run: RunDto): string {
  const kind = runAttentionKind(run);
  if (kind === "active") return "Needs attention: currently active";
  if (kind === "warning") return `Needs attention: ${run.warnings?.length ?? 0} warning${run.warnings?.length === 1 ? "" : "s"}`;
  if (kind === "blocked") return "Needs attention: blocked";
  if (kind === "review") return "Needs attention: awaiting operator review";
  if (kind === "queued") return "Needs attention: queued";
  return "No operator attention required";
}

export function runAttentionIcon(kind: RunAttentionKind): string {
  if (kind === "active") return "●";
  if (kind === "queued") return "↥";
  return "!";
}

export function compareRunsForNavigator(left: RunDto, right: RunDto): number {
  const attentionDifference = Number(runRequiresAttention(right)) - Number(runRequiresAttention(left));
  if (attentionDifference !== 0) return attentionDifference;
  return right.created_at.localeCompare(left.created_at);
}

export function hasDiffEvidence(run: RunDto, artifacts: ArtifactDto[]): boolean {
  const diffCapture = isRecord(run.execution?.diff_capture) ? run.execution.diff_capture : {};
  return artifacts.some((artifact) => artifact.type === "diff") ||
    (Array.isArray(diffCapture.changed_files) && diffCapture.changed_files.length > 0) ||
    (typeof diffCapture.diff_stat === "string" && diffCapture.diff_stat.trim().length > 0);
}

export function statusTone(status: string): BadgeTone {
  if (status === "starting") return "cyan";
  if (status === "active") return "green";
  if (status === "queued") return "blue";
  if (status === "blocked") return "red";
  if (status === "finished") return "purple";
  return "default";
}

export function outcomeTone(outcome: string): BadgeTone {
  if (outcome === "completed") return "green";
  if (outcome === "failed" || outcome === "interrupted") return "red";
  if (outcome === "stopped" || outcome === "canceled") return "pink";
  return "default";
}

export function renderRunTranscript(events: RunEventDto[]): string {
  if (events.length === 0) return "No output yet.";
  return events
    .map((event) => {
      if (event.event_type === "run_output" || event.event_type === "run_error_output" || event.event_type === "run_input") {
        return String(event.payload.chunk ?? "");
      }
      if (event.event_type === "user_message") return `user: ${String(event.payload.content ?? event.payload.message ?? "")}\n`;
      if (event.event_type === "mon_message") return `mon: ${String(event.payload.content ?? event.payload.message ?? "")}\n`;
      if (event.event_type === "system_message") return `system: ${String(event.payload.content ?? event.payload.message ?? "")}\n`;
      if (event.event_type === "error") return `error: ${String(event.payload.content ?? event.payload.message ?? "")}\n`;
      if (event.event_type === "warning_added") return `\n[${event.run_id}] warning ${event.payload.warning}\n`;
      if (event.event_type === "run_started") return `[${event.run_id}] started\n`;
      if (event.event_type === "run_finished") {
        return `\n[${event.run_id}] finished ${event.payload.status}/${event.payload.process_status}/${event.payload.outcome}\n`;
      }
      return "";
    })
    .join("");
}
