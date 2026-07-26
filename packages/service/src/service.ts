import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadOrCreateServiceAuth } from "./auth.js";
import { loadServiceConfig } from "./config.js";
import { CronScheduler } from "./cron-scheduler.js";
import { openDatabase } from "./db.js";
import { ensureDirectory, getPlatformPaths } from "./platform.js";
import { ArtifactRepository } from "./repositories/artifacts.js";
import { CronScheduleRepository } from "./repositories/cron-schedules.js";
import { ExternalExecutionRepository } from "./repositories/external-executions.js";
import { ExternalMcpGrantRepository } from "./repositories/external-mcp-grants.js";
import { ExecutionManifestRepository } from "./repositories/execution-manifests.js";
import { LogRepository } from "./repositories/logs.js";
import { MonRepository } from "./repositories/mons.js";
import { MondeRepository } from "./repositories/mondes.js";
import { PlanRepository } from "./repositories/plans.js";
import { ProcessSlotRepository } from "./repositories/process-slots.js";
import { RunEventRepository } from "./repositories/run-events.js";
import { RunRepository } from "./repositories/runs.js";
import { RunWorkspaceRepository } from "./repositories/run-workspaces.js";
import { RunEventBus } from "./run-events.js";
import { RunManager } from "./run-manager.js";
import { registerMcpRoutes, registerRoutes } from "./routes.js";
import { ToolHandlers } from "./tools.js";

export async function createService() {
  const config = loadServiceConfig();
  const auth = loadOrCreateServiceAuth();
  const paths = getPlatformPaths();
  const database = openDatabase();
  const app = Fastify({ logger: true });
  const mcpApp = Fastify({ logger: true });
  const mondes = new MondeRepository(database.db);
  const cronSchedules = new CronScheduleRepository(database.db);
  const externalExecutions = new ExternalExecutionRepository(database.db);
  const externalMcpGrants = new ExternalMcpGrantRepository(database.db);
  const executionManifests = new ExecutionManifestRepository(database.db);
  const mons = new MonRepository(database.db);
  const plans = new PlanRepository(database.db);
  const processSlots = new ProcessSlotRepository(database.db);
  const runs = new RunRepository(database.db);
  const runEvents = new RunEventRepository(database.db);
  const runWorkspaces = new RunWorkspaceRepository(database.db);
  const eventBus = new RunEventBus(runEvents);
  const logs = new LogRepository(database.db);
  const artifacts = new ArtifactRepository(database.db);
  const serviceAddr = `http://${config.host}:${config.webPort}`;
  const mcpAddr = `http://${config.host}:${config.mcpPort}/mcp`;
  const uiPort = Number.parseInt(process.env.MONDE_UI_PORT ?? "5175", 10);
  const runManager = new RunManager({
    mondes,
    externalExecutions,
    externalMcpGrants,
    executionManifests,
    mons,
    plans,
    processSlots,
    runs,
    runWorkspaces,
    logs,
    artifacts,
    events: eventBus,
    config: {
      serviceAddr,
      mcpAddr,
      dataDir: paths.dataDir
    }
  });
  runManager.markLostRunsOnStartup();
  runManager.sweepExpiredRunScopes();
  const cronScheduler = new CronScheduler(
    cronSchedules,
    runManager,
    15_000,
    (error) => app.log.error(error, "cron scheduler tick failed")
  );
  const runScopeSweep = setInterval(() => runManager.sweepExpiredRunScopes(), 60_000);
  runScopeSweep.unref();
  const tools = new ToolHandlers({ runs, plans, logs, artifacts });
  const allowedOrigins = new Set([
    `http://${config.host}:${config.webPort}`,
    `http://127.0.0.1:${uiPort}`,
    `http://localhost:${uiPort}`
  ]);

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("origin_not_allowed"), false);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health" || request.url === "/external-mcp/introspect") {
      return;
    }

    if (request.url.startsWith("/tools/")) {
      return;
    }

    if (request.url.includes("/events")) {
      const query = request.query as { token?: string };
      if (auth.authorizeToken(query.token)) {
        return;
      }
    }

    if (!auth.authorizeHeader(request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  await mcpApp.register(cors, {
    origin(origin, callback) {
      if (!origin || (process.env.MONDE_ALLOW_BROWSER_MCP === "1" && allowedOrigins.has(origin))) {
        callback(null, true);
        return;
      }

      callback(new Error("origin_not_allowed"), false);
    }
  });

  registerRoutes(app, {
    database,
    auth,
    mondes,
    cronSchedules,
    externalExecutions,
    externalMcpGrants,
    executionManifests,
    mons,
    plans,
    runs,
    runEvents,
    eventBus,
    runManager,
    tools
  });
  registerMcpRoutes(mcpApp, { auth, runManager, tools });

  return {
    logger: app.log,
    async start() {
      ensureDirectory(paths.runtimeDir);
      await app.listen({ host: config.host, port: config.webPort });
      await mcpApp.listen({ host: config.host, port: config.mcpPort });
      cronScheduler.start();
      fs.writeFileSync(
        paths.metadataPath,
        JSON.stringify(
          {
            web_addr: serviceAddr,
            mcp_addr: mcpAddr,
            token_path: paths.tokenPath,
            db_path: paths.dbPath
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
    },
    async stop() {
      clearInterval(runScopeSweep);
      cronScheduler.stop();
      await app.close();
      await mcpApp.close();
      database.close();
    }
  };
}
