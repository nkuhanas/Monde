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

## Mon Configuration

A concurrent isolated Codex Mon can use:

```json
{
  "max_active_runs": 2,
  "run_workspace": {
    "mode": "isolated",
    "recovery_window_seconds": 86400
  },
  "actor_context": [
    { "root": "mon", "path": "SOUL.md" },
    { "root": "mon", "path": "doctrine" }
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
audience, expiry, and an opaque external scope. For the narrow integration-run
endpoint, external scope is `null`; the TeaParty MCP server resolves its domain
authorization from TeaParty's persisted execution record and context-packet
contract. A Monde run claim is not TeaParty domain authorization.

## Operational Evidence

Inspection returns the durable Monde run record alongside the normalized
snapshot. It includes process lifecycle, exit or failure condition, adapter
information, scope snapshot, context-packet digest, MCP attachment evidence,
timestamps, logs, and events.

Monde scratch is generic harness-local state. TeaParty owns runtime containers,
ephemeral intelligence, staged artifacts, output manifests, provenance,
retention, and Asset admission.

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
