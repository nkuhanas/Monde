# Harness Liveness And HITL Timeouts

## Problem

HITL mon chat turns currently use a wall-clock timeout. The timer starts when
the adapter turn starts and does not reset while the harness is actively doing
useful work.

This can misclassify a healthy write-capable Codex turn as failed. A turn may
edit files, call MCP tools, write logs, run checks, and build successfully, but
still be terminated if it crosses the fixed turn duration before producing its
final mon response.

The operator-facing symptom is a generic `Response failed` message even though
the run produced useful progress and possibly completed the requested code
change.

## Goals

- Detect dead or silent harnesses by inactivity, not only elapsed wall time.
- Preserve a hard maximum duration as a last-resort safety guard.
- Surface progress in the UI while a HITL turn is active.
- Keep timeout behavior run-scoped and visible in run metadata/events.
- Avoid weakening write-run boundaries: `can_write`, `write_scope`, and
  `sandbox_mode` remain independent of timeout policy.

## Non-Goals

- Inferring semantic task success from activity.
- Treating all long-running turns as healthy.
- Letting harnesses run forever.
- Replacing run review or write evidence capture.

## Timeout Model

Each adapter turn should have two timers:

```text
idle_timeout_ms
hard_timeout_ms
```

`idle_timeout_ms` is reset whenever Monde observes meaningful activity from the
turn. If the turn is silent longer than this window, the service marks the turn
failed and attempts to terminate the adapter process.

`hard_timeout_ms` is not reset. It is a maximum total turn duration used as a
last-resort guard against runaway work.

Recommended defaults:

```text
MONDE_HITL_IDLE_TIMEOUT_MS = 120000
MONDE_HITL_HARD_TIMEOUT_MS = 900000
```

`MONDE_HITL_TURN_TIMEOUT_MS` should remain as a backward-compatible alias for
`MONDE_HITL_HARD_TIMEOUT_MS` during migration.

## Activity Signals

The service should update `last_activity_at` for a HITL adapter turn when any
of these happen:

- adapter process spawn
- stdout chunk from the harness process
- stderr chunk from the harness process
- MCP request authenticated with the run token
- `runtime_scope` tool call
- `search_docs` tool call
- `write_log` tool call
- `register_artifact` tool call
- run event published for the active turn
- process exit

Activity does not imply success. It only means the turn is alive enough that
the idle timeout should not fire.

## Run Metadata

While a HITL turn is running, `run.execution` should include:

```text
hitl_turn_started_at
hitl_last_activity_at
hitl_idle_timeout_ms
hitl_hard_timeout_ms
hitl_timeout_reason
```

`hitl_timeout_reason` is set only on timeout:

```text
idle_timeout
hard_timeout
```

Existing fields such as `chat_last_turn_started_at`,
`chat_last_turn_finished_at`, and `chat_last_error` should remain for UI
compatibility.

## Events

The service should publish explicit activity and timeout events:

```text
thread_turn_started
thread_turn_activity
thread_turn_idle_timeout
thread_turn_hard_timeout
thread_turn_failed
thread_turn_finished
```

`thread_turn_activity` should be rate-limited so noisy stdout or polling-heavy
MCP usage does not flood the UI. A reasonable default is at most one visible
activity event every 2 seconds, while internal `last_activity_at` updates still
occur for every activity signal.

## UI Behavior

The bottom mon chat should show an active state while the service observes
activity:

```text
working
checking
building
calling tools
last active <relative time>
```

The first implementation can use generic copy such as `working` and
`last active`. More detailed labels can come later from typed activity payloads.

On timeout, the UI should distinguish:

- `No harness activity for <idle_timeout>.`
- `Turn exceeded the maximum duration of <hard_timeout>.`

The error event should include the timeout reason and last activity timestamp
so the operator can decide whether to retry, split the task, or inspect partial
work.

## Implementation Shape

Add a small run-scoped activity tracker owned by the service process:

```text
RunActivityTracker.touch(run_id, reason)
RunActivityTracker.snapshot(run_id)
RunActivityTracker.clear(run_id)
```

The run manager creates a tracker entry at HITL turn start. The process runner
touches it on spawn/stdout/stderr/exit. MCP and tool routes touch it after
run-token authorization resolves a run id.

The HITL adapter turn watchdog should:

1. Start both idle and hard timers.
2. Reset only the idle timer on tracker activity.
3. On idle timeout, send SIGTERM and record `idle_timeout`.
4. On hard timeout, send SIGTERM and record `hard_timeout`.
5. Escalate to SIGKILL after a short grace period if the process remains alive.
6. Clear tracker state when the turn finishes or fails.

## Acceptance Criteria

- A HITL Codex turn that writes logs or calls MCP tools every 60 seconds is not
  killed by the idle timeout.
- A HITL Codex turn with no stdout, stderr, MCP calls, logs, artifacts, or run
  events for longer than `MONDE_HITL_IDLE_TIMEOUT_MS` fails with
  `hitl_timeout_reason = idle_timeout`.
- A HITL Codex turn that remains active longer than
  `MONDE_HITL_HARD_TIMEOUT_MS` fails with
  `hitl_timeout_reason = hard_timeout`, even if it is producing activity.
- Timeout errors shown in the chat UI include the timeout kind and last
  activity timestamp.
- Existing one-shot run behavior is unchanged.
- Existing `MONDE_HITL_TURN_TIMEOUT_MS` deployments continue to work as a hard
  timeout alias.

## Test Plan

- Unit-test the watchdog with a fake clock and fake process handle.
- Service-test HITL turn activity from stdout/stderr.
- Service-test run-token MCP activity resetting the idle timer.
- Service-test idle timeout with no activity.
- Service-test hard timeout despite repeated activity.
- Web-test that idle and hard timeout events render distinct error messages.
