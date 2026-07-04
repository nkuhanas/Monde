import fs from "node:fs";
import { getMondePlatformPaths } from "@monde/core";

interface ServiceMetadata {
  web_addr: string;
  mcp_addr: string;
  token_path: string;
  db_path: string;
}

export class ServiceClient {
  private readonly metadata: ServiceMetadata;
  private readonly token: string;

  constructor(metadata = readServiceMetadata()) {
    this.metadata = metadata;
    this.token = fs.readFileSync(metadata.token_path, "utf8").trim();
  }

  get serviceToken(): string {
    return this.token;
  }

  buildUrl(path: string): string {
    return `${this.metadata.web_addr}${path}`;
  }

  eventUrl(path: string): string {
    const separator = path.includes("?") ? "&" : "?";
    return `${this.metadata.web_addr}${path}${separator}token=${encodeURIComponent(this.token)}`;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" }
    });
  }

  async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);

    const response = await fetch(`${this.metadata.web_addr}${path}`, {
      ...init,
      headers
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      throw new Error(`Service request failed (${response.status}): ${JSON.stringify(payload)}`);
    }

    return payload as T;
  }
}

export function readServiceMetadata(): ServiceMetadata {
  const paths = getMondePlatformPaths();
  if (!fs.existsSync(paths.metadataPath)) {
    throw new Error(`Monde service metadata not found at ${paths.metadataPath}. Start the service first.`);
  }

  return JSON.parse(fs.readFileSync(paths.metadataPath, "utf8")) as ServiceMetadata;
}

export async function getServiceStatus(): Promise<Record<string, unknown>> {
  const metadata = readServiceMetadata();
  const response = await fetch(`${metadata.web_addr}/health`);
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}.`);
  }

  return (await response.json()) as Record<string, unknown>;
}
