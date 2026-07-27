import type { RunOutcome, RunStatus } from "./run-state.js";
import type { RunCloseReason, RunInteractionMode, RunOutcomeState, RunRuntimeState } from "./run-state.js";
import type { MonConfig, RetryCondition, RunOrigin, RunRecord, RunRetryPolicy } from "./schemas.js";

export type RunnerType = "basic-process" | "codex" | "opencode" | "pty" | "adapter-native";
export type InteractionMode = "interactive" | "single-shot";
export type InputMode = "open" | "closed";
export type OutputMode = "json-events" | "terminal" | "plain";
export type ArtifactPathStatus = "exists" | "missing" | "inaccessible" | "unknown";
export type PlanStatus = "draft" | "active" | "blocked" | "completed" | "superseded" | "abandoned";
export type PlanAssignmentStatus = "pending" | "queued" | "active" | "satisfied" | "blocked" | "canceled";
export type AdapterStatus = "detected" | "missing" | "partial" | "unsupported";
export type McpStatus = "configured" | "manual_required" | "unsupported";
export type PromptInjectionStatus = "automatic" | "manual_required" | "unsupported";
export type DoctorFindingLevel = "ok" | "warn" | "error";

export interface HealthDto {
  ok: boolean;
  service: "monde";
  machine_name?: string;
  db_path: string;
  schema_version?: number;
}

export interface MondeDto {
  id: string;
  name: string;
  root: string;
  docs: string;
  created_at?: string;
  updated_at?: string;
}

