# Plans

Plans are server-owned coordination contracts, not a general workflow engine.
They express declared intent and responsibility, then create accountable runs
from assignments. Plans do not execute directly.

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

A plan assignment links to one logical run even when that run has multiple
process attempts. During retry backoff the run and assignment return to
`queued`; another run ID is not generated. The eventual terminal run result
drives the assignment status, while `GET /runs/:id/attempts` and the Review
evidence tab retain the intermediate attempt failures.

Plan-level follow-up or retry remains a coordination decision. Mon-level
process retry handles only configured operational failures inside the existing
logical assignment run.

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
