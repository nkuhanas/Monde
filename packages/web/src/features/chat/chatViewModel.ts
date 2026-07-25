import type { MonDto, RunDto, RunEventDto } from "@monde/core";
import type { ChipMeta } from "../../components/MetaChip";
import { monDisplayName, monIdDisplayName } from "../../lib/mon";

export const chatEventTypes = new Set(["user_message", "mon_message", "system_message", "error"]);

export function mergeServerAndDraftThreads(serverThreads: RunDto[], currentThreads: RunDto[]): RunDto[] {
  const serverById = new Map(serverThreads.map((thread) => [thread.id, thread]));
  const next: RunDto[] = [];
  const seen = new Set<string>();
  for (const current of currentThreads) {
    if (isDraftThreadRun(current)) { next.push(current); seen.add(current.id); continue; }
    const serverThread = serverById.get(current.id);
    if (serverThread) { next.push(serverThread); seen.add(serverThread.id); }
  }
  for (const serverThread of serverThreads) if (!seen.has(serverThread.id)) next.push(serverThread);
  return next;
}

export function createDraftThreadRun(mondeId: string, mon: MonDto): RunDto {
  const now = new Date().toISOString();
  return {
    id: `draft_${mondeId}_${mon.id}_${Date.now()}`,
    monde_id: mondeId,
    mon_id: mon.id,
    status: "active",
    process_status: "running",
    outcome: "unknown",
    interaction_mode: "hitl_thread",
    runtime_state: "idle_open",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "operator", label: "Draft bottom mon chat" },
    intent: { title: `${monDisplayName(mon)} chat`, prompt: `Draft human-in-the-loop chat thread with ${mon.id}.` },
    execution: { local_draft: true, input_mode: "open", output_mode: "plain", thread_surface: "bottom_rail" },
    result: {},
    created_at: now,
    updated_at: now,
    opened_at: now
  };
}

export function isDraftThreadRun(thread: RunDto): boolean {
  return isDraftThreadId(thread.id) || thread.execution?.local_draft === true;
}

export function isDraftThreadId(threadId: string): boolean { return threadId.startsWith("draft_"); }

export function isOpenThreadRuntimeState(runtimeState: string): boolean {
  return runtimeState === "queued" || runtimeState === "running" || runtimeState === "waiting_for_user" || runtimeState === "idle_open";
}

export function threadRuntimeLabel(runtimeState: string): string {
  if (runtimeState === "waiting_for_user") return "waiting for you";
  if (runtimeState === "idle_open") return "idle";
  if (runtimeState === "running") return "responding";
  if (runtimeState === "closed") return "closed";
  if (runtimeState === "cancelled") return "cancelled";
  return runtimeState.replaceAll("_", " ");
}

export function threadHarnessMeta(thread: RunDto, mon: MonDto | undefined): ChipMeta {
  const raw = typeof thread.execution?.runner === "string" ? thread.execution.runner : typeof thread.execution?.runner_type === "string" ? thread.execution.runner_type : mon?.default_harness ?? "";
  const label = raw.trim() || "harness";
  return { label: label.replaceAll("_", " "), tone: label === "harness" ? "neutral" : "blue" };
}

export function threadStatusMeta(thread: RunDto): ChipMeta {
  if (thread.runtime_state === "running") return { label: "working", tone: "blue" };
  if (thread.runtime_state === "waiting_for_user") return { label: "waiting", tone: "amber" };
  if (thread.runtime_state === "idle_open") return { label: "idle", tone: "green" };
  if (thread.runtime_state === "queued") return { label: "queued", tone: "amber" };
  if (thread.runtime_state === "closed") return { label: "closed", tone: "neutral" };
  if (thread.runtime_state === "failed" || thread.runtime_state === "cancelled") return { label: thread.runtime_state, tone: "red" };
  return { label: threadRuntimeLabel(thread.runtime_state), tone: "neutral" };
}

export function threadModeMeta(thread: RunDto): ChipMeta {
  if (isDraftThreadRun(thread)) return { label: "draft", tone: "neutral" };
  if (thread.execution?.can_write === true) return { label: "write", tone: "amber" };
  if (thread.execution?.can_write === false) return { label: "read only", tone: "green" };
  const sandbox = typeof thread.execution?.sandbox_mode === "string" ? thread.execution.sandbox_mode : "";
  if (sandbox.includes("write")) return { label: "write", tone: "amber" };
  if (sandbox.includes("read")) return { label: "read only", tone: "green" };
  return { label: "mode unknown", tone: "neutral" };
}

