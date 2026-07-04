import fs from "node:fs";
import path from "node:path";
import { MonConfigSchema, MondeConfigSchema, type MonConfig, type MondeConfig } from "@monde/core";

export interface MondeContext {
  root: string;
  mondeDir: string;
  configPath: string;
  config: MondeConfig;
}

export function findNearestMondeRoot(start = process.cwd()): string | undefined {
  let current = path.resolve(start);

  while (true) {
    if (fs.existsSync(path.join(current, ".monde", "monde.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

export function readMondeContext(start = process.cwd()): MondeContext {
  const root = findNearestMondeRoot(start);
  if (!root) {
    throw new Error("No .monde/monde.json found from the current directory upward.");
  }

  const mondeDir = path.join(root, ".monde");
  const configPath = path.join(mondeDir, "monde.json");
  const config = MondeConfigSchema.parse(readJson(configPath));
  return { root, mondeDir, configPath, config };
}

export function readMonConfig(monRoot: string): MonConfig {
  return MonConfigSchema.parse(readJson(path.join(monRoot, "mon.json")));
}

export function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function findMonRoot(mondeRoot: string, monArg: string): string {
  const direct = path.resolve(monArg);
  if (fs.existsSync(path.join(direct, "mon.json"))) {
    return direct;
  }

  const queue = [mondeRoot];
  const ignored = new Set([".git", ".monde", "node_modules", "dist", "build", ".next", ".vite"]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name)) {
        continue;
      }

      const child = path.join(current, entry.name);
      if (entry.name === monArg && fs.existsSync(path.join(child, "mon.json"))) {
        return child;
      }

      queue.push(child);
    }
  }

  throw new Error(`Could not find mon directory ${monArg} under ${mondeRoot}.`);
}
