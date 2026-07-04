import { getMondePlatformPaths } from "@monde/core";
import { getServiceStatus } from "../service-client.js";

export async function serviceStatus(): Promise<void> {
  const status = await getServiceStatus();
  console.log(JSON.stringify(status, null, 2));
}

export function servicePaths(): void {
  console.log(JSON.stringify(getMondePlatformPaths(), null, 2));
}