export interface MonDto {
  id: string;
  monde_id: string;
  name: string;
  role: string;
  mon_root: string;
  work_root: string;
  configured_work_root?: string;
  default_harness: string | null;
  default_model?: string | null;
  harness_defaults?: Record<string, { sandbox_mode?: string }>;
  allow_external_work_root?: boolean;
  max_active_runs?: number;
  retry_policy?: RunRetryPolicy;
  run_workspace?: { mode: "shared" } | { mode: "isolated"; recovery_window_seconds: number };
  actor_context?: Array<{ root: "mon" | "work"; path: string }>;
  read_mounts?: Array<{ root: "mon" | "work"; path: string }>;
  external_mcp_servers?: MonConfig["external_mcp_servers"];
  capabilities?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface RunExecutionDto extends Record<string, unknown> {
  runner?: string;
  runner_type?: RunnerType | string;
  interaction_mode?: InteractionMode;
  input_mode?: InputMode;
  output_mode?: OutputMode;
  can_write?: boolean;
  write_scope?: string | null;
  sandbox_mode?: string;
  approval_mode?: string;
  adapter_status?: AdapterStatus | string;
  mcp_status?: McpStatus | string;
  prompt_injection_status?: PromptInjectionStatus | string;
  diff_capture?: Record<string, unknown>;
  terminal?: Record<string, unknown>;
}

export interface RunResultDto {
  summary?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  notes?: string;
}

export type RunDto = Omit<RunRecord, "execution" | "result" | "origin"> & {
  interaction_mode: RunInteractionMode;
  runtime_state: RunRuntimeState;
  outcome_state: RunOutcomeState;
  close_reason?: RunCloseReason | null;
  origin: RunOrigin | Record<string, unknown>;
  execution: RunExecutionDto;
  result: RunResultDto;
};

export interface PlanAssignmentDto {
  id: string;
  plan_id?: string;
  status: PlanAssignmentStatus | string;
  phase?: string | null;
  mon_id: string;
  intent: {
    title: string;
    prompt: string;
  };
  trigger?: "on_activation" | "manual";
  depends_on?: string | null;
  generated_run_ids: string[];
  generation_key?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PlanDto {
  id: string;
  monde_id: string;
  title: string;
  objective: string;
  prompt?: string;
  description?: string;
  status: PlanStatus | string;
  created_at?: string;
  updated_at?: string;
  assignments: PlanAssignmentDto[];
}

export interface LogEventDto {
  id: string;
  run_id?: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RunEventDto {
  id: string;
  run_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ArtifactDto {
  id: string;
  monde_id?: string;
  mon_id?: string;
  run_id?: string;
  type: string;
  title: string;
  path?: string | null;
  summary?: string | null;
  created_at?: string;
  path_exists: boolean;
  path_status: ArtifactPathStatus | string;
}

export interface ArtifactDetailDto extends ArtifactDto {
  content_available?: boolean;
  content_excerpt?: string;
  content_truncated?: boolean;
  content_reason?: string;
  size?: number;
}

export interface PlanEvidenceRunDto {
  run: RunDto;
  logs: LogEventDto[];
  artifacts: ArtifactDto[];
  result_summary?: string | null;
  review_notes?: string | null;
  warnings: string[];
}

export interface PlanEvidenceDto {
  plan: PlanDto;
  summary: {
    assignments: number;
    linked_runs: number;
    artifacts: number;
    logs: number;
    warnings: number;
    result_summaries: number;
  };
  assignments: Array<{
    assignment: PlanAssignmentDto;
    runs: PlanEvidenceRunDto[];
  }>;
  runs: RunDto[];
  artifacts: ArtifactDto[];
  logs: LogEventDto[];
  warnings: Array<{ run_id: string; warning: string }>;
  result_summaries: Array<{ run_id: string; summary?: string; outcome: RunOutcome | string }>;
}

export interface AdapterDetectionDto {
  available: boolean;
  adapter_status: AdapterStatus | string;
  mcp_status: McpStatus | string;
  prompt_injection_status: PromptInjectionStatus | string;
  supports_readonly?: boolean;
  supports_write?: boolean;
  supports_interactive_input?: boolean;
  interaction_mode?: InteractionMode;
  input_mode?: InputMode;
  output_mode?: OutputMode;
  supported_sandbox_modes?: string[];
  default_sandbox_mode?: string;
  command?: string;
  path?: string | null;
  version?: string;
  reason?: string;
  details?: string;
  notes?: string[];
  supports_isolated_runs?: boolean;
  supports_external_mcp?: boolean;
  isolation_status?: "verified" | "verification_required" | "unsupported";
}

export interface AdapterInfoDto {
  id: string;
  label: string;
  detection: AdapterDetectionDto;
}

export interface BackupMetadataDto {
  created_at: string;
  db_path: string;
  backup_path: string;
  schema_version: number | string;
  size: number;
  sha256?: string;
  checksum_algorithm?: "sha256";
  integrity_check?: "ok";
}

export interface BackupVerificationDto {
  backup_path: string;
  metadata_path: string | null;
  schema_version: number | string;
  size: number;
  sha256: string;
  recorded_sha256: string | null;
  checksum_matches: boolean;
  integrity_check: string;
  foreign_key_violations: number;
  valid: boolean;
}

export interface BackupRestoreRehearsalDto {
  source_backup_path: string;
  destination_directory: string;
  restored_db_path: string;
  report_path: string;
  source_verification: BackupVerificationDto;
  restored_verification: BackupVerificationDto;
  rehearsed_at: string;
}

export interface BackupInfoDto {
  db_path: string;
  token_path: string;
  backup_directory: string;
  latest_backup: string | null;
  continuity_warning: string;
  future_recovery_path: string;
}

export interface DoctorFindingDto {
  level: DoctorFindingLevel;
  message: string;
}

export interface DoctorStatusDto {
  findings: DoctorFindingDto[];
}

export type RunListStatusFilter = RunStatus | "all";

export type ExternalExecutionPhase =
  | "queued"
  | "starting"
  | "active"
  | "awaiting_completion"
  | "cancelling"
  | "terminal";

export type ExternalExecutionOutcome = "succeeded" | "failed" | "cancelled" | null;
export type ExternalExecutionCompletionPolicy = "process_exit" | "external_receipt";
export type ExternalCancellationState =
  | "none"
  | "requested"
  | "signalled"
  | "acknowledged"
  | "failed"
  | "lost";

export interface ExternalExecutionDto {
  id: string;
  integration_id: string;
  external_execution_key: string;
  request_digest: string;
  run_id: string;
  monde_id: string;
  mon_id: string;
  completion_policy: ExternalExecutionCompletionPolicy;
  phase: ExternalExecutionPhase;
  outcome: ExternalExecutionOutcome;
  condition: string | null;
  cancellation_state: ExternalCancellationState;
  external_scope: unknown;
  external_context: unknown;
  artifact_sink_ref?: unknown;
  external_lineage?: unknown;
  local_predecessor_run_id: string | null;
  process_exited_at: string | null;
  process_attempt: number;
  retry_not_before: string | null;
  completion_received_at: string | null;
  completion_deadline_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationRunSnapshotDto {
  run_id: string;
  execution_key: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  started_at?: string;
  finished_at?: string;
  failure_code?: string;
  process_attempt?: number;
  retry_condition?: string;
  next_attempt_at?: string;
}

export type RunAttemptStatus = "starting" | "active" | "succeeded" | "failed" | "cancelled" | "lost";

export interface RunAttemptDto {
  id: string;
  run_id: string;
  attempt_number: number;
  status: RunAttemptStatus;
  condition: RetryCondition | string | null;
  pid: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  error: string | null;
  retry_at: string | null;
  started_at: string;
  spawned_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ExecutionManifestAvailability = "available" | "deleted" | "expired";

export type ExecutionManifestStagingRef =
  | { type: "local_path"; path: string }
  | { type: "opaque"; value: unknown };

export interface ExecutionManifestOutputDto {
  logical_name: string;
  staging_ref: ExecutionManifestStagingRef;
  sha256: string;
  byte_size: number;
  media_type: string;
  producer_run_id: string;
  external_execution_key: string;
  created_at: string;
  integration_metadata?: unknown;
  availability: {
    status: ExecutionManifestAvailability;
    reason: string | null;
    updated_at: string;
  };
}

export interface ExecutionManifestDto {
  id: string;
  external_execution_id: string;
  run_id: string;
  external_execution_key: string;
  manifest_digest: string;
  created_at: string;
  integration_metadata?: unknown;
  outputs: ExecutionManifestOutputDto[];
}

export interface CronScheduleDto {
  id: string;
  monde_id: string;
  mon_id: string;
  name: string;
  expression: string;
  timezone: string;
  title: string;
  prompt: string;
  harness_override: string | null;
  sandbox_mode: string | null;
  integration_id: string | null;
  external_schedule_key: string | null;
  request_digest: string | null;
  context_packet?: unknown;
  enabled: boolean;
  next_fire_at: string | null;
  pending_first_fire_at: string | null;
  pending_fire_at: string | null;
  last_scheduled_fire_at: string | null;
  last_fired_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CronFireDto {
  id: string;
  cron_id: string;
  scheduled_fire_time: string;
  coalesced_from_fire_time: string | null;
  fired_at: string;
  run_id: string;
  external_execution_key: string | null;
}
