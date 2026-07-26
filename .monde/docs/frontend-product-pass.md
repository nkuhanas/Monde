# Frontend Product Pass

Monde is now past the initial scaffold/proof phase. The current frontend is an
operator console with a working overview, tabs, run review, plan evidence,
artifacts, status/doctor views, and a bottom mon chat rail.

Current frontend priority:

```text
Make Monde understandable and usable from the web UI without reading CLI logs.
```

## Implemented Information Architecture

```text
Local-machine sidebar
  one local machine section
  Monde rows

Main workspace
  Overview
  Runs
  Mons
  Plans
  Cron
  Artifacts
  Status
  Review

Persistent bottom rail
  mon launcher
  expanded/collapsed chat threads
```

The sidebar intentionally does not list mons. Mons are actors inside a selected
Monde and are shown in the Mons tab and chat launcher.

Until authenticated machine inventory and deployment identity exist, every
Monde returned by the local service belongs to the single `Local Machine`
section. Do not derive machine placement from Monde names or filesystem paths.
Future VM deployments should supply explicit machine records through the
service.

## Current UX Conventions

- Use Monde names in the sidebar.
- Use mon ids with `.mon` when referencing mons, for example `frontend.mon`.
- Show status/mode as chips, not raw enum dumps, on compact thread surfaces.
- Keep the Overview visual and backdrop as the first-viewport signal.
- Confirmation prompts use the shared overlay, not ad hoc browser confirms.
- Destructive actions should be explicit and should not silently remove server
  state.

## Bottom Chat Product Rules

- Choosing a mon opens a draft thread locally.
- A draft thread becomes a real `hitl_thread` run only after first send.
- User messages render optimistically.
- A mon typing indicator appears while a response is pending.
- Errors render as mon-side failed responses.
- Multiple chat widgets can stay expanded.
- Thread order is stable in the rail; server refreshes update items in place
  rather than reordering by `updated_at`.

## Run Review Surface

Run Review should make these fields obvious:

- origin and why the run exists
- intent title and prompt
- lifecycle/process/outcome
- `finished/exited/unknown` review warning for ordinary review-governed runs
- stable-key integration status without implying downstream domain validation
- runner, runner type, interaction mode, input mode, output mode
- write/sandbox/approval metadata
- terminal/output stream
- logs
- artifacts and diff evidence
- scope snapshot
- review summary and notes

## Plan Evidence Surface

Plans are coordination contracts. The UI should present:

- objective and state
- assignments
- generated runs grouped by assignment or phase
- run lifecycle/process/outcome
- artifacts
- important logs/milestones
- warnings
- result summaries and review notes

Do not assume final Parley-deep semantics. Plans currently mean coordination
contract plus assignments plus generated run evidence.

## Artifact And Diff Review

Write-capable agents are trusted through evidence. The artifact surface should
prioritize:

- changed files
- diff stat
- bounded diff excerpt
- artifact type
- path status
- linked run

Artifacts are path references in MVP, not blob storage.

## Cron

Cron has its own top-level operator surface. It lists generic Monde schedules,
target Mons, timezone-aware expressions, next fires, enablement, and archive
controls. Cron runs flow through the normal Runs and Review surfaces.

## Deferred Areas

These should stay out of the current frontend polish path unless explicitly
needed:

- opencode breadth
- native PTY backend
- import/restore
- deeper plan review gates
- release packaging
