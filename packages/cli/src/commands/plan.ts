import { findMonRoot, readMonConfig, readMondeContext } from "../fs-context.js";
import { ServiceClient } from "../service-client.js";
import { syncFilesystemIdentity } from "../sync.js";

interface PlanResponse {
  plan: unknown;
}

interface PlansResponse {
  plans: Array<{
    id: string;
    title: string;
    status: string;
    assignments: Array<{ id: string; mon_id: string; status: string; generated_run_ids: string[] }>;
    updated_at: string;
  }>;
}

export async function createPlan(
  title: string,
  options: { mon?: string; prompt?: string; objective?: string; description?: string; phase?: string }
): Promise<void> {
  const monde = readMondeContext();
  const client = new ServiceClient();
  let assignment: Record<string, unknown> | undefined;

  if (options.mon) {
    const monRoot = findMonRoot(monde.root, options.mon);
    const mon = readMonConfig(monRoot);
    await syncFilesystemIdentity(client, monde.config, mon, monRoot);
    assignment = {
      mon_id: mon.id,
      title,
      prompt: options.prompt ?? options.objective ?? options.description ?? title,
      phase: options.phase
    };
  }

  const response = await client.post<PlanResponse>("/plans", {
    monde_id: monde.config.id,
    title,
    objective: options.objective,
    prompt: options.prompt,
    description: options.description,
    assignment
  });
  console.log(JSON.stringify(response.plan, null, 2));
}

export async function assignPlan(
  planId: string,
  options: { mon: string; title?: string; prompt: string; phase?: string }
): Promise<void> {
  const monde = readMondeContext();
  const client = new ServiceClient();
  const monRoot = findMonRoot(monde.root, options.mon);
  const mon = readMonConfig(monRoot);
  await syncFilesystemIdentity(client, monde.config, mon, monRoot);
  const response = await client.post(`/plans/${encodeURIComponent(planId)}/assignments`, {
    mon_id: mon.id,
    title: options.title,
    prompt: options.prompt,
    phase: options.phase
  });
  console.log(JSON.stringify(response, null, 2));
}

export async function listPlans(): Promise<void> {
  const monde = readMondeContext();
  const client = new ServiceClient();
  const response = await client.get<PlansResponse>(`/plans?monde_id=${encodeURIComponent(monde.config.id)}`);
  for (const plan of response.plans) {
    const assignmentText = plan.assignments
      .map((assignment) => `${assignment.mon_id}:${assignment.status}:${assignment.generated_run_ids.join(",") || "-"}`)
      .join(" ");
    console.log(`${plan.id}\t${plan.status}\t${plan.title}\t${assignmentText}\t${plan.updated_at}`);
  }
}

export async function showPlan(planId: string): Promise<void> {
  const client = new ServiceClient();
  const response = await client.get<PlanResponse>(`/plans/${encodeURIComponent(planId)}`);
  console.log(JSON.stringify(response.plan, null, 2));
}

export async function activatePlan(planId: string): Promise<void> {
  const client = new ServiceClient();
  const response = await client.post(`/plans/${encodeURIComponent(planId)}/activate`);
  console.log(JSON.stringify(response, null, 2));
}

export async function searchPlans(query: string): Promise<void> {
  const monde = readMondeContext();
  const client = new ServiceClient();
  const params = new URLSearchParams({ monde_id: monde.config.id, q: query });
  const response = await client.get<PlansResponse>(`/plans?${params.toString()}`);
  for (const plan of response.plans) {
    console.log(`${plan.id}\t${plan.status}\t${plan.title}`);
  }
}
