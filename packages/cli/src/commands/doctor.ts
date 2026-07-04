import fs from "node:fs";
import path from "node:path";
import { harnessAdapters } from "@monde/adapters";
import { monIdFromDirectoryName, MonConfigSchema } from "@monde/core";
import { findNearestMondeRoot, readMondeContext } from "../fs-context.js";
import { ServiceClient, getServiceStatus, readServiceMetadata } from "../service-client.js";
import { syncFilesystemIdentity } from "../sync.js";
import { getMondePlatformPaths } from "@monde/core";

interface DoctorFinding {
  level: "ok" | "warn" | "error";
  message: string;
}

export async function doctor(): Promise<void> {
  const findings: DoctorFinding[] = [];
  const root = findNearestMondeRoot();
  if (!root) {
    findings.push({ level: "error", message: "Current directory is not inside a Monde." });
    printFindings(findings);
    process.exitCode = 1;
    return;
  }

  const context = readMondeContext(root);
  findings.push({ level: "ok", message: `Nearest Monde: ${context.config.name} (${context.config.id}) at ${context.root}` });

  if (fs.existsSync(context.configPath)) {
    findings.push({ level: "ok", message: ".monde/monde.json exists and parses." });
  }

  if (fs.existsSync(context.config.docs)) {
    findings.push({ level: "ok", message: `.monde/docs exists at ${context.config.docs}` });
  } else {
    findings.push({ level: "warn", message: `.monde/docs is missing at ${context.config.docs}` });
  }

  const discoveredMons = discoverMons(context.root);
  for (const discovered of discoveredMons) {
    if (!discovered.config) {
      findings.push({ level: "error", message: `${discovered.root} has invalid or missing mon.json.` });
      continue;
    }

    const expected = monIdFromDirectoryName(path.basename(discovered.root));
    if (discovered.config.id === expected) {
      findings.push({ level: "ok", message: `${path.relative(context.root, discovered.root)} id matches basename.` });
    } else {
      findings.push({
        level: "error",
        message: `${path.relative(context.root, discovered.root)} id ${discovered.config.id} should be ${expected}.`
      });
    }
  }

  findings.push({
    level: "warn",
    message: "Operational continuity depends on the local SQLite DB; use future export/import or backup/restore for recovery."
  });
  const platformPaths = getMondePlatformPaths();
  findings.push({ level: "ok", message: `SQLite DB path: ${platformPaths.dbPath}` });
  findings.push({ level: "ok", message: `Backup info: monde backup info` });
  findings.push({ level: "ok", message: `Latest backup: ${latestBackupPath(platformPaths.dataDir) ?? "none"}` });

  if (fs.existsSync(platformPaths.tokenPath)) {
    const mode = fs.statSync(platformPaths.tokenPath).mode & 0o777;
    findings.push({
      level: mode & 0o077 ? "warn" : "ok",
      message: `Service token file exists at ${platformPaths.tokenPath} with mode ${mode.toString(8)}.`
    });
  } else {
    findings.push({ level: "warn", message: `Service token file is missing at ${platformPaths.tokenPath}.` });
  }

  let client: ServiceClient | undefined;
  try {
    const status = await getServiceStatus();
    const metadata = readServiceMetadata();
    findings.push({
      level: "ok",
      message: `Service reachable. DB path: ${String(status.db_path)} schema: ${String(status.schema_version ?? "unknown")}`
    });
    findings.push({ level: "ok", message: `Web/API address: ${metadata.web_addr}` });
    findings.push({ level: "ok", message: `MCP address: ${metadata.mcp_addr}` });
    client = new ServiceClient();
  } catch (error) {
    findings.push({ level: "warn", message: `Service is not reachable: ${error instanceof Error ? error.message : String(error)}` });
  }

  if (client) {
    for (const mon of discoveredMons.flatMap((entry) => (entry.config ? [{ root: entry.root, config: entry.config }] : []))) {
      await syncFilesystemIdentity(client, context.config, mon.config, mon.root);
    }

    const [runsResponse, monsResponse, artifactsResponse] = await Promise.all([
      client.get<{
        runs: Array<{
          id: string;
          mon_id: string;
          status: string;
          warnings?: string[];
          execution?: Record<string, unknown>;
        }>;
      }>(
        `/runs?monde_id=${encodeURIComponent(context.config.id)}`
      ),
      client.get<{ mons: Array<{ id: string }> }>(`/mons?monde_id=${encodeURIComponent(context.config.id)}`),
      client.get<{ artifacts: Array<{ id: string; title: string; path_status: string }> }>("/artifacts")
    ]);
    const monIds = new Set(monsResponse.mons.map((mon) => mon.id));

    for (const run of runsResponse.runs.filter((run) => run.status === "queued" && !monIds.has(run.mon_id))) {
      findings.push({ level: "warn", message: `Queued run ${run.id} targets missing mon ${run.mon_id}.` });
    }

    for (const run of runsResponse.runs.filter((run) => run.warnings?.includes("stale_scope"))) {
      findings.push({ level: "warn", message: `Run ${run.id} has stale_scope warning.` });
    }

    for (const run of runsResponse.runs.filter((run) => run.status === "active" || run.status === "starting")) {
      if (!monIds.has(run.mon_id)) {
        findings.push({ level: "warn", message: `Active run ${run.id} points to missing mon ${run.mon_id}.` });
      }

      const pid = run.execution?.pid;
      if (typeof pid === "number" && isProcessAlive(pid)) {
        findings.push({ level: "ok", message: `Active run ${run.id} process ${pid} is alive.` });
      } else {
        findings.push({ level: "warn", message: `Active run ${run.id} has no live process pid.` });
      }
    }

    for (const artifact of artifactsResponse.artifacts) {
      if (artifact.path_status === "missing") {
        findings.push({ level: "warn", message: `Artifact ${artifact.id} path is missing: ${artifact.title}` });
      }
    }
  }

  for (const adapter of harnessAdapters) {
    const detection = adapter.detect();
    findings.push({
      level: detection.available ? "ok" : adapter.id === "basic-process" ? "error" : "warn",
      message: `${adapter.label}: adapter=${detection.adapter_status} mcp=${detection.mcp_status} prompt=${detection.prompt_injection_status} ${detection.reason ?? detection.version ?? ""}`
    });
  }

  printFindings(findings);
  process.exitCode = findings.some((finding) => finding.level === "error") ? 1 : 0;
}

