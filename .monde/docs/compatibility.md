# Compatibility And Migration

The service database migrates forward to schema version 12 at startup. Startup
still refuses a database whose schema is newer than the running service.

## Existing Mon Defaults

Missing fields retain legacy behavior:

```json
{
  "max_active_runs": 1,
  "run_workspace": { "mode": "shared" },
  "actor_context": [],
  "read_mounts": [],
  "external_mcp_servers": []
}
```

Existing Mons therefore keep:

- one active process-backed run per Mon
- their shared work root
- current prompt, event, and artifact retention
- existing path-referenced artifacts
- no external MCP servers

Concurrency is opt-in. `max_active_runs > 1` is rejected unless
`run_workspace.mode` is `isolated`.

## New Tables

Migrations add:

- `process_slots`
- `run_workspaces`
- `external_executions`
- `external_mcp_grants`
- `execution_manifests`
- `execution_manifest_outputs`
- `execution_manifest_availability`
- `cron_schedules`
- `cron_fires`

Existing run, log, event, plan, and artifact rows are not rewritten into
TeaParty-specific shapes.

Schema 12 adds `completion_policy` to the generic external-execution ledger.
Existing rows use `external_receipt`, preserving the previously shipped
behavior. The narrow integration-run endpoint creates `process_exit` rows.

## Isolation Compatibility

Shared workspaces remain available. Isolated mode is adapter capability-gated.
For Codex, the installed binaries, sandbox policy, and relevant host/runtime
identity must match a successful local attestation:

```bash
monde adapter verify-isolation codex
```

The fingerprint includes Codex and bubblewrap binary hashes, the Monde sandbox
policy, Node version, OS/kernel release, platform, and architecture. Changing
any of those inputs invalidates the attestation until it is rerun.

## Backup Compatibility

Existing checksum-less backup files remain listable and readable, but the new
supported `backup verify` and `backup rehearse` path requires a recorded
SHA-256 sidecar. Create a fresh online backup before relying on rehearsal:

```bash
monde backup create
monde backup verify <backup.sqlite>
```

Restore rehearsal never replaces the live DB.

## Deliberate Non-Features

This progression does not add:

- model or machine routing
- automatic retry/backoff policy
- a workflow engine
- TeaParty Persona, Pater, Trinity, or Filius schemas
- artifact byte/blob storage
- semantic pipeline validation
- prompt/event redaction

Generic cron is a separate Monde capability. It enqueues normal runs and does
not define workflows or retry policy.
