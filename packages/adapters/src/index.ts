import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimePrompt } from "@monde/core";
import type { RunRecord } from "@monde/core";

export interface HarnessAdapterContext {
  runId: string;
  runToken: string;
  monRoot: string;
  workRoot: string;
  prompt: string;
  sandboxMode?: string;
  runtimePrompt?: string;
  run?: Pick<RunRecord, "id" | "origin" | "intent" | "status" | "process_status" | "outcome" | "warnings">;
  scopeSnapshot?: Record<string, unknown>;
  model?: string | null;
  serviceAddr: string;
  mcpAddr: string;
}

export interface HarnessLaunchCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdinMode?: "pipe" | "closed";
  outputMode?: "raw" | "codex-json-filtered";
}

export type HarnessInteractionMode = "interactive" | "single-shot";
export type HarnessInputMode = "open" | "closed";
export type HarnessOutputMode = "json-events" | "terminal" | "plain";

export interface HarnessDetection {
  available: boolean;
  adapter_status: "detected" | "missing" | "partial" | "unsupported";
  mcp_status: "configured" | "manual_required" | "unsupported";
  prompt_injection_status: "automatic" | "manual_required" | "unsupported";
  supports_readonly?: boolean;
  supports_write?: boolean;
  supports_interactive_input?: boolean;
  interaction_mode?: HarnessInteractionMode;
  input_mode?: HarnessInputMode;
  output_mode?: HarnessOutputMode;
  supported_sandbox_modes?: string[];
  default_sandbox_mode?: string;
  command?: string;
  version?: string;
  reason?: string;
  details?: string;
  notes?: string[];
}

export interface HarnessAdapter {
  id: string;
  label: string;
  detect(): HarnessDetection;
  buildCommand(context: HarnessAdapterContext): HarnessLaunchCommand;
  buildArgs?(context: HarnessAdapterContext): string[];
  buildEnv(context: HarnessAdapterContext): Record<string, string>;
  buildRuntimePromptInjection(context: HarnessAdapterContext): Record<string, string>;
  buildMcpConfig?(context: HarnessAdapterContext): Record<string, unknown>;
  start?(context: HarnessAdapterContext): HarnessLaunchCommand;
}

function baseEnv(context: HarnessAdapterContext): Record<string, string> {
  const runtimePrompt = runtimePromptForContext(context);
  return {
    MONDE_RUN_ID: context.runId,
    MONDE_RUN_TOKEN: context.runToken,
    MONDE_SERVICE_ADDR: context.serviceAddr,
    MONDE_MCP_ADDR: context.mcpAddr,
    MONDE_MON_ROOT: context.monRoot,
    MONDE_WORK_ROOT: context.workRoot,
    MONDE_RUNTIME_PROMPT: runtimePrompt,
    MONDE_MCP_CONFIG: JSON.stringify(stdioMcpConfig(context))
  };
}

