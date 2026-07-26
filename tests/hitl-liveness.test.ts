import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { RunEventDto, RunRecord } from "@monde/core";
import type { HarnessRunner, RunningProcess, StartRunInput } from "../packages/service/src/basic-process-runner.ts";
import { RunManager, type RunManagerClock, type RunManagerTimer } from "../packages/service/src/run-manager.ts";
import type { RunScopeSnapshot } from "../packages/service/src/scope.ts";
import { chatEventContent } from "../packages/web/src/features/chat/chatViewModel.ts";

class FakeTimer implements RunManagerTimer {
  cancelled = false;

  constructor(
    readonly dueAt: number,
    readonly callback: () => void
  ) {}

  unref(): void {}
}

class FakeClock implements RunManagerClock {
  private currentTime = Date.parse("2026-07-26T00:00:00.000Z");
  private readonly timers = new Set<FakeTimer>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): FakeTimer {
    const timer = new FakeTimer(this.currentTime + delayMs, callback);
    this.timers.add(timer);
    return timer;
  }

  clearTimeout(timer: RunManagerTimer): void {
    (timer as FakeTimer).cancelled = true;
  }

  advance(delayMs: number): void {
    const targetTime = this.currentTime + delayMs;
    while (true) {
      const next = [...this.timers]
        .filter((timer) => !timer.cancelled && timer.dueAt <= targetTime)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!next) {
        break;
      }

      this.timers.delete(next);
      next.cancelled = true;
      this.currentTime = next.dueAt;
      next.callback();
    }
    this.currentTime = targetTime;
  }
}

class ControlledHarnessRunner implements HarnessRunner {
  input?: StartRunInput;
  readonly signals: NodeJS.Signals[] = [];
  readonly process: RunningProcess = {
    runId: "run_hitl",
    pid: 42,
    runnerType: "adapter-native",
    write: () => {},
    kill: (signal = "SIGTERM") => {
      this.signals.push(signal);
    }
  };

  async startRun(input: StartRunInput): Promise<RunningProcess> {
    this.input = input;
    input.onSpawn?.(this.process.pid);
    return this.process;
  }
}

interface PublishedEvent {
  runId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

function runRecord(): RunRecord {
  return {
    id: "run_hitl",
    monde_id: "monde-test",
    mon_id: "frontend",
    status: "active",
    process_status: "running",
    outcome: "unknown",
    interaction_mode: "hitl_thread",
    runtime_state: "running",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "operator" },
    intent: { title: "Test HITL turn", prompt: "Test" },
    execution: {},
    result: {},
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z"
  };
}

function createHarness() {
  let run = runRecord();
  const clock = new FakeClock();
  const runner = new ControlledHarnessRunner();
  const events: PublishedEvent[] = [];
  const manager = new RunManager({
    mondes: {} as never,
    mons: {} as never,
    runs: {
      get: () => run,
      updateExecution: (_runId: string, execution: Record<string, unknown>) => {
        run = { ...run, execution };
      }
    } as never,
    logs: {} as never,
    artifacts: {} as never,
    events: {
      publish: (runId: string, eventType: string, payload: Record<string, unknown>) => {
        events.push({ runId, eventType, payload });
        return {} as never;
      }
    } as never,
    config: {
      serviceAddr: "http://127.0.0.1:3761",
      mcpAddr: "http://127.0.0.1:3762/mcp"
    },
    runner,
    clock
  });

  return {
    clock,
    runner,
    events,
    manager,
    run: () => run
  };
}

type TurnResult = {
  stdout: string;
  stderr: string;
  exit: { code: number | null; signal: NodeJS.Signals | null };
};

function startTurn(manager: RunManager): Promise<TurnResult> {
  const runHitlAdapterTurn = (
    manager as unknown as {
      runHitlAdapterTurn(input: {
        runId: string;
        runToken: string;
        prompt: string;
        runtimePrompt: string;
        scope: RunScopeSnapshot;
        sandboxMode: string;
        harness: string;
      }): Promise<TurnResult>;
    }
  ).runHitlAdapterTurn.bind(manager);

  return runHitlAdapterTurn({
    runId: "run_hitl",
    runToken: "run-token",
    prompt: "Test",
    runtimePrompt: "Runtime",
    scope: {} as RunScopeSnapshot,
    sandboxMode: "read-only",
    harness: "codex"
  });
}

