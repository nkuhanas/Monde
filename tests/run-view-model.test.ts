import assert from "node:assert/strict";
import test from "node:test";
import type { RunDto } from "@monde/core";
import { runStateLabel, runStateTone, runVisualState } from "../packages/web/src/features/runs/runViewModel.ts";

function run(overrides: Partial<RunDto>): RunDto {
  return {
    id: "run_test",
    monde_id: "monde",
    mon_id: "test.mon",
    status: "finished",
    process_status: "exited",
    outcome: "unknown",
    warnings: [],
    interaction_mode: "one_shot",
    runtime_state: "closed",
    outcome_state: "unknown",
    close_reason: "process_exited",
    origin: { type: "operator" },
    intent: { title: "Test run", prompt: "Test" },
    execution: {},
    result: {},
    created_at: "2026-07-24T00:00:00.000Z",
    updated_at: "2026-07-24T00:00:00.000Z",
    ...overrides
  } as RunDto;
}

test("run cards use the semantic state after the lifecycle finishes", () => {
  const cases: Array<[RunDto, string, string, string]> = [
    [run({ status: "queued", runtime_state: "queued", process_status: "not_started" }), "queued", "queued", "blue"],
    [run({}), "review", "review", "amber"],
    [run({ outcome: "completed", outcome_state: "succeeded" }), "completed", "completed", "green"],
    [run({ outcome: "stopped", outcome_state: "abandoned" }), "stopped", "stopped", "pink"],
    [run({ outcome: "failed", outcome_state: "failed", runtime_state: "failed" }), "failed", "failed", "red"],
    [run({ result: { reviewed_at: "2026-07-24T01:00:00.000Z" } }), "closed", "closed", "purple"]
  ];

  for (const [value, visualState, label, tone] of cases) {
    assert.equal(runVisualState(value), visualState);
    assert.equal(runStateLabel(value), label);
    assert.equal(runStateTone(value), tone);
  }
});
