export function upsertString(items: string[], item: string): string[] {
  return items.includes(item) ? items : [...items, item];
}

export function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [item, ...items];
  return items.map((candidate) => candidate.id === item.id ? item : candidate);
}

export function appendById<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((candidate) => candidate.id === item.id) ? items : [...items, item];
}

export function replaceById<T extends { id: string }>(items: T[], replacedId: string, item: T): T[] {
  let replaced = false;
  const next: T[] = [];
  for (const candidate of items) {
    if (candidate.id === item.id && candidate.id !== replacedId) continue;
    if (candidate.id === replacedId) { next.push(item); replaced = true; }
    else next.push(candidate);
  }
  return replaced ? next : appendById(next, item);
}
