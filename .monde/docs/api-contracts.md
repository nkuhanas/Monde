# Frontend API Contracts

The web UI should treat backend responses as stable DTOs owned by
`@monde/core` in `api-contracts.ts`.

Primary DTOs:

- `RunDto`
- `MonDto`
- `PlanDto`
- `PlanEvidenceDto`
- `ArtifactDto`
- `ArtifactDetailDto`
- `LogEventDto`
- `RunEventDto`
- `AdapterInfoDto`
- `HealthDto`
- `BackupInfoDto`
- `DoctorStatusDto`
- `ExternalExecutionDto`
- `IntegrationRunSnapshotDto`
- `RunAttemptDto`
- `ExecutionManifestDto`
- `CronScheduleDto`
- `CronFireDto`

Frontend code should import these as type-only contracts instead of redefining
local copies. Backend changes that alter these shapes should update
`api-contracts.ts` and the web UI in the same change.

`GET /health` includes `machine_name`, sourced from the local service host. The
web UI uses it as presentation identity for the current machine; it is not a
durable cross-machine identifier.

## Stable Read Endpoints

```text
GET /health
GET /mondes
GET /mons?monde_id=
GET /runs?monde_id=&mon_id=&status=&origin_type=
GET /runs/:id
GET /runs/:id/attempts
GET /runs/:id/external-execution
GET /runs/:id/manifest
GET /runs/:id/events/history
GET /runs/:id/events?token=
GET /external-executions/lookup?integration_id=&external_execution_key=
GET /external-executions/:id
GET /external-executions/:id/manifest
GET /mondes/:mondeId/integrations/:integrationId/runs/:executionKey
GET /mondes/:mondeId/integrations/:integrationId/schedules/:scheduleKey
GET /logs?run_id=
GET /artifacts?monde_id=&run_id=&mon_id=
GET /artifacts/:id
GET /plans?monde_id=
GET /plans/:id
GET /plans/:id/evidence
GET /cron-schedules?monde_id=
GET /cron-schedules/:id
GET /mondes/:mondeId/threads?runtime_state=open
GET /adapters
GET /backup/info
GET /backup/list
GET /doctor
```

## Stable Mutation/Action Endpoints

```text
POST /mondes/upsert
POST /mons/upsert
PATCH /mons/:mondeId/:monId
DELETE /mons/:mondeId/:monId
POST /runs/operator
POST /runs/:id/start
POST /runs/:id/input
POST /runs/:id/interrupt
POST /runs/:id/cancel
POST /runs/:id/close
POST /runs/:id/review
POST /runs/:id/resolve
POST /runs/:id/abandon
POST /external-executions
POST /external-executions/:id/complete
POST /external-executions/:id/cancel
POST /mondes/:mondeId/integrations/:integrationId/runs
POST /mondes/:mondeId/integrations/:integrationId/runs/:executionKey/cancel
POST /mondes/:mondeId/integrations/:integrationId/schedules
DELETE /mondes/:mondeId/integrations/:integrationId/schedules/:scheduleKey
PUT /external-executions/:id/manifest
PUT /external-executions/:id/manifest/outputs/:logicalName/availability
POST /mondes/:mondeId/threads
POST /runs/:id/messages
POST /plans
POST /plans/:id/assignments
POST /plans/:id/activate
POST /cron-schedules
PATCH /cron-schedules/:id
DELETE /cron-schedules/:id
POST /artifacts
GET /runs/:id/runtime-scope
POST /tools/runtime_scope
```

The operator UI reads run scope through `GET /runs/:id/runtime-scope`. The
`POST /tools/runtime_scope` form remains a run-token-scoped harness/MCP
capability and is intentionally not a browser API.

`/runs/:id/close` has two relevant surfaces:

- one-shot run close/review with an explicit `outcome`
- HITL thread close with a `close_reason`

