import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildIsolatedStdioLaunch,
  codexAdapter,
  type ExternalMcpRuntime
} from "@monde/adapters";
import { MonConfigSchema, type MonConfig, type RunRecord } from "@monde/core";
import type {
  HarnessRunner,
  RunningProcess,
  StartRunInput
} from "../packages/service/src/basic-process-runner.ts";
import { migrateDatabase } from "../packages/service/src/db.ts";
import { ArtifactRepository } from "../packages/service/src/repositories/artifacts.ts";
import { ExternalExecutionRepository } from "../packages/service/src/repositories/external-executions.ts";
import { ExternalMcpGrantRepository } from "../packages/service/src/repositories/external-mcp-grants.ts";
import { LogRepository } from "../packages/service/src/repositories/logs.ts";
import { MonRepository } from "../packages/service/src/repositories/mons.ts";
import { MondeRepository } from "../packages/service/src/repositories/mondes.ts";
import { ProcessSlotRepository } from "../packages/service/src/repositories/process-slots.ts";
import { RunEventRepository } from "../packages/service/src/repositories/run-events.ts";
import { RunRepository } from "../packages/service/src/repositories/runs.ts";
import { RunEventBus } from "../packages/service/src/run-events.ts";
import { RunManager } from "../packages/service/src/run-manager.ts";

function baseMonConfig(
  externalMcpServers: unknown[] = []
): Omit<MonConfig, "external_mcp_servers"> & { external_mcp_servers: unknown[] } {
  return {
    id: "seia",
    name: "Seia",
    role: "actor",
    version: 1,
    default_harness: "codex",
    default_model: null,
    work_root: "..",
    max_active_runs: 1,
    run_workspace: { mode: "shared" },
    actor_context: [],
    read_mounts: [],
    external_mcp_servers: externalMcpServers,
    capabilities: [],
    created_at: "2026-01-01T00:00:00.000Z"
  };
}

test("external MCP configuration reserves namespaces and constrains authenticated HTTP to loopback", () => {
  const stdio = {
    id: "doctrine",
    transport: "stdio",
    command: "doctrine-mcp",
    auth: { type: "none" }
  };
  assert.equal(MonConfigSchema.safeParse(baseMonConfig([stdio])).success, true);
  assert.equal(MonConfigSchema.safeParse(baseMonConfig([{ ...stdio, id: "monde" }])).success, false);
  assert.equal(MonConfigSchema.safeParse(baseMonConfig([stdio, stdio])).success, false);
  assert.equal(
    MonConfigSchema.safeParse(
      baseMonConfig([
        {
          id: "remote",
          transport: "streamable_http",
          url: "https://mcp.example.test/mcp",
          auth: {
            type: "run_claims",
            audience: "remote",
            token_env_var: "REMOTE_RUN_TOKEN"
          }
        }
      ])
    ).success,
    false
  );
  assert.equal(
    MonConfigSchema.safeParse(
      baseMonConfig([
        {
          id: "public",
          transport: "streamable_http",
          url: "https://mcp.example.test/mcp",
          auth: { type: "none" }
        }
      ])
    ).success,
    true
  );
});

