import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";
import {
  buildIsolatedStdioLaunch,
  codexAdapter,
  type ExternalMcpRuntime
} from "@monde/adapters";
import { canonicalJson, MonConfigSchema } from "@monde/core";
import type {
  HarnessRunner,
  RunningProcess,
  StartRunInput
} from "../packages/service/src/basic-process-runner.ts";
import { migrateDatabase } from "../packages/service/src/db.ts";
import { ArtifactRepository } from "../packages/service/src/repositories/artifacts.ts";
import { CronScheduleRepository } from "../packages/service/src/repositories/cron-schedules.ts";
import { ExecutionManifestRepository } from "../packages/service/src/repositories/execution-manifests.ts";
import { ExternalExecutionRepository } from "../packages/service/src/repositories/external-executions.ts";
import { ExternalMcpGrantRepository } from "../packages/service/src/repositories/external-mcp-grants.ts";
import { LogRepository } from "../packages/service/src/repositories/logs.ts";
import { MonRepository } from "../packages/service/src/repositories/mons.ts";
import { MondeRepository } from "../packages/service/src/repositories/mondes.ts";
import { PlanRepository } from "../packages/service/src/repositories/plans.ts";
import { ProcessSlotRepository } from "../packages/service/src/repositories/process-slots.ts";
import { RunAttemptRepository } from "../packages/service/src/repositories/run-attempts.ts";
import { RunEventRepository } from "../packages/service/src/repositories/run-events.ts";
import { RunWorkspaceRepository } from "../packages/service/src/repositories/run-workspaces.ts";
import { RunRepository } from "../packages/service/src/repositories/runs.ts";
import { registerRoutes } from "../packages/service/src/routes.ts";
import { RunEventBus } from "../packages/service/src/run-events.ts";
import { RunManager } from "../packages/service/src/run-manager.ts";
import { ToolHandlers } from "../packages/service/src/tools.ts";

class ControlledRunner implements HarnessRunner {
  readonly inputs: StartRunInput[] = [];
  readonly signals: NodeJS.Signals[][] = [];

  async startRun(input: StartRunInput): Promise<RunningProcess> {
    const index = this.inputs.length;
    this.inputs.push(input);
    this.signals.push([]);
    input.onSpawn?.(7000 + index);
    return {
      runId: input.runId,
      pid: 7000 + index,
      runnerType: "basic-process",
      write() {},
      kill: (signal = "SIGTERM") => {
        this.signals[index].push(signal);
      }
    };
  }

  exit(index: number, exit: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.inputs[index]?.onExit(exit);
  }
}

