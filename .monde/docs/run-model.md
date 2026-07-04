# Run Model

Plan, cron, operator, and system intent sources create runs.

Runs produce typed logs, raw output events, path-referenced artifacts, and
result summaries or review notes. A clean process exit does not automatically
mean the semantic outcome is completed.

## Core Fields

One-shot runs use the v2.5 lifecycle split:

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

MVP invariant for one-shot runs:

```text
one active process-backed run per mon
```

If a mon is busy, new one-shot work queues unless the operator explicitly sends
input to an active run that accepts input.

`monde wake <mon>`:

- attaches to active work when present
- starts the oldest queued run when idle
- creates a manual operator run when idle with no queue

Queued plan/cron-origin starts should disclose origin before launch.

## Evidence

Run evidence is attached directly to the run:

- `run_events` for process output and HITL messages
- typed logs for milestones/decisions/audit/review
- artifacts for path-referenced outputs
- result summary/review fields

The operator console Attention section surfaces active, warning-bearing,
blocked, and queued plan/cron-origin runs from the same run records. It does
not introduce a separate task or obligation lifecycle.
