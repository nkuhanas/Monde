import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  ExternalMcpServerSchema,
  finishRunFromExit,
  MonConfigSchema,
  resolveWorkRoot
} from "@monde/core";
import { canonicalSha256 } from "@monde/core";
import type { BackupInfoDto, BackupMetadataDto, DoctorFindingDto, MonConfig } from "@monde/core";
import type { RunCloseReason, RunRecord } from "@monde/core";
import { harnessAdapters } from "@monde/adapters";
import type { ServiceAuth } from "./auth.js";
import { ArtifactRepository } from "./repositories/artifacts.js";
import {
  ExternalExecutionConflictError,
  ExternalExecutionRepository
} from "./repositories/external-executions.js";
import { ExternalMcpGrantRepository } from "./repositories/external-mcp-grants.js";
import { LogRepository } from "./repositories/logs.js";
import { MonRepository, type MonRow, type MonUpsert } from "./repositories/mons.js";
import { MondeRepository } from "./repositories/mondes.js";
import { PlanRepository } from "./repositories/plans.js";
import { RunEventRepository } from "./repositories/run-events.js";
import { RunRepository } from "./repositories/runs.js";
import type { MondeDatabase } from "./db.js";
import { schemaVersion } from "./db.js";
import { getPlatformPaths } from "./platform.js";
import type { RunEventBus } from "./run-events.js";
import type { RunManager } from "./run-manager.js";
import { ToolHandlers } from "./tools.js";

const HarnessDefaultsSchema = z.record(
  z.object({
    sandbox_mode: z.string().optional()
  })
);

const MonPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    work_root: z.string().min(1).optional(),
    default_harness: z.string().min(1).nullable().optional(),
    default_model: z.string().nullable().optional(),
    capabilities: z.array(z.string()).optional(),
    harness_defaults: HarnessDefaultsSchema.optional(),
    allow_external_work_root: z.boolean().optional(),
    max_active_runs: z.number().int().min(1).max(32).optional(),
    run_workspace: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("shared") }),
        z.object({
          mode: z.literal("isolated"),
          recovery_window_seconds: z.number().int().positive().max(604800).default(86400)
        })
      ])
      .optional(),
    actor_context: z
      .array(z.object({ root: z.enum(["mon", "work"]), path: z.string().min(1) }))
      .max(32)
      .optional(),
    read_mounts: z
      .array(z.object({ root: z.enum(["mon", "work"]), path: z.string().min(1) }))
      .max(16)
      .optional(),
    external_mcp_servers: z.array(ExternalMcpServerSchema).max(8).optional()
  })
  .strict();

export interface RouteDeps {
  database: MondeDatabase;
  auth: ServiceAuth;
  mondes: MondeRepository;
  externalExecutions: ExternalExecutionRepository;
  externalMcpGrants: ExternalMcpGrantRepository;
  mons: MonRepository;
  plans: PlanRepository;
  runs: RunRepository;
  runEvents: RunEventRepository;
  eventBus: RunEventBus;
  runManager: RunManager;
  tools: ToolHandlers;
}

function monConfigPath(monRoot: string): string {
  return path.join(monRoot, "mon.json");
}

function readMonConfig(monRoot: string): MonConfig | undefined {
  try {
    return MonConfigSchema.parse(JSON.parse(fs.readFileSync(monConfigPath(monRoot), "utf8")));
  } catch {
    return undefined;
  }
}