test("Codex receives built-in and external MCP servers without putting grant values in arguments", () => {
  const config = MonConfigSchema.parse(
    baseMonConfig([
      {
        id: "sanctus",
        transport: "streamable_http",
        url: "http://127.0.0.1:4777/mcp",
        auth: {
          type: "run_claims",
          audience: "sanctus",
          token_env_var: "SANCTUS_RUN_TOKEN"
        }
      },
      {
        id: "doctrine",
        transport: "stdio",
        command: "node",
        args: ["doctrine-server.mjs"],
        actor_context_access: true,
        auth: { type: "none" }
      }
    ])
  );
  const [sanctus, doctrine] = config.external_mcp_servers;
  const command = codexAdapter.buildCommand({
    runId: "run_mcp",
    runToken: "built-in-run-token",
    monRoot: "/tmp/mon",
    workRoot: "/tmp/work",
    prompt: "execute",
    runtimePrompt: "runtime prompt",
    serviceAddr: "http://127.0.0.1:3761",
    mcpAddr: "http://127.0.0.1:3762/mcp",
    contextSnapshotPath: "/tmp/run/context",
    externalMcpIntrospectionUrl: "http://127.0.0.1:3761/external-mcp/introspect",
    externalMcpServers: [
      {
        server: sanctus,
        token: "narrow-grant-secret",
        resolvedReadMounts: []
      },
      {
        server: doctrine,
        resolvedReadMounts: []
      }
    ]
  });
  const args = command.args.join("\n");

  assert.match(args, /mcp_servers\.monde\.command/);
  assert.match(args, /mcp_servers\.sanctus\.url/);
  assert.match(args, /mcp_servers\.sanctus\.bearer_token_env_var="SANCTUS_RUN_TOKEN"/);
  assert.match(args, /mcp_servers\.doctrine\.command="node"/);
  assert.match(args, /MONDE_ACTOR_CONTEXT/);
  assert.doesNotMatch(args, /narrow-grant-secret/);
  assert.equal(command.env.SANCTUS_RUN_TOKEN, "narrow-grant-secret");
  assert.equal(command.env.MONDE_SERVICE_TOKEN, undefined);
});

test("isolated stdio MCP children cannot read a sibling run workspace", (t) => {
  if (codexAdapter.detect().supports_isolated_runs !== true) {
    t.skip("Codex isolated mode has not been verified on this host.");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-stdio-mcp-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const scopesRoot = path.join(tempRoot, "run-scopes");
  const currentRoot = path.join(scopesRoot, "current");
  const siblingRoot = path.join(scopesRoot, "sibling");
  const scratchPath = path.join(currentRoot, "scratch");
  const contextPath = path.join(currentRoot, "context");
  const siblingSecret = path.join(siblingRoot, "secret.txt");
  const outputPath = path.join(scratchPath, "probe.txt");
  fs.mkdirSync(scratchPath, { recursive: true });
  fs.mkdirSync(contextPath);
  fs.mkdirSync(siblingRoot);
  fs.writeFileSync(siblingSecret, "must not be visible\n");

  const [server] = MonConfigSchema.parse(
    baseMonConfig([
      {
        id: "sandboxed",
        transport: "stdio",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `try{fs.readFileSync(${JSON.stringify(siblingSecret)});process.exit(91)}catch{}`,
            `fs.writeFileSync(${JSON.stringify(outputPath)},'passed\\n')`
          ].join("")
        ],
        scratch_access: "write",
        auth: { type: "none" }
      }
    ])
  ).external_mcp_servers;
  const runtime: ExternalMcpRuntime = {
    server,
    resolvedReadMounts: []
  };
  const launch = buildIsolatedStdioLaunch(runtime, {
    runId: "current",
    runToken: "token",
    monRoot: "/unmounted/mon",
    workRoot: "/unmounted/work",
    prompt: "test",
    serviceAddr: "http://127.0.0.1:3761",
    mcpAddr: "http://127.0.0.1:3762/mcp",
    workspaceMode: "isolated",
    scratchPath,
    contextSnapshotPath: contextPath,
    runScopesRoot: scopesRoot
  });
  const probe = spawnSync(launch.command, launch.args, { encoding: "utf8" });

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "passed\n");
});

class DeferredRunner implements HarnessRunner {
  input?: StartRunInput;

  async startRun(input: StartRunInput): Promise<RunningProcess> {
    this.input = input;
    input.onSpawn?.(4321);
    return {
      runId: input.runId,
      pid: 4321,
      runnerType: "adapter-native",
      write() {},
      kill() {}
    };
  }
}

