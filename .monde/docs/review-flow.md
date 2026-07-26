# Review Flow

Run review is the operator path for turning process evidence from ordinary
operator, plan, and cron runs into an operator-reviewed outcome.

A process can finish cleanly while the outcome remains `unknown`. Review
records result data and appends audit evidence.

This review gate does not apply to stable-key integration runs created through
the narrow integration API. Those runs use `completion_policy = process_exit`:
a clean acknowledged exit becomes Monde operational success immediately. The
caller may subsequently reject domain output in its own state without changing
the Monde run from `succeeded`.

The broader generic external-execution API can instead opt into
`completion_policy = external_receipt`. That path remains
`awaiting_completion` after a clean exit until the integration provides its
idempotent opaque receipt. It is a separate machine-to-machine lifecycle, not
an operator review requirement.

## One-Shot Run Review

Review records:

```text
run.result.summary
run.result.reviewed_by
run.result.reviewed_at
run.result.notes
```

CLI:

```bash
monde run close <run-id> --outcome completed --summary "Accepted"
monde run close <run-id> --outcome failed --summary "Needs correction"
monde run review <run-id> --outcome stopped --notes "Stopped during review"
```

Web Run Review shows:

- origin
- intent
- lifecycle/process/outcome
- harness mode
- write/sandbox metadata
- logs
- artifacts
- warnings
- result review data

## HITL Thread Closure

Bottom chat threads are not the same as one-shot process completion.

Closing a server-backed chat thread records:

```text
runtime_state = closed
close_reason = user_closed_widget

no unresolved runtime error:
  outcome = completed
  outcome_state = succeeded

unresolved runtime error or timeout:
  outcome = unknown
  outcome_state = unknown
```

The web UI asks for confirmation before closing a server-backed thread.
Draft threads are local-only and close without confirmation.

A thread is an open-ended conversation rather than goal-bearing work. A clean
widget close therefore needs no operator outcome review. A recovered earlier
turn error remains visible as evidence but does not block the clean close;
Monde checks the unresolved final error/timeout state.

If an error remains unresolved, review offers `Mark failed` or
`Accept conversation`. It does not offer `Mark stopped` for a thread that is
already closed. Explicit resolve and abandon endpoints remain available for
callers that want those stronger close reasons.

## UI Principle

Use lowercase `thread` in compact metadata. Do not show `unknown` outcome as
primary compact metadata. Use outcome in review surfaces, and use
status/mode/harness in chat and compact operator controls.
