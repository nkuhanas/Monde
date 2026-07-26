import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MonConfigSchema, MondeConfigSchema } from "@monde/core";
import {
  BasicProcessRunner,
  buildHarnessEnvironment
} from "../packages/service/src/basic-process-runner.ts";
import type { RunScopeSnapshot } from "../packages/service/src/scope.ts";

test("harness environment inherits only the explicit safe allowlist", () => {
  const environment = buildHarnessEnvironment(
    {
      MONDE_RUN_ID: "run_test",
      MONDE_RUN_TOKEN: "run-token",
      ADAPTER_EXPLICIT_VALUE: "allowed"
    },
    {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      LANG: "C.UTF-8",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      NODE_OPTIONS: "--require /tmp/injected.cjs",
      MONDE_SERVICE_TOKEN: "must-not-leak"
    }
  );

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    LANG: "C.UTF-8",
    MONDE_RUN_ID: "run_test",
    MONDE_RUN_TOKEN: "run-token",
    ADAPTER_EXPLICIT_VALUE: "allowed"
  });
});

test(
  "harness cancellation terminates the spawned process group",
  { timeout: 10_000 },
  async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process groups are not available on Windows.");
      return;
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monde-process-group-"));
    const fixturePath = fileURLToPath(
      new URL("./fixtures/process-tree-parent.mjs", import.meta.url)
    );
    const monConfig = MonConfigSchema.parse({
      id: "worker",
      name: "Worker",
      role: "test",
      version: 1,
      default_harness: "basic-process",
      default_model: null,
      work_root: ".",
      capabilities: [],
      created_at: "2026-01-01T00:00:00.000Z"
    });
    const mondeConfig = MondeConfigSchema.parse({
      id: "test",
      name: "Test",
      version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      root: tempRoot,
      docs: tempRoot
    });
    const scope: RunScopeSnapshot = {
      monde_id: "test",
      mon_id: "worker",
      mon_root: tempRoot,
      work_root: tempRoot,
      monde_root: tempRoot,
      monde_config: path.join(tempRoot, "monde.json"),
      mon_config: path.join(tempRoot, "mon.json"),
      docs_root: tempRoot,
      harness: "basic-process",
      model: null,
      capabilities: [],
      workspace_mode: "shared",
      recovery_window_seconds: 86400,
      execution_root: tempRoot,
      actor_context_files: [],
      read_mounts: [],
      mon_json: monConfig,
      monde_json: mondeConfig
    };
    let output = "";
    let childPid: number | undefined;
    let resolveChildPid!: (pid: number) => void;
    const childPidReady = new Promise<number>((resolve) => {
      resolveChildPid = resolve;
    });
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const runner = new BasicProcessRunner();
    const running = await runner.startRun({
      runId: "run_process_group",
      runToken: "run-token",
      prompt: `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)}`,
      runtimePrompt: "Runtime prompt",
      scope,
      serviceAddr: "http://127.0.0.1:3761",
      mcpAddr: "http://127.0.0.1:3762/mcp",
      onStdout(chunk) {
        output += chunk;
        const line = output.split("\n").find((candidate) => candidate.includes("child_pid"));
        if (line && childPid === undefined) {
          childPid = (JSON.parse(line) as { child_pid: number }).child_pid;
          resolveChildPid(childPid);
        }
      },
      onStderr() {},
      onExit() {
        resolveExit();
      },
      onError(error) {
        throw error;
      }
    });
    const parentPid = running.pid;
    childPid = await childPidReady;
    assert.ok(parentPid);
    assert.ok(processExists(parentPid));
    assert.ok(processExists(childPid));

    t.after(() => {
      for (const pid of [parentPid, childPid]) {
        if (pid && processExists(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The process exited between the probe and cleanup.
          }
        }
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    running.kill("SIGTERM");
    await exited;
    await waitForProcessExit(parentPid);
    await waitForProcessExit(childPid);
    assert.equal(processExists(parentPid), false);
    assert.equal(processExists(childPid), false);
  }
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processExists(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
