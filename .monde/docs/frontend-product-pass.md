# Frontend Product Direction

Monde is past the scaffold/proof phase. The frontend is now responsible for
turning a real execution substrate into an understandable operator product:
persistent Mons, logical runs, attempts, evidence, review, schedules, and local
machine context.

Current frontend priority:

```text
Make every execution understandable from first glance through forensic review.
```

The console should feel like an inhabited local operating environment, not an
admin CRUD shell and not a collection of disconnected agent chats.

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

The sidebar intentionally does not list Mons. Mons are actors inside a selected
Monde and are shown in the Mons tab and chat launcher.

Until authenticated machine inventory and deployment identity exist, every
Monde returned by the local service belongs to the first machine section. That
section uses the service hostname (`dev-vm` in development) and a
`This machine` treatment. Do not derive machine placement from Monde names or
filesystem paths. Future VM deployments should supply explicit machine records
through the service while keeping the current local machine first.

## Current UX Conventions

- Use Monde names in the sidebar.
- Use Mon IDs with `.mon` when referencing Mons, for example `frontend.mon`.
- Establish machine, Monde, Mon, run, and attempt hierarchy before details.
- Show status/mode as chips, not raw enum dumps, on compact thread surfaces.
- Keep the Overview visual and backdrop as the first-viewport signal.
- Prefer human-readable evidence summaries with expandable technical detail.
- Confirmation prompts use the shared overlay, not ad hoc browser confirms.
- Destructive actions should be explicit and should not silently remove server
  state.

## Bottom Chat Product Rules

- Choosing a Mon opens a draft thread locally.
- A draft thread becomes a real `hitl_thread` run only after first send.
- User messages render optimistically.
- A Mon typing indicator appears while a response is pending.
- Errors render as Mon-side failed responses.
- Multiple chat widgets can stay expanded.
- Thread order is stable in the rail; server refreshes update items in place
  rather than reordering by `updated_at`.
- A clean server-backed thread close is assumed successful when no runtime
  error or timeout remains unresolved.

## Run Review Surface

Run Review should make these fields obvious:

- origin and why the run exists
- intent title and prompt
- lifecycle/process/outcome
- `finished/exited/unknown` review warning for ordinary review-governed runs
- stable-key integration status without implying downstream domain validation
- process-attempt history and a legible pending-retry state
- runner, runner type, interaction mode, input mode, output mode
- write/sandbox/approval metadata
- terminal/output stream
- logs
- artifacts and diff evidence
- human-readable typed log messages with expandable payload details
- scope snapshot
- review summary and notes

The page should separate three questions that are often conflated:

```text
What is the runtime doing?      lifecycle and process state
What did Monde observe?         attempts, output, changes, logs, artifacts
What judgment was made?         operator or integration outcome
```

Compact run-kind badges use lowercase `thread` and `one-shot`. Closed clean
threads show no outcome actions. Closed threads with an unresolved runtime
error may be accepted or marked failed, but are not offered `Mark stopped`.

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
controls. Cron runs flow through the normal Runs and Review surfaces, where
their Mon-level process attempts and retry state remain visible.

## Deferred Areas

These should stay out of the current frontend polish path unless explicitly
needed:

- opencode breadth
- native PTY backend
- import/restore
- deeper plan review gates
- release packaging

Remote machine rows also remain deferred until the service exposes
authenticated inventory and deployment identity. The UI must not simulate a
distributed product ahead of the runtime contract.
