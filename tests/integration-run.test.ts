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
  options: { isolatedCodex?: boolean } = {}
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
    runs,
    runWorkspaces,
    logs,
    artifacts,
    events: eventBus,
    runner,
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
    executionManifests,
    externalExecutions,
    externalMcpGrants,
    runner,
    runs
  };
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
