# Write Runs

Write-capable runs are explicit. Codex defaults to read-only; use `--write` or
`--sandbox workspace-write` when the operator intends bounded writes.

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

For Codex, `write_scope` is the resolved mon `work_root`.

## Evidence Capture

When the Monde root is in git, write runs capture:

- pre-run HEAD/status
- post-run status
- changed files
- diff stat
- bounded diff artifacts

Changed files are registered as file artifacts when manageable.

Missing git context adds `no_git_diff_available` instead of inventing evidence.

## Artifacts

Artifacts are path references. The service reports:

- `path_exists`
- `path_status`
- bounded content excerpts when available
- `content_truncated`
- file size when available

Monde does not copy artifact files into blob storage in MVP. Missing paths
remain visible in UI/doctor output.

## Review

The trust surface for write-capable agents is evidence review, not automatic
success. A clean process exit can still leave `outcome = unknown` until an
operator reviews the run.
