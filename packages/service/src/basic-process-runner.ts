import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basicProcessAdapter, getHarnessAdapter } from "@monde/adapters";
import type { RunScopeSnapshot } from "./scope.js";

export interface StartRunInput {
  runId: string;
  runToken: string;
  prompt: string;
  runtimePrompt: string;
  sandboxMode?: string;
  scope: RunScopeSnapshot;
  serviceAddr: string;
  mcpAddr: string;
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  onExit(exit: { code: number | null; signal: NodeJS.Signals | null }): void;
  onSpawn?(pid?: number): void;
  onError(error: Error): void;
}

export interface RunningProcess {
  runId: string;
  pid?: number;
  runnerType: "basic-process" | "pty" | "adapter-native";
  write(input: string): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface HarnessRunner {
  startRun(input: StartRunInput): Promise<RunningProcess>;
}

export class BasicProcessRunner implements HarnessRunner {
  async startRun(input: StartRunInput): Promise<RunningProcess> {
    const adapter = getHarnessAdapter(input.scope.harness) ?? basicProcessAdapter;
    const runnerType = adapter.id === "basic-process" ? "basic-process" : "adapter-native";
    const detection = adapter.detect();
    if (!detection.available) {
      throw new Error(`${adapter.label} adapter is not available: ${detection.reason ?? "missing or unsupported"}`);
    }

    const command = adapter.buildCommand({
      runId: input.runId,
      runToken: input.runToken,
      monRoot: input.scope.mon_root,
      workRoot: input.scope.work_root,
      prompt: input.prompt,
      sandboxMode: input.sandboxMode,
      runtimePrompt: input.runtimePrompt,
      model: input.scope.model,
      serviceAddr: input.serviceAddr,
      mcpAddr: input.mcpAddr,
      scopeSnapshot: input.scope as unknown as Record<string, unknown>
    });
    const stdoutFilter = command.outputMode === "codex-json-filtered" ? new CodexJsonOutputFilter() : undefined;
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: {
        ...process.env,
        ...command.env,
        MONDE_RUN_ID: input.runId,
        MONDE_RUN_TOKEN: input.runToken,
        MONDE_SERVICE_ADDR: input.serviceAddr,
        MONDE_MCP_ADDR: input.mcpAddr,
        MONDE_MON_ID: input.scope.mon_id,
        MONDE_MON_ROOT: input.scope.mon_root,
        MONDE_WORK_ROOT: input.scope.work_root,
        MONDE_DOCS_ROOT: input.scope.docs_root,
        MONDE_HARNESS_ADAPTER: adapter.id,
        MONDE_RUNNER_TYPE: runnerType,
        TERM: process.env.TERM || "xterm-256color",
        COLUMNS: process.env.COLUMNS || "120",
        LINES: process.env.LINES || "32"
      },
      stdio: "pipe"
    });

    input.onSpawn?.(child.pid);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!stdoutFilter) {
        input.onStdout(chunk);
        return;
      }

      for (const rendered of stdoutFilter.push(chunk)) {
        input.onStdout(rendered);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      const filtered = command.outputMode === "codex-json-filtered" ? filterCodexStderr(chunk) : chunk;
      if (filtered) {
        input.onStderr(filtered);
      }
    });
    child.on("error", (error) => input.onError(error));
    child.on("close", (code, signal) => input.onExit({ code, signal }));
    if (command.stdinMode === "closed") {
      child.stdin.end();
    }

    return new ChildRunningProcess(input.runId, child, runnerType, command.stdinMode !== "closed");
  }
}

class ChildRunningProcess implements RunningProcess {
  readonly pid?: number;

  constructor(
    readonly runId: string,
    private readonly child: ChildProcessWithoutNullStreams,
    readonly runnerType: "basic-process" | "pty" | "adapter-native",
    private readonly acceptsInput: boolean
  ) {
    this.pid = child.pid;
  }

  write(input: string): void {
    if (!this.acceptsInput) {
      throw new Error("This harness run does not accept interactive stdin after launch.");
    }

    this.child.stdin.write(input);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child.kill(signal);
  }
}

class CodexJsonOutputFilter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const rendered: string[] = [];
    let newlineIndex = this.buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        const output = renderCodexJsonLine(line);
        if (output) {
          rendered.push(output);
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }

    return rendered;
  }
}

function renderCodexJsonLine(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "unknown";
    if (type === "thread.started" && typeof event.thread_id === "string") {
      return `[codex] thread ${event.thread_id}\n`;
    }

    if (type === "turn.started") {
      return "[codex] turn started\n";
    }

    if (type === "turn.completed") {
      const usage = isRecord(event.usage) ? event.usage : {};
      const tokens = typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number"
        ? ` input=${String(usage.input_tokens ?? "?")} output=${String(usage.output_tokens ?? "?")}`
        : "";
      return `[codex] turn completed${tokens}\n`;
    }

    if (type === "error") {
      return `[codex error] ${JSON.stringify(event)}\n`;
    }

    if (type !== "item.completed") {
      return undefined;
    }

    const item = isRecord(event.item) ? event.item : {};
    const itemType = typeof item.type === "string" ? item.type : "unknown";
    if (itemType === "agent_message" && typeof item.text === "string") {
      return `${item.text}\n`;
    }

    if (itemType.includes("tool") || itemType.includes("command") || itemType.includes("mcp")) {
      const name = typeof item.name === "string" ? ` ${item.name}` : "";
      return `[codex] ${itemType}${name} completed\n`;
    }

    return undefined;
  } catch {
    return `[codex] ${line.slice(0, 240)}${line.length > 240 ? "..." : ""}\n`;
  }
}

function filterCodexStderr(chunk: string): string {
  return chunk
    .split(/\r?\n/)
    .filter((line) => line.trim() && line.trim() !== "Reading additional input from stdin...")
    .map((line) => `${line}\n`)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
