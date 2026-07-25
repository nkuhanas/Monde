import fs from "node:fs";
import path from "node:path";
import { isInsidePath, MonConfigSchema, MondeConfigSchema, resolveWorkRoot, type MonConfig, type MondeConfig } from "@monde/core";
import type { MonRow } from "./repositories/mons.js";
import type { MondeRow } from "./repositories/mondes.js";

export interface RunScopeSnapshot {
  monde_id: string;
  mon_id: string;
  mon_root: string;
  work_root: string;
  monde_root: string;
  monde_config: string;
  mon_config: string;
  docs_root: string;
  harness: string;
  model: string | null;
  capabilities: string[];
  mon_json: MonConfig;
  monde_json: MondeConfig;
}

export function resolveRunScope(monde: MondeRow, mon: MonRow): RunScopeSnapshot {
  const mondeRoot = canonicalDirectory(monde.root, "Monde root");
  const monRoot = canonicalDirectory(mon.mon_root, "mon root");
  const docsRoot = canonicalDirectory(monde.docs, "docs root");
  const monConfigPath = path.join(monRoot, "mon.json");
  const mondeConfigPath = path.join(mondeRoot, ".monde", "monde.json");
  const monConfig = MonConfigSchema.parse(JSON.parse(fs.readFileSync(monConfigPath, "utf8")));
  const mondeConfig = MondeConfigSchema.parse(JSON.parse(fs.readFileSync(mondeConfigPath, "utf8")));
  const configuredWorkRoot = monConfig.work_root ?? mon.work_root;
  const workRoot = canonicalDirectory(resolveWorkRoot(monRoot, configuredWorkRoot), "work root");

  if (!isInsidePath(mondeRoot, workRoot) && !monConfig.allow_external_work_root) {
    throw new Error(
      `work_root ${workRoot} is outside Monde ${mondeRoot}; set allow_external_work_root=true in mon.json to allow this.`
    );
  }

  return {
    monde_id: monde.id,
    mon_id: mon.id,
    mon_root: monRoot,
    work_root: workRoot,
    monde_root: mondeRoot,
    monde_config: mondeConfigPath,
    mon_config: monConfigPath,
    docs_root: docsRoot,
    harness: monConfig.default_harness ?? mon.default_harness ?? "basic-process",
    model: monConfig.default_model ?? mon.default_model ?? null,
    capabilities: monConfig.capabilities ?? mon.capabilities,
    mon_json: monConfig,
    monde_json: mondeConfig
  };
}

function canonicalDirectory(value: string, label: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(path.resolve(value));
  } catch (error) {
    throw new Error(`${label} ${path.resolve(value)} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`${label} ${canonical} is not a directory.`);
  }

  return canonical;
}
