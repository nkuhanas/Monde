import type { HealthDto, MondeDto } from "@monde/core";
import type { SidebarMachine } from "./AppShell";

const templates = [
  { id: "cli-machine", displayName: "CLI Machine" },
  { id: "ui-demo-machine", displayName: "UI Demo Machine" },
  { id: "nightstand-machine", displayName: "Nightstand Machine" }
] as const;

export function buildSidebarMachines(mondes: MondeDto[], health: HealthDto | null): SidebarMachine[] {
  const groups = new Map<string, SidebarMachine>(templates.map((machine) => [machine.id, { ...machine, online: health?.ok ?? false, mondes: [] }]));
  for (const monde of mondes) {
    const group = groups.get(sidebarMachineIdForMonde(monde)) ?? groups.get("nightstand-machine");
    group?.mondes.push(monde);
  }
  return templates.map((machine) => groups.get(machine.id)).filter((machine): machine is SidebarMachine => Boolean(machine));
}

function sidebarMachineIdForMonde(monde: MondeDto): string {
  const key = `${monde.id} ${monde.name} ${monde.root}`.toLowerCase();
  if (key.includes("ui-demo") || key.includes("demo") || key.includes("backup")) return "ui-demo-machine";
  if (key.includes("cli") || key.includes("frontend") || key.includes("service") || key.includes("temporary") || key.includes("temp")) return "cli-machine";
  return "nightstand-machine";
}