function fixture(
  t: test.TestContext,
  options: {
    isolatedCodex?: boolean;
    retryPolicy?: {
      max_attempts: number;
      initial_backoff_seconds: number;
      backoff_multiplier: number;
      max_backoff_seconds: number;
      kill_grace_seconds: number;
      retryable_conditions: string[];
      attempt_timeout_seconds?: number;
    };
    clock?: ManualClock;
  } = {}
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-integration-run-"));
  const mondeRoot = path.join(tempRoot, "world");
  const docsRoot = path.join(mondeRoot, ".monde", "docs");
  const monRoot = path.join(mondeRoot, "worker.mon");
  fs.mkdirSync(docsRoot, { recursive: true });
  fs.mkdirSync(monRoot, { recursive: true });
  fs.writeFileSync(path.join(monRoot, "SOUL.md"), "stable worker identity\n");
  fs.writeFileSync(
    path.join(mondeRoot, ".monde", "monde.json"),
    JSON.stringify({
      id: "local",
      name: "Local",
      version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      root: mondeRoot,
      docs: docsRoot
    })
  );
  fs.writeFileSync(
    path.join(monRoot, "mon.json"),
    JSON.stringify(
      MonConfigSchema.parse({
        id: "worker",
        name: "Worker",
        role: "execution actor",
        version: 1,
        default_harness: options.isolatedCodex ? "codex" : "basic-process",
        default_model: null,
        work_root: ".",
        max_active_runs: options.isolatedCodex ? 2 : 1,
        ...(options.retryPolicy ? { retry_policy: options.retryPolicy } : {}),
        run_workspace: options.isolatedCodex
          ? { mode: "isolated", recovery_window_seconds: 86400 }
          : { mode: "shared" },
        actor_context: options.isolatedCodex
          ? [{ root: "mon", path: "SOUL.md" }]
          : [],
        read_mounts: [],
        external_mcp_servers: options.isolatedCodex
          ? [
              {
                id: "domain",
                transport: "stdio",
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
                actor_context_access: true,
                scratch_access: "write",
                auth: {
                  type: "run_claims",
                  audience: "domain",
                  token_env_var: "DOMAIN_RUN_TOKEN"
                }
              }
            ]
          : [],
        capabilities: [],
        created_at: "2026-01-01T00:00:00.000Z"
      })
    )
  );

  const db = new DatabaseSync(":memory:");
  migrateDatabase(db);
  const mondes = new MondeRepository(db);
  const mons = new MonRepository(db);
  const runs = new RunRepository(db);
  const plans = new PlanRepository(db);
  const logs = new LogRepository(db);
  const artifacts = new ArtifactRepository(db);
  const cronSchedules = new CronScheduleRepository(db);
  const externalExecutions = new ExternalExecutionRepository(db);
  const externalMcpGrants = new ExternalMcpGrantRepository(db);
  const executionManifests = new ExecutionManifestRepository(db);
  const processSlots = new ProcessSlotRepository(db);
  const runEvents = new RunEventRepository(db);
  const runAttempts = new RunAttemptRepository(db);
  const runWorkspaces = new RunWorkspaceRepository(db);
  const eventBus = new RunEventBus(runEvents);
  const runner = new ControlledRunner();
  mondes.upsert({ id: "local", name: "Local", root: mondeRoot, docs: docsRoot });
  mons.upsert({
    id: "worker",
    monde_id: "local",
    name: "Worker",
    role: "execution actor",
    mon_root: monRoot,
    work_root: monRoot,
    default_harness: options.isolatedCodex ? "codex" : "basic-process",
    default_model: null,
    capabilities: []
  });
  const manager = new RunManager({
    mondes,
    externalExecutions,
    externalMcpGrants,
    executionManifests,
    mons,
    plans,
    processSlots,
    runAttempts,
    runs,
    runWorkspaces,
    logs,
    artifacts,
    events: eventBus,
    runner,
    clock: options.clock,
    config: {
      serviceAddr: "http://127.0.0.1:3761",
      mcpAddr: "http://127.0.0.1:3762/mcp",
      dataDir: path.join(tempRoot, "data")
    }
  });
  const app = Fastify();
  registerRoutes(app, {
    database: { db, close() {} },
    auth: {
      token: "test",
      authorizeHeader: () => true,
      authorizeToken: () => true
    },
    mondes,
    cronSchedules,
    externalExecutions,
    externalMcpGrants,
    executionManifests,
    mons,
    plans,
    runs,
    runAttempts,
    runEvents,
    eventBus,
    runManager: manager,
    tools: new ToolHandlers({ runs, plans, logs, artifacts })
  });

  t.after(async () => {
    await app.close();
    db.close();
    makeWritable(tempRoot);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return {
    app,
    cronSchedules,
    executionManifests,
    externalExecutions,
    externalMcpGrants,
    runner,
    runs,
    runAttempts,
    manager
  };
}

class ManualClock {
  private value = Date.parse("2026-01-01T00:00:00.000Z");
  private readonly timers = new Set<{
    callback: () => void;
    at: number;
    unref(): void;
  }>();

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }

  fireDue(): void {
    const due = [...this.timers]
      .filter((timer) => timer.at <= this.value)
      .sort((left, right) => left.at - right.at);
    for (const timer of due) {
      this.timers.delete(timer);
      timer.callback();
    }
  }

  setTimeout(
    callback: () => void,
    delayMs: number
  ): { unref(): void } {
    const timer = {
      callback,
      at: this.value + delayMs,
      unref() {}
    };
    this.timers.add(timer);
    return timer;
  }

  clearTimeout(timer: { unref(): void }): void {
    this.timers.delete(
      timer as { callback: () => void; at: number; unref(): void }
    );
  }
}

function makeWritable(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o700);
    for (const entry of fs.readdirSync(target)) {
      makeWritable(path.join(target, entry));
    }
  } else if (stat.isFile()) {
    fs.chmodSync(target, 0o600);
  }
}

