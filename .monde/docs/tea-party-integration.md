# TeaParty External Execution Integration

Monde provides TeaParty with local Codex execution, persistent Mon identity,
process-slot dispatch, run scopes, external execution reconciliation,
run-scoped MCP grants, cancellation evidence, and immutable artifact-manifest
references.

TeaParty continues to own Trinity/Filius state, queue leases, retry and backoff
policy, global attempt lineage, Pater workflows, machine and model selection,
semantic validation, staged bytes, and Asset admission.

Monde does not interpret TeaParty personas, pipelines, queue records, or result
semantics. Those values travel as opaque JSON.

## Mon Configuration

Existing Mons need no configuration changes. A concurrent isolated Codex Mon
can use:

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
  "read_mounts": [
    { "root": "work", "path": "." }
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

`max_active_runs > 1` requires an isolated workspace. Actor-context bytes are
copied, hashed, sealed, and injected from the run snapshot. Source Mon/work
roots are not implicitly readable in isolated mode; use `read_mounts` for
explicit repository access.

Authenticated streamable-HTTP MCP is loopback-only in v1. A stdio MCP child is
launched through its own bubblewrap profile for isolated runs. Monde refuses
isolated Codex execution until the installed Codex/bubblewrap fingerprint has
passed:

```bash
monde adapter verify-isolation codex
```

## Create Or Recover An Execution

Control-plane endpoints use the local service token:

```text
Authorization: Bearer <local-service-token>
```

The caller computes `request_digest` as SHA-256 over Monde's canonical JSON
encoding of every request field except `request_digest`.

```http
POST /external-executions
Content-Type: application/json
Authorization: Bearer ...

{
  "integration_id": "tea-party",
  "external_execution_key": "filius:01J...",
  "monde_id": "production",
  "mon_id": "seia",
  "input": {
    "kind": "prompt",
    "prompt": "Execute the claimed Filius work."
  },
  "external_scope": {
    "sanctus_scope": "opaque-value"
  },
  "external_context": {
    "trinity_id": "tri_...",
    "filius_id": "fil_...",
    "attempt": 3
  },
  "external_lineage": {
    "root_execution_key": "filius:root",
    "attempt": 3
  },
  "predecessor": {
    "external_execution_key": "filius:previous"
  },
  "artifact_sink_ref": {
    "stage": "tea-party-owned"
  },
  "request_digest": "<64 lowercase hex characters>"
}
```

The uniqueness boundary is:

```text
(integration_id, external_execution_key)
```

- Same key and digest returns the existing execution and run.
- Same key with another digest returns `409 digest_conflict`.
- A lost response is recovered with:

```http
GET /external-executions/lookup?integration_id=tea-party&external_execution_key=...
```

Monde never silently relaunches a process after uncertain ownership. Global
attempt numbering and lineage remain caller-supplied. Monde resolves
`local_predecessor_run_id` only when that predecessor exists in the same local
database.

## Lifecycle

External lifecycle keeps process placement separate from semantic outcome:

```text
phase:
  queued | starting | active | awaiting_completion | cancelling | terminal

outcome:
  null | succeeded | failed | cancelled

condition:
  missing_completion
  process_exit_nonzero
  process_interrupted
  process_lost
  required_mcp_unavailable
  cancellation_unacknowledged
  cancellation_lost
  ...
```

A clean process exit enters `awaiting_completion`. It never reports semantic
success by itself. A non-zero or interrupted exit becomes failed with a named
condition.

TeaParty may submit an opaque completion receipt, an owned Monde manifest, or
both. `completion_digest` is the canonical SHA-256 of the supplied
`completion_receipt` and/or `manifest_id`.

```http
POST /external-executions/:id/complete

{
  "completion_receipt": {
    "tea_party_validation_id": "validation_..."
  },
  "manifest_id": "manifest_...",
  "completion_digest": "<canonical SHA-256>"
}
```

Monde checks structure, digest identity, replay identity, and manifest
ownership. TeaParty's receipt asserts that semantic validation occurred;
Monde does not validate TeaParty result semantics.

Cancellation is idempotent:

```http
POST /external-executions/:id/cancel
```

Queued cancellation terminates immediately. Active cancellation passes through
`cancelling`, records signal delivery, and becomes cancelled only after process
exit acknowledgement. Restart reconciliation distinguishes process loss and
cancellation loss.

## External MCP Claims

Each authenticated external MCP server receives its own narrow random grant,
not Monde's service token. The grant is accepted only while its run is
`starting` or `active` and is revoked on process termination.

The external server introspects it with:

```http
POST /external-mcp/introspect
Authorization: Bearer <server-specific-run-grant>
```

Active claims include:

```json
{
  "run_id": "run_...",
  "mon_id": "seia",
  "monde_id": "production",
  "integration_id": "tea-party",
  "external_execution_key": "filius:...",
  "external_scope": {},
  "audience": "domain-mcp",
  "expires_at": "..."
}
```

## Immutable Manifests

TeaParty owns bytes and Asset admission. Monde stores immutable metadata and
opaque staging references.

```http
PUT /external-executions/:id/manifest

{
  "outputs": [
    {
      "logical_name": "proposal",
      "staging_ref": {
        "type": "opaque",
        "value": {
          "provider": "tea-party-stage",
          "object_key": "stage/..."
        }
      },
      "sha256": "<64 lowercase hex characters>",
      "byte_size": 4821,
      "media_type": "application/json",
      "integration_metadata": {
        "asset_kind": "proposal"
      }
    }
  ],
  "integration_metadata": {
    "filius_id": "fil_..."
  },
  "manifest_digest": "<canonical SHA-256>"
}
```

There is one immutable manifest per external execution. Output names are
unique only inside that manifest, so the same logical name may appear in a
later attempt. Replaying the identical digest returns the existing manifest;
a different digest returns `409 manifest_conflict`.

`local_path` references must be normalized relative paths inside the recorded
run workspace and can be registered only after process exit. Verification
rejects traversal, symlinks, checksum/size differences, and rename/swap races.
Opaque references are stored as JSON and are never opened as URLs or paths.

Availability is mutable without changing the immutable manifest:

```http
PUT /external-executions/:id/manifest/outputs/:logicalName/availability

{
  "status": "deleted",
  "reason": "TeaParty staging object removed"
}
```

Manifests are returned by execution ID, run ID, and external-key lookup.

## Retention

Isolated scratch workspaces are sealed when the process ends and deleted after
the configured recovery window. Cleanup is restart-safe and retried after
failure. Local manifest references become `expired`; their immutable hashes and
operational metadata remain.

Prompt/event redaction and selective operational-database backup exclusion are
not part of this progression. Existing prompt and event retention remains
unchanged.
