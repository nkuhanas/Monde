import fs from "node:fs";
import path from "node:path";
import { ensureDirectory, slugifyMondeId, type MondeConfig } from "@monde/core";
import { writeJson } from "../fs-context.js";

export interface InitOptions {
  name?: string;
  force?: boolean;
}

export function initMonde(targetPath: string, options: InitOptions): void {
  const root = path.resolve(targetPath);
  const name = options.name ?? path.basename(root);
  const mondeDir = path.join(root, ".monde");
  const docsDir = path.join(mondeDir, "docs");
  const configPath = path.join(mondeDir, "monde.json");

  if (fs.existsSync(configPath) && !options.force) {
    throw new Error(`${configPath} already exists. Pass --force to overwrite it.`);
  }

  ensureDirectory(root);
  ensureDirectory(docsDir);

  const config: MondeConfig = {
    id: slugifyMondeId(name),
    name,
    version: 1,
    created_at: new Date().toISOString(),
    root,
    docs: docsDir
  };

  writeJson(configPath, config);
  console.log(`Initialized Monde ${config.name} (${config.id}) at ${root}`);
}
