#!/usr/bin/env node
import { Command } from "commander";
import { initMonde } from "./commands/init.js";
import { createMon } from "./commands/mon.js";
import { messageMon } from "./commands/message.js";
import { listArtifacts, registerArtifact, showArtifact } from "./commands/artifact.js";
import { listAdapters, inspectAdapter } from "./commands/adapter.js";
import { backupCreate, backupInfo, backupList } from "./commands/backup.js";
import { doctor, repair } from "./commands/doctor.js";
import { bridgeMcp } from "./commands/mcp.js";
import { activatePlan, assignPlan, createPlan, listPlans, searchPlans, showPlan } from "./commands/plan.js";
import { attachRun, cancelRun, closeRun, inputRun, interruptRun, listRuns, reviewRun, showRun, startRun, summarizeRun } from "./commands/run.js";
import { servicePaths, serviceStatus } from "./commands/service.js";
import { sleepMon, wakeMon } from "./commands/wake.js";

const program = new Command();

program.name("monde").description("Local Monde operator CLI").version("0.0.0");

program
  .command("init")
  .argument("[path]", "directory to initialize", ".")
  .option("--name <name>", "display name for this Monde")
  .option("--force", "overwrite an existing .monde/monde.json")
  .action((targetPath: string, options: { name?: string; force?: boolean }) => {
    initMonde(targetPath, options);
  });

const mon = program.command("mon").description("Manage filesystem mon identities");

mon
  .command("create")
  .argument("<directory>", "mon directory name, for example frontend.mon")
  .option("--path <path>", "parent directory for the mon", ".")
  .option("--name <name>", "display name")
  .option("--role <role>", "operator-facing role label")
  .option("--harness <harness>", "default harness")
  .option("--model <model>", "default model")
  .action(createMon);

program
  .command("message")
  .argument("<mon>", "mon directory name or path")
  .argument("<prompt...>", "operator message")
  .option("--harness <harness>", "launch new operator run with this harness when no run is active")
  .option("--write", "allow a Codex run to write inside the mon work root")
  .option("--sandbox <mode>", "sandbox mode for adapter-native runs, for example read-only or workspace-write")
  .option("--attach-active", "require appending to the active run; fail if the active run has closed input")
  .action(messageMon);

program
  .command("wake")
  .argument("<mon>", "mon directory name or path")
  .option("--run <run-id>", "start this queued run if the mon is idle")
  .option("--harness <harness>", "launch new manual run with this harness when no queued run is available")
  .option("--write", "allow a Codex manual run to write inside the mon work root")
  .option("--sandbox <mode>", "sandbox mode for adapter-native manual runs")
  .action(wakeMon);

program
  .command("sleep")
  .argument("<mon>", "mon directory name or path")
  .action(sleepMon);

const run = program.command("run").description("Inspect and update runs");

run
  .command("list")
  .option("--all", "list runs across all known Mondes")
  .option("--status <status>", "filter by run lifecycle status")
  .option("--mon <mon-id>", "filter by mon id or directory name")
  .option("--origin <type>", "filter by origin type")
  .action(listRuns);

run.command("show").argument("<run-id>").option("--artifacts", "include artifact content excerpts").action(showRun);
run.command("start").argument("<run-id>").option("--attach", "attach after starting").action(startRun);
run.command("attach").argument("<run-id>").action(attachRun);
run.command("input").argument("<run-id>").argument("<input...>").action(inputRun);
run.command("interrupt").argument("<run-id>").description("send SIGINT/Ctrl-C to an active run").action(interruptRun);
run.command("cancel").argument("<run-id>").action(cancelRun);
run
  .command("close")
  .argument("<run-id>")
  .requiredOption("--outcome <outcome>", "completed, failed, or stopped")
  .option("--summary <summary>", "review summary stored under run.result.summary")
  .option("--notes <notes>", "optional review notes")
  .action((runId: string, options: { outcome: string; summary?: string; notes?: string }) => closeRun(runId, options));
run
  .command("review")
  .argument("<run-id>")
  .requiredOption("--outcome <outcome>", "completed, failed, or stopped")
  .option("--summary <summary>", "review summary stored under run.result.summary")
  .option("--notes <notes>", "optional review notes")
  .action((runId: string, options: { outcome: string; summary?: string; notes?: string }) =>
    reviewRun(runId, options)
  );
run.command("summarize").argument("<run-id>").action(summarizeRun);

const plan = program.command("plan").description("Manage server-owned coordination plans");
plan
  .command("create")
  .argument("<title>")
  .option("--mon <mon>", "create one assignment for this mon")
  .option("--prompt <prompt>", "assignment prompt")
  .option("--objective <objective>", "plan objective")
  .option("--description <description>", "plan description")
  .option("--phase <phase>", "assignment phase")
  .action(createPlan);
plan
  .command("assign")
  .argument("<plan-id>")
  .requiredOption("--mon <mon>", "assigned mon")
  .requiredOption("--prompt <prompt>", "assignment prompt")
  .option("--title <title>", "assignment title")
  .option("--phase <phase>", "assignment phase")
  .action(assignPlan);
plan.command("list").action(listPlans);
plan.command("show").argument("<plan-id>").action(showPlan);
plan.command("activate").argument("<plan-id>").action(activatePlan);
plan.command("search").argument("<query>").action(searchPlans);

const artifact = program.command("artifact").description("Inspect and register run artifacts");
artifact.command("list").option("--run <run-id>").option("--mon <mon-id>").action(listArtifacts);
artifact.command("show").argument("<artifact-id>").action(showArtifact);
artifact
  .command("register")
  .argument("<run-id>")
  .requiredOption("--type <type>", "artifact type")
  .option("--path <path>", "artifact path")
  .option("--title <title>", "artifact title")
  .option("--summary <summary>", "artifact summary")
  .action(registerArtifact);

const adapter = program.command("adapter").description("Inspect harness adapters");
adapter.command("list").action(listAdapters);
adapter.command("inspect").argument("<adapter-id>").action(inspectAdapter);

const mcp = program.command("mcp").description("Run MCP bridge helpers");
mcp
  .command("bridge")
  .option("--run <run-id>", "run id for MCP attribution")
  .option("--token <token>", "run-scoped token for MCP authorization")
  .action(bridgeMcp);

const backup = program.command("backup").description("Inspect local continuity and backup paths");
backup.command("info").action(backupInfo);
backup.command("create").description("create a consistent online backup of the operational SQLite DB").action(backupCreate);
backup.command("list").description("list local SQLite backups").action(backupList);

program.command("doctor").description("Inspect local Monde health and continuity risks").action(doctor);
program.command("repair").description("Run conservative local repair actions").action(repair);

const service = program.command("service").description("Inspect the local Monde service");
service.command("status").action(serviceStatus);
service.command("paths").action(servicePaths);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`monde: ${message}`);
  process.exitCode = 1;
});
