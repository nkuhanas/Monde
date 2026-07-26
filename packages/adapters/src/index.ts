import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimePrompt, getMondePlatformPaths } from "@monde/core";
import type { RunRecord } from "@monde/core";
import type { MonConfig } from "@monde/core";

export interface ExternalMcpRuntime {
  server: MonConfig["external_mcp_servers"][number];
  token?: string;
  resolvedReadMounts: string[];
  resolvedCwd?: string;
}

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
  workspaceMode?: "shared" | "isolated";
  scratchPath?: string;
  contextSnapshotPath?: string;
  readMounts?: string[];
  runScopesRoot?: string;
  externalMcpServers?: ExternalMcpRuntime[];
  externalMcpIntrospectionUrl?: string;
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
  supports_isolated_runs?: boolean;
  supports_external_mcp?: boolean;
  isolation_status?: "verified" | "verification_required" | "unsupported";
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
  const externalGrantEnvironment: Record<string, string> = {};
  for (const runtime of context.externalMcpServers ?? []) {
    if (runtime.server.auth.type === "run_claims" && runtime.token) {
      externalGrantEnvironment[runtime.server.auth.token_env_var] = runtime.token;
    }
  }
  return {
    MONDE_RUN_ID: context.runId,
    MONDE_RUN_TOKEN: context.runToken,
    MONDE_SERVICE_ADDR: context.serviceAddr,
    MONDE_MCP_ADDR: context.mcpAddr,
    MONDE_MON_ROOT: context.monRoot,
    MONDE_WORK_ROOT: context.workRoot,
    MONDE_WORKSPACE_MODE: context.workspaceMode ?? "shared",
    ...(context.scratchPath ? { MONDE_RUN_SCRATCH: context.scratchPath } : {}),
    ...(context.contextSnapshotPath ? { MONDE_ACTOR_CONTEXT: context.contextSnapshotPath } : {}),
    ...(context.externalMcpIntrospectionUrl
      ? { MONDE_RUN_CLAIMS_INTROSPECTION_URL: context.externalMcpIntrospectionUrl }
      : {}),
    ...externalGrantEnvironment,
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
      supports_isolated_runs: false,
      isolation_status: "unsupported",
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
      supported_sandbox_modes: ["read-only", "workspace-write", "isolated"],
      default_sandbox_mode: "read-only",
      supports_isolated_runs: codexIsolationStatus(detection.version).status === "verified",
      supports_external_mcp: true,
      isolation_status: codexIsolationStatus(detection.version).status,
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
      cwd: context.workspaceMode === "isolated" ? context.scratchPath ?? context.workRoot : context.monRoot,
      stdinMode: "closed",
      outputMode: "codex-json-filtered"
    };
  },
  buildArgs(context) {
    if (context.workspaceMode === "isolated") {
      return isolatedCodexArgs(context);
    }
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
      `mcp_servers.monde.env_vars=${tomlStringArray([
        "MONDE_RUN_ID",
        "MONDE_RUN_TOKEN",
        "MONDE_MCP_ADDR",
        "MONDE_SERVICE_ADDR"
      ])}`
    ];

    appendExternalMcpArgs(args, context);

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
      supports_isolated_runs: false,
      isolation_status: "unsupported",
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

