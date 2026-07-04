# Plans

Plans are server-owned coordination contracts. They do not execute directly.
Activation creates queued runs from assignments.

Short form:

```text
Plan = declared goal + coordination state + run generation model + evidence surface
```

## Current MVP Shape

A plan has:

- title/objective/prompt/description
- lifecycle status
- assignments
- generated run ids
- evidence aggregated from linked runs

Assignments currently include:

- assigned mon
- assignment title/prompt
- optional phase
- generated run ids
- status

CLI:

```bash
monde plan create "Review auth state" --mon frontend.mon --prompt "Review the auth UI changes"
monde plan assign <plan-id> --mon service.mon --prompt "Review service changes"
monde plan activate <plan-id>
monde plan list
monde plan show <plan-id>
monde plan search auth
```

Web UI:

- Plans tab lists coordination contracts and assignments.
- Activation creates queued plan-origin runs.
- Plan evidence aggregates linked runs, artifacts, logs, warnings, and review
  state.

## Relationship To Runs

The plan itself does not execute. Runs are the execution/provenance records.

Parley-to-Monde translation:

```text
Parley task        -> Monde run or plan assignment that creates a run
Parley obligation  -> plan constraint, unresolved item, or queued follow-up run
Parley effect      -> typed log/result/artifact evidence attached to runs
Parley artifact    -> Monde artifact attached to a run and visible through the plan
Parley projection  -> web UI view, not filesystem projection in MVP
```

If a commitment is executable, represent it as a queued run. If it is an
invariant, keep it in plan state. If it is human context, keep it as a note.

Do not add filesystem plan projections in MVP.