function configureTimeouts(t: TestContext): void {
  const previous = {
    idle: process.env.MONDE_HITL_IDLE_TIMEOUT_MS,
    hard: process.env.MONDE_HITL_HARD_TIMEOUT_MS,
    grace: process.env.MONDE_HITL_KILL_GRACE_MS
  };
  process.env.MONDE_HITL_IDLE_TIMEOUT_MS = "100";
  process.env.MONDE_HITL_HARD_TIMEOUT_MS = "250";
  process.env.MONDE_HITL_KILL_GRACE_MS = "10";
  t.after(() => {
    restoreEnvironment("MONDE_HITL_IDLE_TIMEOUT_MS", previous.idle);
    restoreEnvironment("MONDE_HITL_HARD_TIMEOUT_MS", previous.hard);
    restoreEnvironment("MONDE_HITL_KILL_GRACE_MS", previous.grace);
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function allowRunnerHandleToAttach(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("run-token activity resets the HITL idle timeout", async (t) => {
  configureTimeouts(t);
  const harness = createHarness();
  const turn = startTurn(harness.manager);
  await allowRunnerHandleToAttach();

  harness.clock.advance(90);
  harness.manager.noteRunActivity("run_hitl", "mcp:tools/call");
  harness.clock.advance(90);

  assert.deepEqual(harness.runner.signals, []);
  assert.equal(harness.run().execution.hitl_last_activity_reason, "mcp:tools/call");
  assert.ok(harness.events.some((event) => event.eventType === "thread_turn_activity"));

  harness.runner.input?.onExit({ code: 0, signal: null });
  const result = await turn;
  assert.deepEqual(result.exit, { code: 0, signal: null });
});

test("an inactive HITL turn records and reports an idle timeout", async (t) => {
  configureTimeouts(t);
  const harness = createHarness();
  const turn = startTurn(harness.manager);
  const rejection = assert.rejects(turn, /no activity for 100ms/);
  await allowRunnerHandleToAttach();

  harness.clock.advance(100);
  await rejection;

  assert.deepEqual(harness.runner.signals, ["SIGTERM"]);
  assert.equal(harness.run().execution.hitl_timeout_reason, "idle_timeout");
  assert.ok(harness.events.some((event) => event.eventType === "thread_turn_idle_timeout" && event.payload.reason === "idle_timeout"));

  harness.clock.advance(10);
  assert.deepEqual(harness.runner.signals, ["SIGTERM", "SIGKILL"]);
});

test("the HITL hard timeout fires despite repeated activity", async (t) => {
  configureTimeouts(t);
  const harness = createHarness();
  const turn = startTurn(harness.manager);
  const rejection = assert.rejects(turn, /hard timeout of 250ms/);
  await allowRunnerHandleToAttach();

  harness.clock.advance(80);
  harness.runner.input?.onStdout("working");
  harness.clock.advance(80);
  harness.runner.input?.onStderr("checking");
  harness.clock.advance(80);
  harness.manager.noteRunActivity("run_hitl", "tool:write_log");
  harness.clock.advance(10);
  await rejection;

  assert.deepEqual(harness.runner.signals, ["SIGTERM"]);
  assert.equal(harness.run().execution.hitl_timeout_reason, "hard_timeout");
  assert.ok(harness.events.some((event) => event.eventType === "thread_turn_hard_timeout" && event.payload.reason === "hard_timeout"));
});

test("the legacy turn timeout remains the hard-timeout fallback", async (t) => {
  const previous = {
    idle: process.env.MONDE_HITL_IDLE_TIMEOUT_MS,
    hard: process.env.MONDE_HITL_HARD_TIMEOUT_MS,
    legacy: process.env.MONDE_HITL_TURN_TIMEOUT_MS,
    grace: process.env.MONDE_HITL_KILL_GRACE_MS
  };
  process.env.MONDE_HITL_IDLE_TIMEOUT_MS = "1000";
  delete process.env.MONDE_HITL_HARD_TIMEOUT_MS;
  process.env.MONDE_HITL_TURN_TIMEOUT_MS = "275";
  process.env.MONDE_HITL_KILL_GRACE_MS = "10";
  t.after(() => {
    restoreEnvironment("MONDE_HITL_IDLE_TIMEOUT_MS", previous.idle);
    restoreEnvironment("MONDE_HITL_HARD_TIMEOUT_MS", previous.hard);
    restoreEnvironment("MONDE_HITL_TURN_TIMEOUT_MS", previous.legacy);
    restoreEnvironment("MONDE_HITL_KILL_GRACE_MS", previous.grace);
  });

  const harness = createHarness();
  const turn = startTurn(harness.manager);
  const rejection = assert.rejects(turn, /hard timeout of 275ms/);
  await allowRunnerHandleToAttach();

  harness.clock.advance(275);
  await rejection;

  assert.equal(harness.run().execution.hitl_hard_timeout_ms, 275);
  assert.equal(harness.run().execution.hitl_timeout_reason, "hard_timeout");
});

test("chat timeout errors distinguish idle and hard timeout failures", () => {
  const baseEvent: RunEventDto = {
    id: "event_timeout",
    run_id: "run_hitl",
    event_type: "error",
    payload: {
      content: "Response failed.",
      last_activity_at: "2026-07-26T00:00:00.000Z"
    },
    created_at: "2026-07-26T00:02:00.000Z"
  };

  const idle = chatEventContent({
    ...baseEvent,
    payload: { ...baseEvent.payload, timeout_reason: "idle_timeout", idle_timeout_ms: 120000 }
  });
  const hard = chatEventContent({
    ...baseEvent,
    payload: { ...baseEvent.payload, timeout_reason: "hard_timeout", hard_timeout_ms: 900000 }
  });

  assert.match(idle, /No harness activity for 2 minutes\./);
  assert.match(idle, /Last activity:/);
  assert.match(hard, /Turn exceeded the maximum duration of 15 minutes\./);
  assert.match(hard, /Last activity:/);
});