function writeMonConfig(monRoot: string, config: MonConfig): void {
  const parsed = MonConfigSchema.parse(config);
  fs.writeFileSync(monConfigPath(monRoot), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

function monUpsertFromConfig(mondeId: string, monRoot: string, config: MonConfig): MonUpsert {
  return {
    id: config.id,
    monde_id: mondeId,
    name: config.name,
    role: config.role,
    mon_root: monRoot,
    work_root: resolveWorkRoot(monRoot, config.work_root),
    default_harness: config.default_harness,
    default_model: config.default_model,
    capabilities: config.capabilities
  };
}

function monDto(mon: MonRow): MonRow & {
  configured_work_root?: string;
  harness_defaults?: Record<string, { sandbox_mode?: string }>;
  allow_external_work_root?: boolean;
  max_active_runs?: number;
  run_workspace?: MonConfig["run_workspace"];
  actor_context?: MonConfig["actor_context"];
  read_mounts?: MonConfig["read_mounts"];
  external_mcp_servers?: MonConfig["external_mcp_servers"];
} {
  const config = readMonConfig(mon.mon_root);
  if (!config) {
    return mon;
  }

  return {
    ...mon,
    name: config.name,
    role: config.role,
    work_root: resolveWorkRoot(mon.mon_root, config.work_root),
    configured_work_root: config.work_root,
    default_harness: config.default_harness,
    default_model: config.default_model,
    capabilities: config.capabilities,
    harness_defaults: config.harness_defaults,
    allow_external_work_root: config.allow_external_work_root,
    max_active_runs: config.max_active_runs,
    run_workspace: config.run_workspace,
    actor_context: config.actor_context,
    read_mounts: config.read_mounts,
    external_mcp_servers: config.external_mcp_servers
  };
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {
    auth,
    mondes,
    mons,
    plans,
    runs,
    runEvents,
    eventBus,
    runManager,
    tools,
    externalExecutions,
    externalMcpGrants
  } = deps;
  const logs = new LogRepository(deps.database.db);
  const artifacts = new ArtifactRepository(deps.database.db);
  app.get("/health", async () => ({
    ok: true,
    service: "monde",
    db_path: getPlatformPaths().dbPath,
    schema_version: schemaVersion
  }));

  app.post("/external-mcp/introspect", async (request) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    const claims = token ? externalMcpGrants.introspect(token) : undefined;
    return claims ? { active: true, claims } : { active: false };
  });

  app.get("/session", async () => ({
    service: "monde",
    token_path: getPlatformPaths().tokenPath,
    note: "Paste the local service token into the web UI for authenticated local API calls."
  }));

  app.get("/adapters", async () => ({
    adapters: harnessAdapters.map((adapter) => {
      const detection = adapter.detect();
      return {
        id: adapter.id,
        label: adapter.label,
        detection: {
          ...detection,
          path: detection.command ?? null
        }
      };
    })
  }));

  app.get("/backup/info", async () => ({ backup: backupInfo() }));
  app.get("/backup/list", async () => ({ backups: listBackups() }));
  app.get("/doctor", async () => ({ findings: serviceDoctorFindings() }));

  app.get("/mondes", async () => ({ mondes: mondes.list() }));

  app.post("/mondes/upsert", async (request, reply) => {
    const body = z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        root: z.string().min(1),
        docs: z.string().min(1)
      })
      .parse(request.body);

    mondes.upsert(body);
    return reply.code(204).send();
  });

  app.post("/mons/upsert", async (request, reply) => {
    const body = z
      .object({
        id: z.string().min(1),
        monde_id: z.string().min(1),
        name: z.string().min(1),
        role: z.string().min(1),
        mon_root: z.string().min(1),
        work_root: z.string().min(1),
        default_harness: z.string().nullable(),
        default_model: z.string().nullable(),
        capabilities: z.array(z.string())
      })
      .parse(request.body);

    mons.upsert(body);
    return reply.code(204).send();
  });

  app.get("/mons", async (request) => {
    const query = request.query as { monde_id?: string };
    return { mons: mons.list(query.monde_id).map(monDto) };
  });

  app.patch("/mons/:mondeId/:monId", async (request, reply) => {
    const params = request.params as { mondeId: string; monId: string };
    const mon = mons.get(params.mondeId, params.monId);
    if (!mon) {
      return reply.code(404).send({ error: "mon_not_found" });
    }

    const currentConfig = readMonConfig(mon.mon_root);
    if (!currentConfig) {
      return reply.code(409).send({ error: "mon_config_unavailable", mon_root: mon.mon_root });
    }

    const patch = MonPatchSchema.parse(request.body);
    const nextConfig: MonConfig = {
      ...currentConfig,
      ...patch
    };
    writeMonConfig(mon.mon_root, nextConfig);
    mons.upsert(monUpsertFromConfig(params.mondeId, mon.mon_root, nextConfig));
    return { mon: monDto(mons.get(params.mondeId, params.monId)!) };
  });

  app.delete("/mons/:mondeId/:monId", async (request, reply) => {
    const params = request.params as { mondeId: string; monId: string };
    const deleted = mons.delete(params.mondeId, params.monId);
    if (!deleted) {
      return reply.code(404).send({ error: "mon_not_found" });
    }

    return reply.code(204).send();
  });

  app.get("/plans", async (request) => {
    const query = request.query as { monde_id?: string; q?: string };
    return {
      plans: query.q && query.monde_id ? plans.search(query.monde_id, query.q) : plans.list(query.monde_id)
    };
  });

  app.post("/plans", async (request) => {
    const body = z
      .object({
        monde_id: z.string().min(1),
        title: z.string().min(1),
        objective: z.string().optional(),
        prompt: z.string().optional(),
        description: z.string().optional(),
        assignment: z
          .object({
            mon_id: z.string().min(1),
            title: z.string().optional(),
            prompt: z.string().min(1),
            phase: z.string().optional(),
            trigger: z.enum(["on_activation", "manual"]).optional()
          })
          .optional()
      })
      .parse(request.body);

    return { plan: plans.create(body) };
  });

  app.get("/plans/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const plan = plans.get(params.id);
    if (!plan) {
      return reply.code(404).send({ error: "plan_not_found" });
    }

    return { plan };
  });

  app.get("/plans/:id/evidence", async (request, reply) => {
    const params = request.params as { id: string };
    const plan = plans.get(params.id);
    if (!plan) {
      return reply.code(404).send({ error: "plan_not_found" });
    }

    return { evidence: buildPlanEvidence(plan) };
  });

  app.post("/plans/:id/assignments", async (request, reply) => {
    const params = request.params as { id: string };
    if (!plans.get(params.id)) {
      return reply.code(404).send({ error: "plan_not_found" });
    }

    const body = z
      .object({
        mon_id: z.string().min(1),
        title: z.string().optional(),
        prompt: z.string().min(1),
        phase: z.string().optional(),
        trigger: z.enum(["on_activation", "manual"]).optional()
      })
      .parse(request.body);

    return { assignment: plans.addAssignment(params.id, body) };
  });

  app.post("/plans/:id/activate", async (request, reply) => {
    const params = request.params as { id: string };
    const plan = plans.get(params.id);
    if (!plan) {
      return reply.code(404).send({ error: "plan_not_found" });
    }

    const createdRuns = [];
    const existingRuns = [];
    for (const assignment of plan.assignments) {
      if (assignment.trigger !== "on_activation" || assignment.status === "canceled") {
        continue;
      }

      const existing = assignment.generated_run_ids
        .map((runId) => runs.get(runId))
        .find((run) => run && !(run.status === "finished" && run.outcome === "canceled"));

      if (existing) {
        existingRuns.push(existing);
        continue;
      }

      const now = new Date().toISOString();
      const run = {
        id: `run_${nanoid(10)}`,
        monde_id: plan.monde_id,
        mon_id: assignment.mon_id,
        status: "queued" as const,
        process_status: "not_started" as const,
        outcome: "unknown" as const,
        interaction_mode: "one_shot" as const,
        runtime_state: "queued" as const,
        outcome_state: "unknown" as const,
        close_reason: null,
        warnings: [],
        origin: {
          type: "plan" as const,
          plan_id: plan.id,
          phase: assignment.phase ?? undefined,
          assignment: assignment.id
        },
        intent: assignment.intent,
        execution: {},
        result: {},
        created_at: now,
        updated_at: now
      };

      runs.insert(run);
      plans.updateAssignmentGeneratedRun(assignment.id, "queued", run.id);
      createdRuns.push(runs.get(run.id));
    }

    plans.updateStatus(plan.id, "active");
    return { plan: plans.get(plan.id), created_runs: createdRuns, existing_runs: existingRuns };
  });

  function buildPlanEvidence(plan: NonNullable<ReturnType<PlanRepository["get"]>>): Record<string, unknown> {
    const assignments = plan.assignments.map((assignment) => {
      const linkedRuns = assignment.generated_run_ids
        .map((runId) => runs.get(runId))
        .filter((run): run is RunRecord => !!run);
      const runEvidence = linkedRuns.map((run) => {
        const runLogs = logs.list(run.id);
        const runArtifacts = artifacts.list({ runId: run.id });
        return {
          run,
          logs: runLogs,
          artifacts: runArtifacts,
          result_summary: run.result.summary ?? null,
          review_notes: run.result.notes ?? null,
          warnings: run.warnings
        };
      });

      return {
        assignment,
        runs: runEvidence
      };
    });
    const allRunEvidence = assignments.flatMap((assignment) => assignment.runs);
    const linkedRuns = allRunEvidence.map((entry) => entry.run);
    const linkedArtifacts = allRunEvidence.flatMap((entry) => entry.artifacts);
    const linkedLogs = allRunEvidence.flatMap((entry) => entry.logs);
    const warnings = linkedRuns.flatMap((run) => run.warnings.map((warning) => ({ run_id: run.id, warning })));
    const resultSummaries = linkedRuns
      .filter((run) => typeof run.result.summary === "string")
      .map((run) => ({ run_id: run.id, summary: run.result.summary, outcome: run.outcome }));

    return {
      plan,
      summary: {
        assignments: assignments.length,
        linked_runs: linkedRuns.length,
        artifacts: linkedArtifacts.length,
        logs: linkedLogs.length,
        warnings: warnings.length,
        result_summaries: resultSummaries.length
      },
      assignments,
      runs: linkedRuns,
      artifacts: linkedArtifacts,
      logs: linkedLogs,
      warnings,
      result_summaries: resultSummaries
    };
  }

  app.get("/runs", async (request) => {
    const query = request.query as { monde_id?: string; mon_id?: string; status?: string; origin_type?: string };
    return {
      runs: runs.list({
        mondeId: query.monde_id,
        monId: query.mon_id,
        status: query.status as never,
        originType: query.origin_type
      })
    };
  });

  app.get("/runs/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const run = runs.get(params.id);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    return { run };
  });

  app.post("/external-executions", async (request, reply) => {
    const body = z
      .object({
        integration_id: z.string().min(1).max(128),
        external_execution_key: z.string().min(1).max(512),
        monde_id: z.string().min(1),
        mon_id: z.string().min(1),
        input: z.object({ kind: z.literal("prompt"), prompt: z.string().min(1).max(1024 * 1024) }),
        harness_override: z.string().min(1).optional(),
        external_scope: z.unknown(),
        external_context: z.unknown(),
        artifact_sink_ref: z.unknown().optional(),
        external_lineage: z.unknown().optional(),
        predecessor: z
          .object({
            integration_id: z.string().min(1).max(128).optional(),
            external_execution_key: z.string().min(1).max(512)
          })
          .optional(),
        request_digest: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
      .parse(request.body);

    if (!mondes.get(body.monde_id) || !mons.get(body.monde_id, body.mon_id)) {
      return reply.code(404).send({ error: "execution_target_not_found" });
    }
    try {
      assertCanonicalSize(body.external_scope, 4096, "external_scope");
      assertCanonicalSize(body.external_context, 64 * 1024, "external_context");
      if (body.artifact_sink_ref !== undefined) assertCanonicalSize(body.artifact_sink_ref, 16 * 1024, "artifact_sink_ref");
      if (body.external_lineage !== undefined) assertCanonicalSize(body.external_lineage, 32 * 1024, "external_lineage");
    } catch (error) {
      return reply.code(422).send({ error: "payload_too_large", message: error instanceof Error ? error.message : String(error) });
    }

    const { request_digest: _requestDigest, ...digestPayload } = body;
    const computedDigest = canonicalSha256(digestPayload);
    if (computedDigest !== body.request_digest) {
      return reply.code(422).send({ error: "request_digest_mismatch", computed_digest: computedDigest });
    }

    const run = createExternalRun(body);
    try {
      const reserved = externalExecutions.createOrGet({
        integrationId: body.integration_id,
        externalExecutionKey: body.external_execution_key,
        requestDigest: body.request_digest,
        run,
        externalScope: body.external_scope,
        externalContext: body.external_context,
        artifactSinkRef: body.artifact_sink_ref,
        externalLineage: body.external_lineage,
        predecessorIntegrationId: body.predecessor?.integration_id,
        predecessorExternalKey: body.predecessor?.external_execution_key
      });
      if (reserved.created) {
        try {
          await runManager.dispatchQueuedForMon(body.monde_id, body.mon_id);
        } catch (error) {
          externalExecutions.markFailedByRun(reserved.execution.run_id, "configuration_error");
          runs.updateLifecycle(reserved.execution.run_id, {
            status: "finished",
            process_status: "not_started",
            outcome: "failed",
            runtime_state: "failed",
            outcome_state: "failed",
            close_reason: "error",
            ended_at: new Date().toISOString(),
            closed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
          eventBus.publish(reserved.execution.run_id, "external_execution_start_failed", {
            run_id: reserved.execution.run_id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      const execution = externalExecutions.get(reserved.execution.id)!;
      return reply.code(reserved.created ? 201 : 200).send({
        execution,
        run: runs.get(execution.run_id),
        created: reserved.created
      });
    } catch (error) {
      if (error instanceof ExternalExecutionConflictError) {
        return reply.code(409).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/external-executions/lookup", async (request, reply) => {
    const query = z
      .object({
        integration_id: z.string().min(1),
        external_execution_key: z.string().min(1)
      })
      .parse(request.query);
    const execution = externalExecutions.getByKey(query.integration_id, query.external_execution_key);
    if (!execution) {
      return reply.code(404).send({ error: "external_execution_not_found" });
    }
    return { execution, run: runs.get(execution.run_id) };
  });

  app.get("/external-executions/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const execution = externalExecutions.get(params.id);
    if (!execution) {
      return reply.code(404).send({ error: "external_execution_not_found" });
    }
    return { execution, run: runs.get(execution.run_id) };
  });

  app.get("/runs/:id/external-execution", async (request, reply) => {
    const params = request.params as { id: string };
    const execution = externalExecutions.getByRunId(params.id);
    if (!execution) {
      return reply.code(404).send({ error: "external_execution_not_found" });
    }
    return { execution };
  });

  app.post("/external-executions/:id/complete", async (request, reply) => {
    const params = request.params as { id: string };
    if (!externalExecutions.get(params.id)) {
      return reply.code(404).send({ error: "external_execution_not_found" });
    }
    const body = z
      .object({
        completion_receipt: z.unknown().optional(),
        manifest_id: z.string().min(1).optional(),
        completion_digest: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
      .refine((value) => value.completion_receipt !== undefined || value.manifest_id !== undefined, {
        message: "completion_receipt or manifest_id is required"
      })
      .parse(request.body);
    if (body.manifest_id && body.completion_receipt === undefined) {
      return reply.code(409).send({ error: "manifest_not_found" });
    }
    if (body.completion_receipt !== undefined) {
      try {
        assertCanonicalSize(body.completion_receipt, 64 * 1024, "completion_receipt");
      } catch (error) {
        return reply.code(422).send({ error: "payload_too_large", message: error instanceof Error ? error.message : String(error) });
      }
    }
    const digestPayload = {
      ...(body.completion_receipt !== undefined ? { completion_receipt: body.completion_receipt } : {}),
      ...(body.manifest_id !== undefined ? { manifest_id: body.manifest_id } : {})
    };
    const computedDigest = canonicalSha256(digestPayload);
    if (computedDigest !== body.completion_digest) {
      return reply.code(422).send({ error: "completion_digest_mismatch", computed_digest: computedDigest });
    }
    try {
      const execution = runManager.completeExternalExecution({
        executionId: params.id,
        completionDigest: body.completion_digest,
        completionReceipt: body.completion_receipt,
        manifestId: body.manifest_id
      });
      return { execution, run: runs.get(execution.run_id) };
    } catch (error) {
      if (error instanceof ExternalExecutionConflictError) {
        return reply.code(409).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/external-executions/:id/cancel", async (request, reply) => {
    const params = request.params as { id: string };
    if (!externalExecutions.get(params.id)) {
      return reply.code(404).send({ error: "external_execution_not_found" });
    }
    try {
      const execution = runManager.cancelExternalExecution(params.id);
      return { execution, run: runs.get(execution.run_id) };
    } catch (error) {
      if (error instanceof ExternalExecutionConflictError) {
        return reply.code(409).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/runs/:id/events/history", async (request, reply) => {
    const params = request.params as { id: string };
    if (!runs.get(params.id)) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    return { events: runEvents.list(params.id) };
  });

  app.get("/runs/:id/events", async (request, reply) => {
    const params = request.params as { id: string };
    if (!runs.get(params.id)) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    for (const event of runEvents.list(params.id)) {
      writeSse(reply.raw, event.event_type, event);
    }

    const unsubscribe = eventBus.subscribe(params.id, (event) => {
      writeSse(reply.raw, event.event_type, event);
    });
    request.raw.on("close", unsubscribe);
  });

  app.get("/mondes/:mondeId/threads", async (request, reply) => {
    const params = request.params as { mondeId: string };
    const query = request.query as { runtime_state?: string };
    if (!mondes.get(params.mondeId)) {
      return reply.code(404).send({ error: "monde_not_found" });
    }

    return {
      threads: runs.list({
        mondeId: params.mondeId,
        interactionMode: "hitl_thread",
        runtimeState: query.runtime_state === "open" ? "open" : (query.runtime_state as never)
      })
    };
  });

  app.post("/mondes/:mondeId/threads", async (request, reply) => {
    const params = request.params as { mondeId: string };
    const body = z
      .object({
        mon_id: z.string().min(1),
        title: z.string().optional(),
        context: z.record(z.unknown()).optional()
      })
      .parse(request.body);

    if (!mondes.get(params.mondeId)) {
      return reply.code(404).send({ error: "monde_not_found" });
    }
    const mon = mons.get(params.mondeId, body.mon_id);
    if (!mon) {
      return reply.code(404).send({ error: "mon_not_found" });
    }

    const existing = runs.list({
      mondeId: params.mondeId,
      monId: body.mon_id,
      interactionMode: "hitl_thread",
      runtimeState: "open"
    })[0];
    if (existing) {
      return { thread: existing, resumed: true };
    }

    const thread = createHitlThreadRun(params.mondeId, body.mon_id, body.title ?? `${mon.name} chat`, body.context);
    runs.insert(thread);
    const systemMessage = eventBus.publish(thread.id, "system_message", {
      run_id: thread.id,
      author_type: "system",
      content: "Thread opened. Messages remain available in run history.",
      context: body.context ?? {}
    });
    eventBus.publish(thread.id, "state_change", {
      run_id: thread.id,
      runtime_state: thread.runtime_state,
      outcome_state: thread.outcome_state
    });

    return reply.code(201).send({ thread: runs.get(thread.id), message: systemMessage, resumed: false });
  });

  app.post("/runs/:id/messages", async (request, reply) => {
    const params = request.params as { id: string };
    const body = z
      .object({
        content: z.string().min(1),
        context: z.record(z.unknown()).optional()
      })
      .parse(request.body);
    const run = runs.get(params.id);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }
    if (run.interaction_mode !== "hitl_thread") {
      return reply.code(409).send({ error: "run_not_hitl_thread", interaction_mode: run.interaction_mode });
    }
    if (!isOpenThreadRuntimeState(run.runtime_state)) {
      return reply.code(409).send({ error: "thread_not_open", runtime_state: run.runtime_state });
    }

    const now = new Date().toISOString();
    const userMessage = eventBus.publish(run.id, "user_message", {
      run_id: run.id,
      author_type: "user",
      content: body.content,
      context: body.context ?? {}
    });
    runs.updateLifecycle(run.id, { runtime_state: "running", updated_at: now });
    eventBus.publish(run.id, "state_change", {
      run_id: run.id,
      runtime_state: "running",
      outcome_state: run.outcome_state
    });

    try {
      const response = await runManager.respondToHitlThread(run.id, {
        content: body.content,
        context: body.context
      });
      const monMessage = eventBus.publish(run.id, "mon_message", {
        run_id: run.id,
        author_type: "mon",
        author_id: run.mon_id,
        harness: response.harness,
        content: response.response,
        context: body.context ?? {}
      });
      const respondedAt = new Date().toISOString();
      runs.updateLifecycle(run.id, {
        runtime_state: "waiting_for_user",
        outcome_state: "unknown",
        updated_at: respondedAt
      });
      eventBus.publish(run.id, "state_change", {
        run_id: run.id,
        runtime_state: "waiting_for_user",
        outcome_state: "unknown"
      });

      return { run: runs.get(run.id), user_message: userMessage, message: monMessage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedRun = runs.get(run.id);
      const timeoutReason = typeof failedRun?.execution?.hitl_timeout_reason === "string" ? failedRun.execution.hitl_timeout_reason : undefined;
      const lastActivityAt = typeof failedRun?.execution?.hitl_last_activity_at === "string" ? failedRun.execution.hitl_last_activity_at : undefined;
      const lastActivityReason = typeof failedRun?.execution?.hitl_last_activity_reason === "string" ? failedRun.execution.hitl_last_activity_reason : undefined;
      const idleTimeoutMs = typeof failedRun?.execution?.hitl_idle_timeout_ms === "number" ? failedRun.execution.hitl_idle_timeout_ms : undefined;
      const hardTimeoutMs = typeof failedRun?.execution?.hitl_hard_timeout_ms === "number" ? failedRun.execution.hitl_hard_timeout_ms : undefined;
      const errorMessage = eventBus.publish(run.id, "error", {
        run_id: run.id,
        author_type: "mon",
        content: "Response failed.",
        detail: message,
        timeout_reason: timeoutReason,
        idle_timeout_ms: idleTimeoutMs,
        hard_timeout_ms: hardTimeoutMs,
        last_activity_at: lastActivityAt,
        last_activity_reason: lastActivityReason,
        context: body.context ?? {}
      });
      const respondedAt = new Date().toISOString();
      runs.updateLifecycle(run.id, {
        runtime_state: "waiting_for_user",
        outcome_state: "unknown",
        updated_at: respondedAt
      });
      eventBus.publish(run.id, "state_change", {
        run_id: run.id,
        runtime_state: "waiting_for_user",
        outcome_state: "unknown"
      });

      return reply.code(202).send({ run: runs.get(run.id), user_message: userMessage, message: errorMessage, error: message });
    }
  });

  app.post("/runs/:id/resolve", async (request, reply) => {
    const params = request.params as { id: string };
    const run = runs.get(params.id);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }
    if (run.interaction_mode !== "hitl_thread") {
      return reply.code(409).send({ error: "run_not_hitl_thread", interaction_mode: run.interaction_mode });
    }

    return { run: closeHitlThread(run, "user_marked_resolved") };
  });

  app.post("/runs/:id/abandon", async (request, reply) => {
    const params = request.params as { id: string };
    const run = runs.get(params.id);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }
    if (run.interaction_mode !== "hitl_thread") {
      return reply.code(409).send({ error: "run_not_hitl_thread", interaction_mode: run.interaction_mode });
    }

    return { run: closeHitlThread(run, "user_abandoned") };
  });

  app.post("/runs/operator", async (request, reply) => {
    const body = request.body as {
      monde_id?: string;
      mon_id?: string;
      title?: string;
      prompt?: string;
      harness?: string;
      sandbox_mode?: string;
      attach_active?: boolean;
    };

    if (!body.monde_id || !body.mon_id || !body.prompt) {
      return reply.code(400).send({ error: "monde_id, mon_id, and prompt are required" });
    }

    const activeRuns = runs.listActiveForMon(body.monde_id, body.mon_id);
    const activeRun = activeRuns[0];
    if (activeRun) {
      if (runInputMode(activeRun) !== "open") {
        if (body.attach_active) {
          return reply.code(409).send({
            error: "active_run_input_closed",
            active_run_id: activeRun.id,
            input_mode: runInputMode(activeRun),
            interaction_mode: runInteractionMode(activeRun),
            message: `Active run ${activeRun.id} does not accept stdin turns. Start a new operator run instead.`
          });
        }

        const queued = createOperatorRun(body.monde_id, body.mon_id, body.prompt, body.title, body.harness, body.sandbox_mode);
        runs.insert(queued);
        const dispatched = await runManager.dispatchQueuedForMon(body.monde_id, body.mon_id);
        const started = dispatched.some((candidate) => candidate.id === queued.id);
        return reply.code(started ? 201 : 202).send({
          run: runs.get(queued.id),
          started,
          active_run_id: activeRun.id,
          active_run_ids: runs.listActiveForMon(body.monde_id, body.mon_id).map((candidate) => candidate.id),
          attached_to_active_run: false,
          message: started
            ? `Created and started operator-origin run ${queued.id} in an available process slot.`
            : `Created operator-origin run ${queued.id} and left it queued behind active work.`
        });
      }

      try {
        const run = runManager.writeInput(activeRun.id, `${body.prompt}\n`);
        return reply.code(202).send({
          run,
          attached_to_active_run: true,
          message: "Message sent to active run."
        });
      } catch (error) {
        return reply.code(409).send({
          error: "active_run_not_accepting_input",
          active_run_id: activeRun.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const run = createOperatorRun(body.monde_id, body.mon_id, body.prompt, body.title, body.harness, body.sandbox_mode);

    runs.insert(run);
    const startResult = await runManager.startRun(run.id);
    return reply.code(201).send({ run: startResult.run, started: startResult.started });
  });

  app.post("/runs/:id/start", async (request, reply) => {
    const params = request.params as { id: string };
    const run = runs.get(params.id);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    const result = await runManager.startRun(run.id);
    if (result.active_run_id && result.active_run_id !== run.id && !result.started) {
      return reply.code(409).send({
        error: "mon_active",
        active_run_id: result.active_run_id,
        active_run_ids: result.active_run_ids,
        run: result.run
      });
    }

    return result;
  });

  app.post("/runs/:id/input", async (request, reply) => {
    const params = request.params as { id: string };
    const body = z.object({ input: z.string() }).parse(request.body);
    try {
      return { run: runManager.writeInput(params.id, body.input) };
    } catch (error) {
      return reply.code(409).send({ error: "input_failed", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/runs/:id/interrupt", async (request, reply) => {
    const params = request.params as { id: string };
    try {
      return { run: runManager.interruptRun(params.id) };
    } catch (error) {
      return reply.code(409).send({ error: "interrupt_failed", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/runs/:id/cancel", async (request, reply) => {
    const params = request.params as { id: string };
    const run = runs.get(params.id);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    if (run.status !== "queued" && run.status !== "blocked") {
      return reply.code(409).send({ error: "run_not_cancelable", status: run.status });
    }

    return { run: runManager.cancelRun(run.id) };
  });

  app.post("/runs/:id/close", async (request, reply) => {
    const params = request.params as { id: string };
    const rawBody = (request.body ?? {}) as Record<string, unknown>;
    const run = runs.get(params.id);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    if (run.interaction_mode === "hitl_thread" && typeof rawBody.close_reason === "string") {
      const body = z
        .object({
          close_reason: z.enum(["user_closed_widget", "user_marked_resolved", "user_abandoned", "system_cancelled", "error"])
        })
        .parse(rawBody);
      return { run: closeHitlThread(run, body.close_reason) };
    }

    const body = z
      .object({
        outcome: z.enum(["completed", "failed", "stopped"]),
        summary: z.string().optional(),
        notes: z.string().optional(),
        reviewed_by: z.string().optional()
      })
      .parse(rawBody);

    if (body.outcome === "stopped" && (run.status === "active" || run.status === "starting")) {
      const stopped = runManager.stopRun(run.id);
      return { run: applyManualRunReview(stopped, body.outcome, body.summary, body.notes, body.reviewed_by) };
    }

    if (run.status !== "finished") {
      runs.updateLifecycle(run.id, finishRunFromExit(run, { code: body.outcome === "failed" ? 1 : 0, signal: null }));
    }

    runs.updateLifecycle(run.id, {
      outcome: body.outcome,
      outcome_state: body.outcome === "completed" ? "succeeded" : body.outcome === "failed" ? "failed" : "unknown",
      ended_at: run.ended_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    const updated = applyManualRunReview(runs.get(run.id)!, body.outcome, body.summary, body.notes, body.reviewed_by);
    if (updated?.origin.type === "plan" && updated.origin.assignment) {
      plans.updateAssignmentStatusForRun(updated.origin.assignment, body.outcome === "completed" ? "satisfied" : "blocked", updated.id);
    }
    return { run: updated };
  });

  app.post("/runs/:id/review", async (request, reply) => {
    const params = request.params as { id: string };
    const body = z
      .object({
        outcome: z.enum(["completed", "failed", "stopped"]),
        summary: z.string().optional(),
        notes: z.string().optional(),
        reviewed_by: z.string().optional()
      })
      .parse(request.body);
    const run = runs.get(params.id);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }
    if (run.status !== "finished") {
      return reply.code(409).send({ error: "run_not_finished", status: run.status });
    }

    const reviewedAt = new Date().toISOString();
    const result = {
      ...run.result,
      summary: body.summary ?? run.result.summary,
      reviewed_by: body.reviewed_by ?? "operator",
      reviewed_at: reviewedAt,
      notes: body.notes ?? run.result.notes
    };
    runs.updateLifecycle(run.id, { outcome: body.outcome });
    runs.updateResult(run.id, result);
    logs.append(
      run.id,
      {
        type: "run_reviewed",
        outcome: body.outcome,
        summary: result.summary,
        notes: result.notes,
        reviewed_by: result.reviewed_by,
        reviewed_at: reviewedAt
      },
      "audit"
    );

    const updated = runs.get(run.id);
    if (updated?.origin.type === "plan" && updated.origin.assignment) {
      plans.updateAssignmentStatusForRun(updated.origin.assignment, body.outcome === "completed" ? "satisfied" : "blocked", updated.id);
    }
    return { run: updated };
  });

  function applyManualRunReview(
    run: RunRecord,
    outcome: "completed" | "failed" | "stopped",
    summary?: string,
    notes?: string,
    reviewedBy?: string
  ): RunRecord {
    const reviewedAt = new Date().toISOString();
    const result = {
      ...run.result,
      summary: summary ?? run.result.summary,
      reviewed_by: reviewedBy ?? "operator",
      reviewed_at: reviewedAt,
      notes: notes ?? run.result.notes
    };
    runs.updateLifecycle(run.id, { outcome });
    runs.updateResult(run.id, result);
    logs.append(
      run.id,
      {
        type: "run_closed",
        outcome,
        summary: result.summary,
        notes: result.notes,
        reviewed_by: result.reviewed_by,
        reviewed_at: reviewedAt
      },
      "audit"
    );

    return runs.get(run.id)!;
  }

  function closeHitlThread(run: RunRecord, closeReason: RunCloseReason): RunRecord {
    const now = new Date().toISOString();
    const outcomeState =
      closeReason === "user_marked_resolved" ? "succeeded" : closeReason === "user_abandoned" ? "abandoned" : closeReason === "error" ? "failed" : "unknown";
    const outcome =
      closeReason === "user_marked_resolved" ? "completed" : closeReason === "user_abandoned" ? "stopped" : closeReason === "error" ? "failed" : "unknown";

    runs.updateLifecycle(run.id, {
      status: "finished",
      process_status: closeReason === "system_cancelled" ? "killed" : "exited",
      outcome,
      runtime_state: closeReason === "error" ? "failed" : closeReason === "system_cancelled" ? "cancelled" : "closed",
      outcome_state: outcomeState,
      close_reason: closeReason,
      closed_at: now,
      ended_at: now,
      updated_at: now
    });
    logs.append(
      run.id,
      {
        type: "hitl_thread_closed",
        close_reason: closeReason,
        runtime_state: closeReason === "error" ? "failed" : closeReason === "system_cancelled" ? "cancelled" : "closed",
        outcome_state: outcomeState,
        closed_at: now
      },
      "audit"
    );
    eventBus.publish(run.id, "state_change", {
      run_id: run.id,
      runtime_state: closeReason === "error" ? "failed" : closeReason === "system_cancelled" ? "cancelled" : "closed",
      outcome_state: outcomeState,
      close_reason: closeReason
    });
    eventBus.publish(run.id, "system_message", {
      run_id: run.id,
      author_type: "system",
      content: `Thread closed (${closeReason}).`
    });
    return runs.get(run.id)!;
  }

  app.post("/tools/:name", async (request, reply) => {
    const params = request.params as { name: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const runId = getRunIdFromToolRequest(request.headers, body);
    const token = getRunTokenFromToolRequest(request.headers, body);

    if (!runId) {
      return reply.code(400).send({ error: "run_id_required" });
    }

    const runTokenAuthorized = !!token && runManager.isRunTokenAuthorized(runId, token);
    if (!auth.authorizeHeader(request.headers.authorization) && !runTokenAuthorized) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    try {
      if (runTokenAuthorized) {
        runManager.noteRunActivity(runId, `tool:${params.name}`);
      }
      return invokeTool(tools, params.name, runId, body);
    } catch (error) {
      return reply.code(400).send({ error: "tool_failed", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/logs", async (request) => {
    const query = request.query as { run_id: string };
    return { logs: logs.list(query.run_id) };
  });

  app.post("/artifacts", async (request, reply) => {
    const body = z
      .object({
        run_id: z.string().min(1),
        type: z.enum([
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
        ]),
        path: z.string().optional(),
        title: z.string().optional(),
        summary: z.string().optional()
      })
      .parse(request.body);
    const run = runs.get(body.run_id);
    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    return {
      artifact: artifacts.register({
        monde_id: run.monde_id,
        mon_id: run.mon_id,
        run_id: run.id,
        type: body.type,
        path: body.path,
        title: body.title,
        summary: body.summary
      })
    };
  });

  app.get("/artifacts", async (request) => {
    const query = request.query as { monde_id?: string; run_id?: string; mon_id?: string };
    return { artifacts: artifacts.list({ mondeId: query.monde_id, runId: query.run_id, monId: query.mon_id }) };
  });

  app.get("/artifacts/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const artifact = artifacts.get(params.id);
    if (!artifact) {
      return reply.code(404).send({ error: "artifact_not_found" });
    }

    return { artifact, ...readArtifactExcerpt(artifact.path) };
  });
}

function readArtifactExcerpt(pathValue: string | null | undefined): Record<string, unknown> {
  if (!pathValue) {
    return { content_available: false };
  }

  try {
    const stat = fs.statSync(pathValue);
    if (!stat.isFile()) {
      return { content_available: false, content_reason: "not_a_file", size: stat.size };
    }

    const maxBytes = 48 * 1024;
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const fd = fs.openSync(pathValue, "r");
    try {
      fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }

    if (buffer.includes(0)) {
      return { content_available: false, content_reason: "binary", size: stat.size };
    }

    return {
      content_available: true,
      content_excerpt: buffer.toString("utf8"),
      content_truncated: stat.size > maxBytes,
      size: stat.size
    };
  } catch (error) {
    return {
      content_available: false,
      content_reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function backupInfo(): BackupInfoDto {
  const paths = getPlatformPaths();
  return {
    db_path: paths.dbPath,
    token_path: paths.tokenPath,
    backup_directory: backupDir(paths.dataDir),
    latest_backup: listBackups().at(-1)?.backup_path ?? null,
    continuity_warning: "Operational continuity depends on the local SQLite DB.",
    future_recovery_path: "export/import or backup/restore"
  };
}

function listBackups(): BackupMetadataDto[] {
  const paths = getPlatformPaths();
  const dir = backupDir(paths.dataDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".sqlite"))
    .map((entry) => path.join(dir, entry))
    .sort()
    .map((backupPath) => {
      const metadataPath = `${backupPath}.json`;
      if (fs.existsSync(metadataPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as BackupMetadataDto;
          return parsed.backup_path ? parsed : { ...parsed, backup_path: backupPath };
        } catch {
          // Fall through to filesystem metadata.
        }
      }

      const stat = fs.statSync(backupPath);
      return {
        created_at: stat.mtime.toISOString(),
        db_path: paths.dbPath,
        backup_path: backupPath,
        schema_version: "unknown",
        size: stat.size
      };
    });
}

function serviceDoctorFindings(): DoctorFindingDto[] {
  const paths = getPlatformPaths();
  const findings: DoctorFindingDto[] = [
    { level: "ok", message: `Service reachable. DB path: ${paths.dbPath} schema: ${schemaVersion}` },
    { level: "ok", message: `Backup directory: ${backupDir(paths.dataDir)}` },
    {
      level: listBackups().length ? "ok" : "warn",
      message: `Latest backup: ${listBackups().at(-1)?.backup_path ?? "none"}`
    }
  ];

  if (fs.existsSync(paths.tokenPath)) {
    const mode = fs.statSync(paths.tokenPath).mode & 0o777;
    findings.push({
      level: mode & 0o077 ? "warn" : "ok",
      message: `Service token file exists with mode ${mode.toString(8)}.`
    });
  } else {
    findings.push({ level: "warn", message: `Service token file is missing at ${paths.tokenPath}.` });
  }

  for (const adapter of harnessAdapters) {
    const detection = adapter.detect();
    findings.push({
      level: detection.available ? "ok" : adapter.id === "basic-process" ? "error" : "warn",
      message: `${adapter.label}: adapter=${detection.adapter_status} mcp=${detection.mcp_status} prompt=${detection.prompt_injection_status} ${detection.reason ?? detection.version ?? ""}`
    });
  }

  return findings;
}

function backupDir(dataDir: string): string {
  return path.join(dataDir, "backups");
}

function operatorRunExecution(harness?: string, sandboxMode?: string): Record<string, unknown> {
  const execution: Record<string, unknown> = {};
  if (harness) {
    execution.harness_override = harness;
  }
  if (sandboxMode) {
    execution.sandbox_mode = sandboxMode;
  }

  return execution;
}

function createHitlThreadRun(
  mondeId: string,
  monId: string,
  title: string,
  context: Record<string, unknown> | undefined
): RunRecord {
  const now = new Date().toISOString();
  return {
    id: `run_${nanoid(10)}`,
    monde_id: mondeId,
    mon_id: monId,
    status: "active",
    process_status: "running",
    outcome: "unknown",
    interaction_mode: "hitl_thread",
    runtime_state: "idle_open",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "operator", label: "Bottom mon chat" },
    intent: {
      title,
      prompt: `Human-in-the-loop chat thread with ${monId}.`
    },
    execution: {
      input_mode: "open",
      output_mode: "plain",
      thread_surface: "bottom_rail",
      context: context ?? {}
    },
    result: {},
    created_at: now,
    updated_at: now,
    opened_at: now
  };
}

function createOperatorRun(
  mondeId: string,
  monId: string,
  prompt: string,
  title?: string,
  harness?: string,
  sandboxMode?: string
): RunRecord {
  const now = new Date().toISOString();
  return {
    id: `run_${nanoid(10)}`,
    monde_id: mondeId,
    mon_id: monId,
    status: "queued",
    process_status: "not_started",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "queued",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "operator", label: "Direct operator message" },
    intent: {
      title: title ?? prompt.slice(0, 80),
      prompt
    },
    execution: operatorRunExecution(harness, sandboxMode),
    result: {},
    created_at: now,
    updated_at: now
  };
}

function createExternalRun(body: {
  integration_id: string;
  external_execution_key: string;
  monde_id: string;
  mon_id: string;
  input: { kind: "prompt"; prompt: string };
  harness_override?: string;
}): RunRecord {
  const now = new Date().toISOString();
  return {
    id: `run_${nanoid(10)}`,
    monde_id: body.monde_id,
    mon_id: body.mon_id,
    status: "queued",
    process_status: "not_started",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "queued",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: {
      type: "system",
      label: `external:${body.integration_id}:${body.external_execution_key}`
    },
    intent: {
      title: `External execution ${body.external_execution_key}`,
      prompt: body.input.prompt
    },
    execution: {
      externally_managed: true,
      integration_id: body.integration_id,
      external_execution_key: body.external_execution_key,
      ...(body.harness_override ? { harness_override: body.harness_override } : {})
    },
    result: {},
    created_at: now,
    updated_at: now
  };
}

function assertCanonicalSize(value: unknown, maxBytes: number, label: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? "");
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  }
}

function isOpenThreadRuntimeState(runtimeState: string): boolean {
  return runtimeState === "queued" || runtimeState === "running" || runtimeState === "waiting_for_user" || runtimeState === "idle_open";
}

function runInputMode(run: RunRecord): string {
  if (typeof run.execution?.input_mode === "string") {
    return run.execution.input_mode;
  }

  const terminal = isRecord(run.execution?.terminal) ? run.execution.terminal : {};
  if (terminal.stdin === true || terminal.stdin_mode === "pipe") {
    return "open";
  }

  return "closed";
}

function runInteractionMode(run: RunRecord): string {
  if (typeof run.execution?.interaction_mode === "string") {
    return run.execution.interaction_mode;
  }

  return runInputMode(run) === "open" ? "interactive" : "single-shot";
}

export function registerMcpRoutes(app: FastifyInstance, deps: Pick<RouteDeps, "auth" | "runManager" | "tools">): void {
  app.post("/mcp", async (request, reply) => {
    if (request.headers.origin && process.env.MONDE_ALLOW_BROWSER_MCP !== "1") {
      return reply.code(403).send({ error: "browser_origin_rejected" });
    }

    const body = request.body as unknown;
    if (Array.isArray(body)) {
      const responses = body
        .map((message) => handleMcpMessage(deps, request.headers, asRecord(message)))
        .filter((response) => response !== undefined);
      return responses.length > 0 ? responses : reply.code(204).send();
    }

    const response = handleMcpMessage(deps, request.headers, asRecord(body));
    return response ?? reply.code(204).send();
  });
}

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function handleMcpMessage(
  deps: Pick<RouteDeps, "auth" | "runManager" | "tools">,
  headers: Record<string, unknown>,
  body: Record<string, unknown>
): JsonRpcResponse | Record<string, unknown> | undefined {
  if (body.jsonrpc !== "2.0") {
    return handleLegacyMcpToolCall(deps, headers, body);
  }

  const id = typeof body.id === "string" || typeof body.id === "number" || body.id === null ? body.id : null;
  try {
    const runId = getRunIdFromMcpRequest(headers, body);
    const token = getRunTokenFromMcpRequest(headers, body);
    if (!runId) {
      throw mcpError(-32602, "MONDE_RUN_ID or run_id is required for MCP requests.");
    }

    if (!token || !deps.runManager.isRunTokenAuthorized(runId, token)) {
      throw mcpError(-32001, "MCP request is not authorized for this run.");
    }

    const method = typeof body.method === "string" ? body.method : "";
    deps.runManager.noteRunActivity(runId, `mcp:${method || "unknown"}`);
    if (method === "notifications/initialized") {
      return undefined;
    }

    if (method === "initialize") {
      const requestedVersion = typeof asRecord(body.params).protocolVersion === "string"
        ? String(asRecord(body.params).protocolVersion)
        : "2025-08-07";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requestedVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "monde", version: "0.0.0" }
        }
      };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: mcpToolDefinitions } };
    }

    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }

    if (method === "resources/templates/list") {
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    }

    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }

    if (method === "tools/call") {
      const params = asRecord(body.params);
      const name = typeof params.name === "string" ? params.name : undefined;
      const args = asRecord(params.arguments);
      if (!name) {
        throw mcpError(-32602, "tools/call requires params.name.");
      }

      deps.runManager.noteRunActivity(runId, `tool:${name}`);
      const result = invokeTool(deps.tools, name, runId, args);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false
        }
      };
    }

    throw mcpError(-32601, `Unknown MCP method: ${method}`);
  } catch (error) {
    const known = isMcpError(error) ? error : mcpError(-32000, error instanceof Error ? error.message : String(error));
    return { jsonrpc: "2.0", id, error: known };
  }
}

function handleLegacyMcpToolCall(
  deps: Pick<RouteDeps, "auth" | "runManager" | "tools">,
  headers: Record<string, unknown>,
  body: Record<string, unknown>
): Record<string, unknown> {
  const toolName =
    typeof body.tool === "string"
      ? body.tool
      : typeof body.name === "string"
        ? body.name
        : typeof asRecord(body.params).name === "string"
          ? String(asRecord(body.params).name)
          : undefined;
  const args =
    typeof body.arguments === "object" && body.arguments
      ? (body.arguments as Record<string, unknown>)
      : typeof asRecord(body.params).arguments === "object"
        ? asRecord(asRecord(body.params).arguments)
        : body;
  const runId = getRunIdFromToolRequest(headers, args);
  const token = getRunTokenFromToolRequest(headers, args);

  if (!toolName || !runId) {
    return { error: "tool_and_run_id_required" };
  }

  if (!token || !deps.runManager.isRunTokenAuthorized(runId, token)) {
    return { error: "unauthorized" };
  }

  try {
    deps.runManager.noteRunActivity(runId, `tool:${toolName}`);
    return { result: invokeTool(deps.tools, toolName, runId, args) };
  } catch (error) {
    return { error: "tool_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

const mcpToolDefinitions = [
  toolDefinition("runtime_scope", "Return the run-scoped Monde, mon, lifecycle, warnings, and scope snapshot.", {}),
  toolDefinition("search_docs", "Search .monde/docs with ripgrep snippets.", {
    query: { type: "string" }
  }, ["query"]),
  toolDefinition("list_plans", "List plans in the current run's Monde.", {}),
  toolDefinition("get_plan", "Get one plan in the current run's Monde.", {
    plan_id: { type: "string" }
  }, ["plan_id"]),
  toolDefinition("search_plans", "Search plans in the current run's Monde.", {
    query: { type: "string" }
  }, ["query"]),
  toolDefinition("list_runs", "List runs in the current run's Monde.", {
    status: { type: "string" },
    origin_type: { type: "string" },
    mon_id: { type: "string" }
  }),
  toolDefinition("get_run", "Get a run in the current run's Monde.", {
    run_id: { type: "string" }
  }),
  toolDefinition("write_log", "Append a typed log event to the run.", {
    entry: {
      type: "object",
      description: "Log payload. Use event_type/type decision, milestone, observation, error, tool_call, artifact_registered, warning_added, review, or audit.",
      properties: {
        event_type: { type: "string" },
        type: { type: "string" },
        message: { type: "string" },
        summary: { type: "string" }
      }
    },
    run_id: { type: "string" }
  }, ["entry"]),
  toolDefinition("register_artifact", "Register a path-referenced artifact for the run.", {
    path: { type: "string" },
    type: {
      type: "string",
      enum: ["file", "note", "diff", "report", "schema", "test_suite", "screenshot", "generated_asset", "prompt_pack", "other"]
    },
    title: { type: "string" },
    run_id: { type: "string" },
    summary: { type: "string" }
  }, ["type"]),
  toolDefinition("list_artifacts", "List artifacts in the current run's Monde.", {
    run_id: { type: "string" },
    mon_id: { type: "string" }
  }),
  toolDefinition("get_artifact", "Get one artifact in the current run's Monde.", {
    artifact_id: { type: "string" }
  }, ["artifact_id"])
];

function toolDefinition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required
    }
  };
}

function getRunIdFromMcpRequest(headers: Record<string, unknown>, body: Record<string, unknown>): string | undefined {
  const params = asRecord(body.params);
  return (
    getRunIdFromToolRequest(headers, params) ??
    getRunIdFromToolRequest(headers, asRecord(params.arguments)) ??
    getRunIdFromToolRequest(headers, body)
  );
}

function getRunTokenFromMcpRequest(headers: Record<string, unknown>, body: Record<string, unknown>): string | undefined {
  const params = asRecord(body.params);
  return (
    getRunTokenFromToolRequest(headers, params) ??
    getRunTokenFromToolRequest(headers, asRecord(params.arguments)) ??
    getRunTokenFromToolRequest(headers, body)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpError(code: number, message: string, data?: unknown): { code: number; message: string; data?: unknown } {
  return { code, message, data };
}

function isMcpError(value: unknown): value is { code: number; message: string; data?: unknown } {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "number";
}

function writeSse(raw: NodeJS.WritableStream, eventName: string, data: unknown): void {
  raw.write(`event: ${eventName}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function getRunIdFromToolRequest(headers: Record<string, unknown>, body: Record<string, unknown>): string | undefined {
  const header = headers["x-monde-run-id"];
  return typeof header === "string" ? header : typeof body.run_id === "string" ? body.run_id : undefined;
}

function getRunTokenFromToolRequest(headers: Record<string, unknown>, body: Record<string, unknown>): string | undefined {
  const header = headers["x-monde-run-token"];
  if (typeof header === "string") {
    return header;
  }

  if (typeof body.run_token === "string") {
    return body.run_token;
  }

  const authorization = headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
}

function invokeTool(tools: ToolHandlers, name: string, runId: string, body: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "runtime_scope":
      return tools.runtimeScope(runId);
    case "search_docs":
      return tools.searchDocs(runId, String(body.query ?? ""));
    case "list_plans":
      return tools.listPlans(runId);
    case "get_plan":
      if (typeof body.plan_id !== "string") {
        throw new Error("plan_id is required");
      }
      return tools.getPlan(runId, body.plan_id);
    case "search_plans":
      return tools.searchPlans(runId, String(body.query ?? ""));
    case "get_run":
      return tools.getRun(runId, typeof body.run_id === "string" ? body.run_id : runId);
    case "list_runs":
      return tools.listRuns(runId, {
        monde_id: typeof body.monde_id === "string" ? body.monde_id : undefined,
        mon_id: typeof body.mon_id === "string" ? body.mon_id : undefined,
        status: typeof body.status === "string" ? body.status : undefined,
        origin_type: typeof body.origin_type === "string" ? body.origin_type : undefined
      });
    case "write_log":
      return tools.writeLog(runId, (body.entry as Record<string, unknown> | undefined) ?? body);
    case "register_artifact":
      return tools.registerArtifact(runId, {
        path: typeof body.path === "string" ? body.path : undefined,
        type: typeof body.type === "string" && artifactTypes.has(body.type) ? body.type : "other",
        title: typeof body.title === "string" ? body.title : undefined,
        summary: typeof body.summary === "string" ? body.summary : undefined
      });
    case "list_artifacts":
      return tools.listArtifacts(runId, {
        run_id: typeof body.run_id === "string" ? body.run_id : undefined,
        mon_id: typeof body.mon_id === "string" ? body.mon_id : undefined
      });
    case "get_artifact":
      if (typeof body.artifact_id !== "string") {
        throw new Error("artifact_id is required");
      }
      return tools.getArtifact(runId, body.artifact_id);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

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
