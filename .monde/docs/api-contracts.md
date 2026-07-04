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

Frontend code should import these as type-only contracts instead of redefining
local copies. Backend changes that alter these shapes should update
`api-contracts.ts` and the web UI in the same change.

## Stable Read Endpoints

```text
GET /health
GET /mondes
GET /mons?monde_id=
GET /runs?monde_id=&mon_id=&status=&origin_type=
GET /runs/:id
GET /runs/:id/events/history
GET /runs/:id/events?token=
GET /logs?run_id=
GET /artifacts?monde_id=&run_id=&mon_id=
GET /artifacts/:id
GET /plans?monde_id=
GET /plans/:id
GET /plans/:id/evidence
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
POST /mondes/:mondeId/threads
POST /runs/:id/messages
POST /plans
POST /plans/:id/assignments
POST /plans/:id/activate
POST /artifacts
POST /tools/runtime_scope
```

`/runs/:id/close` has two relevant surfaces:

- one-shot run close/review with an explicit `outcome`
- HITL thread close with a `close_reason`

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
```

The UI should not infer semantic completion from process exit. Use
`status`, `process_status`, and `outcome` together for one-shot run state.

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
