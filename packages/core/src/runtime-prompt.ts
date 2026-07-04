import type { MonConfig, MondeConfig, RunOrigin, RunRecord } from "./schemas.js";

export interface RuntimePromptMon {
  id: string;
  name?: string;
  role?: string;
  mon_root?: string;
  work_root?: string;
  capabilities?: string[];
}

export interface RuntimePromptMonde {
  id: string;
  name?: string;
  root?: string;
  docs?: string;
}

export type RuntimePromptScope = Record<string, unknown> & {
  mon_root?: unknown;
  work_root?: unknown;
  monde_root?: unknown;
  docs_root?: unknown;
  capabilities?: unknown;
  mon_json?: unknown;
  monde_json?: unknown;
};

export function buildRuntimePrompt(
  run: Pick<RunRecord, "id" | "origin" | "intent" | "status" | "process_status" | "outcome" | "warnings"> & {
    execution?: Record<string, unknown>;
  },
  mon?: RuntimePromptMon | MonConfig,
  monde?: RuntimePromptMonde | MondeConfig,
  scopeSnapshot: RuntimePromptScope = {}
): string {
  const monJson = isRecord(scopeSnapshot.mon_json) ? (scopeSnapshot.mon_json as Partial<MonConfig>) : {};
  const mondeJson = isRecord(scopeSnapshot.monde_json) ? (scopeSnapshot.monde_json as Partial<MondeConfig>) : {};
  const monId = String(mon?.id ?? monJson.id ?? "unknown");
  const monName = String(mon?.name ?? monJson.name ?? monId);
  const role = String(mon?.role ?? monJson.role ?? monName);
  const mondeId = String(monde?.id ?? mondeJson.id ?? "unknown");
  const mondeName = String(monde?.name ?? mondeJson.name ?? mondeId);
  const monRoot = stringValue(scopeSnapshot.mon_root, mon && "mon_root" in mon ? mon.mon_root : undefined);
  const workRoot = stringValue(scopeSnapshot.work_root, mon && "work_root" in mon ? mon.work_root : undefined);
  const mondeRoot = stringValue(scopeSnapshot.monde_root, monde && "root" in monde ? monde.root : undefined);
  const docsRoot = stringValue(scopeSnapshot.docs_root, monde && "docs" in monde ? monde.docs : undefined);
  const canWrite = run.execution?.can_write === true;
  const sandboxMode = typeof run.execution?.sandbox_mode === "string" ? run.execution.sandbox_mode : "unknown";
  const writeScope = typeof run.execution?.write_scope === "string" ? run.execution.write_scope : "not advertised";
  const capabilities = Array.isArray(scopeSnapshot.capabilities)
    ? scopeSnapshot.capabilities.map(String)
    : Array.isArray(mon?.capabilities)
      ? mon.capabilities
      : [];

  return [
    `You are the ${role} mon in the current Monde named ${mondeName}.`,
    "",
    "Your identity root is:",
    `  ${monRoot ?? "(unknown)"}`,
    "",
    "Your project working scope is:",
    `  ${workRoot ?? "(unknown)"}`,
    "",
    "The Monde root is:",
    `  ${mondeRoot ?? "(unknown)"}`,
    "",
    "The Monde docs root is:",
    `  ${docsRoot ?? "(unknown)"}`,
    "",
    "Run identity:",
    `  run.id = ${run.id}`,
    `  mon.id = ${monId}`,
    `  monde.id = ${mondeId}`,
    `  warnings = ${run.warnings.length ? run.warnings.join(", ") : "none"}`,
    "  lifecycle = this run is being started by Monde; call runtime_scope() for current status, process_status, and outcome.",
    "",
    "This run exists because:",
    ...formatOrigin(run.origin).map((line) => `  ${line}`),
    `  intent.title = ${run.intent.title}`,
    `  intent.prompt = ${run.intent.prompt}`,
    "",
    "Scope rules:",
    "  Treat mon_root as identity/configuration for this mon.",
    "  Work primarily inside work_root.",
    "  Do not edit outside work_root unless the operator explicitly authorizes it.",
    "  The active scope snapshot is stable for this run; stale_scope is a warning, not an automatic scope change.",
    "",
    "Write capability:",
    `  sandbox_mode = ${sandboxMode}`,
    `  can_write = ${canWrite ? "true" : "false"}`,
    `  write_scope = ${writeScope}`,
    canWrite
      ? "  If you edit files, keep changes inside write_scope and register important outputs as artifacts."
      : "  This run is read-only unless the operator starts a write-capable run.",
    "",
    "Available Monde tools:",
    "  runtime_scope()",
    "  search_docs(query)",
    "  list_plans(), get_plan(plan_id), search_plans(query)",
    "  list_runs(status?, origin_type?, mon_id?), get_run(run_id)",
    "  write_log(entry, run_id?)",
    "  register_artifact(path?, type, title?, run_id?, summary?)",
    "  list_artifacts(run_id? | mon_id?), get_artifact(artifact_id)",
    "",
    "Use Monde tools for runtime scope, docs, plans, runs, logs, and artifacts.",
    "Use runtime_scope() when uncertain about identity, roots, warnings, or current run state.",
    "Write concise logs for decisions, milestones, and blockers.",
    "Register important produced files as artifacts.",
    "A clean process exit does not imply semantic success; outcome may remain unknown until reviewed.",
    capabilities.length ? `Advisory capabilities declared by this mon: ${capabilities.join(", ")}` : "No advisory capabilities are declared by this mon."
  ].join("\n");
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatOrigin(origin: RunOrigin): string[] {
  return Object.entries(origin).map(([key, value]) => `${key} = ${String(value)}`);
}