For `close_reason = user_closed_widget`, the service records a clean HITL
thread as `completed/succeeded` when its final execution metadata has no
unresolved chat error or timeout. A thread with an unresolved error remains
`unknown` for optional operator review. Earlier recovered turn errors stay in
the event history but do not force review.

## Run Execution Metadata

The UI expects this metadata under `run.execution`:

```text
runner
runner_type
interaction_mode
input_mode
output_mode
can_write
write_scope
sandbox_mode
approval_mode
adapter_status
mcp_status
prompt_injection_status
diff_capture
terminal
process_attempt
retry_condition
retry_not_before
```

For ordinary review-governed runs, the UI should not infer semantic completion
from process exit. Use `status`, `process_status`, and `outcome` together for
their one-shot run state.

The narrow integration-run surface exposes:

```text
status     pending | running | succeeded | failed | cancelled

optional operational attempt detail:
process_attempt
retry_condition
next_attempt_at
```

It uses `completion_policy = process_exit`; a clean acknowledged exit is
generic execution success and requires no callback or manifest. Its request
contains one bounded opaque `context_packet`, and the server computes the
canonical idempotency digest. A retryable attempt failure returns the same
logical execution to `pending`; it does not allocate another execution key.

`GET /runs/:id/attempts` returns ordered durable process-attempt records. An
attempt may be `starting`, `active`, `succeeded`, `failed`, `cancelled`, or
`lost`, with its operational condition, process evidence, and retry wake time.
This ledger is not a caller-domain retry or semantic validation record.

Example:

```json
{
  "attempts": [
    {
      "attempt_number": 1,
      "status": "failed",
      "condition": "credential_expired",
      "retry_at": "2026-07-27T01:45:00.000Z"
    },
    {
      "attempt_number": 2,
      "status": "succeeded",
      "condition": null,
      "retry_at": null
    }
  ]
}
```

`POST /runs/:id/start` does not override a future persisted retry time.
Cancellation during backoff clears the scheduled wake and terminally cancels
the logical run.

Integration-owned cron registration uses the same opaque-packet boundary:

```text
POST   /mondes/:mondeId/integrations/:integrationId/schedules
GET    /mondes/:mondeId/integrations/:integrationId/schedules/:scheduleKey
DELETE /mondes/:mondeId/integrations/:integrationId/schedules/:scheduleKey
```

Registration is idempotent on `(integrationId, scheduleKey)` plus the
server-computed request digest. A conflicting replay returns 409. Each fire
creates a process-exit integration run with a deterministic execution key
derived from the schedule key and scheduled fire time.

The broader optional external-execution surface additionally uses:

```text
phase                  queued | starting | active | awaiting_completion |
                       cancelling | terminal
outcome                null | succeeded | failed | cancelled
condition              precise failure or reconciliation reason
cancellation_state     none | requested | signalled | acknowledged |
                       failed | lost
```

A clean process exit is `awaiting_completion` only for
`completion_policy = external_receipt`. Integrations that intentionally choose
that optional policy make an idempotent completion call with an opaque receipt,
an owned immutable manifest, or both.

For HITL thread cards, prefer user-facing metadata:

```text
harness chip
runtime status chip
mode chip
work root tail
```

Avoid showing `outcome_state = unknown` as primary chat thread metadata.

## Auth

API requests use:

```text
Authorization: Bearer <local-service-token>
```

Event streams may use:

```text
?token=<local-service-token>
```

MCP/tool calls must include run identity and run-scoped authorization unless
they are privileged service-token calls from the local UI/backend.

External MCP integrations receive a distinct server-specific grant and call
`POST /external-mcp/introspect`; they never receive the local service token.

Backup checksum verification and restore rehearsal are CLI-only operational
commands:

```text
monde backup verify <backup.sqlite>
monde backup rehearse <backup.sqlite> --destination <new-directory>
```

See `tea-party-integration.md` for the TeaParty v1 start, inspect, cancel, and
process-exit contract.
