import type { MonDto, RunDto } from "@monde/core";
import type { ChipMeta } from "../../components/MetaChip";

export function monHarnessMeta(mon: MonDto): ChipMeta {
  const label = (mon.default_harness ?? "").trim() || "harness";
  return { label: label.replaceAll("_", " "), tone: label === "harness" ? "neutral" : "blue" };
}

export function monStatusMeta(monRuns: RunDto[], monThreads: RunDto[]): ChipMeta {
  if (monRuns.some((run) => run.status === "active" || run.status === "starting") || monThreads.some((thread) => thread.runtime_state === "running")) return { label: "working", tone: "blue" };
  if (monThreads.some((thread) => thread.runtime_state === "waiting_for_user")) return { label: "waiting", tone: "amber" };
  if (monRuns.some((run) => run.status === "queued") || monThreads.some((thread) => thread.runtime_state === "queued")) return { label: "queued", tone: "amber" };
  if (monThreads.some((thread) => thread.runtime_state === "failed" || thread.runtime_state === "cancelled")) return { label: "needs review", tone: "red" };
  return { label: "idle", tone: "green" };
}

export function monModeMeta(mon: MonDto): ChipMeta {
  const sandboxMode = monSandboxMode(mon);
  if (sandboxMode.includes("write")) return { label: "write", tone: "amber" };
  if (sandboxMode.includes("read")) return { label: "read only", tone: "green" };
  if (sandboxMode) return { label: sandboxMode.replaceAll("_", " "), tone: "neutral" };
  return { label: "mode default", tone: "neutral" };
}

function monSandboxMode(mon: MonDto): string {
  const defaults = mon.harness_defaults ?? {};
  const preferredHarness = mon.default_harness ?? "";
  const preferred = preferredHarness ? defaults[preferredHarness]?.sandbox_mode : undefined;
  if (preferred) return preferred;
  if (defaults.codex?.sandbox_mode) return defaults.codex.sandbox_mode;
  return Object.values(defaults).find((entry) => entry?.sandbox_mode)?.sandbox_mode ?? "";
}
