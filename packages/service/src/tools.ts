import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactRepository } from "./repositories/artifacts.js";
import type { LogRepository } from "./repositories/logs.js";
import type { PlanRepository } from "./repositories/plans.js";
import type { RunRepository } from "./repositories/runs.js";

export class ToolHandlers {
  constructor(
    private readonly deps: {
      runs: RunRepository;
      plans: PlanRepository;
      logs: LogRepository;
      artifacts: ArtifactRepository;
    }
  ) {}

  runtimeScope(runId: string): Record<string, unknown> {
    const run = this.requireRun(runId);
    const scope = (run.scope_snapshot ?? {}) as Record<string, unknown>;

    return {
      monde: {
        id: run.monde_id,
        root: scope.monde_root,
        docs_root: scope.docs_root
      },
      mon: {
        id: run.mon_id,
        root: scope.mon_root,
        work_root: scope.work_root,
        capabilities: scope.capabilities ?? []
      },
      run: {
        id: run.id,
        status: run.status,
        process_status: run.process_status,
        outcome: run.outcome,
        interaction_mode: run.interaction_mode,
        runtime_state: run.runtime_state,
        outcome_state: run.outcome_state,
        close_reason: run.close_reason ?? null,
        origin: run.origin,
        intent: run.intent,
        warnings: run.warnings,
        runner: run.execution?.runner,
        runner_type: run.execution?.runner_type,
        harness_interaction_mode: run.execution?.interaction_mode,
        input_mode: run.execution?.input_mode,
        output_mode: run.execution?.output_mode,
        can_write: run.execution?.can_write,
        write_scope: run.execution?.write_scope,
        sandbox_mode: run.execution?.sandbox_mode,
        approval_mode: run.execution?.approval_mode
      },
      server_owned_surfaces: {
        logs: true,
        artifacts: true,
        result: true
      },
      scope_rules: {
        work_root: scope.work_root,
        docs_root: scope.docs_root,
        stale_scope_is_warning: true
      },
      evidence_expectations: {
        logs: "Use write_log for decisions, milestones, observations, errors, tool calls, warnings, review notes, and audit notes.",
        artifacts: "Use register_artifact for files, reports, diffs, schemas, screenshots, generated assets, prompt packs, and notes.",
        result: "Run summaries live under run.result.summary when present."
      },
      tool_policy: {
        capabilities_are_advisory: true,
        plans_are_read_only_to_mons: true,
        run_start_cancel_close_are_operator_actions: true
      },
      valid_next_actions: [
        "runtime_scope",
        "search_docs",
        "list_plans",
        "get_plan",
        "search_plans",
        "get_run",
        "list_runs",
        "write_log",
        "register_artifact",
        "list_artifacts",
        "get_artifact"
      ],
      next_actions: ["search_docs", "write_log", "register_artifact", "get_run"]
    };
  }

  searchDocs(runId: string, query: string): Record<string, unknown> {
    const run = this.requireRun(runId);
    const docsRoot = String((run.scope_snapshot as Record<string, unknown> | undefined)?.docs_root ?? "");
    if (!docsRoot) {
      return { surface: "docs", query, results: [], warning: "docs_root_missing", guidance: "Run has no docs_root in scope." };
    }

    if (!fs.existsSync(docsRoot)) {
      return { surface: "docs", query, results: [], warning: "docs_root_missing", guidance: "Create .monde/docs and add docs." };
    }

    const result = spawnSync("rg", ["-n", "-i", "--", query, docsRoot], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });

    if (result.status !== 0 && result.status !== 1) {
      return {
        surface: "docs",
        query,
        results: [],
        warning: "search_failed",
        stderr: result.stderr
      };
    }

