import path from "node:path";
import { resolveWorkRoot, type MonConfig, type MondeConfig } from "@monde/core";
import type { ServiceClient } from "./service-client.js";

export async function syncFilesystemIdentity(
  client: ServiceClient,
  monde: MondeConfig,
  mon: MonConfig,
  monRoot: string
): Promise<void> {
  await client.post("/mondes/upsert", {
    id: monde.id,
    name: monde.name,
    root: monde.root,
    docs: monde.docs
  });

  await client.post("/mons/upsert", {
    id: mon.id,
    monde_id: monde.id,
    name: mon.name,
    role: mon.role,
    mon_root: monRoot,
    work_root: resolveWorkRoot(monRoot, mon.work_root),
    default_harness: mon.default_harness,
    default_model: mon.default_model,
    capabilities: mon.capabilities
  });
}

export function displayPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative.startsWith("..") ? filePath : relative || ".";
}
