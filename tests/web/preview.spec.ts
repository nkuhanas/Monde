import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const storedTokenKey = "monde.serviceToken";
const mondeId = "preview-smoke";

test("renders an isolated authenticated operator overview", async ({ page, request }, testInfo) => {
  const testRoot = process.env.MONDE_WEB_TEST_ROOT;
  const tokenPath = process.env.MONDE_WEB_TEST_TOKEN_PATH;
  if (!testRoot || !tokenPath) {
    throw new Error("Playwright web runtime paths were not configured.");
  }

  const projectRoot = path.join(testRoot, "project");
  const docsRoot = path.join(projectRoot, ".monde", "docs");
  const monRoot = path.join(projectRoot, "frontend.mon");
  const workRoot = path.join(projectRoot, "web");
  fs.mkdirSync(docsRoot, { recursive: true });
  fs.mkdirSync(monRoot, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });

  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const consoleErrors: string[] = [];
  const headers = { authorization: `Bearer ${token}` };

  const mondeSeed = await request.post("/api/mondes/upsert", {
    headers,
    data: {
      id: mondeId,
      name: "Preview Smoke",
      root: projectRoot,
      docs: docsRoot
    }
  });
  expect(mondeSeed.status()).toBe(204);

  const monSeed = await request.post("/api/mons/upsert", {
    headers,
    data: {
      id: "frontend",
      monde_id: mondeId,
      name: "frontend",
      role: "frontend",
      mon_root: monRoot,
      work_root: workRoot,
      default_harness: "basic-process",
      default_model: null,
      capabilities: []
    }
  });
  expect(monSeed.status()).toBe(204);

  const healthResponse = await request.get("/api/health", { headers });
  expect(healthResponse.status()).toBe(200);
  const health = (await healthResponse.json()) as { db_path?: string };
  expect(health.db_path).toBe(path.join(testRoot, "data", "monde", "monde.sqlite"));

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: storedTokenKey, value: token }
  );

  const mondesResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/mondes") && response.request().method() === "GET"
  );
  await page.goto("/");
  const authenticatedResponse = await mondesResponse;
  const payload = (await authenticatedResponse.json()) as { mondes?: unknown[] };

  expect(authenticatedResponse.status()).toBe(200);
  expect(payload.mondes).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "Monde", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Monde sections" })).toBeVisible();
  await expect(page.getByLabel("Token")).toHaveValue(token);
  await expect(page.locator(".service-dot-online")).toBeVisible();
  await expect(page.getByText("Enter the local service token to load Monde state.")).toHaveCount(0);
  await expect(page.locator(".workspace-title h2")).toHaveText("Preview Smoke");
  await expect(page.locator(".monde-row-active .monde-name")).toHaveText("Preview Smoke");
  await expect(page.locator(".recent-mon-row")).toContainText("frontend.mon");

  const screenshotPath = testInfo.outputPath("monde-overview.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach("authenticated-overview", { path: screenshotPath, contentType: "image/png" });

  expect(consoleErrors).toEqual([]);
});
