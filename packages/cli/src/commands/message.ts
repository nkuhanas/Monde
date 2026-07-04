import { findMonRoot, readMonConfig, readMondeContext } from "../fs-context.js";
import { ServiceClient } from "../service-client.js";
import { displayPath, syncFilesystemIdentity } from "../sync.js";
import { attachRun } from "./run.js";

interface OperatorRunResponse {
  run: {
    id: string;
    status: string;
    process_status: string;
    outcome: string;
  };
  started?: boolean;
  active_run_id?: string;
  attached_to_active_run?: boolean;
  message?: string;
}

export async function messageMon(
  monArg: string,
  promptParts: string[],
  options: { harness?: string; write?: boolean; sandbox?: string; attachActive?: boolean } = {}
): Promise<void> {
  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error("Message prompt cannot be empty.");
  }

  const monde = readMondeContext();
  const monRoot = findMonRoot(monde.root, monArg);
  const mon = readMonConfig(monRoot);
  const client = new ServiceClient();

  await syncFilesystemIdentity(client, monde.config, mon, monRoot);
  const response = await client.post<OperatorRunResponse>("/runs/operator", {
    monde_id: monde.config.id,
    mon_id: mon.id,
    title: prompt.slice(0, 80),
    prompt,
    harness: options.harness,
    sandbox_mode: sandboxModeFromOptions(options),
    attach_active: options.attachActive === true
  });

  console.log(
    `${response.attached_to_active_run ? "Attached to active" : response.started === false ? "Queued" : "Created"} run ${response.run.id} for ${mon.id} (${displayPath(monRoot)})`
  );
  console.log(
    `status=${response.run.status} process_status=${response.run.process_status} outcome=${response.run.outcome}`
  );
  if (response.active_run_id && response.active_run_id !== response.run.id) {
    console.log(`active_run=${response.active_run_id}`);
  }
  if (response.message) {
    console.log(response.message);
  }

  await attachRun(response.run.id);
}

function sandboxModeFromOptions(options: { write?: boolean; sandbox?: string }): string | undefined {
  if (options.write) {
    return "workspace-write";
  }

  return options.sandbox;
}
