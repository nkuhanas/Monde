import fs from "node:fs";
import path from "node:path";
import { ensureDirectory, monIdFromDirectoryName, type MonConfig } from "@monde/core";
import { findNearestMondeRoot, readJson, writeJson } from "../fs-context.js";

export interface MonCreateOptions {
  path?: string;
  name?: string;
  role?: string;
  harness?: string;
  model?: string;
}

export function createMon(directoryName: string, options: MonCreateOptions): void {
  if (directoryName.includes("/") || directoryName.includes("\\")) {
    throw new Error("The mon create argument must be a directory name like frontend.mon, not a path.");
  }

  const id = monIdFromDirectoryName(directoryName);
  const parent = path.resolve(options.path ?? ".");
  const monRoot = path.join(parent, directoryName);
  const configPath = path.join(monRoot, "mon.json");

  if (fs.existsSync(configPath)) {
    throw new Error(`${configPath} already exists.`);
  }

  ensureDirectory(monRoot);
  const mondeRoot = findNearestMondeRoot(parent);
  const mondeId = mondeRoot
    ? (readJson(path.join(mondeRoot, ".monde", "monde.json")) as { id?: string }).id
    : undefined;

  const config: MonConfig = {
    id,
    name: options.name ?? id,
    role: options.role ?? id,
    version: 1,
    default_harness: options.harness ?? null,
    default_model: options.model ?? null,
    work_root: "..",
    max_active_runs: 1,
    retry_policy: {
      max_attempts: 1,
      initial_backoff_seconds: 5,
      backoff_multiplier: 2,
      max_backoff_seconds: 300,
      kill_grace_seconds: 5,
      retryable_conditions: [
        "launch_error",
        "process_exit_nonzero",
        "process_interrupted",
        "required_mcp_unavailable",
        "attempt_timeout",
        "credential_expired"
      ]
    },
    run_workspace: { mode: "shared" },
    actor_context: [],
    read_mounts: [],
    external_mcp_servers: [],
    capabilities: [],
    created_at: new Date().toISOString(),
    created_under_monde_id: mondeId
  };

  writeJson(configPath, config);
  console.log(`Created mon ${id} at ${monRoot}`);
}
