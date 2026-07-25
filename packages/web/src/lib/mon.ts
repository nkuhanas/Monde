import type { MonDto, MondeDto } from "@monde/core";

export function mondeDisplayName(monde: MondeDto): string {
  return monde.name || monde.id;
}

export function monDisplayName(mon: MonDto): string {
  return monIdDisplayName(mon.id);
}

export function monIdDisplayName(monId: string): string {
  return monId.endsWith(".mon") ? monId : `${monId}.mon`;
}
