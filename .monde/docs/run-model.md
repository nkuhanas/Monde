# Run Model

Plan, cron, external integration, operator, and system intent sources create
runs.

Runs produce typed logs, raw output events, path-referenced artifacts, and
result summaries or review notes. For ordinary review-governed runs, a clean
process exit does not automatically mean the operator has accepted the
semantic outcome. Stable-key integration runs have a separate process-exit
projection described below.

## Core Fields

Ordinary one-shot runs use the v2.5 lifecycle split:

```text
status           Monde lifecycle placement
process_status   harness/process state
outcome          semantic/result state
warnings         non-terminal concerns
```

Examples:

```json
{
  "status": "finished",
  "process_status": "exited",
  "outcome": "unknown"
}
```

This means the process exited cleanly, but the operator has not asserted that
the intended work succeeded.

The corresponding extended lifecycle fields are also conservative:

```text
runtime_state = closed
outcome_state = unknown
close_reason = process_exited
```

`outcome = unknown` and `outcome_state = unknown` must agree after a clean
ordinary one-shot exit. A migration repairs older rows that paired an unknown
outcome with `outcome_state = succeeded`.

## One-Shot Runs And HITL Threads

Runs carry a top-level interaction mode:

- `one_shot` for process/task-bounded work such as CLI commands,
  plan-generated assignments, cron work, and direct harness invocations.
- `hitl_thread` for user/session-bounded conversations such as bottom-rail mon
  chats.

HITL adds user-facing thread state:

```text
runtime_state:
  queued
  running
  waiting_for_user
  idle_open
  closing
  closed
  failed
  cancelled

outcome_state:
  unknown
  succeeded
  failed
  partial
  abandoned
  superseded

close_reason:
  process_exited
  user_closed_widget
  user_marked_resolved
  user_abandoned
  system_cancelled
  error
```

One-shot runs end when their process/task exits. HITL threads do not close just
because the mon replied. A mon reply normally leaves the thread open as
`waiting_for_user` with `outcome_state = unknown`.

## Bottom Chat Threads

Web UI behavior:

- selecting a mon creates a local draft thread
- first send registers a server-backed `hitl_thread` run
- user messages render optimistically
- mon replies or errors are recorded as run events
- multiple thread widgets can stay expanded
- thread rail order is stable across refreshes

Closing a draft thread removes local UI state only.

Closing a server-backed bottom chat thread:

```text
runtime_state = closed
close_reason = user_closed_widget

clean final runtime state:
  outcome = completed
  outcome_state = succeeded

unresolved final error or timeout:
  outcome = unknown
  outcome_state = unknown
```

The web UI prompts before closing a server-backed thread. Threads have no
task-level success criterion, so a clean close is successful conversation
lifecycle rather than an operator-reviewed task result. A later successful
turn clears an earlier transient turn error for this decision; the event
history remains durable evidence.

## Queue Semantics

Existing Mon default:

```text
max_active_runs = 1
run_workspace.mode = shared
```

The process-slot dispatcher supports a configurable number of active
process-backed runs per Mon. Slot reservation is atomic in SQLite, the oldest
runnable queued run goes first, and a freed slot triggers more dispatch.
`max_active_runs > 1` requires isolated workspaces so concurrent processes do
not mutate one shared work root.

If every slot is occupied, new one-shot work queues unless the operator sends
input to an active run that accepts input. Open HITL threads do not permanently
occupy slots; their individual adapter turns do.

`monde wake <mon>`:

- attaches to an active run when present
- starts the oldest queued run when idle
- creates a manual operator run when idle with no queue

Queued plan/cron-origin starts should disclose origin before launch.

Queued work is restart-safe: after local startup reconciliation, runnable
queued runs return to the dispatcher. A queued run waiting for retry backoff
starts only after its persisted `retry_not_before` time.

## Logical Runs And Process Attempts

One logical run may contain multiple process attempts when its Mon opts into a
generic retry policy. Attempts are operational evidence, not new domain
executions:

```text
logical run ID and external execution key   stable
scope snapshot and scratch workspace        stable
process, run token, and MCP grants           new per attempt
process_attempt                              monotonically increasing
```

Retryable conditions include launch errors, non-zero exits, interrupted
processes, required MCP startup failure, per-attempt timeout, credential
expiry, and optionally an observed harness no-op. Backoff is persisted and
does not consume a process slot. Cancellation during backoff prevents another
attempt.

An observed no-op is intentionally opt-in. Silence is not generally proof that
a harness did no work. Monde does not retry a process found active after a
service restart because it no longer has enough evidence to guarantee that a
relaunch would not duplicate effects.

## Stable-Key Integration Runs

Generic integrations reserve a durable identity on
`(integration_id, external_execution_key)`. The same canonical request digest
returns the existing run; a different digest conflicts. This makes a lost HTTP
response recoverable without launching duplicate work.

The narrow integration-run endpoint accepts one opaque bounded context packet
and uses process-exit completion:

```text
clean acknowledged exit  → succeeded
non-zero/lost/failed      → failed
acknowledged cancellation → cancelled
```

No completion callback or Monde manifest is required. This lets an integration
apply independent domain validation after Monde has succeeded.

With generic retry enabled, a retryable process failure returns the same
logical execution to `pending`; only success, cancellation, or final exhausted
failure is terminal. Inspection can report the current process-attempt number,
retry condition, and next-attempt time. TeaParty still verifies whether the
successful process's claimed effects materialized.

## Optional External Completion

The broader external-execution API separates placement, externally asserted
outcome, and reconciliation detail:

```text
phase       queued | starting | active | awaiting_completion |
            cancelling | terminal
outcome     null | succeeded | failed | cancelled
condition   missing_completion | process_exit_nonzero | process_lost | ...
```

A clean process exit enters `awaiting_completion` only when the integration
chooses `completion_policy = external_receipt`. Only an idempotent external
completion receipt and/or an owned manifest can complete that optional mode.
Global retry attempt numbers and lineage are caller-owned opaque data; Monde
resolves only a nullable local predecessor.

Cancellation is also idempotent. Queued work terminates immediately; active
work records request and signal delivery, waits for process acknowledgement,
and distinguishes acknowledged, failed, and lost cancellation.

## Cron Semantics

A cron schedule produces one-shot runs with `origin.type = cron`.
Timezone-aware five-field schedules coalesce missed fires to the latest due
time and maintain at most one queued, starting, or active logical run per
schedule. Archived schedules retain fire and run history.

Legacy schedules carry a prompt, optional harness, and sandbox override.
Integration-owned schedules carry one bounded opaque context packet and create
the same process-exit execution contract as an idempotent integration start.
Their per-fire key is deterministic from the stable schedule key and scheduled
fire time, so replay cannot duplicate a fire.

Cron is not a workflow engine. A fired run is subject to its Mon's generic
retry policy just like a manually or externally started run; cron itself does
not own attempt classification, model routing, or machine routing.

## Evidence

Run evidence is attached directly to the run:

- `run_events` for process output and HITL messages
- `run_attempts` for durable launch, process, retry, and exit evidence
- typed logs for milestones/decisions/audit/review
- artifacts for path-referenced outputs
- immutable external-execution manifests for output hashes and staging
  references
- result summary/review fields

The operator console Attention section surfaces active, warning-bearing,
blocked, and queued plan/cron-origin runs from the same run records. It does
not introduce a separate task or obligation lifecycle.
