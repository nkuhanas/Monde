import crypto from "node:crypto";
import fs from "node:fs";
import { ensureDirectory, getPlatformPaths } from "./platform.js";

export interface ServiceAuth {
  token: string;
  authorizeHeader(value: string | undefined): boolean;
  authorizeToken(value: string | undefined): boolean;
}

export function loadOrCreateServiceAuth(): ServiceAuth {
  const paths = getPlatformPaths();
  ensureDirectory(paths.dataDir);

  if (!fs.existsSync(paths.tokenPath)) {
    const token = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(paths.tokenPath, `${token}\n`, { mode: 0o600 });
  }

  const token = fs.readFileSync(paths.tokenPath, "utf8").trim();

  return {
    token,
    authorizeToken(value: string | undefined): boolean {
      if (!value || value.length !== token.length) {
        return false;
      }

      return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));
    },
    authorizeHeader(value: string | undefined): boolean {
      if (!value?.startsWith("Bearer ")) {
        return false;
      }

      const candidate = value.slice("Bearer ".length);
      return this.authorizeToken(candidate);
    }
  };
}
