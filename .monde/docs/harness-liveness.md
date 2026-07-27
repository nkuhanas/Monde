# Harness Liveness And HITL Timeouts

## Current Status

Activity-aware HITL watchdogs are implemented in the service. Each adapter turn
has a resettable idle timeout and a non-resettable hard timeout. Process output,
and run-scoped MCP/tool calls keep an active turn alive without claiming that
the work succeeded.

The web chat surface distinguishes idle and hard timeout failures and includes
the last recorded activity timestamp in the rendered error. One-shot run
timeouts use a separate process-attempt policy and do not use this HITL
activity model.

## Problem Addressed

The earlier HITL implementation used one wall-clock turn timeout. A healthy
write-capable Codex turn could edit files, call MCP tools, write logs, run
checks, and build successfully, but still be terminated before its final mon
response.

Liveness is now based on observed activity, with a hard maximum retained as the
last-resort guard against runaway work.

## Timeout Model

Each adapter turn uses:

```text
idle_timeout_ms
hard_timeout_ms
```

`idle_timeout_ms` resets whenever Monde observes meaningful activity from the
turn. If the turn is silent longer than this window, the service marks the turn
failed and terminates the adapter process.

`hard_timeout_ms` never resets. It is the maximum total turn duration.

Current defaults:

```text
MONDE_HITL_IDLE_TIMEOUT_MS = 120000
MONDE_HITL_HARD_TIMEOUT_MS = 900000
MONDE_HITL_KILL_GRACE_MS = 5000
```

`MONDE_HITL_TURN_TIMEOUT_MS` remains a backward-compatible fallback for
`MONDE_HITL_HARD_TIMEOUT_MS`.

One-shot Mons may separately configure:

```text
retry_policy.attempt_timeout_seconds
retry_policy.kill_grace_seconds
```

That deadline does not reset on activity. It records `attempt_timeout`,
signals the process group, and either schedules another process attempt or
terminally fails the logical run according to the Mon retry policy.

## Activity Signals

The service updates `hitl_last_activity_at` when it observes:

- adapter process spawn
- stdout or stderr from the harness
- process exit
- an authenticated run-scoped MCP request
- a run-scoped tool call, including `runtime_scope`, `search_docs`,
  `write_log`, and `register_artifact`

Activity does not imply success. It only means the adapter turn is alive enough
that the idle timeout should not fire.

## Run Metadata

While a HITL turn is running, `run.execution` includes:

```text
hitl_turn_started_at
hitl_last_activity_at
hitl_last_activity_reason
hitl_idle_timeout_ms
hitl_hard_timeout_ms
hitl_timeout_reason
hitl_timeout_at
```

`hitl_timeout_reason` is null for a normal turn and becomes one of:

```text
idle_timeout
hard_timeout
```

Existing compatibility fields remain:

```text
chat_last_turn_started_at
chat_last_turn_finished_at
chat_last_error
```

## Events

The service publishes:

```text
thread_turn_started
thread_turn_activity
thread_turn_idle_timeout
thread_turn_hard_timeout
thread_turn_failed
thread_turn_finished
```

Visible `thread_turn_activity` events are rate-limited to at most one every two
seconds, while internal activity timestamps and idle timeout resets still occur
for every signal.

## Timeout And Process Behavior

The run manager owns one activity tracker per active HITL adapter turn:

```text
turn start
  -> start idle timer
  -> start hard timer
  -> reset idle timer on activity
  -> clear tracker and revoke run token on completion/failure
```

On timeout, Monde:

1. records the timeout reason and last activity
2. publishes the reason-specific timeout event
3. sends `SIGTERM` to the spawned process group on POSIX, or the direct child
   where process groups are unavailable
4. schedules `SIGKILL` against the same target after the configured grace
   period
5. rejects the turn and revokes its run-scoped token

## UI Behavior

An active chat turn uses the generic `working` state. Timeout errors distinguish:

```text
No harness activity for <idle_timeout>.
Turn exceeded the maximum duration of <hard_timeout>.
```

Both include the last activity timestamp when available. Richer live labels
such as `building` or `calling tools`, and a continuously visible relative
`last active` indicator, remain future UI refinement rather than current
behavior.

## Verification

Focused tests cover:

- HITL tokens requiring a current, non-timed-out adapter turn
- run-scoped/MCP activity resetting the idle timer
- idle timeout metadata, events, and termination
- hard timeout despite repeated activity
- termination of descendants through POSIX process-group signaling
- the legacy turn-timeout environment fallback
- distinct idle and hard timeout copy in the chat view model

The deterministic smoke suites continue to cover run-scoped MCP authorization,
process lifecycle, write evidence, review, and cross-Monde isolation. External
Codex execution remains an explicit opt-in smoke.