test("integration start is idempotent, forwards one opaque packet, and succeeds on process exit", async (t) => {
  const { app, executionManifests, externalExecutions, runner, runs } = fixture(t);
  const contextPacket = {
    schema: { id: "example.run-context", version: "1" },
    execution: { executionKey: "queue-1:1", correlationId: "correlation-1" },
    scope: { kind: "system" },
    objective: "Execute the claimed work.",
    toolProfile: "worker"
  };
  const request = {
    execution_key: "queue-1:1",
    mon_id: "worker",
    context_packet: contextPacket
  };
  const responses = await Promise.all(
    Array.from({ length: 20 }, () =>
      app.inject({
        method: "POST",
        url: "/mondes/local/integrations/example/runs",
        payload: request
      })
    )
  );

  assert.equal(responses.filter((response) => response.statusCode === 201).length, 1);
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 19);
  assert.equal(new Set(responses.map((response) => response.json().snapshot.run_id)).size, 1);
  assert.equal(runner.inputs.length, 1);

  const execution = externalExecutions.getByKey("example", "queue-1:1");
  assert.ok(execution);
  assert.equal(execution.completion_policy, "process_exit");
  assert.deepEqual(execution.external_context, contextPacket);
  assert.equal(execution.external_scope, null);
  assert.equal(execution.artifact_sink_ref, undefined);
  assert.equal(execution.external_lineage, undefined);
  assert.match(runner.inputs[0].prompt, /forwards the following bounded context packet opaquely/);
  assert.ok(runner.inputs[0].prompt.includes(canonicalJson(contextPacket)));

  runner.exit(0, { code: 0, signal: null });
  const inspection = await app.inject({
    method: "GET",
    url: "/mondes/local/integrations/example/runs/queue-1%3A1"
  });
  assert.equal(inspection.statusCode, 200);
  assert.equal(inspection.json().snapshot.status, "succeeded");
  assert.equal(runs.get(execution.run_id)?.outcome, "completed");
  assert.equal(executionManifests.getByExecution(execution.id), undefined);
  assert.equal(externalExecutions.get(execution.id)?.completion_received_at, null);

  const conflict = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/runs",
    payload: {
      ...request,
      context_packet: { ...contextPacket, objective: "Different work." }
    }
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, "digest_conflict");
  assert.equal(runner.inputs.length, 1);
});

test("startup recovery dispatches persisted queued runs", async (t) => {
  const { manager, runner, runs } = fixture(t);
  runs.insert({
    id: "run_persisted_queue",
    monde_id: "local",
    mon_id: "worker",
    status: "queued",
    process_status: "not_started",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "queued",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "system", label: "restart recovery" },
    intent: {
      title: "Persisted work",
      prompt: "Resume this queued run after restart."
    },
    execution: {},
    result: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  });

  const started = await manager.resumeQueuedRunsOnStartup();
  assert.deepEqual(started.map((run) => run.id), ["run_persisted_queue"]);
  assert.equal(runner.inputs.length, 1);
});

test("integration cancellation persists intent and becomes acknowledged on process exit", async (t) => {
  const { app, externalExecutions, runner } = fixture(t);
  const started = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/runs",
    payload: {
      execution_key: "queue-2:1",
      mon_id: "worker",
      context_packet: {
        schema: { id: "example.run-context", version: "1" },
        objective: "Wait for cancellation."
      }
    }
  });
  assert.equal(started.statusCode, 201);

  const cancellation = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/runs/queue-2%3A1/cancel"
  });
  assert.equal(cancellation.statusCode, 200);
  assert.equal(cancellation.json().snapshot.status, "running");
  assert.deepEqual(runner.signals[0], ["SIGTERM"]);
  const requested = externalExecutions.getByKey("example", "queue-2:1");
  assert.equal(requested?.phase, "cancelling");
  assert.equal(requested?.cancellation_state, "signalled");

  runner.exit(0, { code: null, signal: "SIGTERM" });
  const inspection = await app.inject({
    method: "GET",
    url: "/mondes/local/integrations/example/runs/queue-2%3A1"
  });
  assert.equal(inspection.json().snapshot.status, "cancelled");
  const acknowledged = externalExecutions.getByKey("example", "queue-2:1");
  assert.equal(acknowledged?.cancellation_state, "acknowledged");
  assert.ok(acknowledged?.cancellation_requested_at);
  assert.ok(acknowledged?.cancellation_acknowledged_at);
});