function isolatedCodexArgs(context: HarnessAdapterContext): string[] {
  if (!context.scratchPath || !context.contextSnapshotPath || !context.runScopesRoot) {
    throw new Error("Isolated Codex runs require scratch, context snapshot, and run-scope paths.");
  }

  const profile = "monde_isolated";
  const filesystemPermissions: Record<string, string> = {
    ":minimal": "read",
    [context.runScopesRoot]: "deny",
    [context.contextSnapshotPath]: "read",
    [context.scratchPath]: "write"
  };
  for (const mount of context.readMounts ?? []) {
    filesystemPermissions[mount] = "read";
  }
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--cd",
    context.scratchPath,
    "--json",
    "--color",
    "never",
    "-c",
    `approval_policy=${tomlString("never")}`,
    "-c",
    `default_permissions=${tomlString(profile)}`,
    "-c",
    `permissions.${profile}.filesystem=${tomlStringMap(filesystemPermissions)}`,
    "-c",
    `mcp_servers.monde.command=${tomlString(bridgeCommand())}`,
    "-c",
    `mcp_servers.monde.args=${tomlStringArray(bridgeArgs())}`,
    "-c",
    `mcp_servers.monde.default_tools_approval_mode=${tomlString("approve")}`,
    "-c",
    `mcp_servers.monde.enabled_tools=${tomlStringArray(mondeMcpTools)}`,
    "-c",
    `mcp_servers.monde.env_vars=${tomlStringArray([
      "MONDE_RUN_ID",
      "MONDE_RUN_TOKEN",
      "MONDE_MCP_ADDR",
      "MONDE_SERVICE_ADDR"
    ])}`
  ];

  appendExternalMcpArgs(args, context);

  if (context.model) {
    args.push("--model", context.model);
  }
  args.push(`${runtimePromptForContext(context)}\n\nOperator request:\n${context.prompt}`);
  return args;
}

export interface CodexIsolationFingerprint {
  codex_version: string;
  codex_binary_sha256: string;
  bwrap_version: string;
  bwrap_binary_sha256: string;
  sandbox_policy_sha256: string;
  node_version: string;
  platform: string;
  release: string;
  arch: string;
}

export interface CodexIsolationAttestation {
  verified_at: string;
  fingerprint: CodexIsolationFingerprint;
  command_probe: "passed";
  stdio_child_probe: "passed";
}

const codexIsolationPolicyDescriptor = [
  "version=1",
  "codex:minimal-system=read",
  "codex:run-scopes-parent=deny",
  "codex:actor-context=read",
  "codex:current-scratch=write",
  "codex:explicit-read-mounts=read",
  "stdio:die-with-parent",
  "stdio:unshare-pid",
  "stdio:unshare-ipc",
  "stdio:system-paths=read-only",
  "stdio:tmp=ephemeral",
  "stdio:declared-mounts-only"
].join("\n");

export const codexIsolationPolicySha256 = createHash("sha256")
  .update(codexIsolationPolicyDescriptor, "utf8")
  .digest("hex");

export function codexIsolationAttestationPath(): string {
  return path.join(getMondePlatformPaths().dataDir, "adapter-attestations", "codex-isolation.json");
}

export function currentCodexIsolationFingerprint(): CodexIsolationFingerprint | undefined {
  const codex = commandDetection("codex", "Codex is unavailable.");
  const bwrap = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
  const codexPath = findExecutable("codex");
  const bwrapPath = findExecutable("bwrap");
  if (!codex.available || bwrap.error || bwrap.status !== 0 || !codexPath || !bwrapPath) {
    return undefined;
  }
  return {
    codex_version: codex.version ?? "unknown",
    codex_binary_sha256: hashFile(codexPath),
    bwrap_version: (bwrap.stdout || bwrap.stderr).trim().split(/\r?\n/)[0],
    bwrap_binary_sha256: hashFile(bwrapPath),
    sandbox_policy_sha256: codexIsolationPolicySha256,
    node_version: process.version,
    platform: process.platform,
    release: os.release(),
    arch: os.arch()
  };
}

export function readCodexIsolationAttestation(): CodexIsolationAttestation | undefined {
  const fingerprint = currentCodexIsolationFingerprint();
  if (!fingerprint) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(codexIsolationAttestationPath(), "utf8")) as CodexIsolationAttestation;
    return codexIsolationAttestationMatches(parsed, fingerprint) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function codexIsolationAttestationMatches(
  attestation: CodexIsolationAttestation,
  fingerprint: CodexIsolationFingerprint
): boolean {
  return (
    attestation.command_probe === "passed" &&
    attestation.stdio_child_probe === "passed" &&
    JSON.stringify(attestation.fingerprint) === JSON.stringify(fingerprint)
  );
}

