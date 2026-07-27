# TeaParty V1 Monde Integration

TeaParty v1 uses Monde as a local, generic Mon process substrate. Monde owns
process slots, verified run isolation, Codex launch, actor-context snapshots,
external MCP attachment, cancellation, and operational evidence. TeaParty owns
all domain and output semantics.

TeaParty does not send a semantic completion callback, register a Monde
execution manifest, stage outputs in Monde scratch, or expose QueueItem,
Persona, pipeline, Recipe, lease, artifact-sink, or lineage fields separately.
Those values remain in TeaParty storage or inside one opaque context packet.

## Adapter Port

The TeaParty application port remains:

```ts
type StartMondeRunRequest = {
  executionKey: string;
  monId: string;
  contextPacket: TeaPartyRunContextPacket;
};

type MondeRunSnapshot = {
  runId: string;
  executionKey: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  failureCode?: string;
  processAttempt?: number;
  retryCondition?: string;
  nextAttemptAt?: string;
};
```

The adapter is configured with the local `mondeId`, an integration identifier,
and the Monde service token. These deployment values are not TeaParty domain
fields.

## Idempotent Start

```http
POST /mondes/:mondeId/integrations/:integrationId/runs
Authorization: Bearer <local-service-token>
Content-Type: application/json

{
  "execution_key": "queue-item-id:attempt",
  "mon_id": "seia",
  "context_packet": {
    "schema": {
      "id": "teaparty.run-context",
      "version": "1"
    },
    "execution": {
      "executionKey": "queue-item-id:attempt",
      "correlationId": "correlation-id"
    },
    "scope": {
      "kind": "system"
    },
    "objective": "Perform the approved work.",
    "toolProfile": "seia"
  }
}
```

Monde bounds the packet to 64 KiB, stores it as an opaque JSON value, records
its canonical SHA-256 digest, and forwards its canonical bytes in the Mon
prompt. Monde does not parse or authorize its domain fields.

The server computes the complete request digest. The uniqueness boundary is:

```text
(integrationId, executionKey)
```

- Twenty concurrent identical requests create one Monde run and launch one
  process.
- Replaying the same key and packet returns the existing run.
- Reusing the key with a different packet or target returns
  `409 digest_conflict`.
- A lost start response is recovered by inspection with the same key.

The response includes:

```json
{
  "snapshot": {
    "run_id": "run_...",
    "execution_key": "queue-item-id:attempt",
    "status": "running",
    "started_at": "..."
  },
  "context_packet_digest": "...",
  "created": true,
  "run": {}
}
```

The TeaParty adapter maps this snake-case HTTP DTO to its camel-case
`MondeRunSnapshot`.

## Inspect And Cancel

Inspect by the stable execution key:

```http
GET /mondes/:mondeId/integrations/:integrationId/runs/:executionKey
Authorization: Bearer <local-service-token>
```

Request cancellation by the same key:

```http
POST /mondes/:mondeId/integrations/:integrationId/runs/:executionKey/cancel
Authorization: Bearer <local-service-token>
```

Cancellation intent is persisted before signalling. Active harnesses are
started as process-group leaders; Monde signals the whole group and reports
`cancelled` only after process-exit acknowledgement. Restart reconciliation
reports lost cancellation as a failed run with a precise condition.

A cancellation received while the run is waiting for Monde retry backoff
clears the pending retry wake and cancels the same logical execution.

## V1 Outcome Contract

The narrow integration-run endpoint always uses
`completion_policy = process_exit`:

```text
clean acknowledged exit
→ succeeded

non-zero exit, signal not caused by acknowledged cancellation,
failed launch, or lost process
→ failed

acknowledged cancellation
→ cancelled
```

No `/complete` call or Monde manifest is involved. TeaParty validates its
runtime output after Monde reports success. A TeaParty QueueItem may therefore
be failed while the Monde snapshot remains `succeeded`; TeaParty owns and
displays that independent domain outcome.

## Monde Retry Contract

Monde may retry a generically failed process attempt when the selected Mon's
`retry_policy` permits it. This never changes the TeaParty execution key or
creates a new TeaParty QueueItem attempt:

```text
same TeaParty executionKey
same Monde runId
same opaque context packet
new Monde processAttempt
```

During backoff the TeaParty snapshot is `pending`, with optional
`retryCondition` and `nextAttemptAt`. Success on a later process attempt makes
the Monde snapshot `succeeded`. Exhaustion makes it `failed`.

TeaParty must still verify that the successful Mon run's claimed effects and
outputs materialized. That domain check can fail the QueueItem without
rewriting Monde's operational success. TeaParty should not issue a new Monde
execution key merely because Monde is between its own process attempts.

Monde does not automatically retry a process that was merely found active
after a service restart. It marks that run lost/failed because relaunching
after uncertain execution could duplicate effects.

## Mon Configuration

A concurrent isolated Codex Mon can use:

