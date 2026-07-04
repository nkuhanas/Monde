export interface ServiceConfig {
  host: string;
  webPort: number;
  mcpPort: number;
}

export function loadServiceConfig(): ServiceConfig {
  return {
    host: process.env.MONDE_HOST ?? "127.0.0.1",
    webPort: Number.parseInt(process.env.MONDE_WEB_PORT ?? "3761", 10),
    mcpPort: Number.parseInt(process.env.MONDE_MCP_PORT ?? "3762", 10)
  };
}