export function verifyCodexIsolation(): CodexIsolationAttestation {
  const fingerprint = currentCodexIsolationFingerprint();
  if (!fingerprint || process.platform !== "linux") {
    throw new Error("Codex isolation verification requires Linux, Codex permission profiles, and bubblewrap.");
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-isolation-verify-"));
  try {
    const scopesRoot = path.join(tempRoot, "run-scopes");
    const currentRoot = path.join(scopesRoot, "current");
    const siblingRoot = path.join(scopesRoot, "sibling");
    const contextPath = path.join(currentRoot, "context");
    const scratchPath = path.join(currentRoot, "scratch");
    const siblingSecret = path.join(siblingRoot, "secret.txt");
    fs.mkdirSync(contextPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(scratchPath, { mode: 0o700 });
    fs.mkdirSync(siblingRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(contextPath, "SOUL.md"), "verification context\n", { mode: 0o400 });
    fs.writeFileSync(siblingSecret, "sibling secret\n", { mode: 0o600 });

    const profile = "monde_verify";
    const commandProbe = spawnSync(
      "codex",
      [
        "sandbox",
        "-P",
        profile,
        "-C",
        scratchPath,
        "-c",
        `permissions.${profile}.filesystem=${tomlStringMap({
          ":minimal": "read",
          [scopesRoot]: "deny",
          [contextPath]: "read",
          [scratchPath]: "write"
        })}`,
        process.execPath,
        "-e",
        isolationProbeScript(siblingSecret, path.join(scratchPath, "codex-probe.txt"))
      ],
      { encoding: "utf8" }
    );
    if (commandProbe.error || commandProbe.status !== 0 || !fs.existsSync(path.join(scratchPath, "codex-probe.txt"))) {
      throw new Error(
        `Codex command isolation probe failed: ${commandProbe.error?.message ?? (commandProbe.stderr || commandProbe.stdout)}`
      );
    }

    const childProbe = spawnSync(
      "bwrap",
      [
        "--die-with-parent",
        "--unshare-pid",
        "--unshare-ipc",
        ...systemReadOnlyBindArgs(),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/run",
        "--dir",
        "/run/monde",
        "--bind",
        scratchPath,
        "/run/monde/scratch",
        "--chdir",
        "/run/monde/scratch",
        process.execPath,
        "-e",
        isolationProbeScript(siblingSecret, "/run/monde/scratch/stdio-probe.txt")
      ],
      { encoding: "utf8" }
    );
    if (childProbe.error || childProbe.status !== 0 || !fs.existsSync(path.join(scratchPath, "stdio-probe.txt"))) {
      throw new Error(
        `Stdio child isolation probe failed: ${childProbe.error?.message ?? (childProbe.stderr || childProbe.stdout)}`
      );
    }

    const attestation: CodexIsolationAttestation = {
      verified_at: new Date().toISOString(),
      fingerprint,
      command_probe: "passed",
      stdio_child_probe: "passed"
    };
    const attestationPath = codexIsolationAttestationPath();
    fs.mkdirSync(path.dirname(attestationPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 });
    return attestation;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function codexIsolationStatus(version?: string): {
  status: "verified" | "verification_required" | "unsupported";
} {
  if (process.platform !== "linux" || !versionSupportsPermissionProfiles(version) || !findExecutable("bwrap")) {
    return { status: "unsupported" };
  }
  return { status: readCodexIsolationAttestation() ? "verified" : "verification_required" };
}

function versionSupportsPermissionProfiles(version?: string): boolean {
  const match = version?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 138;
}

function findExecutable(command: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync.native(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isolationProbeScript(siblingPath: string, outputPath: string): string {
  return [
    "const fs=require('node:fs');",
    `try{fs.readFileSync(${JSON.stringify(siblingPath)});process.exit(91)}catch{}`,
    `fs.writeFileSync(${JSON.stringify(outputPath)},'passed\\n')`
  ].join("");
}

function systemReadOnlyBindArgs(): string[] {
  const args: string[] = [];
  for (const systemPath of ["/usr", "/bin", "/lib", "/lib64"]) {
    if (fs.existsSync(systemPath)) {
      args.push("--ro-bind", systemPath, systemPath);
    }
  }
  if (fs.existsSync("/etc")) {
    args.push("--dir", "/etc");
    for (const systemPath of ["/etc/hosts", "/etc/nsswitch.conf", "/etc/resolv.conf", "/etc/ssl"]) {
      if (fs.existsSync(systemPath)) {
        args.push("--ro-bind", systemPath, systemPath);
      }
    }
  }
  return args;
}

function appendExternalMcpArgs(args: string[], context: HarnessAdapterContext): void {
  for (const runtime of context.externalMcpServers ?? []) {
    const server = runtime.server;
    const prefix = `mcp_servers.${server.id}`;
    if (server.transport === "streamable_http") {
      args.push("-c", `${prefix}.url=${tomlString(server.url)}`);
      if (server.auth.type === "run_claims") {
        args.push("-c", `${prefix}.bearer_token_env_var=${tomlString(server.auth.token_env_var)}`);
      }
    } else {
      const command =
        context.workspaceMode === "isolated"
          ? buildIsolatedStdioLaunch(runtime, context)
          : { command: server.command, args: server.args };
      args.push(
        "-c",
        `${prefix}.command=${tomlString(command.command)}`,
        "-c",
        `${prefix}.args=${tomlStringArray(command.args)}`
      );
      const envVars = [
        ...(server.auth.type === "run_claims"
          ? [server.auth.token_env_var, "MONDE_RUN_CLAIMS_INTROSPECTION_URL"]
          : []),
        ...(server.actor_context_access ? ["MONDE_ACTOR_CONTEXT"] : []),
        ...(server.scratch_access !== "none" ? ["MONDE_RUN_SCRATCH"] : [])
      ];
      if (envVars.length > 0) {
        args.push("-c", `${prefix}.env_vars=${tomlStringArray(envVars)}`);
      }
      if (context.workspaceMode !== "isolated" && runtime.resolvedCwd) {
        args.push("-c", `${prefix}.cwd=${tomlString(runtime.resolvedCwd)}`);
      }
    }
    args.push(
      "-c",
      `${prefix}.required=${server.required ? "true" : "false"}`,
      "-c",
      `${prefix}.startup_timeout_sec=${String(server.startup_timeout_seconds)}`
    );
  }
}

export function buildIsolatedStdioLaunch(
  runtime: ExternalMcpRuntime,
  context: HarnessAdapterContext
): { command: string; args: string[] } {
  if (runtime.server.transport !== "stdio" || !context.scratchPath || !context.contextSnapshotPath) {
    throw new Error("Invalid isolated stdio MCP runtime.");
  }
  const mounts: Array<{ path: string; access: "read" | "write" }> = runtime.resolvedReadMounts.map((mount) => ({
    path: mount,
    access: "read"
  }));
  if (runtime.server.actor_context_access) {
    mounts.push({ path: context.contextSnapshotPath, access: "read" });
  }
  if (runtime.resolvedCwd) {
    mounts.push({ path: runtime.resolvedCwd, access: "read" });
  }
  if (runtime.server.scratch_access !== "none") {
    mounts.push({
      path: context.scratchPath,
      access: runtime.server.scratch_access === "write" ? "write" : "read"
    });
  }

  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    ...systemReadOnlyBindArgs(),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp"
  ];
  const createdDirectories = new Set<string>([
    "/",
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/etc",
    "/proc",
    "/dev",
    "/tmp"
  ]);
  for (const mount of mounts) {
    appendBubblewrapParentDirectories(args, mount.path, createdDirectories);
    args.push(mount.access === "write" ? "--bind" : "--ro-bind", mount.path, mount.path);
  }
  const cwd = runtime.resolvedCwd ?? (runtime.server.scratch_access !== "none" ? context.scratchPath : "/");
  if (cwd !== "/") {
    appendBubblewrapParentDirectories(args, cwd, createdDirectories);
  }
  args.push("--chdir", cwd, runtime.server.command, ...runtime.server.args);
  return { command: "bwrap", args };
}

function appendBubblewrapParentDirectories(args: string[], target: string, created: Set<string>): void {
  let current = path.dirname(target);
  const parents: string[] = [];
  while (current !== "/" && !created.has(current)) {
    parents.push(current);
    current = path.dirname(current);
  }
  for (const parent of parents.reverse()) {
    args.push("--dir", parent);
    created.add(parent);
  }
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

function tomlStringMap(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(",")}}`;
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