test("integration schedule registration is idempotent and fires on the stable run path", async (t) => {
  const { app, cronSchedules, manager, runner } = fixture(t);
  const payload = {
    schedule_key: "persona-review",
    mon_id: "worker",
    name: "Persona review",
    expression: "* * * * *",
    timezone: "UTC",
    title: "Review persona",
    context_packet: {
      schema: { id: "example.scheduled-context", version: "1" },
      scheduleKey: "persona-review",
      scope: { kind: "persona", personaId: "persona-1" },
      objective: "Review this persona."
    }
  };
  const first = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/schedules",
    payload
  });
  const replay = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/schedules",
    payload
  });
  assert.equal(first.statusCode, 201);
  assert.equal(replay.statusCode, 200);
  assert.equal(first.json().schedule.id, replay.json().schedule.id);

  const conflict = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/schedules",
    payload: {
      ...payload,
      context_packet: {
        ...payload.context_packet,
        objective: "Different objective."
      }
    }
  });
  assert.equal(conflict.statusCode, 409);

  const scheduledFireTime = first.json().schedule.next_fire_at as string;
  const [fire] = cronSchedules.tick(scheduledFireTime);
  await manager.dispatchQueuedForMon("local", "worker");
  assert.equal(runner.inputs.length, 1);
  assert.equal(
    fire.external_execution?.external_execution_key,
    `persona-review:${scheduledFireTime}`
  );
  runner.inputs[0].onStdout("scheduled review completed\n");
  runner.exit(0, { code: 0, signal: null });
  const inspection = await app.inject({
    method: "GET",
    url:
      "/mondes/local/integrations/example/runs/" +
      encodeURIComponent(`persona-review:${scheduledFireTime}`)
  });
  assert.equal(inspection.json().snapshot.status, "succeeded");
});

test("generic retries keep one logical run and expose durable process attempts", async (t) => {
  const clock = new ManualClock();
  const { app, externalExecutions, manager, runAttempts, runner } = fixture(t, {
    clock,
    retryPolicy: {
      max_attempts: 2,
      initial_backoff_seconds: 30,
      backoff_multiplier: 2,
      max_backoff_seconds: 120,
      kill_grace_seconds: 5,
      retryable_conditions: ["process_exit_nonzero"]
    }
  });
  const started = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/runs",
    payload: {
      execution_key: "queue-retry:1",
      mon_id: "worker",
      context_packet: {
        schema: { id: "example.run-context", version: "1" },
        objective: "Retry generic harness failure."
      }
    }
  });
  assert.equal(started.statusCode, 201);
  const runId = started.json().snapshot.run_id as string;

  runner.exit(0, { code: 17, signal: null });
  const waiting = await app.inject({
    method: "GET",
    url: "/mondes/local/integrations/example/runs/queue-retry%3A1"
  });
  assert.equal(waiting.json().snapshot.status, "pending");
  assert.equal(waiting.json().snapshot.process_attempt, 1);
  assert.equal(
    waiting.json().snapshot.retry_condition,
    "process_exit_nonzero"
  );
  assert.equal(externalExecutions.getByKey("example", "queue-retry:1")?.run_id, runId);
  const earlyStart = await manager.startRun(runId);
  assert.equal(earlyStart.started, false);
  assert.equal(runner.inputs.length, 1);

  clock.advance(30_000);
  await manager.dispatchDueRetries();
  assert.equal(runner.inputs.length, 2);
  runner.inputs[1].onStdout("meaningful harness activity\n");
  runner.exit(1, { code: 0, signal: null });

  const finished = await app.inject({
    method: "GET",
    url: "/mondes/local/integrations/example/runs/queue-retry%3A1"
  });
  assert.equal(finished.json().snapshot.status, "succeeded");
  assert.equal(finished.json().snapshot.run_id, runId);
  assert.deepEqual(
    runAttempts.list(runId).map((attempt) => [
      attempt.attempt_number,
      attempt.status,
      attempt.condition
    ]),
    [
      [1, "failed", "process_exit_nonzero"],
      [2, "succeeded", null]
    ]
  );
  const evidence = await app.inject({
    method: "GET",
    url: `/runs/${runId}/attempts`
  });
  assert.equal(evidence.statusCode, 200);
  assert.equal(evidence.json().attempts.length, 2);
});

