# Review Flow

Run review is the operator path for turning process evidence into semantic
outcome.

A process can finish cleanly while the outcome remains `unknown`. Review
records result data and appends audit evidence.

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
outcome_state = unknown
close_reason = user_closed_widget
```

The web UI asks for confirmation before closing a server-backed thread.
Draft threads are local-only and close without confirmation.

Explicit success/resolution should be a separate review/resolve action rather
than treating widget close as completion.

## UI Principle

Do not show `unknown` outcome as primary compact metadata. Use outcome in review
surfaces, and use status/mode/harness in chat and compact operator controls.
