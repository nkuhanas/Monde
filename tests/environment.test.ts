import assert from "node:assert/strict";
import test from "node:test";
import { buildHarnessEnvironment } from "../packages/service/src/basic-process-runner.ts";

test("harness environment inherits only the explicit safe allowlist", () => {
  const environment = buildHarnessEnvironment(
    {
      MONDE_RUN_ID: "run_test",
      MONDE_RUN_TOKEN: "run-token",
      ADAPTER_EXPLICIT_VALUE: "allowed"
    },
    {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      LANG: "C.UTF-8",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      NODE_OPTIONS: "--require /tmp/injected.cjs",
      MONDE_SERVICE_TOKEN: "must-not-leak"
    }
  );

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    LANG: "C.UTF-8",
    MONDE_RUN_ID: "run_test",
    MONDE_RUN_TOKEN: "run-token",
    ADAPTER_EXPLICIT_VALUE: "allowed"
  });
});
