import { createHash } from "node:crypto";
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
  workspace_mode: "shared" | "isolated";
  recovery_window_seconds: number;
  scope_root?: string;
  context_snapshot_path?: string;
  scratch_path?: string;
  execution_root: string;
  actor_context_files: ActorContextSnapshot[];
  read_mounts: string[];
  mon_json: MonConfig;
  monde_json: MondeConfig;
}

export interface ActorContextSnapshot {
  order: number;
  source_root: "mon" | "work";
  configured_path: string;
  logical_path: string;
  snapshot_path: string;
  sha256: string;
  bytes: number;
  content: string;
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
    workspace_mode: monConfig.run_workspace.mode,
    recovery_window_seconds:
      monConfig.run_workspace.mode === "isolated" ? monConfig.run_workspace.recovery_window_seconds : 86400,
    execution_root: workRoot,
    actor_context_files: [],
    read_mounts: resolveReadMounts(monConfig, monRoot, workRoot),
    mon_json: monConfig,
    monde_json: mondeConfig
  };
}

export function materializeRunScope(
  scope: RunScopeSnapshot,
  runId: string,
  dataDir: string
): RunScopeSnapshot {
  const runScopesRoot = path.join(dataDir, "run-scopes");
  fs.mkdirSync(runScopesRoot, { recursive: true, mode: 0o700 });
  const scopeRoot = path.join(runScopesRoot, runId);
  fs.mkdirSync(scopeRoot, { mode: 0o700 });

  try {
    const contextPath = path.join(scopeRoot, "context");
    fs.mkdirSync(contextPath, { mode: 0o700 });
    const actorContextFiles = snapshotActorContext(scope, contextPath);
    sealTree(contextPath);

    const scratchPath = scope.workspace_mode === "isolated" ? path.join(scopeRoot, "scratch") : undefined;
    if (scratchPath) {
      fs.mkdirSync(scratchPath, { mode: 0o700 });
    }

    return {
      ...scope,
      scope_root: scopeRoot,
      context_snapshot_path: contextPath,
      scratch_path: scratchPath,
      execution_root: scratchPath ?? scope.work_root,
      actor_context_files: actorContextFiles
    };
  } catch (error) {
    fs.rmSync(scopeRoot, { recursive: true, force: true });
    throw error;
  }
}

export function sealRunScopeFiles(scopeRoot: string): void {
  if (!fs.existsSync(scopeRoot)) {
    return;
  }
  sealTree(scopeRoot);
}

export function cleanupRunScopeFiles(scopeRoot: string, dataDir: string): void {
  const runScopesRoot = path.resolve(dataDir, "run-scopes");
  const target = path.resolve(scopeRoot);
  if (target === runScopesRoot || !isInsidePath(runScopesRoot, target)) {
    throw new Error(`Refusing to clean run scope outside ${runScopesRoot}: ${target}`);
  }
  makeTreeRemovable(target);
  fs.rmSync(target, { recursive: true, force: true });
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

function resolveReadMounts(config: MonConfig, monRoot: string, workRoot: string): string[] {
  return config.read_mounts.map((mount) => {
    const root = mount.root === "mon" ? monRoot : workRoot;
    return canonicalContainedPath(root, mount.path, `read mount ${mount.path}`);
  });
}

function snapshotActorContext(scope: RunScopeSnapshot, contextPath: string): ActorContextSnapshot[] {
  const snapshots: ActorContextSnapshot[] = [];
  let totalBytes = 0;

  for (const [entryIndex, entry] of scope.mon_json.actor_context.entries()) {
    const sourceRoot = entry.root === "mon" ? scope.mon_root : scope.work_root;
    const sourcePath = canonicalContainedPath(sourceRoot, entry.path, `actor context ${entry.path}`);
    const files = collectRegularFiles(sourcePath);
    for (const sourceFile of files) {
      if (snapshots.length >= 32) {
        throw new Error("Actor context exceeds the maximum of 32 files.");
      }
      const content = fs.readFileSync(sourceFile, "utf8");
      const bytes = Buffer.byteLength(content);
      if (bytes > 64 * 1024) {
        throw new Error(`Actor context file exceeds 64 KiB: ${sourceFile}`);
      }
      totalBytes += bytes;
      if (totalBytes > 256 * 1024) {
        throw new Error("Actor context exceeds the maximum total size of 256 KiB.");
      }

      const sourceStat = fs.statSync(sourcePath);
      const logicalPath = sourceStat.isDirectory()
        ? path.relative(sourcePath, sourceFile)
        : path.basename(sourceFile);
      const snapshotPath = path.join(contextPath, String(entryIndex).padStart(2, "0"), logicalPath);
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(snapshotPath, content, { encoding: "utf8", mode: 0o400, flag: "wx" });
      snapshots.push({
        order: snapshots.length,
        source_root: entry.root,
        configured_path: entry.path,
        logical_path: logicalPath,
        snapshot_path: snapshotPath,
        sha256: sha256(content),
        bytes,
        content
      });
    }
  }

  return snapshots;
}

function collectRegularFiles(root: string): string[] {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`Actor context may not contain symlinks: ${root}`);
  }
  if (stat.isFile()) {
    return [root];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Actor context path is not a regular file or directory: ${root}`);
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Actor context may not contain symlinks: ${child}`);
    }
    if (entry.isDirectory()) {
      files.push(...collectRegularFiles(child));
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      throw new Error(`Actor context contains a non-regular file: ${child}`);
    }
  }
  return files;
}

function canonicalContainedPath(root: string, configuredPath: string, label: string): string {
  if (path.isAbsolute(configuredPath)) {
    throw new Error(`${label} must be relative to its configured root.`);
  }
  const candidate = path.resolve(root, configuredPath);
  assertNoSymlinkComponents(root, candidate, label);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(candidate);
  } catch (error) {
    throw new Error(`${label} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (canonical !== root && !isInsidePath(root, canonical)) {
    throw new Error(`${label} escapes its configured root.`);
  }
  return canonical;
}

function sealTree(root: string): void {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to seal symlink: ${root}`);
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) {
      sealTree(path.join(root, entry));
    }
    fs.chmodSync(root, 0o500);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to seal non-regular path: ${root}`);
  }
  fs.chmodSync(root, 0o400);
}

function makeTreeRemovable(root: string): void {
  if (!fs.existsSync(root)) {
    return;
  }
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const entry of fs.readdirSync(root)) {
      makeTreeRemovable(path.join(root, entry));
    }
    return;
  }
  if (stat.isFile()) {
    fs.chmodSync(root, 0o600);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertNoSymlinkComponents(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} may not traverse symlinks.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("may not traverse symlinks")) {
        throw error;
      }
      throw new Error(`${label} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
