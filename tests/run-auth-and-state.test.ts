import assert from "node:assert/strict";
import test from "node:test";
import { finishRunFromExit, type RunRecord } from "@monde/core";
import { createRunToken, hashRunToken } from "../packages/service/src/run-auth.ts";
import { RunManager } from "../packages/service/src/run-manager.ts";

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_test",
    monde_id: "monde-test",
    mon_id: "frontend",
    status: "active",
    process_status: "running",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "running",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "operator" },
    intent: { title: "Test", prompt: "Test" },
    execution: {},
    result: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function managerFor(getRun: () => RunRecord | undefined): RunManager {
  return new RunManager({
    mondes: {} as never,
    mons: {} as never,
    runs: { get: getRun } as never,
    logs: {} as never,
    artifacts: {} as never,
    events: {} as never,
    config: {
      serviceAddr: "http://127.0.0.1:3761",
      mcpAddr: "http://127.0.0.1:3762/mcp"
    }
  });
}

test("one-shot run tokens are rejected after completion and for invalid tokens", () => {
  const token = createRunToken();
  let run = runRecord({ execution: { run_token_hash: hashRunToken(token) } });
  const manager = managerFor(() => run);

  assert.equal(manager.isRunTokenAuthorized(run.id, token), true);
  assert.equal(manager.isRunTokenAuthorized(run.id, "wrong-token"), false);

  run = { ...run, status: "finished", process_status: "exited" };
  assert.equal(manager.isRunTokenAuthorized(run.id, token), false);
});

test("HITL tokens require a current, non-timed-out adapter turn", () => {
  const token = createRunToken();
  const run = runRecord({
    interaction_mode: "hitl_thread",
    execution: { run_token_hash: hashRunToken(token) }
  });
  const manager = managerFor(() => run);
  const activities = (manager as unknown as { hitlActivities: Map<string, { timedOut: boolean }> }).hitlActivities;

  assert.equal(manager.isRunTokenAuthorized(run.id, token), false);
  activities.set(run.id, { timedOut: false });
  assert.equal(manager.isRunTokenAuthorized(run.id, token), true);
  activities.set(run.id, { timedOut: true });
  assert.equal(manager.isRunTokenAuthorized(run.id, token), false);
});

test("a clean process exit does not claim semantic success", () => {
  const patch = finishRunFromExit(runRecord(), { code: 0, signal: null }, "2026-01-01T00:01:00.000Z");

  assert.equal(patch.outcome, "unknown");
  assert.equal(patch.outcome_state, "unknown");
  assert.equal(patch.process_status, "exited");
});
