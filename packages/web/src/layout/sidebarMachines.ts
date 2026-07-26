import type { HealthDto, MondeDto } from "@monde/core";
import type { SidebarMachine } from "./AppShell";

export function buildSidebarMachines(mondes: MondeDto[], health: HealthDto | null): SidebarMachine[] {
  return [{
    id: "local-machine",
    displayName: health?.machine_name || "Local Machine",
    isLocal: true,
    online: health?.ok ?? false,
    mondes: [...mondes]
  }];
}