export const basicProcessAdapter: HarnessAdapter = {
  id: "basic-process",
  label: "Basic shell process",
  detect() {
    return {
      available: true,
      adapter_status: "detected",
      mcp_status: "configured",
      prompt_injection_status: "automatic",
      supports_readonly: false,
      supports_write: true,
      supports_interactive_input: true,
      interaction_mode: "interactive",
      input_mode: "open",
      output_mode: "terminal",
      supported_sandbox_modes: ["process-permissions"],
      default_sandbox_mode: "process-permissions",
      command: process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "/bin/sh"
    };
  },
  buildCommand(context) {
    if (process.platform === "win32") {
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", context.prompt],
        env: this.buildEnv(context),
        cwd: context.monRoot
      };
    }

    return {
      command: process.env.SHELL || "/bin/sh",
      args: ["-lc", context.prompt],
      env: this.buildEnv(context),
      cwd: context.monRoot
    };
  },
  buildEnv: baseEnv,
  buildRuntimePromptInjection(context) {
    return { MONDE_RUNTIME_PROMPT: runtimePromptForContext(context) };
  },
  buildMcpConfig: stdioMcpConfig
};

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  label: "Codex CLI",
  detect() {
    const detection = commandDetection("codex", "Codex CLI is not installed or not on PATH.");
    if (!detection.available) {
      return detection;
    }

    return {
      ...detection,
      mcp_status: bridgeAvailable() ? "configured" : "manual_required",
      supports_readonly: true,
      supports_write: true,
      supports_interactive_input: false,
      interaction_mode: "single-shot",
      input_mode: "closed",
      output_mode: "json-events",
      supported_sandbox_modes: ["read-only", "workspace-write"],
      default_sandbox_mode: "read-only",
      details: bridgeAvailable()
        ? "Codex can be launched with a Monde stdio MCP bridge."
        : "Codex was detected, but the Monde stdio bridge command is not on PATH. Set MONDE_MCP_BRIDGE_COMMAND/ARGS or install the monde CLI.",
      notes: [
        "Default Codex runs are read-only.",
        "Pass --write or --sandbox workspace-write to grant bounded writes under the mon work_root.",
        "Monde launches Codex through codex exec as a single-shot run; send a complete prompt rather than stdin turns."
      ]
    };
  },
  buildCommand(context) {
    const args = this.buildArgs?.(context) ?? [];
    return {
      command: "codex",
      args,
      env: this.buildEnv(context),
      cwd: context.monRoot,
      stdinMode: "closed",
      outputMode: "codex-json-filtered"
    };
  },
  buildArgs(context) {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--cd",
      context.workRoot,
      "--json",
      "--color",
      "never",
      "--sandbox",
      codexSandboxMode(context),
      "-c",
      `approval_policy=${tomlString("never")}`,
      "-c",
      `mcp_servers.monde.command=${tomlString(bridgeCommand())}`,
      "-c",
      `mcp_servers.monde.args=${tomlStringArray(bridgeArgs())}`,
      "-c",
      `mcp_servers.monde.default_tools_approval_mode=${tomlString("approve")}`,
      "-c",
      `mcp_servers.monde.enabled_tools=${tomlStringArray(mondeMcpTools)}`,
      "-c",
      `mcp_servers.monde.env.MONDE_RUN_ID=${tomlString(context.runId)}`,
      "-c",
      `mcp_servers.monde.env.MONDE_RUN_TOKEN=${tomlString(context.runToken)}`,
      "-c",
      `mcp_servers.monde.env.MONDE_MCP_ADDR=${tomlString(context.mcpAddr)}`,
      "-c",
      `mcp_servers.monde.env.MONDE_SERVICE_ADDR=${tomlString(context.serviceAddr)}`
    ];

    if (context.model) {
      args.push("--model", context.model);
    }

    args.push(`${runtimePromptForContext(context)}\n\nOperator request:\n${context.prompt}`);
    return args;
  },
  buildEnv: baseEnv,
  buildRuntimePromptInjection(context) {
    return { prompt: runtimePromptForContext(context) };
  },
  buildMcpConfig(context) {
    return stdioMcpConfig(context);
  }
};

export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  label: "opencode",
  detect() {
    const detection = commandDetection("opencode", "opencode is not installed or not on PATH.");
    if (!detection.available) {
      return detection;
    }

    return {
      ...detection,
      adapter_status: "partial",
      mcp_status: "manual_required",
      supports_readonly: false,
      supports_write: false,
      supports_interactive_input: false,
      interaction_mode: "single-shot",
      input_mode: "closed",
      output_mode: "plain",
      supported_sandbox_modes: ["adapter-default"],
      default_sandbox_mode: "adapter-default",
      details: "opencode was detected, but Monde has not pinned an automatic opencode MCP configuration path yet."
    };
  },
  buildCommand(context) {
    return {
      command: "opencode",
      args: this.buildArgs?.(context) ?? ["run", context.prompt],
      env: this.buildEnv(context),
      cwd: context.monRoot,
      stdinMode: "closed"
    };
  },
  buildArgs(context) {
    if (context.model) {
      return ["run", "--model", context.model, `${runtimePromptForContext(context)}\n\nOperator request:\n${context.prompt}`];
    }

    return ["run", `${runtimePromptForContext(context)}\n\nOperator request:\n${context.prompt}`];
  },
  buildEnv: baseEnv,
  buildRuntimePromptInjection(context) {
    return { prompt: runtimePromptForContext(context) };
  },
  buildMcpConfig(context) {
    return {
      ...stdioMcpConfig(context),
      status: "manual_required",
      note: "Automatic opencode MCP configuration is not claimed by Monde MVP."
    };
  }
};