test("observed no-op and credential expiry are opt-in generic retry conditions", async (t) => {
  const clock = new ManualClock();
  const { app, manager, runner } = fixture(t, {
    clock,
    retryPolicy: {
      max_attempts: 3,
      initial_backoff_seconds: 1,
      backoff_multiplier: 1,
      max_backoff_seconds: 1,
      kill_grace_seconds: 5,
      retryable_conditions: ["harness_noop", "credential_expired"]
    }
  });
  const started = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/runs",
    payload: {
      execution_key: "queue-classified:1",
      mon_id: "worker",
      context_packet: { objective: "Exercise retry classification." }
    }
  });
  assert.equal(started.statusCode, 201);

  runner.exit(0, { code: 0, signal: null });
  clock.advance(1_000);
  await manager.dispatchDueRetries();
  assert.equal(runner.inputs.length, 2);

  runner.inputs[1].onStderr("401: authentication token expired\n");
  runner.exit(1, { code: 1, signal: null });
  clock.advance(1_000);
  await manager.dispatchDueRetries();
  assert.equal(runner.inputs.length, 3);

  runner.inputs[2].onStdout("completed\n");
  runner.exit(2, { code: 0, signal: null });
  const inspection = await app.inject({
    method: "GET",
    url: "/mondes/local/integrations/example/runs/queue-classified%3A1"
  });
  assert.equal(inspection.json().snapshot.status, "succeeded");
});

test("one-shot attempt timeout terminates the process and enters retry backoff", async (t) => {
  const clock = new ManualClock();
  const { app, runner } = fixture(t, {
    clock,
    retryPolicy: {
      max_attempts: 2,
      initial_backoff_seconds: 15,
      backoff_multiplier: 1,
      max_backoff_seconds: 15,
      attempt_timeout_seconds: 10,
      kill_grace_seconds: 5,
      retryable_conditions: ["attempt_timeout"]
    }
  });
  await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/runs",
    payload: {
      execution_key: "queue-timeout:1",
      mon_id: "worker",
      context_packet: { objective: "Time out this attempt." }
    }
  });

  clock.advance(10_000);
  clock.fireDue();
  assert.deepEqual(runner.signals[0], ["SIGTERM"]);
  runner.exit(0, { code: null, signal: "SIGTERM" });

  const inspection = await app.inject({
    method: "GET",
    url: "/mondes/local/integrations/example/runs/queue-timeout%3A1"
  });
  assert.equal(inspection.json().snapshot.status, "pending");
  assert.equal(inspection.json().snapshot.retry_condition, "attempt_timeout");
});

test("cancelling retry backoff prevents every future process attempt", async (t) => {
  const clock = new ManualClock();
  const { app, manager, runner } = fixture(t, {
    clock,
    retryPolicy: {
      max_attempts: 3,
      initial_backoff_seconds: 30,
      backoff_multiplier: 1,
      max_backoff_seconds: 30,
      kill_grace_seconds: 5,
      retryable_conditions: ["process_exit_nonzero"]
    }
  });
  await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/runs",
    payload: {
      execution_key: "queue-cancel-backoff:1",
      mon_id: "worker",
      context_packet: { objective: "Cancel during retry backoff." }
    }
  });
  runner.exit(0, { code: 1, signal: null });

  const cancelled = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/runs/queue-cancel-backoff%3A1/cancel"
  });
  assert.equal(cancelled.json().snapshot.status, "cancelled");
  clock.advance(60_000);
  await manager.dispatchDueRetries();
  assert.equal(runner.inputs.length, 1);
});

