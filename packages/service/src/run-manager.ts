import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  addRunWarning,
  buildRuntimePrompt,
  cancelQueuedRun,
  finishRunFromExit,
  finishRunInterrupted,
  finishRunStopped,
  markRunActive,
  startRunLifecycle,
  type RunRecord
} from "@monde/core";
import {
  getHarnessAdapter,
  type ExternalMcpRuntime,
  type HarnessInputMode,
  type HarnessInteractionMode,
  type HarnessOutputMode
} from "@monde/adapters";
import { createRunToken, hashRunToken, verifyRunToken } from "./run-auth.js";
import { RunEventBus } from "./run-events.js";
import { BasicProcessRunner, type HarnessRunner, type RunningProcess } from "./basic-process-runner.js";
import {
  cleanupRunScopeFiles,
  materializeRunScope,
  resolveRunScope,
  resolveRunScopedPath,
  sealRunScopeFiles,
  type RunScopeSnapshot
} from "./scope.js";
import type { MonRepository } from "./repositories/mons.js";
import type { MondeRepository } from "./repositories/mondes.js";
import type { PlanRepository, PlanAssignmentStatus } from "./repositories/plans.js";
import type { ProcessSlotRepository } from "./repositories/process-slots.js";
import type { RunRepository } from "./repositories/runs.js";
import type { RunWorkspaceRepository } from "./repositories/run-workspaces.js";
import type { ArtifactRepository } from "./repositories/artifacts.js";
import type { ExternalExecutionRepository } from "./repositories/external-executions.js";
import type { ExternalMcpGrantRepository } from "./repositories/external-mcp-grants.js";
import type { ExecutionManifestRepository } from "./repositories/execution-manifests.js";
import type { LogRepository } from "./repositories/logs.js";

export interface RunManagerConfig {
  serviceAddr: string;
  mcpAddr: string;
  dataDir?: string;
}

export interface RunManagerTimer {
  unref(): void;
}

export interface RunManagerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): RunManagerTimer;
  clearTimeout(timer: RunManagerTimer): void;
}

export interface StartRunResult {
  run: RunRecord;
  started: boolean;
  active_run_id?: string;
  active_run_ids?: string[];
}

export interface HitlThreadResponseResult {
  run: RunRecord;
  response: string;
  harness: string;
  raw_output: string;
  error_output: string;
}

interface RunningRun {
  process: RunningProcess;
  stopRequested: boolean;
  stalePoll?: NodeJS.Timeout;
}

type HitlTimeoutReason = "idle_timeout" | "hard_timeout";

interface HitlActivityState {
  runId: string;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  killGraceMs: number;
  lastActivityAtMs: number;
  lastActivityAt: string;
  lastActivityReason: string;
  lastActivityEventAtMs: number;
  processHandle?: RunningProcess;
  idleTimer?: RunManagerTimer;
  hardTimer?: RunManagerTimer;
  timedOut: boolean;
  onTimeout(reason: HitlTimeoutReason): void;
}

const systemRunManagerClock: RunManagerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
};

export class RunManager {
  private readonly running = new Map<string, RunningRun>();
  private readonly hitlActivities = new Map<string, HitlActivityState>();
  private readonly runner: HarnessRunner;
  private readonly clock: RunManagerClock;

  constructor(
    private readonly deps: {
      mondes: MondeRepository;
      externalExecutions?: ExternalExecutionRepository;
      externalMcpGrants?: ExternalMcpGrantRepository;
      executionManifests?: ExecutionManifestRepository;
      mons: MonRepository;
      plans?: PlanRepository;
      processSlots?: ProcessSlotRepository;
      runs: RunRepository;
      runWorkspaces?: RunWorkspaceRepository;
      logs: LogRepository;
      artifacts: ArtifactRepository;
      events: RunEventBus;
      config: RunManagerConfig;
      runner?: HarnessRunner;
      clock?: RunManagerClock;
    }
  ) {
    this.runner = deps.runner ?? new BasicProcessRunner();
    this.clock = deps.clock ?? systemRunManagerClock;
  }