test("run claims carry external context and a required MCP failure releases its slot", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-mcp-manager-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const mondeRoot = path.join(tempRoot, "world");
  const monRoot = path.join(mondeRoot, "seia.mon");
  const docsRoot = path.join(mondeRoot, ".monde", "docs");
  fs.mkdirSync(monRoot, { recursive: true });
  fs.mkdirSync(docsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(mondeRoot, ".monde", "monde.json"),
    JSON.stringify({
      id: "test",
      name: "Test",
      version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      root: mondeRoot,
      docs: docsRoot
    })
  );
  const monConfig = MonConfigSchema.parse({
    ...baseMonConfig([
      {
        id: "sanctus",
        transport: "streamable_http",
        url: "http://127.0.0.1:4777/mcp",
        required: true,
        auth: {
          type: "run_claims",
          audience: "sanctus",
          token_env_var: "SANCTUS_RUN_TOKEN"
        }
      }
    ]),
    work_root: "."
  });
  fs.writeFileSync(path.join(monRoot, "mon.json"), JSON.stringify(monConfig));

  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrateDatabase(db);
  const mondes = new MondeRepository(db);
  const mons = new MonRepository(db);
  const runs = new RunRepository(db);
  const executions = new ExternalExecutionRepository(db);
  const grants = new ExternalMcpGrantRepository(db);
  const slots = new ProcessSlotRepository(db);
  mondes.upsert({ id: "test", name: "Test", root: mondeRoot, docs: docsRoot });
  mons.upsert({
    id: "seia",
    monde_id: "test",
    name: "Seia",
    role: "actor",
    mon_root: monRoot,
    work_root: monRoot,
    default_harness: "codex",
    default_model: null,
    capabilities: []
  });
  const now = "2026-01-01T00:00:00.000Z";
  const run: RunRecord = {
    id: "run_external_mcp",
    monde_id: "test",
    mon_id: "seia",
    status: "queued",
    process_status: "not_started",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "queued",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "system", label: "external:test" },
    intent: { title: "external MCP", prompt: "execute" },
    execution: { externally_managed: true },
    result: {},
    created_at: now,
    updated_at: now
  };
  const external = executions.createOrGet({
    integrationId: "tea-party",
    externalExecutionKey: "filius:42",
    requestDigest: "a".repeat(64),
    run,
    externalScope: { persona_ref: "seia" },
    externalContext: { queue_item: "42" }
  }).execution;
  const runner = new DeferredRunner();
  const manager = new RunManager({
    mondes,
    externalExecutions: executions,
    externalMcpGrants: grants,
    mons,
    processSlots: slots,
    runs,
    logs: new LogRepository(db),
    artifacts: new ArtifactRepository(db),
    events: new RunEventBus(new RunEventRepository(db)),
    runner,
    config: {
      serviceAddr: "http://0.0.0.0:3761",
      mcpAddr: "http://127.0.0.1:3762/mcp",
      dataDir: path.join(tempRoot, "data")
    }
  });

  const started = await manager.startRun(run.id);
  assert.equal(started.started, true);
  const runtime = runner.input?.externalMcpServers?.[0];
  assert.ok(runtime?.token);
  assert.equal(
    runner.input?.externalMcpIntrospectionUrl,
    "http://127.0.0.1:3761/external-mcp/introspect"
  );
  assert.deepEqual(grants.introspect(runtime.token), {
    run_id: run.id,
    mon_id: "seia",
    monde_id: "test",
    integration_id: "tea-party",
    external_execution_key: "filius:42",
    external_scope: { persona_ref: "seia" },
    audience: "sanctus",
    expires_at: grants.getForRunServer(run.id, "sanctus")?.expires_at
  });

  runner.input?.onStderr("MCP server sanctus initialization failed\n");
  runner.input?.onExit({ code: 1, signal: null });

  assert.equal(executions.get(external.id)?.condition, "required_mcp_unavailable");
  assert.equal(slots.listForMon("test", "seia").length, 0);
  assert.equal(grants.introspect(runtime.token), undefined);
});
