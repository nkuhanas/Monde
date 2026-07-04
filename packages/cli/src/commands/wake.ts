import { findMonRoot, readMonConfig, readMondeContext } from "../fs-context.js";
import { ServiceClient } from "../service-client.js";
import { syncFilesystemIdentity } from "../sync.js";
import { attachRun, closeRun, findRuns, startRun, type CliRun } from "./run.js";

export async function wakeMon(
  monArg: string,
  options: { run?: string; harness?: string; write?: boolean; sandbox?: string } = {}
): Promise<void> {
  const { monde, monRoot, mon } = await syncMon(monArg);
  if (options.run) {
    await startRun(options.run, { attach: true });
    return;
  }

  const active = [
    ...(await findRuns({ mondeId: monde.config.id, monId: mon.id, status: "active" })),
    ...(await findRuns({ mondeId: monde.config.id, monId: mon.id, status: "starting" }))
  ][0];

  if (active) {
    console.log(`Attaching to active run ${active.id}`);
    await attachRun(active.id);
    return;
  }

  const queued = (await findRuns({ mondeId: monde.config.id, monId: mon.id, status: "queued" })).sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  )[0];

  if (queued) {
    printLaunchDisclosure(queued);
    await startRun(queued.id, { attach: true });
    return;
  }

  const shell = process.env.SHELL || "/bin/sh";
  const client = new ServiceClient();
  const response = await client.post<{ run: CliRun }>("/runs/operator", {
    monde_id: monde.config.id,
    mon_id: mon.id,
    title: "Manual wake",
    prompt: `exec ${shell}`,
    harness: options.harness,
    sandbox_mode: sandboxModeFromOptions(options)
  });
  console.log(`Started manual run ${response.run.id} from ${monRoot}`);
  await attachRun(response.run.id);
}

export async function sleepMon(monArg: string): Promise<void> {
  const { monde, mon } = await syncMon(monArg);
  const active = [
    ...(await findRuns({ mondeId: monde.config.id, monId: mon.id, status: "active" })),
    ...(await findRuns({ mondeId: monde.config.id, monId: mon.id, status: "starting" }))
  ][0];

  if (!active) {
    console.log(`No active run for ${mon.id}.`);
    return;
  }

  await closeRun(active.id, "stopped");
}

async function syncMon(monArg: string) {
  const monde = readMondeContext();
  const monRoot = findMonRoot(monde.root, monArg);
  const mon = readMonConfig(monRoot);
  const client = new ServiceClient();
  await syncFilesystemIdentity(client, monde.config, mon, monRoot);
  return { monde, monRoot, mon };
}

function printLaunchDisclosure(run: CliRun): void {
  console.log(`Starting queued ${run.origin.type ?? "unknown"}-origin run ${run.id}:`);
  console.log(run.intent.title);
  console.log("");
  console.log("Origin:");
  for (const [key, value] of Object.entries(run.origin)) {
    console.log(`  ${key}: ${String(value)}`);
  }
}

function sandboxModeFromOptions(options: { write?: boolean; sandbox?: string }): string | undefined {
  if (options.write) {
    return "workspace-write";
  }

  return options.sandbox;
}
