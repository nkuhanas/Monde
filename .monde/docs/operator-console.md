# Operator Console

The Monde web UI is the local operator console for the selected Monde. It is
the primary product surface for understanding what agents are doing, why they
are doing it, and what evidence they produced.

## Shell Layout

Current layout:

```text
left sidebar       machine -> Monde hierarchy
top tabs           Overview, Runs, Mons, Plans, Cron, Artifacts, Status, Review
main surface       selected tab content
bottom rail        human-in-the-loop mon chat launcher and thread widgets
overlay layer      reusable confirmation prompts
```

The sidebar is grouped by machine first, then Monde. The current grouping is
presentation data until machine inventory is implemented. Monde names, not mon
names, are shown under each machine.

## Overview

The Overview tab is the visual home surface. It uses the current Monde backdrop
asset, sector cards, a status/telemetry strip, and a right-side Monde panel.

Overview should answer:

- which Monde is selected
- how many mons/runs/plans/artifacts matter right now
- what needs attention
- where to click next

The primary creation affordance is `Add new .mon`.

## Main Tabs

Runs:

- active, queued, warning-bearing, and reviewable runs
- lifecycle/process/outcome fields
- runtime state for HITL threads
- runner, harness, input mode, and write metadata

Mons:

- registered mons in the selected Monde
- mon ids are shown as filesystem-branded names such as `frontend.mon`

Plans:

- server-owned coordination contracts
- assignments
- generated runs
- evidence aggregated from linked runs

Cron:

- generic timezone-aware schedules owned by Monde
- target Mon, prompt, harness/sandbox overrides, and next fire
- enable/disable and archive controls
- coalesced fire and generated-run history

Cron creates ordinary runs. It does not represent TeaParty workflows, retries,
or machine/model routing.

Artifacts:

- path-referenced artifacts
- path status
- bounded content excerpts when available

Status:

- service health
- adapter status
- SQLite DB path and schema
- backup and doctor findings

Review:

- run transcript/history
- logs, artifacts, runtime scope, review outcome, notes, and summary

## Bottom Mon Chat Rail

The bottom rail is a persistent chat launcher and thread surface.

Behavior:

- `Add new .mon chat` expands to list mons.
- The launcher does not collapse when a mon is selected.
- Selecting a mon creates or focuses a local draft thread.
- A thread becomes a registered server run only after the first message.
- Multiple chat widgets can be expanded at once.
- Expanded chat headers minimize when clicked.
- Collapsed chat pills expand when clicked.
- Close buttons are rounded-square controls layered above the clickable header
  or pill surface.

Thread display:

- mon name
- harness chip first
- runtime status chip second
- mode chip third
- work root tail
- message timestamps using the browser/computer timezone

Runtime status examples:

```text
idle
working
waiting
queued
closed
failed
```

Mode examples:

```text
draft
read only
write
mode unknown
```

Closing policy:

- Draft threads close immediately because they are local-only.
- Server-backed threads show the reusable confirmation overlay.
- Closing a HITL thread records `close_reason = user_closed_widget`.

## Confirmation Overlay

The web UI has a generic confirmation overlay for destructive or irreversible
actions. The first production use is closing server-backed chat threads.

The overlay supports:

- default and danger tones
- title/body copy
- custom confirm/cancel labels
- Escape/backdrop cancel
- busy state while the action is running

## Review And Outcome

Process completion is not semantic completion. A run can be
`finished/exited/unknown` until an operator reviews it.

Run review records:

- `run.result.summary`
- `run.result.reviewed_by`
- `run.result.reviewed_at`
- `run.result.notes`
- audit log entries

The UI should keep outcome review explicit and should not hide uncertainty.

## Write Evidence

Write-capable runs surface git evidence when available:

- pre-run HEAD/status
- post-run status
- changed files
- diff stat
- bounded diff artifacts

Artifacts are path references, not blobs. Missing paths should remain visible
instead of disappearing from review surfaces.
