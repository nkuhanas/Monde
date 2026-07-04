import path from "node:path";

export interface ResolvedMonScope {
  monId: string;
  monRoot: string;
  workRoot: string;
  mondeRoot: string;
  mondeConfig: string;
}

export function resolveWorkRoot(monRoot: string, configuredWorkRoot = ".."): string {
  if (path.isAbsolute(configuredWorkRoot)) {
    return path.resolve(configuredWorkRoot);
  }

  return path.resolve(monRoot, configuredWorkRoot);
}

export function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