export function threadTitle(thread: RunDto, mons: MonDto[]): string {
  const mon = mons.find((candidate) => candidate.id === thread.mon_id);
  return mon ? monDisplayName(mon) : monIdDisplayName(thread.mon_id);
}

export function createLocalRunEvent(runId: string, eventType: string, payload: Record<string, unknown>): RunEventDto {
  return { id: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`, run_id: runId, event_type: eventType, payload, created_at: new Date().toISOString() };
}

export function appendLocalEvent(events: RunEventDto[], event: RunEventDto): RunEventDto[] {
  return events.some((existing) => existing.id === event.id) ? events : [...events, event];
}

export function chatEventAuthor(event: RunEventDto): "user" | "mon" | "system" | "error" {
  if (event.event_type === "user_message") return "user";
  if (event.event_type === "mon_message") return "mon";
  if (event.event_type === "error") return "mon";
  return "system";
}

export function chatEventContent(event: RunEventDto): string {
  if (event.event_type === "error") {
    const content = typeof event.payload.content === "string" ? event.payload.content : "Response failed.";
    const timeoutReason = typeof event.payload.timeout_reason === "string" ? event.payload.timeout_reason : "";
    const lastActivityAt = typeof event.payload.last_activity_at === "string" ? event.payload.last_activity_at : "";
    const lastActivityText = lastActivityAt ? ` Last activity: ${formatChatTimestampTitle(lastActivityAt)}.` : "";
    if (timeoutReason === "idle_timeout" || timeoutReason === "hard_timeout") {
      const timeoutKey = timeoutReason === "idle_timeout" ? "idle_timeout_ms" : "hard_timeout_ms";
      const timeoutMs = typeof event.payload[timeoutKey] === "number" ? event.payload[timeoutKey] as number : undefined;
      const windowText = timeoutMs ? (timeoutReason === "idle_timeout" ? ` for ${formatDuration(timeoutMs)}` : ` of ${formatDuration(timeoutMs)}`) : "";
      return timeoutReason === "idle_timeout" ? `${content} No harness activity${windowText}.${lastActivityText}` : `${content} Turn exceeded the maximum duration${windowText}.${lastActivityText}`;
    }
    const detail = typeof event.payload.detail === "string" ? event.payload.detail : "";
    return detail && detail !== content ? `${content} ${detail}` : content;
  }
  if (typeof event.payload.content === "string") return event.payload.content;
  if (typeof event.payload.message === "string") return event.payload.message;
  if (typeof event.payload.chunk === "string") return event.payload.chunk;
  return JSON.stringify(event.payload);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds >= 60000 && milliseconds % 60000 === 0) { const minutes = milliseconds / 60000; return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`; }
  if (milliseconds >= 1000 && milliseconds % 1000 === 0) { const seconds = milliseconds / 1000; return `${seconds} ${seconds === 1 ? "second" : "seconds"}`; }
  return `${milliseconds}ms`;
}

function chatTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles"; }
  catch { return "America/Los_Angeles"; }
}

export function formatChatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const timeZone = chatTimeZone();
  const date = new Date(timestamp);
  const currentDate = new Date();
  const dateParts = chatCalendarParts(date, timeZone);
  const currentDateParts = chatCalendarParts(currentDate, timeZone);
  const isCurrentDay = dateParts.year === currentDateParts.year && dateParts.month === currentDateParts.month && dateParts.day === currentDateParts.day;
  return new Intl.DateTimeFormat(undefined, { timeZone, ...(isCurrentDay ? {} : { month: "short", day: "numeric", ...(dateParts.year === currentDateParts.year ? {} : { year: "numeric" }) }), hour: "numeric", minute: "2-digit" }).format(date);
}

function chatCalendarParts(date: Date, timeZone: string): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  return { year: parts.find((part) => part.type === "year")?.value ?? "", month: parts.find((part) => part.type === "month")?.value ?? "", day: parts.find((part) => part.type === "day")?.value ?? "" };
}

export function formatChatTimestampTitle(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, { timeZone: chatTimeZone(), weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(timestamp));
}
