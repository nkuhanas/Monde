import crypto from "node:crypto";

export function createRunToken(): string {
  return `run_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashRunToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

export function verifyRunToken(token: string, expectedHash: string): boolean {
  const candidate = hashRunToken(token);
  if (candidate.length !== expectedHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedHash));
}
