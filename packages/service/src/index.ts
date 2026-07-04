import { createService } from "./service.js";

const service = await createService();

await service.start();

const shutdown = async (signal: NodeJS.Signals) => {
  service.logger.info({ signal }, "shutting down monde service");
  await service.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
