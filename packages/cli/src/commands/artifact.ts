import { ServiceClient } from "../service-client.js";

export async function listArtifacts(options: { run?: string; mon?: string }): Promise<void> {
  const client = new ServiceClient();
  const params = new URLSearchParams();
  if (options.run) {
    params.set("run_id", options.run);
  }
  if (options.mon) {
    params.set("mon_id", options.mon.endsWith(".mon") ? options.mon.slice(0, -".mon".length) : options.mon);
  }

  const response = await client.get<{
    artifacts: Array<{ id: string; type: string; title: string; path?: string; path_status: string; path_exists: boolean }>;
  }>(`/artifacts${params.toString() ? `?${params.toString()}` : ""}`);

  for (const artifact of response.artifacts) {
    const warning = artifact.path_status === "missing" ? " missing_path" : "";
    console.log(`${artifact.id}\t${artifact.type}\t${artifact.path_status}\t${artifact.title}\t${artifact.path ?? ""}${warning}`);
  }
}

export async function showArtifact(artifactId: string): Promise<void> {
  const client = new ServiceClient();
  const response = await client.get(`/artifacts/${encodeURIComponent(artifactId)}`);
  console.log(JSON.stringify(response, null, 2));
}

export async function registerArtifact(
  runId: string,
  options: { type: string; path?: string; title?: string; summary?: string }
): Promise<void> {
  const client = new ServiceClient();
  const response = await client.post("/artifacts", {
    run_id: runId,
    type: options.type,
    path: options.path,
    title: options.title,
    summary: options.summary
  });
  console.log(JSON.stringify(response, null, 2));
}