```json
{
  "max_active_runs": 2,
  "run_workspace": {
    "mode": "isolated",
    "recovery_window_seconds": 86400
  },
  "retry_policy": {
    "max_attempts": 3,
    "initial_backoff_seconds": 5,
    "backoff_multiplier": 2,
    "max_backoff_seconds": 60,
    "attempt_timeout_seconds": 1800,
    "kill_grace_seconds": 5,
    "retryable_conditions": [
      "launch_error",
      "process_exit_nonzero",
      "process_interrupted",
      "required_mcp_unavailable",
      "attempt_timeout",
      "credential_expired"
    ]
  },
  "actor_context": [
    { "root": "mon", "path": "SOUL.md" },
    { "root": "mon", "path": "doctrine/identity.md" },
    { "root": "mon", "path": "doctrine/operations.md" }
  ],
  "external_mcp_servers": [
    {
      "id": "domain",
      "transport": "streamable_http",
      "url": "http://127.0.0.1:4777/mcp",
      "required": true,
      "startup_timeout_seconds": 10,
      "auth": {
        "type": "run_claims",
        "audience": "domain-mcp",
        "token_env_var": "DOMAIN_RUN_TOKEN"
      }
    }
  ]
}
```

`max_active_runs > 1` requires isolated workspaces. Actor-context bytes are
copied, hashed, sealed, and injected from the run snapshot. Source Mon/work
roots are not implicitly readable. TeaParty runtime storage is reached through
its MCP tools, not a broad filesystem mount or Monde scratch.

Authenticated streamable-HTTP MCP is loopback-only in v1. An isolated stdio
MCP child receives its own bubblewrap profile and only explicitly declared
context, scratch, working-directory, and read-mount access.

Retry is opt-in. Existing Mons default to `max_attempts: 1`. `harness_noop`
can be placed in `retryable_conditions`, but is excluded by default because a
quiet harness may have performed useful external work.

Isolated Codex admission requires:

```bash
monde adapter verify-isolation codex
```

The attestation is bound to Codex and bubblewrap binary hashes, the Monde
sandbox-policy hash, Node version, operating-system/kernel release, platform,
and architecture.

## MCP Run Claims

Each authenticated external MCP server receives a separate narrow random grant,
not Monde's service token:

```http
POST /external-mcp/introspect
Authorization: Bearer <server-specific-run-grant>
```

Claims include the generic run, Mon, Monde, integration, execution key,
audience, expiry, and an opaque external scope. For a direct narrow
integration-run start, external scope is `null`; the TeaParty MCP server
resolves its domain authorization from TeaParty's persisted execution record
and context-packet contract. An integration-owned scheduled fire carries its
opaque packet as external scope so the MCP server can resolve that activation.
A Monde run claim is not TeaParty domain authorization.

Each process attempt receives new grants. Introspection renews an unrevoked
grant's short expiry while its run is actually `starting` or `active`; terminal
or backoff-queued runs cannot introspect, and prior-attempt grants remain
revoked.

## Operational Evidence

Inspection returns the durable Monde run record alongside the normalized
snapshot, including lifecycle, exit or failure condition, adapter information,
scope snapshot, context-packet digest, MCP attachment evidence, and timestamps.
Ordered process attempts, logs, and events are separate Monde evidence
endpoints; they are not embedded into the stable-key inspection response.

Monde scratch is generic harness-local state. TeaParty owns runtime containers,
ephemeral intelligence, staged artifacts, output manifests, provenance,
retention, and Asset admission.

## Scheduled Integration Runs

TeaParty can register generic scheduled activation without exposing CronJob or
QueueItem schemas:

```http
POST /mondes/:mondeId/integrations/:integrationId/schedules
Authorization: Bearer <local-service-token>
Content-Type: application/json

{
  "schedule_key": "seia-refresh",
  "mon_id": "seia",
  "name": "Seia refresh",
  "expression": "0 * * * *",
  "timezone": "America/Los_Angeles",
  "title": "Run the scheduled refresh",
  "context_packet": {
    "schema": {
      "id": "teaparty.run-context",
      "version": "1"
    },
    "scope": {
      "kind": "system"
    },
    "objective": "Perform the scheduled refresh."
  }
}
```

An identical registration replays the same schedule; a changed payload under
the same schedule key conflicts. A fire uses a deterministic external
execution key equivalent to:

```text
<scheduleKey>:<scheduledFireTime>
```

The fired run uses the same process-exit, inspect, cancel, isolation, MCP, and
generic retry behavior as a direct integration run. Cron coalesces missed
fires and does not create a TeaParty workflow, lease, or machine route.

## Optional Generic Monde Capabilities

The following remain supported but are not TeaParty v1 dependencies:

- `POST /external-executions` with
  `completion_policy = external_receipt`
- `POST /external-executions/:id/complete`
- opaque completion receipts
- caller-supplied external lineage
- immutable Monde execution manifests and availability records

Those APIs serve integrations that intentionally require externally managed
completion or generic immutable output references. TeaParty must not call them
as part of its v1 execution adapter.

## Retention

Isolated scratch workspaces are sealed at process exit and deleted after the
configured recovery window. Cleanup is restart-safe and retried after failure.

Prompt, context-packet, event, and tool-trace redaction is not part of Monde's
current local-first contract. TeaParty treats any content deliberately passed
to Monde or Codex as potentially durable and keeps credentials, raw sensitive
binaries, LoRAs, reference banks, and unpublished media in TeaParty-controlled
storage.