    const results = result.stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, 40)
      .map((line, index) => {
        const [file, lineNumber, ...rest] = line.split(":");
        const lineStart = Number.parseInt(lineNumber ?? "0", 10);
        const lineEnd = lineStart;
        return {
          surface: "docs",
          path: path.relative(String((run.scope_snapshot as Record<string, unknown>).monde_root ?? docsRoot), path.resolve(file)),
          absolute_path: path.resolve(file),
          heading: detectHeading(path.resolve(file), lineStart),
          line_start: Math.max(1, lineStart - 2),
          line_end: lineEnd + 2,
          matched_line: lineStart,
          snippet: readSnippet(path.resolve(file), lineStart, 2) || rest.join(":"),
          score: Math.max(0.1, 1 - index * 0.03)
        };
      });

    return {
      surface: "docs",
      query,
      results,
      guidance: results.length === 0 ? "No docs matched. Try broader terms, inspect runtime_scope(), or add docs under .monde/docs." : undefined,
      next_actions: ["search_docs", "runtime_scope"]
    };
  }

  getRun(runId: string, targetRunId = runId): Record<string, unknown> {
    const current = this.requireRun(runId);
    const target = this.requireRun(targetRunId);
    if (target.monde_id !== current.monde_id) {
      throw new Error(`Run not found in current Monde: ${targetRunId}`);
    }

    return {
      run: target,
      recent_logs: this.deps.logs.list(target.id).slice(-10),
      artifacts: this.deps.artifacts.list({ runId: target.id }),
      result: target.result,
      next_actions: ["write_log", "register_artifact", "list_artifacts"]
    };
  }

  listPlans(runId: string): Record<string, unknown> {
    const run = this.requireRun(runId);
    return { plans: this.deps.plans.list(run.monde_id) };
  }

  getPlan(runId: string, planId: string): Record<string, unknown> {
    const run = this.requireRun(runId);
    const plan = this.deps.plans.get(planId);
    if (!plan || plan.monde_id !== run.monde_id) {
      throw new Error(`Plan not found in current Monde: ${planId}`);
    }

    return { plan };
  }

  searchPlans(runId: string, query: string): Record<string, unknown> {
    const run = this.requireRun(runId);
    return { plans: this.deps.plans.search(run.monde_id, query) };
  }

  listRuns(runId: string, filters: { status?: string; origin_type?: string; mon_id?: string; monde_id?: string }): Record<string, unknown> {
    const run = this.requireRun(runId);
    return {
      runs: this.deps.runs.list({
        mondeId: run.monde_id,
        monId: filters.mon_id,
        status: filters.status as never,
        originType: filters.origin_type
      })
    };
  }

  writeLog(runId: string, entry: Record<string, unknown>): Record<string, unknown> {
    const requestedType = typeof entry.event_type === "string"
      ? entry.event_type
      : typeof entry.type === "string"
        ? entry.type
        : "observation";
    const eventType = logEventTypes.has(requestedType) ? requestedType : "observation";
    return {
      log: this.deps.logs.append(runId, entry, eventType),
      next_actions: ["runtime_scope", "register_artifact", "get_run"]
    };
  }

  registerArtifact(
    runId: string,
    input: { path?: string; type: string; title?: string; summary?: string }
  ): Record<string, unknown> {
    const run = this.requireRun(runId);
    const type = artifactTypes.has(input.type) ? input.type : "other";
    const artifact = this.deps.artifacts.register({
        monde_id: run.monde_id,
        mon_id: run.mon_id,
        run_id: run.id,
        type,
        path: input.path,
        title: input.title,
        summary: input.summary
    });

    return {
      artifact,
      next_actions: ["write_log", "get_artifact", "list_artifacts"]
    };
  }

  listArtifacts(runId: string, filters: { run_id?: string; mon_id?: string }): Record<string, unknown> {
    const run = this.requireRun(runId);
    return {
      artifacts: this.deps.artifacts.list({
        mondeId: run.monde_id,
        runId: filters.run_id,
        monId: filters.mon_id
      })
    };
  }

  getArtifact(runId: string, artifactId: string): Record<string, unknown> {
    const run = this.requireRun(runId);
    const artifact = this.deps.artifacts.get(artifactId);
    if (!artifact || artifact.monde_id !== run.monde_id) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    return { artifact };
  }

  private requireRun(runId: string) {
    const run = this.deps.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    return run;
  }
}

function detectHeading(filePath: string, lineNumber: number): string | undefined {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (let index = Math.min(lineNumber - 1, lines.length - 1); index >= 0; index -= 1) {
      const line = lines[index]?.trim() ?? "";
      if (line.startsWith("#")) {
        return line.replace(/^#+\s*/, "");
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function readSnippet(filePath: string, lineNumber: number, radius: number): string | undefined {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const start = Math.max(0, lineNumber - 1 - radius);
    const end = Math.min(lines.length, lineNumber + radius);
    return lines
      .slice(start, end)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join("\n");
  } catch {
    return undefined;
  }
}

const logEventTypes = new Set([
  "decision",
  "milestone",
  "observation",
  "error",
  "tool_call",
  "artifact_registered",
  "warning_added",
  "review",
  "audit"
]);

const artifactTypes = new Set([
  "file",
  "note",
  "diff",
  "report",
  "schema",
  "test_suite",
  "screenshot",
  "generated_asset",
  "prompt_pack",
  "other"
]);
