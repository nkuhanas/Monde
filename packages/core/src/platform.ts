import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MondePlatformPaths {
  dataDir: string;
  runtimeDir: string;
  dbPath: string;
  tokenPath: string;
  metadataPath: string;
}

export function getMondePlatformPaths(): MondePlatformPaths {
  const home = os.homedir();
  const isMac = process.platform === "darwin";
  const dataDir = isMac
    ? path.join(home, "Library", "Application Support", "monde")
    : path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "monde");
  const runtimeDir = isMac ? dataDir : path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), "monde");

  return {
    dataDir,
    runtimeDir,
    dbPath: path.join(dataDir, "monde.sqlite"),
    tokenPath: path.join(dataDir, "service.token"),
    metadataPath: path.join(runtimeDir, "service.json")
  };
}

export function ensureDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
