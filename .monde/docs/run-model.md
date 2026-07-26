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
outcome_state = unknown
close_reason = user_closed_widget
```

The web UI prompts before closing a server-backed thread.

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

A cron schedule produces ordinary one-shot runs with `origin.type = cron`.
Timezone-aware five-field schedules coalesce missed fires to the latest due
time and maintain at most one queued, starting, or active run per schedule.
Archived schedules retain fire and run history.

Cron is not a workflow or retry engine. The scheduled prompt, optional harness,
and sandbox override are the complete activation contract.

## Evidence

Run evidence is attached directly to the run:

- `run_events` for process output and HITL messages
- typed logs for milestones/decisions/audit/review
- artifacts for path-referenced outputs
- immutable external-execution manifests for output hashes and staging
  references
- result summary/review fields

The operator console Attention section surfaces active, warning-bearing,
blocked, and queued plan/cron-origin runs from the same run records. It does
not introduce a separate task or obligation lifecycle.