export const harnessAdapters = [basicProcessAdapter, codexAdapter, opencodeAdapter] as const;

const mondeMcpTools = [
  "runtime_scope",
  "search_docs",
  "list_plans",
  "get_plan",
  "search_plans",
  "list_runs",
  "get_run",
  "write_log",
  "register_artifact",
  "list_artifacts",
  "get_artifact"
];

export function detectHarnessAdapters(): HarnessDetection[] {
  return harnessAdapters.map((adapter) => adapter.detect());
}

export function getHarnessAdapter(id: string | null | undefined): HarnessAdapter | undefined {
  return harnessAdapters.find((adapter) => adapter.id === id);
}

function commandDetection(command: string, missingReason: string): HarnessDetection {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.error) {
    return {
      available: false,
      adapter_status: "missing",
      mcp_status: "unsupported",
      prompt_injection_status: "unsupported",
      supports_readonly: false,
      supports_write: false,
      supports_interactive_input: false,
      interaction_mode: "single-shot",
      input_mode: "closed",
      output_mode: "plain",
      supported_sandbox_modes: [],
      command,
      reason: missingReason
    };
  }

  return {
    available: true,
    adapter_status: "detected",
    mcp_status: "manual_required",
    prompt_injection_status: "automatic",
    supports_readonly: false,
    supports_write: false,
    supports_interactive_input: false,
    interaction_mode: "single-shot",
    input_mode: "closed",
    output_mode: "plain",
    supported_sandbox_modes: [],
    command,
    version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0]
  };
}

function codexSandboxMode(context: HarnessAdapterContext): string {
  return context.sandboxMode === "workspace-write" ? "workspace-write" : "read-only";
}

function runtimePromptForContext(context: HarnessAdapterContext): string {
  if (context.runtimePrompt) {
    return context.runtimePrompt;
  }

  if (context.run) {
    return buildRuntimePrompt(context.run, undefined, undefined, context.scopeSnapshot ?? {});
  }

  return [
    "You are running inside Monde.",
    `Run id: ${context.runId}`,
    `Identity root: ${context.monRoot}`,
    `Work root: ${context.workRoot}`,
    "Use runtime_scope() when uncertain about current run context."
  ].join("\n");
}

function stdioMcpConfig(context: HarnessAdapterContext): Record<string, unknown> {
  return {
    type: "stdio",
    command: bridgeCommand(),
    args: bridgeArgs(),
    env: {
      MONDE_RUN_ID: context.runId,
      MONDE_RUN_TOKEN: context.runToken,
      MONDE_MCP_ADDR: context.mcpAddr,
      MONDE_SERVICE_ADDR: context.serviceAddr
    }
  };
}

function bridgeCommand(): string {
  if (process.env.MONDE_MCP_BRIDGE_COMMAND) {
    return process.env.MONDE_MCP_BRIDGE_COMMAND;
  }

  if (spawnSync("monde", ["--help"], { encoding: "utf8" }).status === 0) {
    return "monde";
  }

  return localCliCommand() ?? "monde";
}

function bridgeArgs(): string[] {
  const raw = process.env.MONDE_MCP_BRIDGE_ARGS;
  return raw ? raw.split(/\s+/).filter(Boolean) : ["mcp", "bridge"];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function bridgeAvailable(): boolean {
  const command = bridgeCommand();
  if (command === "monde") {
    return spawnSync(command, ["--help"], { encoding: "utf8" }).status === 0;
  }

  const args = bridgeArgs();
  return spawnSync(command, args.length ? [...args, "--help"] : ["--help"], { encoding: "utf8" }).error === undefined;
}

function localCliCommand(): string | undefined {
  const adapterDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(adapterDir, "../../cli/dist/index.js"),
    path.resolve(adapterDir, "../../../cli/dist/index.js")
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}
