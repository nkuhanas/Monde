# Write Runs

Write access is an explicit run capability, not an assumed property of a Mon
or harness. Monde grants it for a bounded execution scope and records the
resulting change evidence.

Codex write-capable runs are explicit. Codex defaults to read-only; use
`--write` or `--sandbox workspace-write` when the operator intends bounded
writes.

```bash
monde message frontend.mon "Make the UI fix" --harness codex --write
monde wake frontend.mon --harness codex --sandbox workspace-write
```

Monde stores write metadata on `run.execution`:

- `can_write`
- `write_scope`
- `sandbox_mode`
- `approval_mode`
- `diff_capture`

For a shared Codex run, `write_scope` is the resolved Mon `work_root`. For an
isolated Codex run, it is the run's unique scratch directory. The immutable
actor-context snapshot and configured read mounts remain read-only and are not
part of the writable scope.

This is adapter-specific. `basic-process` does not implement an OS sandbox:
its declared work root is context and a working directory, not an enforced
write boundary. Basic-process commands must therefore be trusted as the Monde
service user.

## Evidence Capture

When the Monde root is in git, write runs capture:

- pre-run HEAD/status
- post-run status
- changed files
- diff stat
- bounded diff artifacts

Changed files are registered as file artifacts when manageable.

Missing git context adds `no_git_diff_available` instead of inventing evidence.

## Retry Safety

Generic process retry preserves the run's workspace. An isolated run reuses
its run-scoped scratch directory; a shared run reuses the same Mon work root.
This permits recovery or continuation, but it also means a failed attempt's
partial writes remain visible to the next attempt.

Do not enable automatic retry for write-capable work unless the operation is
idempotent, explicitly resumable, or can safely recognize its prior partial
effects. A non-zero exit, timeout, credential failure, or lost connection does
not prove that no write or external tool call occurred.

Existing Mons default to `max_attempts: 1`, preserving operator-reviewed
single-attempt write behavior.

## Artifacts

Artifacts are path references. The service reports:

- `path_exists`
- `path_status`
- bounded content excerpts when available
- `content_truncated`
- file size when available

Monde does not copy artifact files into blob storage in MVP. Missing paths
remain visible in UI/doctor output. The optional immutable execution-manifest
facility also stores metadata and references rather than artifact bytes; it is
not required by the stable-key process-exit integration path.

## Review

For ordinary operator, plan, and cron writes, the trust surface is evidence
review rather than automatic success. A clean process exit can leave
`outcome = unknown` until an operator reviews the run.

When retry is enabled, diff evidence is finalized only when the logical run
becomes terminal. The process-attempt ledger records the failed and successful
launches separately.

For a stable-key integration run using `completion_policy = process_exit`, a
clean exit means only that Monde executed the process successfully. The
integration remains responsible for reviewing or validating its domain output,
and that later decision does not alter the Monde outcome.
