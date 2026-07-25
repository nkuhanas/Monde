export function ageLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s old`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function compactPathTail(value: string | null | undefined, depth = 3): string {
  const path = value?.trim();
  if (!path) return "unknown work root";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= depth) return path;
  return `.../${parts.slice(-depth).join("/")}`;
}

export function tabLabel(value: string): string {
  return value[0].toUpperCase() + value.slice(1);
}