test("process-exit integration path carries isolated scope and contained MCP capabilities", async (t) => {
  if (codexAdapter.detect().supports_isolated_runs !== true) {
    t.skip("The deployed Codex adapter requires a current isolation attestation.");
    return;
  }
  const {
    app,
    executionManifests,
    externalExecutions,
    externalMcpGrants,
    runner
  } = fixture(t, { isolatedCodex: true });
  const started = await app.inject({
    method: "POST",
    url: "/mondes/local/integrations/example/runs",
    payload: {
      execution_key: "queue-isolated:1",
      mon_id: "worker",
      context_packet: {
        schema: { id: "example.run-context", version: "1" },
        objective: "Use the contained domain MCP."
      }
    }
  });
  assert.equal(started.statusCode, 201);
  assert.equal(runner.inputs.length, 1);
  const input = runner.inputs[0];
  assert.equal(input.scope.workspace_mode, "isolated");
  assert.ok(input.scope.scratch_path);
  assert.ok(input.scope.context_snapshot_path);
  assert.equal(input.scope.actor_context_files[0]?.content, "stable worker identity\n");
  assert.equal(input.externalMcpServers?.length, 1);
  assert.ok(input.externalMcpServers?.[0]?.token);
  assert.equal(
    externalMcpGrants.introspect(input.externalMcpServers![0].token!)?.integration_id,
    "example"
  );
  const initialGrant = externalMcpGrants.getForRunServer(
    input.runId,
    "domain"
  );
  assert.ok(initialGrant);
  const renewedClaims = externalMcpGrants.introspect(
    input.externalMcpServers![0].token!,
    new Date(Date.parse(initialGrant.expires_at) + 1).toISOString()
  );
  assert.ok(renewedClaims);
  assert.ok(Date.parse(renewedClaims.expires_at) > Date.parse(initialGrant.expires_at));

  const command = codexAdapter.buildCommand({
    runId: input.runId,
    runToken: "run-token",
    monRoot: input.scope.mon_root,
    workRoot: input.scope.work_root,
    prompt: input.prompt,
    runtimePrompt: input.runtimePrompt,
    serviceAddr: input.serviceAddr,
    mcpAddr: input.mcpAddr,
    workspaceMode: "isolated",
    scratchPath: input.scope.scratch_path,
    contextSnapshotPath: input.scope.context_snapshot_path,
    readMounts: input.scope.read_mounts,
    runScopesRoot: path.dirname(input.scope.scope_root!),
    externalMcpServers: input.externalMcpServers,
    externalMcpIntrospectionUrl: input.externalMcpIntrospectionUrl
  });
  assert.match(command.args.join("\n"), /mcp_servers\.monde\.command/);
  assert.match(command.args.join("\n"), /mcp_servers\.domain\.command="bwrap"/);
  assert.equal(command.env.MONDE_SERVICE_TOKEN, undefined);

  const siblingScratch = path.join(
    path.dirname(input.scope.scope_root!),
    "sibling",
    "scratch"
  );
  const siblingSecret = path.join(siblingScratch, "secret.txt");
  const probeOutput = path.join(input.scope.scratch_path!, "mcp-probe.txt");
  fs.mkdirSync(siblingScratch, { recursive: true });
  fs.writeFileSync(siblingSecret, "sibling secret\n");
  const runtime = input.externalMcpServers![0] as ExternalMcpRuntime;
  if (runtime.server.transport !== "stdio") {
    throw new Error("Expected a stdio integration MCP runtime.");
  }
  const probeRuntime: ExternalMcpRuntime = {
    ...runtime,
    server: {
      ...runtime.server,
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `try{fs.readFileSync(${JSON.stringify(siblingSecret)});process.exit(91)}catch{}`,
          `fs.writeFileSync(${JSON.stringify(probeOutput)},'passed\\n')`
        ].join("")
      ]
    }
  };
  const probe = buildIsolatedStdioLaunch(probeRuntime, {
    runId: input.runId,
    runToken: "run-token",
    monRoot: input.scope.mon_root,
    workRoot: input.scope.work_root,
    prompt: input.prompt,
    serviceAddr: input.serviceAddr,
    mcpAddr: input.mcpAddr,
    workspaceMode: "isolated",
    scratchPath: input.scope.scratch_path,
    contextSnapshotPath: input.scope.context_snapshot_path,
    readMounts: input.scope.read_mounts,
    runScopesRoot: path.dirname(input.scope.scope_root!)
  });
  const result = spawnSync(probe.command, probe.args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(probeOutput, "utf8"), "passed\n");

  runner.exit(0, { code: 0, signal: null });
  const inspection = await app.inject({
    method: "GET",
    url: "/mondes/local/integrations/example/runs/queue-isolated%3A1"
  });
  assert.equal(inspection.json().snapshot.status, "succeeded");
  const execution = externalExecutions.getByKey("example", "queue-isolated:1");
  assert.ok(execution);
  assert.equal(
    executionManifests.getByExecution(execution.id),
    undefined
  );
});
