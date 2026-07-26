import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const webPort = Number.parseInt(process.env.MONDE_WEB_TEST_UI_PORT ?? "45175", 10);
const servicePort = Number.parseInt(process.env.MONDE_WEB_TEST_SERVICE_PORT ?? "43761", 10);
const mcpPort = Number.parseInt(process.env.MONDE_WEB_TEST_MCP_PORT ?? "43762", 10);
const testRoot = path.resolve(process.env.MONDE_WEB_TEST_ROOT ?? path.join(os.tmpdir(), "monde-playwright-preview"));
const baseURL = `http://127.0.0.1:${webPort}`;

process.env.MONDE_WEB_TEST_ROOT = testRoot;
process.env.MONDE_WEB_TEST_TOKEN_PATH = path.join(testRoot, "data", "monde", "service.token");

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
);

export default defineConfig({
  testDir: "./tests/web",
  outputDir: "test-results/playwright",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }]
  ],
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off"
  },
  webServer: [
    {
      command: "bash scripts/playwright-service.sh",
      url: `http://127.0.0.1:${servicePort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      env: {
        ...inheritedEnvironment,
        MONDE_WEB_TEST_ROOT: testRoot,
        MONDE_WEB_PORT: String(servicePort),
        MONDE_MCP_PORT: String(mcpPort)
      }
    },
    {
      command: "npm run dev:web",
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      env: {
        ...inheritedEnvironment,
        MONDE_UI_PORT: String(webPort),
        MONDE_WEB_PORT: String(servicePort)
      }
    }
  ]
});