  async startRun(runId: string): Promise<StartRunResult> {
    const run = this.requireRun(runId);
    if (run.status === "active" || run.status === "starting") {
      return { run, started: false, active_run_id: run.id };
    }

    if (run.status !== "queued" && run.status !== "blocked") {
      throw new Error(`Run ${run.id} cannot be started from status ${run.status}.`);
    }

    const monde = this.deps.mondes.get(run.monde_id);
    const mon = this.deps.mons.get(run.monde_id, run.mon_id);
    if (!monde || !mon) {
      throw new Error(`Cannot resolve mon ${run.mon_id} in Monde ${run.monde_id}.`);
    }

    const baseScope = resolveRunScope(monde, mon);
    const harnessOverride = typeof run.execution.harness_override === "string" ? run.execution.harness_override : undefined;
    const selectedBaseScope = harnessOverride ? { ...baseScope, harness: harnessOverride } : baseScope;
    const adapter = getHarnessAdapter(selectedBaseScope.harness);
    const adapterDetection = adapter?.detect();
    if (
      selectedBaseScope.mon_json.external_mcp_servers.length > 0 &&
      adapterDetection?.supports_external_mcp !== true
    ) {
      throw new Error(
        `${adapter?.label ?? selectedBaseScope.harness} cannot configure declared external MCP servers.`
      );
    }
    if (selectedBaseScope.workspace_mode === "isolated" && adapterDetection?.supports_isolated_runs !== true) {
      throw new Error(
        `${adapter?.label ?? selectedBaseScope.harness} cannot enforce isolated runs: ${adapterDetection?.isolation_status ?? "unsupported"}`
      );
    }
    const oldestQueued = this.deps.runs.getOldestQueuedForMon(run.monde_id, run.mon_id);
    if (run.status === "queued" && oldestQueued && oldestQueued.id !== run.id) {
      return { run, started: false };
    }
    const reservation = this.deps.processSlots?.reserve({
      runId: run.id,
      mondeId: run.monde_id,
      monId: run.mon_id,
      kind: "one_shot",
      limit: baseScope.mon_json.max_active_runs
    }) ?? { reserved: true, activeRunIds: [] };
    if (!reservation.reserved) {
      return {
        run,
        started: false,
        active_run_id: reservation.activeRunIds[0],
        active_run_ids: reservation.activeRunIds
      };
    }
    let scope = selectedBaseScope;
    if (
      selectedBaseScope.workspace_mode === "isolated" ||
      selectedBaseScope.mon_json.actor_context.length > 0
    ) {
      if (!this.deps.config.dataDir) {
        this.deps.processSlots?.release(run.id);
        throw new Error("Run-scope data directory is unavailable.");
      }
      try {
        scope = materializeRunScope(selectedBaseScope, run.id, this.deps.config.dataDir);
        if (scope.scope_root) {
          this.deps.runWorkspaces?.register({
            runId: run.id,
            workspaceMode: scope.workspace_mode,
            scopeRoot: scope.scope_root,
            contextPath: scope.context_snapshot_path,
            scratchPath: scope.scratch_path
          });
        }
      } catch (error) {
        this.deps.processSlots?.release(run.id);
        throw error;
      }
    }
    const runToken = createRunToken();
    let externalMcp: ReturnType<RunManager["buildExternalMcpRuntime"]>;
    try {
      externalMcp = this.buildExternalMcpRuntime(run, scope);
    } catch (error) {
      this.deps.processSlots?.release(run.id);
      this.deps.externalMcpGrants?.revokeForRun(run.id);
      this.sealRunWorkspace(run.id);
      throw error;
    }
    const runnerType = runnerTypeForHarness(scope.harness);
    const interactionMode = interactionModeForHarness(scope.harness);
    const inputMode = inputModeForHarness(scope.harness);
    const outputMode = outputModeForHarness(scope.harness);
    const requestedSandboxMode = requestedSandboxModeForRun(run, scope);
    const sandboxMode = sandboxModeForHarness(scope.harness, requestedSandboxMode);
    const canWrite = canWriteForHarness(scope.harness, sandboxMode);
    const diffCapture = canWrite && scope.workspace_mode === "shared"
      ? captureGitBaseline(scope.monde_root)
      : { enabled: false, reason: scope.workspace_mode === "isolated" ? "isolated_scratch_workspace" : "run_not_write_capable" };
    const execution = {
      runner: scope.harness,
      runner_type: runnerType,
      pid: null,
      run_token_hash: hashRunToken(runToken),
      run_token_revoked_at: null,
      service_addr: this.deps.config.serviceAddr,
      mcp_addr: this.deps.config.mcpAddr,
      started_by: "monde-service",
      harness_override: harnessOverride,
      adapter_status: adapterDetection?.adapter_status ?? "missing",
      mcp_status: adapterDetection?.mcp_status ?? "unsupported",
      prompt_injection_status: adapterDetection?.prompt_injection_status ?? "unsupported",
      interaction_mode: interactionMode,
      input_mode: inputMode,
      requested_sandbox_mode: requestedSandboxMode,
      sandbox_mode: sandboxMode,
      approval_mode: approvalModeForHarness(scope.harness),
      can_write: canWrite,
      write_scope: writeScopeForHarness(scope.harness, scope.execution_root, canWrite),
      output_mode: outputMode,
      diff_capture: diffCapture,
      terminal: {
        mode: runnerType === "basic-process" ? "pipe-backed pseudo-terminal" : `${runnerType} adapter process`,
        ansi_preserved: true,
        stdin: inputMode === "open",
        stdin_mode: inputMode === "open" ? "pipe" : "closed",
        interrupt_signal: "SIGINT",
        columns: Number.parseInt(process.env.COLUMNS ?? "120", 10),
        rows: Number.parseInt(process.env.LINES ?? "32", 10)
      },
      scope_fingerprints: captureScopeFingerprints(scope),
      external_mcp_servers: externalMcp.runtimes.map((runtime) => runtime.server.id),
      required_external_mcp_servers: externalMcp.runtimes
        .filter((runtime) => runtime.server.required)
        .map((runtime) => runtime.server.id),
      external_mcp_grant_ids: externalMcp.grantIds
    };

    this.deps.runs.updateScopeAndExecution(run.id, scope as unknown as Record<string, unknown>, execution);
    if (isRecord(diffCapture) && diffCapture.warning === "no_git_diff_available") {
      this.addWarning(run.id, "no_git_diff_available");
    }
    if (isRecord(diffCapture) && diffCapture.dirty_before === true) {
      this.addWarning(run.id, "dirty_worktree_before_run");
    }
    this.deps.runs.updateLifecycle(run.id, startRunLifecycle(run));
    const externalExecution = this.deps.externalExecutions?.getByRunId(run.id);
    if (externalExecution) {
      this.deps.externalExecutions?.updatePhase(externalExecution.id, "starting");
    }
    this.deps.events.publish(run.id, "run_started", {
      run_id: run.id,
      runner: scope.harness,
      runner_type: runnerType,
      interaction_mode: interactionMode,
      input_mode: inputMode,
      output_mode: outputMode,
      harness: scope.harness,
      mon_root: scope.mon_root,
      work_root: scope.work_root
    });
    this.updatePlanAssignmentForRun(run, "active");

    const startingRun = this.requireRun(run.id);
    const runtimePrompt = buildRuntimePrompt(startingRun, scope.mon_json, scope.monde_json, scope as unknown as Record<string, unknown>);
    let runningProcess: RunningProcess;
    try {
      runningProcess = await this.runner.startRun({
        runId: run.id,
        runToken,
        prompt: run.intent.prompt,
        runtimePrompt,
        scope,
        sandboxMode: String(execution.sandbox_mode),
        serviceAddr: this.deps.config.serviceAddr,
        mcpAddr: this.deps.config.mcpAddr,
        externalMcpServers: externalMcp.runtimes,
        externalMcpIntrospectionUrl: externalMcp.introspectionUrl,
        onSpawn: (pid) => {
          const current = this.requireRun(run.id);
          this.deps.runs.updateExecution(run.id, { ...current.execution, pid });
        },
        onStdout: (chunk) => {
          this.deps.events.publish(run.id, "run_output", { run_id: run.id, stream: "stdout", chunk });
        },
        onStderr: (chunk) => {
          if (
            externalMcp.runtimes.some((runtime) => runtime.server.required) &&
            /\bmcp\b|model context protocol|initialize|startup/i.test(chunk)
          ) {
            const current = this.requireRun(run.id);
            this.deps.runs.updateExecution(run.id, {
              ...current.execution,
              required_external_mcp_startup_error: true
            });
          }
          this.deps.events.publish(run.id, "run_error_output", { run_id: run.id, stream: "stderr", chunk });
        },
        onExit: (exit) => this.handleProcessExit(run.id, exit),
        onError: (error) => this.handleProcessError(run.id, error)
      });
    } catch (error) {
      this.handleProcessError(run.id, error instanceof Error ? error : new Error(String(error)));
      return { run: this.requireRun(run.id), started: false };
    }

    this.running.set(run.id, {
      process: runningProcess,
      stopRequested: false,
      stalePoll: this.startScopeWarningPoll(run.id, scope, execution.scope_fingerprints)
    });
    this.deps.runs.updateLifecycle(run.id, markRunActive(startingRun));
    const latestExternal = externalExecution ? this.deps.externalExecutions?.get(externalExecution.id) : undefined;
    if (latestExternal?.phase === "cancelling") {
      runningProcess.kill("SIGTERM");
      this.deps.externalExecutions?.markCancellationSignalled(latestExternal.id);
    } else if (latestExternal) {
      this.deps.externalExecutions?.updatePhase(latestExternal.id, "active");
    }

    return { run: this.requireRun(run.id), started: true };
  }

