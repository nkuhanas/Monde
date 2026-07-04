import { readMondeContext } from "../fs-context.js";
import { ServiceClient } from "../service-client.js";

export interface CliRun {
  id: string;
  monde_id: string;
  mon_id: string;
  status: string;
  process_status: string;
  outcome: string;
  interaction_mode?: string;
  runtime_state?: string;
  outcome_state?: string;
  close_reason?: string | null;
  origin: Record<string, unknown>;
  intent: { title: string; prompt: string };
  execution?: Record<string, unknown>;
  result?: Record<string, unknown>;
  warnings?: string[];
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
}

interface CliArtifact {
  id: string;
  type: string;
  title: string;
  path?: string;
  summary?: string;
  path_status: string;
  path_exists?: boolean;
  content_excerpt?: string;
  content_truncated?: boolean;
  size?: number;
}

interface RunsResponse {
  runs: CliRun[];
}

interface RunResponse {
  run: CliRun;
}

interface StartRunResponse {
  run: CliRun;
  started: boolean;
  active_run_id?: string;
}

interface RunEvent {
  id: string;
  run_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface LogEvent {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function listRuns(options: { all?: boolean }): Promise<void> {
  const client = new ServiceClient();
  const params = new URLSearchParams();

  if (!options.all) {
    const monde = readMondeContext();
    params.set("monde_id", monde.config.id);
  }

  if ("status" in options && typeof options.status === "string") {
    params.set("status", options.status);
  }
  if ("mon" in options && typeof options.mon === "string") {
    params.set("mon_id", normalizeMonId(options.mon));
  }
  if ("origin" in options && typeof options.origin === "string") {
    params.set("origin_type", options.origin);
  }

  const query = params.toString();
  const path = query ? `/runs?${query}` : "/runs";
  const response = await client.get<RunsResponse>(path);
  for (const run of response.runs) {
    console.log(
      `${run.id}\t${run.mon_id}\t${run.interaction_mode ?? "one_shot"}\t${run.status}/${run.process_status}/${run.outcome}\t${run.runtime_state ?? "-"} / ${run.outcome_state ?? "-"}\t${String(run.execution?.runner_type ?? run.execution?.runner ?? "-")}\t${run.intent.title}\t${run.created_at}`
    );
  }
}

export async function showRun(runId: string, options: { artifacts?: boolean } = {}): Promise<void> {
  const client = new ServiceClient();
  const [{ run }, { logs }, { artifacts }, { events }] = await Promise.all([
    client.get<RunResponse>(`/runs/${encodeURIComponent(runId)}`),
    client.get<{ logs: LogEvent[] }>(`/logs?run_id=${encodeURIComponent(runId)}`),
    client.get<{ artifacts: CliArtifact[] }>(`/artifacts?run_id=${encodeURIComponent(runId)}`),
    client.get<{ events: RunEvent[] }>(`/runs/${encodeURIComponent(runId)}/events/history`)
  ]);

  const artifactDetails = options.artifacts
    ? await Promise.all(
        artifacts.map(async (artifact) => {
          try {
            const detail = await client.get<{ artifact: CliArtifact; content_excerpt?: string; content_truncated?: boolean; size?: number }>(
              `/artifacts/${encodeURIComponent(artifact.id)}`
            );
            return { ...detail.artifact, content_excerpt: detail.content_excerpt, content_truncated: detail.content_truncated, size: detail.size };
          } catch {
            return artifact;
          }
        })
      )
    : artifacts;

  console.log(
    JSON.stringify(
      {
        ...run,
        logs,
        artifacts: artifactDetails,
        events,
        review: run.result ?? {},
        thread_state: {
          interaction_mode: run.interaction_mode ?? "one_shot",
          runtime_state: run.runtime_state,
          outcome_state: run.outcome_state,
          close_reason: run.close_reason ?? null
        },
        execution_metadata: {
          runner: run.execution?.runner,
          runner_type: run.execution?.runner_type,
          interaction_mode: run.execution?.interaction_mode,
          input_mode: run.execution?.input_mode,
          output_mode: run.execution?.output_mode,
          can_write: run.execution?.can_write,
          write_scope: run.execution?.write_scope,
          sandbox_mode: run.execution?.sandbox_mode,
          approval_mode: run.execution?.approval_mode
        }
      },
      null,
      2
    )
  );
}

export async function startRun(runId: string, options: { attach?: boolean } = {}): Promise<void> {
  const client = new ServiceClient();
  const response = await client.post<StartRunResponse>(`/runs/${encodeURIComponent(runId)}/start`);
  if (response.active_run_id && response.active_run_id !== runId) {
    console.log(`Mon already has active run ${response.active_run_id}; ${runId} was left queued.`);
    return;
  }

  console.log(`Started run ${response.run.id}`);
  console.log(`status=${response.run.status} process_status=${response.run.process_status} outcome=${response.run.outcome}`);
  if (options.attach) {
    await attachRun(response.run.id);
  }
}

export async function attachRun(runId: string): Promise<void> {
  const client = new ServiceClient();
  const response = await client.get<RunResponse>(`/runs/${encodeURIComponent(runId)}`);

  if (response.run.status === "queued" || response.run.status === "blocked") {
    console.log(JSON.stringify(response.run, null, 2));
    console.log(`Run is ${response.run.status}. Start it with: monde run start ${runId}`);
    return;
  }

  if (response.run.status === "finished") {
    await printRunHistory(client, runId);
    console.log(`\nstatus=${response.run.status} process_status=${response.run.process_status} outcome=${response.run.outcome}`);
    if (response.run.warnings?.length) {
      console.log(`warnings=${response.run.warnings.join(",")}`);
    }
    if (response.run.result && Object.keys(response.run.result).length > 0) {
      console.log(`result=${JSON.stringify(response.run.result)}`);
    }
    const artifacts = await client.get<{ artifacts: Array<{ id: string; type: string; title: string }> }>(
      `/artifacts?run_id=${encodeURIComponent(runId)}`
    );
    if (artifacts.artifacts.length > 0) {
      console.log("artifacts:");
      for (const artifact of artifacts.artifacts) {
        console.log(`  ${artifact.id}\t${artifact.type}\t${artifact.title}`);
      }
    }
    return;
  }

  await streamRun(client, runId);
}

export async function cancelRun(runId: string): Promise<void> {
  const client = new ServiceClient();
  const response = await client.post<RunResponse>(`/runs/${encodeURIComponent(runId)}/cancel`);
  console.log(JSON.stringify(response.run, null, 2));
}

export async function closeRun(runId: string, options: { outcome: string; summary?: string; notes?: string } | string): Promise<void> {
  const client = new ServiceClient();
  const body = typeof options === "string" ? { outcome: options } : options;
  const response = await client.post<RunResponse>(`/runs/${encodeURIComponent(runId)}/close`, body);
  console.log(JSON.stringify(response.run, null, 2));
}

export async function reviewRun(
  runId: string,
  options: { outcome: string; summary?: string; notes?: string }
): Promise<void> {
  const client = new ServiceClient();
  const response = await client.post<RunResponse>(`/runs/${encodeURIComponent(runId)}/review`, {
    outcome: options.outcome,
    summary: options.summary,
    notes: options.notes
  });
  console.log(JSON.stringify(response.run, null, 2));
}

export async function summarizeRun(runId: string): Promise<void> {
  const client = new ServiceClient();
  const { run } = await client.get<RunResponse>(`/runs/${encodeURIComponent(runId)}`);
  const [{ logs }, { artifacts }, { events }] = await Promise.all([
    client.get<{ logs: Array<{ event_type: string; payload: Record<string, unknown>; created_at: string }> }>(
      `/logs?run_id=${encodeURIComponent(runId)}`
    ),
    client.get<{ artifacts: Array<{ id: string; type: string; title: string; path_status: string }> }>(
      `/artifacts?run_id=${encodeURIComponent(runId)}`
    ),
    client.get<{ events: RunEvent[] }>(`/runs/${encodeURIComponent(runId)}/events/history`)
  ]);

  if (typeof run.result?.summary === "string") {
    console.log(run.result.summary);
    return;
  }

  console.log(`${run.id}: ${run.intent.title}`);
  console.log(`state: ${run.status}/${run.process_status}/${run.outcome}`);
  console.log(`thread: ${run.interaction_mode ?? "one_shot"} ${run.runtime_state ?? "-"} / ${run.outcome_state ?? "-"} close=${run.close_reason ?? "-"}`);
  console.log(`origin: ${JSON.stringify(run.origin)}`);
  console.log(`created: ${run.created_at}`);
  if (logs.length > 0) {
    console.log("\nrecent logs:");
    for (const log of logs.slice(-5)) {
      console.log(`- ${log.created_at} ${log.event_type}: ${JSON.stringify(log.payload)}`);
    }
  }
  if (artifacts.length > 0) {
    console.log("\nartifacts:");
    for (const artifact of artifacts) {
      console.log(`- ${artifact.id} ${artifact.type} ${artifact.title} [${artifact.path_status}]`);
    }
  }
  const output = events
    .filter((event) => event.event_type === "run_output" || event.event_type === "run_error_output")
    .map((event) => String(event.payload.chunk ?? ""))
    .join("")
    .slice(-1000);
  if (output) {
    console.log("\noutput excerpt:");
    console.log(output);
  }
}

export async function inputRun(runId: string, inputParts: string[]): Promise<void> {
  const input = `${inputParts.join(" ")}\n`;
  const client = new ServiceClient();
  await client.post<RunResponse>(`/runs/${encodeURIComponent(runId)}/input`, { input });
}

export async function interruptRun(runId: string): Promise<void> {
  const client = new ServiceClient();
  const response = await client.post<RunResponse>(`/runs/${encodeURIComponent(runId)}/interrupt`);
  console.log(`Interrupted ${response.run.id}`);
  console.log(`status=${response.run.status} process_status=${response.run.process_status} outcome=${response.run.outcome}`);
}

export async function findRuns(query: { mondeId: string; monId: string; status?: string }): Promise<CliRun[]> {
  const client = new ServiceClient();
  const params = new URLSearchParams({ monde_id: query.mondeId, mon_id: query.monId });
  if (query.status) {
    params.set("status", query.status);
  }

  const response = await client.get<RunsResponse>(`/runs?${params.toString()}`);
  return response.runs;
}

async function printRunHistory(client: ServiceClient, runId: string): Promise<void> {
  const response = await client.get<{ events: RunEvent[] }>(`/runs/${encodeURIComponent(runId)}/events/history`);
  for (const event of response.events) {
    printEvent(event);
  }
}

async function streamRun(client: ServiceClient, runId: string): Promise<void> {
  const response = await fetch(client.eventUrl(`/runs/${encodeURIComponent(runId)}/events`), {
    headers: { authorization: `Bearer ${client.serviceToken}` }
  });

  if (!response.ok || !response.body) {
    throw new Error(`Attach failed with HTTP ${response.status}`);
  }

  const stdinHandler = (chunk: Buffer) => {
    void client.post(`/runs/${encodeURIComponent(runId)}/input`, { input: chunk.toString("utf8") }).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
  };

  if (process.stdin.isTTY) {
    process.stdin.resume();
    process.stdin.on("data", stdinHandler);
  }

  try {
    await readSse(response.body, (event) => {
      printEvent(event);
      return event.event_type === "run_finished";
    });
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.off("data", stdinHandler);
      process.stdin.pause();
    }
  }
}

async function readSse(stream: ReadableStream<Uint8Array>, onEvent: (event: RunEvent) => boolean): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let data = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);

      if (line === "") {
        if (data) {
          const parsed = JSON.parse(data) as RunEvent;
          parsed.event_type = parsed.event_type || eventName;
          if (onEvent(parsed)) {
            await reader.cancel();
            return;
          }
        }
        eventName = "message";
        data = "";
      } else if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice("data:".length).trim();
      }

      newlineIndex = buffer.indexOf("\n");
    }
  }
}

function printEvent(event: RunEvent): void {
  if (event.event_type === "run_output" || event.event_type === "run_error_output") {
    process.stdout.write(String(event.payload.chunk ?? ""));
    return;
  }

  if (event.event_type === "run_started") {
    console.log(`[${event.run_id}] started`);
    return;
  }

  if (event.event_type === "run_finished") {
    console.log(
      `\n[${event.run_id}] finished ${event.payload.status}/${event.payload.process_status}/${event.payload.outcome}`
    );
  }
}

function normalizeMonId(value: string): string {
  return value.endsWith(".mon") ? value.slice(0, -".mon".length) : value;
}