export async function repair(): Promise<void> {
  const context = readMondeContext();
  fs.mkdirSync(context.config.docs, { recursive: true });
  const client = new ServiceClient();
  for (const mon of discoverMons(context.root)) {
    if (mon.config) {
      await syncFilesystemIdentity(client, context.config, mon.config, mon.root);
    }
  }
  console.log("Safe repair completed: ensured docs directory and re-registered discovered mons. Historical runs were not deleted.");
}

function printFindings(findings: DoctorFinding[]): void {
  for (const finding of findings) {
    console.log(`${finding.level.toUpperCase()}\t${finding.message}`);
  }
}

function discoverMons(root: string): Array<{ root: string; config?: import("@monde/core").MonConfig }> {
  const results: Array<{ root: string; config?: import("@monde/core").MonConfig }> = [];
  const queue = [root];
  const ignored = new Set([".git", ".monde", "node_modules", "dist", "build", ".next", ".vite"]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name)) {
        continue;
      }

      const child = path.join(current, entry.name);
      if (entry.name.endsWith(".mon")) {
        const configPath = path.join(child, "mon.json");
        try {
          results.push({ root: child, config: MonConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8"))) });
        } catch {
          results.push({ root: child });
        }
        continue;
      }

      queue.push(child);
    }
  }

  return results;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function latestBackupPath(dataDir: string): string | undefined {
  const backupDir = path.join(dataDir, "backups");
  if (!fs.existsSync(backupDir)) {
    return undefined;
  }

  return fs
    .readdirSync(backupDir)
    .filter((entry) => entry.endsWith(".sqlite"))
    .map((entry) => path.join(backupDir, entry))
    .sort()
    .at(-1);
}