  async respondToHitlThread(runId: string, input: { content: string; context?: Record<string, unknown> }): Promise<HitlThreadResponseResult> {
    const run = this.requireRun(runId);
    if (run.interaction_mode !== "hitl_thread") {
      throw new Error(`Run ${run.id} is not a HITL thread.`);
    }

    const monde = this.deps.mondes.get(run.monde_id);
    const mon = this.deps.mons.get(run.monde_id, run.mon_id);
    if (!monde || !mon) {
      throw new Error(`Cannot resolve mon ${run.mon_id} in Monde ${run.monde_id}.`);
    }

    const baseScope = resolveRunScope(monde, mon);
    const harness = hitlHarnessForThread(run, baseScope.harness);
    if (harness === "basic-process") {
      throw new Error("HITL mon chat cannot use the basic-process shell adapter. Configure a chat_harness such as codex.");
    }

    const scope = { ...baseScope, harness };
    const adapter = getHarnessAdapter(scope.harness);
    const adapterDetection = adapter?.detect();
    if (!adapter || !adapterDetection?.available) {
      throw new Error(`${adapter?.label ?? scope.harness} adapter is not available: ${adapterDetection?.reason ?? "missing or unsupported"}`);
    }
    if (this.hitlActivities.has(run.id)) {
      throw new Error(`Run ${run.id} already has an active HITL adapter turn.`);
    }
    const reservation = this.deps.processSlots?.reserve({
      runId: run.id,
      mondeId: run.monde_id,
      monId: run.mon_id,
      kind: "hitl_turn",
      limit: baseScope.mon_json.max_active_runs
    }) ?? { reserved: true, activeRunIds: [] };
    if (!reservation.reserved) {
      throw new Error(
        `Mon ${run.mon_id} has no free process slot; active runs: ${reservation.activeRunIds.join(", ")}`
      );
    }

    const runToken = createRunToken();
    const runnerType = runnerTypeForHarness(scope.harness);
    const inputMode = inputModeForHarness(scope.harness);
    const outputMode = outputModeForHarness(scope.harness);
    const requestedSandboxMode = requestedSandboxModeForRun(run, scope);
    const sandboxMode = sandboxModeForHarness(scope.harness, requestedSandboxMode);
    const canWrite = canWriteForHarness(scope.harness, sandboxMode);
    const writeScope = writeScopeForHarness(scope.harness, scope.work_root, canWrite);
    const currentExecution = run.execution ?? {};
    const now = new Date().toISOString();
    const execution = {
      ...currentExecution,
      runner: scope.harness,
      runner_type: runnerType,
      pid: null,
      run_token_hash: hashRunToken(runToken),
      run_token_revoked_at: null,
      service_addr: this.deps.config.serviceAddr,
      mcp_addr: this.deps.config.mcpAddr,
      started_by: "monde-service",
      adapter_status: adapterDetection.adapter_status,
      mcp_status: adapterDetection.mcp_status,
      prompt_injection_status: adapterDetection.prompt_injection_status,
      interaction_mode: "hitl_thread",
      input_mode: inputMode,
      output_mode: outputMode,
      requested_sandbox_mode: requestedSandboxMode,
      sandbox_mode: sandboxMode,
      approval_mode: approvalModeForHarness(scope.harness),
      can_write: canWrite,
      write_scope: writeScope,
      chat_harness: scope.harness,
      chat_runner_type: runnerType,
      chat_last_turn_started_at: now,
      chat_last_context: input.context ?? {},
      terminal: {
        mode: `${runnerType} adapter turn`,
        ansi_preserved: true,
        stdin: inputMode === "open",
        stdin_mode: inputMode === "open" ? "pipe" : "closed",
        interrupt_signal: "SIGINT",
        columns: Number.parseInt(process.env.COLUMNS ?? "120", 10),
        rows: Number.parseInt(process.env.LINES ?? "32", 10)
      },
      scope_fingerprints: captureScopeFingerprints(scope)
    };

    this.deps.runs.updateScopeAndExecution(run.id, scope as unknown as Record<string, unknown>, execution);
    this.deps.events.publish(run.id, "thread_turn_started", {
      run_id: run.id,
      harness: scope.harness,
      runner_type: runnerType
    });

    const currentRun = this.requireRun(run.id);
    const runtimePrompt = buildRuntimePrompt(currentRun, scope.mon_json, scope.monde_json, scope as unknown as Record<string, unknown>);
    const prompt = buildHitlTurnPrompt(currentRun, input.content, input.context, canWrite, writeScope, this.deps.events.list(run.id));

    try {
      const turn = await this.runHitlAdapterTurn({
        runId: run.id,
        runToken,
        prompt,
        runtimePrompt,
        scope,
        sandboxMode,
        harness: scope.harness
      });
      const response = extractHitlResponse(turn.stdout);
      const finishedAt = new Date().toISOString();
      const latest = this.requireRun(run.id);
      this.deps.runs.updateExecution(run.id, {
        ...latest.execution,
        pid: null,
        chat_last_turn_finished_at: finishedAt,
        chat_last_exit_code: turn.exit.code,
        chat_last_exit_signal: turn.exit.signal,
        chat_last_error: null
      });
      this.deps.events.publish(run.id, "thread_turn_finished", {
        run_id: run.id,
        harness: scope.harness,
        code: turn.exit.code,
        signal: turn.exit.signal
      });

      return {
        run: this.requireRun(run.id),
        response,
        harness: scope.harness,
        raw_output: turn.stdout,
        error_output: turn.stderr
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = this.requireRun(run.id);
      const timeoutReason = typeof latest.execution?.hitl_timeout_reason === "string" ? latest.execution.hitl_timeout_reason : undefined;
      const lastActivityAt = typeof latest.execution?.hitl_last_activity_at === "string" ? latest.execution.hitl_last_activity_at : undefined;
      const lastActivityReason = typeof latest.execution?.hitl_last_activity_reason === "string" ? latest.execution.hitl_last_activity_reason : undefined;
      const idleTimeoutMs = typeof latest.execution?.hitl_idle_timeout_ms === "number" ? latest.execution.hitl_idle_timeout_ms : undefined;
      const hardTimeoutMs = typeof latest.execution?.hitl_hard_timeout_ms === "number" ? latest.execution.hitl_hard_timeout_ms : undefined;
      this.deps.runs.updateExecution(run.id, {
        ...latest.execution,
        pid: null,
        chat_last_turn_finished_at: new Date().toISOString(),
        chat_last_error: message
      });
      this.deps.events.publish(run.id, "thread_turn_failed", {
        run_id: run.id,
        harness: scope.harness,
        error: message,
        timeout_reason: timeoutReason,
        idle_timeout_ms: idleTimeoutMs,
        hard_timeout_ms: hardTimeoutMs,
        last_activity_at: lastActivityAt,
        last_activity_reason: lastActivityReason
      });
      throw error;
    }
  }

  private runHitlAdapterTurn(input: {
    runId: string;
    runToken: string;
    prompt: string;
    runtimePrompt: string;
    scope: RunScopeSnapshot;
    sandboxMode: string;
    harness: string;
  }): Promise<{ stdout: string; stderr: string; exit: { code: number | null; signal: NodeJS.Signals | null } }> {
    const idleTimeoutMs = timeoutMsFromEnv("MONDE_HITL_IDLE_TIMEOUT_MS", 120000);
    const hardTimeoutMs = timeoutMsFromEnv("MONDE_HITL_HARD_TIMEOUT_MS", timeoutMsFromEnv("MONDE_HITL_TURN_TIMEOUT_MS", 900000));
    const killGraceMs = timeoutMsFromEnv("MONDE_HITL_KILL_GRACE_MS", 5000);
    let stdout = "";
    let stderr = "";

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (
        kind: "resolve" | "reject",
        value: { stdout: string; stderr: string; exit: { code: number | null; signal: NodeJS.Signals | null } } | Error
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearHitlActivity(input.runId);
        this.revokeRunToken(input.runId);
        const completedRun = this.deps.runs.get(input.runId);
        this.deps.processSlots?.release(input.runId);
        if (completedRun) {
          void this.dispatchQueuedForMon(completedRun.monde_id, completedRun.mon_id);
        }
        if (kind === "resolve") {
          resolve(value as { stdout: string; stderr: string; exit: { code: number | null; signal: NodeJS.Signals | null } });
        } else {
          reject(value);
        }
      };

      const startedAtMs = this.clock.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const activity: HitlActivityState = {
        runId: input.runId,
        idleTimeoutMs,
        hardTimeoutMs,
        killGraceMs,
        lastActivityAtMs: startedAtMs,
        lastActivityAt: startedAt,
        lastActivityReason: "turn_started",
        lastActivityEventAtMs: 0,
        timedOut: false,
        onTimeout: (reason) => {
          const detail = this.timeoutMessageForActivity(activity, reason);
          settle("reject", new Error(detail));
        }
      };
      this.hitlActivities.set(input.runId, activity);
      const current = this.requireRun(input.runId);
      this.deps.runs.updateExecution(input.runId, {
        ...current.execution,
        hitl_turn_started_at: startedAt,
        hitl_last_activity_at: startedAt,
        hitl_last_activity_reason: "turn_started",
        hitl_idle_timeout_ms: idleTimeoutMs,
        hitl_hard_timeout_ms: hardTimeoutMs,
        hitl_timeout_reason: null
      });
      this.resetHitlIdleTimer(activity);
      this.startHitlHardTimer(activity);

      this.runner
        .startRun({
          runId: input.runId,
          runToken: input.runToken,
          prompt: input.prompt,
          runtimePrompt: input.runtimePrompt,
          scope: input.scope,
          sandboxMode: input.sandboxMode,
          serviceAddr: this.deps.config.serviceAddr,
          mcpAddr: this.deps.config.mcpAddr,
          onSpawn: (pid) => {
            const current = this.requireRun(input.runId);
            this.deps.runs.updateExecution(input.runId, { ...current.execution, pid });
            this.noteRunActivity(input.runId, "process_spawn");
          },
          onStdout: (chunk) => {
            stdout += chunk;
            this.noteRunActivity(input.runId, "stdout");
          },
          onStderr: (chunk) => {
            stderr += chunk;
            this.noteRunActivity(input.runId, "stderr");
          },
          onExit: (exit) => {
            this.noteRunActivity(input.runId, "process_exit");
            if (exit.signal || (typeof exit.code === "number" && exit.code !== 0)) {
              const detail = stderr.trim() || stdout.trim() || "adapter exited without a successful response";
              settle("reject", new Error(`${input.harness} chat turn exited with code ${String(exit.code)}${exit.signal ? ` signal ${exit.signal}` : ""}: ${detail}`));
              return;
            }

            settle("resolve", { stdout, stderr, exit });
          },
          onError: (error) => {
            settle("reject", error);
          }
        })
        .then((runningProcess) => {
          const activity = this.hitlActivities.get(input.runId);
          if (activity) {
            activity.processHandle = runningProcess;
          }
        })
        .catch((error) => {
          settle("reject", error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  writeInput(runId: string, input: string): RunRecord {
    const running = this.running.get(runId);
    if (!running) {
      throw new Error(`Run ${runId} is not active in this service process.`);
    }

    running.process.write(input);
    this.deps.events.publish(runId, "run_input", { run_id: runId, chunk: input });
    return this.requireRun(runId);
  }

  stopRun(runId: string): RunRecord {
    const run = this.requireRun(runId);
    const running = this.running.get(runId);

    if (run.status === "finished") {
      return run;
    }

    this.deps.runs.updateLifecycle(runId, finishRunStopped(run));
    if (running) {
      running.stopRequested = true;
      running.process.kill("SIGTERM");
      if (running.stalePoll) {
        clearInterval(running.stalePoll);
      }
    } else {
      this.deps.processSlots?.release(runId);
    }

    this.finalizeWriteEvidence(runId);
    this.revokeRunToken(runId);
    this.deps.events.publish(runId, "run_finished", {
      run_id: runId,
      status: "finished",
      process_status: "killed",
      outcome: "stopped"
    });
    const stopped = this.requireRun(runId);
    this.updatePlanAssignmentForRun(stopped, "blocked");
    return stopped;
  }

  interruptRun(runId: string): RunRecord {
    const run = this.requireRun(runId);
    const running = this.running.get(runId);

    if (!running) {
      throw new Error(`Run ${runId} is not active in this service process.`);
    }

    running.process.kill("SIGINT");
    this.deps.events.publish(runId, "run_input", { run_id: runId, chunk: "^C\n" });
    return run;
  }

  cancelRun(runId: string): RunRecord {
    const run = this.requireRun(runId);
    this.deps.runs.updateLifecycle(runId, cancelQueuedRun(run));
    this.deps.processSlots?.release(runId);
    this.revokeRunToken(runId);
    this.deps.events.publish(runId, "run_finished", {
      run_id: runId,
      status: "finished",
      process_status: "not_started",
      outcome: "canceled"
    });
    this.updatePlanAssignmentForRun(this.requireRun(runId), "canceled");
    void this.dispatchQueuedForMon(run.monde_id, run.mon_id);
    return this.requireRun(runId);
  }

  async dispatchQueuedForMon(mondeId: string, monId: string): Promise<RunRecord[]> {
    const started: RunRecord[] = [];
    if (typeof this.deps.runs.getOldestQueuedForMon !== "function") {
      return started;
    }
    while (true) {
      const queued = this.deps.runs.getOldestQueuedForMon(mondeId, monId);
      if (!queued) {
        break;
      }
      const result = await this.startRun(queued.id);
      if (!result.started) {
        break;
      }
      started.push(result.run);
    }
    return started;
  }

  completeExternalExecution(input: {
    executionId: string;
    completionDigest: string;
    completionReceipt?: unknown;
    manifestId?: string;
  }) {
    if (!this.deps.externalExecutions) {
      throw new Error("External execution repository is unavailable.");
    }
    if (input.manifestId) {
      if (!this.deps.executionManifests) {
        throw new Error("Execution manifest repository is unavailable.");
      }
      this.deps.executionManifests.assertOwnedByExecution(input.manifestId, input.executionId);
    }
    const execution = this.deps.externalExecutions.recordCompletion({
      id: input.executionId,
      digest: input.completionDigest,
      receipt: input.completionReceipt,
      manifestId: input.manifestId
    });
    if (execution.outcome === "succeeded") {
      const run = this.requireRun(execution.run_id);
      this.deps.runs.updateLifecycle(run.id, {
        outcome: "completed",
        outcome_state: "succeeded",
        runtime_state: "closed",
        close_reason: "process_exited",
        updated_at: new Date().toISOString()
      });
      this.deps.events.publish(run.id, "external_execution_completed", {
        run_id: run.id,
        external_execution_id: execution.id,
        completion_digest: execution.completion_digest
      });
    }
    return this.deps.externalExecutions.get(input.executionId)!;
  }

  cancelExternalExecution(executionId: string) {
    if (!this.deps.externalExecutions) {
      throw new Error("External execution repository is unavailable.");
    }
    const execution = this.deps.externalExecutions.get(executionId);
    if (!execution) {
      throw new Error(`External execution not found: ${executionId}`);
    }
    const run = this.requireRun(execution.run_id);
    const queued = run.status === "queued" || run.status === "blocked";
    const noActiveProcess = queued || (run.status === "finished" && execution.phase === "awaiting_completion");
    const requested = this.deps.externalExecutions.requestCancellation(execution.id, noActiveProcess);
    if (queued) {
      this.cancelRun(run.id);
      return this.deps.externalExecutions.get(execution.id)!;
    }
    if (noActiveProcess) {
      this.deps.runs.updateLifecycle(run.id, {
        outcome: "canceled",
        runtime_state: "cancelled",
        outcome_state: "unknown",
        close_reason: "system_cancelled",
        updated_at: new Date().toISOString()
      });
      return this.deps.externalExecutions.get(execution.id)!;
    }
    if (requested.phase === "terminal") {
      return requested;
    }

    const running = this.running.get(run.id);
    if (running) {
      running.stopRequested = true;
      running.process.kill("SIGTERM");
      this.deps.externalExecutions.markCancellationSignalled(execution.id);
    } else if (run.status === "active") {
      this.deps.externalExecutions.markFailedByRun(run.id, "cancellation_unacknowledged", "failed");
    }
    this.deps.runs.updateLifecycle(run.id, {
      runtime_state: "cancelling",
      updated_at: new Date().toISOString()
    });
    this.deps.events.publish(run.id, "external_cancellation_requested", {
      run_id: run.id,
      external_execution_id: execution.id
    });
    return this.deps.externalExecutions.get(execution.id)!;
  }

  isRunTokenAuthorized(runId: string, token: string): boolean {
    const run = this.deps.runs.get(runId);
    if (!run || (run.status !== "starting" && run.status !== "active")) {
      return false;
    }
    if (run.interaction_mode === "hitl_thread") {
      const activity = this.hitlActivities.get(runId);
      if (!activity || activity.timedOut) {
        return false;
      }
    }

    const tokenHash = typeof run?.execution.run_token_hash === "string" ? run.execution.run_token_hash : undefined;
    return !!tokenHash && verifyRunToken(token, tokenHash);
  }

  noteRunActivity(runId: string, reason: string): void {
    const activity = this.hitlActivities.get(runId);
    if (!activity || activity.timedOut) {
      return;
    }

    const nowMs = this.clock.now();
    const now = new Date(nowMs).toISOString();
    activity.lastActivityAtMs = nowMs;
    activity.lastActivityAt = now;
    activity.lastActivityReason = reason;
    this.resetHitlIdleTimer(activity);

    const run = this.deps.runs.get(runId);
    if (run) {
      this.deps.runs.updateExecution(runId, {
        ...run.execution,
        hitl_last_activity_at: now,
        hitl_last_activity_reason: reason
      });
    }

    if (nowMs - activity.lastActivityEventAtMs >= 2000) {
      activity.lastActivityEventAtMs = nowMs;
      this.deps.events.publish(runId, "thread_turn_activity", {
        run_id: runId,
        reason,
        at: now,
        idle_timeout_ms: activity.idleTimeoutMs,
        hard_timeout_ms: activity.hardTimeoutMs
      });
    }
  }

  private resetHitlIdleTimer(activity: HitlActivityState): void {
    if (activity.idleTimer) {
      this.clock.clearTimeout(activity.idleTimer);
    }

    activity.idleTimer = activity.idleTimeoutMs > 0
      ? this.clock.setTimeout(() => this.timeoutHitlTurn(activity, "idle_timeout"), activity.idleTimeoutMs)
      : undefined;
    activity.idleTimer?.unref();
  }

  private startHitlHardTimer(activity: HitlActivityState): void {
    if (activity.hardTimer) {
      this.clock.clearTimeout(activity.hardTimer);
    }

    activity.hardTimer = activity.hardTimeoutMs > 0
      ? this.clock.setTimeout(() => this.timeoutHitlTurn(activity, "hard_timeout"), activity.hardTimeoutMs)
      : undefined;
    activity.hardTimer?.unref();
  }

  private timeoutHitlTurn(activity: HitlActivityState, reason: HitlTimeoutReason): void {
    const current = this.hitlActivities.get(activity.runId);
    if (current !== activity || activity.timedOut) {
      return;
    }

    activity.timedOut = true;
    if (activity.idleTimer) {
      this.clock.clearTimeout(activity.idleTimer);
    }
    if (activity.hardTimer) {
      this.clock.clearTimeout(activity.hardTimer);
    }

    const now = new Date(this.clock.now()).toISOString();
    const run = this.deps.runs.get(activity.runId);
    if (run) {
      this.deps.runs.updateExecution(activity.runId, {
        ...run.execution,
        pid: null,
        hitl_timeout_reason: reason,
        hitl_timeout_at: now,
        hitl_last_activity_at: activity.lastActivityAt,
        hitl_last_activity_reason: activity.lastActivityReason
      });
    }

    const payload = {
      run_id: activity.runId,
      reason,
      timeout_ms: reason === "idle_timeout" ? activity.idleTimeoutMs : activity.hardTimeoutMs,
      last_activity_at: activity.lastActivityAt,
      last_activity_reason: activity.lastActivityReason
    };
    this.deps.events.publish(activity.runId, reason === "idle_timeout" ? "thread_turn_idle_timeout" : "thread_turn_hard_timeout", payload);

    const processHandle = activity.processHandle;
    processHandle?.kill("SIGTERM");
    if (processHandle && activity.killGraceMs > 0) {
      this.clock.setTimeout(() => processHandle.kill("SIGKILL"), activity.killGraceMs).unref();
    }
    activity.onTimeout(reason);
  }

  private clearHitlActivity(runId: string): void {
    const activity = this.hitlActivities.get(runId);
    if (!activity) {
      return;
    }

    if (activity.idleTimer) {
      this.clock.clearTimeout(activity.idleTimer);
    }
    if (activity.hardTimer) {
      this.clock.clearTimeout(activity.hardTimer);
    }
    this.hitlActivities.delete(runId);
  }

  private timeoutMessageForActivity(activity: HitlActivityState, reason: HitlTimeoutReason): string {
    if (reason === "idle_timeout") {
      return `HITL adapter turn had no activity for ${activity.idleTimeoutMs}ms. Last activity at ${activity.lastActivityAt} (${activity.lastActivityReason}).`;
    }

    return `HITL adapter turn exceeded hard timeout of ${activity.hardTimeoutMs}ms. Last activity at ${activity.lastActivityAt} (${activity.lastActivityReason}).`;
  }

  markLostRunsOnStartup(): void {
    const candidates = [
      ...this.deps.runs.list({ status: "starting" }),
      ...this.deps.runs.list({ status: "active" })
    ];

    for (const run of candidates) {
      if (run.interaction_mode === "hitl_thread") {
        continue;
      }
      this.deps.runs.updateLifecycle(run.id, finishRunInterrupted(run, "lost"));
      this.deps.externalExecutions?.markProcessLostByRun(run.id);
      this.sealRunWorkspace(run.id);
      this.finalizeWriteEvidence(run.id);
      this.revokeRunToken(run.id);
      this.deps.events.publish(run.id, "run_finished", {
        run_id: run.id,
        status: "finished",
        process_status: "lost",
        outcome: "interrupted"
      });
    }
    this.deps.processSlots?.releaseOrphans();
  }

  sweepExpiredRunScopes(now = new Date().toISOString()): void {
    for (const execution of this.deps.externalExecutions?.expireMissingCompletions(now) ?? []) {
      const run = this.deps.runs.get(execution.run_id);
      if (run) {
        this.deps.runs.updateLifecycle(run.id, {
          outcome: "failed",
          outcome_state: "failed",
          runtime_state: "failed",
          close_reason: "error",
          updated_at: now
        });
        this.deps.events.publish(run.id, "external_completion_missing", {
          run_id: run.id,
          external_execution_id: execution.id,
          condition: "missing_completion"
        });
      }
    }
    if (!this.deps.runWorkspaces || !this.deps.config.dataDir) {
      return;
    }
    for (const workspace of this.deps.runWorkspaces.listExpired(now)) {
      try {
        cleanupRunScopeFiles(workspace.scope_root, this.deps.config.dataDir);
        this.deps.executionManifests?.markLocalOutputsExpiredByRun(workspace.run_id, now);
        this.deps.runWorkspaces.markCleaned(workspace.run_id, now);
        if (this.deps.runs.get(workspace.run_id)) {
          this.deps.events.publish(workspace.run_id, "run_scope_cleaned", {
            run_id: workspace.run_id,
            workspace_mode: workspace.workspace_mode,
            cleanup_attempts: workspace.cleanup_attempts + 1
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.runWorkspaces.markCleanupFailed(workspace.run_id, message);
        if (this.deps.runs.get(workspace.run_id)) {
          this.deps.events.publish(workspace.run_id, "run_scope_cleanup_failed", {
            run_id: workspace.run_id,
            error: message,
            cleanup_attempts: workspace.cleanup_attempts + 1
          });
        }
      }
    }
  }

  private handleProcessExit(runId: string, exit: { code: number | null; signal: NodeJS.Signals | null }): void {
    const running = this.running.get(runId);
    if (running?.stalePoll) {
      clearInterval(running.stalePoll);
    }
    this.running.delete(runId);

    const current = this.deps.runs.get(runId);
    this.deps.processSlots?.release(runId);
    if (!current) {
      return;
    }
    if (current.status === "finished") {
      this.sealRunWorkspace(runId);
      void this.dispatchQueuedForMon(current.monde_id, current.mon_id);
      return;
    }

    const external = this.deps.externalExecutions?.getByRunId(runId);
    const externalUpdated = external
      ? this.deps.externalExecutions?.recordProcessExit(
          external.id,
          { code: exit.code, signal: exit.signal },
          typeof current.scope_snapshot?.recovery_window_seconds === "number"
            ? current.scope_snapshot.recovery_window_seconds
            : 86400
        )
      : undefined;
    if (
      externalUpdated?.outcome === "failed" &&
      current.execution.required_external_mcp_startup_error === true
    ) {
      this.deps.externalExecutions?.setTerminalConditionByRun(runId, "required_mcp_unavailable");
    }
    const patch = externalUpdated?.outcome === "cancelled"
      ? { ...finishRunStopped(current), outcome: "canceled" as const }
      : running?.stopRequested
        ? finishRunStopped(current)
        : finishRunFromExit(current, exit);
    this.deps.runs.updateLifecycle(runId, patch);
    if (externalUpdated?.phase === "awaiting_completion") {
      this.deps.runs.updateLifecycle(runId, {
        runtime_state: "awaiting_completion",
        outcome: "unknown",
        outcome_state: "unknown",
        updated_at: new Date().toISOString()
      });
    } else if (externalUpdated?.outcome === "succeeded") {
      this.deps.runs.updateLifecycle(runId, {
        runtime_state: "closed",
        outcome: "completed",
        outcome_state: "succeeded",
        updated_at: new Date().toISOString()
      });
    }
    this.sealRunWorkspace(runId);
    const finished = this.requireRun(runId);
    this.finalizeWriteEvidence(runId);
    this.revokeRunToken(runId);
    this.deps.events.publish(runId, "run_process_exit", {
      run_id: runId,
      code: exit.code,
      signal: exit.signal
    });
    this.deps.events.publish(runId, "run_finished", {
      run_id: runId,
      status: finished.status,
      process_status: finished.process_status,
      outcome: finished.outcome
    });
    this.updatePlanAssignmentForRun(finished, planAssignmentStatusForRun(finished));
    void this.dispatchQueuedForMon(finished.monde_id, finished.mon_id);
  }

  private handleProcessError(runId: string, error: Error): void {
    const running = this.running.get(runId);
    if (running?.stalePoll) {
      clearInterval(running.stalePoll);
    }
    this.running.delete(runId);
    const current = this.deps.runs.get(runId);
    this.deps.processSlots?.release(runId);
    if (!current || current.status === "finished") {
      return;
    }

    this.deps.runs.updateLifecycle(runId, finishRunInterrupted(current, "crashed"));
    this.deps.externalExecutions?.markFailedByRun(
      runId,
      current.execution.required_external_mcp_startup_error === true
        ? "required_mcp_unavailable"
        : "process_crashed"
    );
    this.sealRunWorkspace(runId);
    const finished = this.requireRun(runId);
    this.finalizeWriteEvidence(runId);
    this.revokeRunToken(runId);
    this.deps.events.publish(runId, "run_error_output", {
      run_id: runId,
      stream: "stderr",
      chunk: `${error.message}\n`
    });
    this.deps.events.publish(runId, "run_finished", {
      run_id: runId,
      status: finished.status,
      process_status: finished.process_status,
      outcome: finished.outcome
    });
    this.updatePlanAssignmentForRun(finished, "blocked");
    void this.dispatchQueuedForMon(finished.monde_id, finished.mon_id);
  }

  private finalizeWriteEvidence(runId: string): void {
    const run = this.deps.runs.get(runId);
    if (!run || run.execution.can_write !== true) {
      return;
    }

    const diffCapture = isRecord(run.execution.diff_capture) ? run.execution.diff_capture : {};
    if (diffCapture.completed === true) {
      return;
    }

    if (diffCapture.available !== true) {
      this.addWarning(runId, "no_git_diff_available");
      this.deps.runs.updateExecution(runId, {
        ...run.execution,
        diff_capture: {
          ...diffCapture,
          completed: true,
          completed_at: new Date().toISOString()
        }
      });
      this.deps.logs.append(runId, { type: "write_evidence_unavailable", reason: "no_git_diff_available" }, "audit");
      return;
    }

    const gitRoot = typeof diffCapture.git_root === "string" ? diffCapture.git_root : undefined;
    if (!gitRoot) {
      this.addWarning(runId, "no_git_diff_available");
      return;
    }

    const afterStatus = gitText(gitRoot, ["status", "--porcelain=v1"]) ?? "";
    const changedFiles = parseChangedFiles(afterStatus);
    const diffStat = gitText(gitRoot, ["diff", "--stat"]) ?? "";
    const fullDiff = gitText(gitRoot, ["diff"], 1024 * 1024) ?? "";
    const bounded = boundDiff(fullDiff);
    const artifacts: string[] = [];
    const mondeRoot = typeof run.scope_snapshot?.monde_root === "string" ? run.scope_snapshot.monde_root : gitRoot;
    const artifactRoot = path.join(mondeRoot, ".monde", "run-artifacts", run.id);
    fs.mkdirSync(artifactRoot, { recursive: true });

    const summaryPath = path.join(artifactRoot, "diff-summary.txt");
    fs.writeFileSync(
      summaryPath,
      [
        `run: ${run.id}`,
        `head: ${String(diffCapture.head ?? "unknown")}`,
        `dirty_before: ${String(diffCapture.dirty_before ?? false)}`,
        "",
        "before_status:",
        String(diffCapture.before_status ?? ""),
        "",
        "after_status:",
        afterStatus,
        "",
        "diff_stat:",
        diffStat,
        "",
        "changed_files:",
        ...changedFiles.map((file) => `- ${file}`)
      ].join("\n"),
      "utf8"
    );
    artifacts.push(
      this.deps.artifacts.register({
        monde_id: run.monde_id,
        mon_id: run.mon_id,
        run_id: run.id,
        type: "diff",
        path: summaryPath,
        title: "Run diff summary",
        summary: `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`
      }).id
    );

    if (bounded.text.trim()) {
      const diffPath = path.join(artifactRoot, bounded.truncated ? "diff-truncated.patch" : "diff.patch");
      fs.writeFileSync(diffPath, bounded.text, "utf8");
      artifacts.push(
        this.deps.artifacts.register({
          monde_id: run.monde_id,
          mon_id: run.mon_id,
          run_id: run.id,
          type: "diff",
          path: diffPath,
          title: bounded.truncated ? "Run diff (truncated)" : "Run diff",
          summary: diffStat.trim() || undefined
        }).id
      );
    }

    for (const changedFile of changedFiles.slice(0, 25)) {
      artifacts.push(
        this.deps.artifacts.register({
          monde_id: run.monde_id,
          mon_id: run.mon_id,
          run_id: run.id,
          type: "file",
          path: path.join(gitRoot, changedFile),
          title: changedFile,
          summary: "Changed during write-capable run."
        }).id
      );
    }

    if (changedFiles.length > 25) {
      this.addWarning(runId, "changed_file_artifacts_truncated");
    }
    if (bounded.truncated) {
      this.addWarning(runId, "diff_truncated");
    }

    const latest = this.requireRun(runId);
    this.deps.runs.updateExecution(runId, {
      ...latest.execution,
      diff_capture: {
        ...diffCapture,
        completed: true,
        completed_at: new Date().toISOString(),
        after_status: afterStatus,
        changed_files: changedFiles,
        diff_stat: diffStat,
        diff_truncated: bounded.truncated,
        artifacts
      }
    });
    this.deps.logs.append(
      runId,
      { type: "write_evidence_captured", changed_files: changedFiles, diff_artifacts: artifacts },
      "audit"
    );
    this.deps.events.publish(runId, "write_evidence_captured", {
      run_id: runId,
      changed_files: changedFiles,
      artifacts
    });
  }

  private startScopeWarningPoll(
    runId: string,
    scope: { monde_config: string; mon_config: string; mon_root: string },
    initial: Record<string, ScopeFingerprint>
  ): NodeJS.Timeout | undefined {
    const intervalMs = Number.parseInt(process.env.MONDE_STALE_SCOPE_INTERVAL_MS ?? "5000", 10);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return undefined;
    }

    return setInterval(() => {
      const run = this.deps.runs.get(runId);
      if (!run || run.status !== "active") {
        return;
      }

      const current = captureScopeFingerprints(scope);
      if (!sameFingerprint(initial[scope.monde_config], current[scope.monde_config]) || !sameFingerprint(initial[scope.mon_config], current[scope.mon_config])) {
        this.addWarning(runId, "stale_scope");
      }

      if (!current[scope.mon_root]?.exists) {
        this.addWarning(runId, "missing_identity_root");
      }
    }, intervalMs).unref();
  }

  private addWarning(runId: string, warning: string): void {
    const run = this.deps.runs.get(runId);
    if (!run || run.warnings.includes(warning)) {
      return;
    }

    this.deps.runs.updateLifecycle(runId, addRunWarning(run, warning));
    this.deps.events.publish(runId, "warning_added", { run_id: runId, warning });
  }

  private revokeRunToken(runId: string): void {
    this.deps.externalMcpGrants?.revokeForRun(runId);
    const run = this.deps.runs.get(runId);
    if (!run || typeof run.execution.run_token_hash !== "string") {
      return;
    }

    const { run_token_hash: _revokedTokenHash, ...execution } = run.execution;
    this.deps.runs.updateExecution(runId, {
      ...execution,
      run_token_revoked_at: new Date().toISOString()
    });
  }

  private buildExternalMcpRuntime(
    run: RunRecord,
    scope: RunScopeSnapshot
  ): { runtimes: ExternalMcpRuntime[]; grantIds: string[]; introspectionUrl?: string } {
    const runtimes: ExternalMcpRuntime[] = [];
    const grantIds: string[] = [];
    const externalExecution = this.deps.externalExecutions?.getByRunId(run.id);
    const introspectionUrl = externalMcpIntrospectionUrl(this.deps.config.serviceAddr);

    for (const server of scope.mon_json.external_mcp_servers) {
      let token: string | undefined;
      if (server.auth.type === "run_claims") {
        if (!this.deps.externalMcpGrants) {
          throw new Error(`External MCP grant storage is unavailable for server ${server.id}.`);
        }
        const expiresAt = new Date(Date.now() + scope.recovery_window_seconds * 1000).toISOString();
        const issued = this.deps.externalMcpGrants.issue({
          externalExecutionId: externalExecution?.id,
          runId: run.id,
          serverId: server.id,
          audience: server.auth.audience,
          claims: {
            run_id: run.id,
            mon_id: run.mon_id,
            monde_id: run.monde_id,
            integration_id: externalExecution?.integration_id ?? "monde",
            external_execution_key: externalExecution?.external_execution_key ?? run.id,
            external_scope: externalExecution?.external_scope ?? null
          },
          expiresAt
        });
        token = issued.token;
        grantIds.push(issued.grant.id);
      }

      const resolvedReadMounts =
        server.transport === "stdio"
          ? server.read_mounts.map((mount) =>
              resolveRunScopedPath(scope, mount, `external MCP ${server.id} read mount ${mount.path}`)
            )
          : [];
      const resolvedCwd =
        server.transport === "stdio" && server.cwd
          ? resolveRunScopedPath(scope, server.cwd, `external MCP ${server.id} cwd`)
          : undefined;
      runtimes.push({ server, token, resolvedReadMounts, resolvedCwd });
    }
    return {
      runtimes,
      grantIds,
      introspectionUrl: runtimes.some((runtime) => runtime.server.auth.type === "run_claims")
        ? introspectionUrl
        : undefined
    };
  }

  private sealRunWorkspace(runId: string): void {
    const workspace = this.deps.runWorkspaces?.get(runId);
    if (!workspace || workspace.state === "sealed" || workspace.state === "cleaned") {
      return;
    }
    const run = this.deps.runs.get(runId);
    const recoverySeconds =
      run?.scope_snapshot?.recovery_window_seconds &&
      typeof run.scope_snapshot.recovery_window_seconds === "number"
        ? run.scope_snapshot.recovery_window_seconds
        : 86400;
    const sealedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(sealedAt) + recoverySeconds * 1000).toISOString();
    try {
      sealRunScopeFiles(workspace.scope_root);
      this.deps.runWorkspaces?.seal(runId, sealedAt, expiresAt);
      if (run) {
        this.deps.events.publish(runId, "run_scope_sealed", {
          run_id: runId,
          workspace_mode: workspace.workspace_mode,
          expires_at: expiresAt
        });
      }
    } catch (error) {
      this.deps.runWorkspaces?.markCleanupFailed(
        runId,
        `seal_failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private requireRun(runId: string): RunRecord {
    const run = this.deps.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    return run;
  }

  private updatePlanAssignmentForRun(run: RunRecord, status: PlanAssignmentStatus): void {
    if (run.origin.type !== "plan" || !run.origin.assignment || !this.deps.plans) {
      return;
    }

    this.deps.plans.updateAssignmentStatusForRun(run.origin.assignment, status, run.id);
  }
}

function planAssignmentStatusForRun(run: RunRecord): PlanAssignmentStatus {
  if (run.outcome === "canceled") {
    return "canceled";
  }

  if (run.outcome === "failed" || run.outcome === "interrupted" || run.outcome === "stopped") {
    return "blocked";
  }

  return "satisfied";
}

function requestedSandboxModeForRun(run: RunRecord, scope: RunScopeSnapshot): string {
  if (scope.workspace_mode === "isolated") {
    return "isolated";
  }
  if (typeof run.execution.sandbox_mode === "string") {
    return run.execution.sandbox_mode;
  }

  const monHarnessDefault = scope.mon_json.harness_defaults?.[scope.harness]?.sandbox_mode;
  if (monHarnessDefault) {
    return monHarnessDefault;
  }

  const harness = scope.harness;
  if (harness === "codex") {
    return "read-only";
  }

  if (harness === "basic-process") {
    return "process-permissions";
  }

  if (harness === "opencode") {
    return "adapter-default";
  }

  return "adapter-default";
}

function sandboxModeForHarness(harness: string, requestedMode: string): string {
  if (harness === "codex") {
    return requestedMode === "isolated"
      ? "isolated"
      : requestedMode === "workspace-write"
        ? "workspace-write"
        : "read-only";
  }

  if (harness === "opencode") {
    return "adapter-default";
  }

  return "process-permissions";
}

function approvalModeForHarness(harness: string): string {
  return harness === "codex" ? "never" : "not_applicable";
}

function canWriteForHarness(harness: string, sandboxMode: string): boolean {
  if (harness === "codex") {
    return sandboxMode === "workspace-write" || sandboxMode === "isolated";
  }

  return harness === "basic-process";
}

function writeScopeForHarness(_harness: string, workRoot: string, canWrite: boolean): string {
  if (canWrite) {
    return workRoot;
  }

  return "none";
}

function runnerTypeForHarness(harness: string): string {
  if (harness === "basic-process" || harness === "codex" || harness === "opencode") {
    return harness;
  }

  return "adapter-native";
}

function interactionModeForHarness(harness: string): HarnessInteractionMode {
  return harness === "basic-process" ? "interactive" : "single-shot";
}

function inputModeForHarness(harness: string): HarnessInputMode {
  return harness === "basic-process" ? "open" : "closed";
}

function outputModeForHarness(harness: string): HarnessOutputMode {
  if (harness === "codex") {
    return "json-events";
  }

  if (harness === "basic-process") {
    return "terminal";
  }

  return "plain";
}

function captureGitBaseline(mondeRoot: string): Record<string, unknown> {
  const gitRoot = gitText(mondeRoot, ["rev-parse", "--show-toplevel"])?.trim();
  if (!gitRoot) {
    return {
      enabled: true,
      available: false,
      warning: "no_git_diff_available",
      started_at: new Date().toISOString()
    };
  }

  const head = gitText(gitRoot, ["rev-parse", "HEAD"])?.trim() || "unknown";
  const beforeStatus = gitText(gitRoot, ["status", "--porcelain=v1"]) ?? "";
  return {
    enabled: true,
    available: true,
    git_root: gitRoot,
    head,
    before_status: beforeStatus,
    dirty_before: beforeStatus.trim().length > 0,
    started_at: new Date().toISOString()
  };
}

function gitText(cwd: string, args: string[], maxBuffer = 512 * 1024): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer
  });
  if (result.status !== 0) {
    return undefined;
  }

  return result.stdout;
}

function parseChangedFiles(status: string): string[] {
  const files = new Set<string>();
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const rawPath = line.slice(3).trim();
    const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
    files.add(stripGitQuotes(filePath));
  }

  return [...files].sort();
}

function stripGitQuotes(filePath: string): string {
  if (filePath.startsWith('"') && filePath.endsWith('"')) {
    return filePath.slice(1, -1).replace(/\\"/g, '"');
  }

  return filePath;
}

function boundDiff(diff: string): { text: string; truncated: boolean } {
  const maxChars = 256 * 1024;
  if (diff.length <= maxChars) {
    return { text: diff, truncated: false };
  }

  return {
    text: `${diff.slice(0, maxChars)}\n\n[Monde truncated this diff artifact at ${maxChars} characters.]\n`,
    truncated: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeoutMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

interface ScopeFingerprint {
  exists: boolean;
  mtime_ms?: number;
  size?: number;
}

function captureScopeFingerprints(scope: { monde_config: string; mon_config: string; mon_root: string }): Record<string, ScopeFingerprint> {
  return {
    [scope.monde_config]: statFingerprint(scope.monde_config),
    [scope.mon_config]: statFingerprint(scope.mon_config),
    [scope.mon_root]: statFingerprint(scope.mon_root)
  };
}

function statFingerprint(filePath: string): ScopeFingerprint {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, mtime_ms: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false };
  }
}

function sameFingerprint(a: ScopeFingerprint | undefined, b: ScopeFingerprint | undefined): boolean {
  return !!a && !!b && a.exists === b.exists && a.mtime_ms === b.mtime_ms && a.size === b.size;
}

function externalMcpIntrospectionUrl(serviceAddr: string): string {
  const url = new URL("/external-mcp/introspect", serviceAddr);
  if (url.hostname === "0.0.0.0") {
    url.hostname = "127.0.0.1";
  } else if (url.hostname === "[::]") {
    url.hostname = "[::1]";
  }
  return url.toString();
}

function hitlHarnessForThread(run: RunRecord, scopeHarness: string): string {
  const explicit = typeof run.execution?.chat_harness === "string" ? run.execution.chat_harness : undefined;
  if (explicit) {
    return explicit;
  }

  if (scopeHarness && scopeHarness !== "basic-process") {
    return scopeHarness;
  }

  return "codex";
}

function buildHitlTurnPrompt(
  run: RunRecord,
  content: string,
  context: Record<string, unknown> | undefined,
  canWrite: boolean,
  writeScope: string,
  events: Array<{ event_type: string; payload: Record<string, unknown>; created_at: string }>
): string {
  const history = events
    .filter((event) => event.event_type === "user_message" || event.event_type === "mon_message" || event.event_type === "system_message" || event.event_type === "error")
    .slice(-16)
    .map((event) => {
      const role = event.event_type === "user_message"
        ? "operator"
        : event.event_type === "mon_message"
          ? "mon"
          : event.event_type === "error"
            ? "error"
            : "system";
      return `${role} (${event.created_at}): ${eventPayloadContent(event.payload)}`;
    })
    .join("\n\n");

  return [
    "You are responding inside an open Monde human-in-the-loop mon chat thread.",
    `Thread run id: ${run.id}`,
    `Mon id: ${run.mon_id}`,
    "",
    "Respond directly to the operator as the mon. Keep the thread open; do not mark the run complete or resolved.",
    canWrite
      ? `This chat turn is write-capable. Keep file edits inside write_scope: ${writeScope}.`
      : "Default to read-only investigation. Do not edit files from this chat turn unless a future write-capable chat policy explicitly grants that.",
    "Use Monde MCP tools such as runtime_scope() and search_docs(query) when they help ground the answer.",
    "",
    "Current UI context:",
    JSON.stringify(context ?? {}, null, 2),
    "",
    "Recent thread history:",
    history || "(no prior messages)",
    "",
    "Latest operator message:",
    content
  ].join("\n");
}

function eventPayloadContent(payload: Record<string, unknown>): string {
  const content = typeof payload.content === "string" ? payload.content : undefined;
  if (content) {
    return content;
  }

  return JSON.stringify(payload);
}

function extractHitlResponse(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trimStart().startsWith("[codex]"));

  const response = lines.join("\n").trim();
  if (response) {
    return response;
  }

  const fallback = stdout.trim();
  return fallback || "The mon did not produce a response.";
}
