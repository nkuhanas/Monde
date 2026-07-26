# Monde Runtime

Monde is a local operator runtime centered on runs. A run captures intent,
provenance, execution state, logs, artifacts, and result/review data.

Filesystem identity is portable through `.monde/` and `*.mon` directories.
Operational state is local and service-owned in SQLite.

## Workspace Packages

```text
packages/core      Shared schemas, IDs, paths, DTOs, and run state helpers
packages/service   Local Fastify service, HTTP API, MCP endpoint, SQLite, run manager
packages/cli       `monde` command-line interface
packages/web       React/Vite operator console
packages/adapters  Harness adapter definitions for basic-process, Codex, opencode
```

## Backend Choices

Current MVP stack:

```text
Runtime/service:   TypeScript + Node.js
HTTP/API:          Fastify, CORS, and SSE event streaming
MCP:               loopback HTTP JSON-RPC plus `monde mcp bridge`
Database:          Node built-in `node:sqlite` with local migrations
Frontend:          React + Vite + xterm.js
CLI:               TypeScript + commander
Auth:              local service token plus run-scoped MCP tokens
```

The runtime favors shared TypeScript DTOs across service, CLI, MCP, and web UI.
The hard problems are orchestration, state, adapters, local auth, and operator
UX, not raw throughput.

## Local Service

The service starts two loopback Fastify servers:

```text
web/API: http://127.0.0.1:3761
MCP:     http://127.0.0.1:3762/mcp
```

Only loopback binding is supported by the current security model. Setting
`MONDE_HOST` to a non-loopback address exposes bearer-token APIs without the
authentication, TLS, proxy, and multi-user isolation required for a remote
deployment and is therefore unsupported.

The Vite web UI defaults to:

```text
http://127.0.0.1:5175
```

Environment:

```text
MONDE_HOST       default 127.0.0.1
MONDE_WEB_PORT   default 3761
MONDE_MCP_PORT   default 3762
MONDE_UI_PORT    default 5175
MONDE_ALLOW_BROWSER_MCP
MONDE_STALE_SCOPE_INTERVAL_MS
MONDE_HITL_IDLE_TIMEOUT_MS
MONDE_HITL_HARD_TIMEOUT_MS
MONDE_HITL_TURN_TIMEOUT_MS
```

Service metadata includes:

```text
web_addr
mcp_addr
token_path
db_path
```

Use:

```bash
monde service status
monde service paths
```

## Auth

The service creates a local capability token with user-only file permissions.
The CLI and web UI authenticate API requests with:

```text
Authorization: Bearer <local-service-token>
```

Harness/MCP calls use run-scoped auth:

```text
MONDE_RUN_ID       identity
MONDE_RUN_TOKEN    authorization
MONDE_RUN_SCRATCH  isolated writable workspace, when configured
MONDE_ACTOR_CONTEXT immutable context snapshot, when present
```

The service token should not be passed to harnesses.

Run-token validity is bounded by active execution:

- a one-shot token is valid only while its run is `starting` or `active`
- a HITL token is additionally valid only during the current, non-timed-out
  adapter turn
- the token hash is removed when the process or turn ends, is stopped, fails,
  is canceled, is lost on restart, or times out

Harness processes receive an allowlisted environment rather than the service's
complete environment. See `security-model.md` and `harnesses.md`.

MCP rejects browser-originated requests unless `MONDE_ALLOW_BROWSER_MCP=1`.
The web backend and Vite UI use strict local-origin CORS.

## SQLite

Operational state is stored in the platform Monde data directory using
Node's built-in SQLite binding.

The DB is currently schema version 12 and has ordered forward migrations.
Startup fails clearly if the DB schema is newer than the service schema.

The service currently uses WAL and foreign keys:

```text
PRAGMA journal_mode = WAL
PRAGMA foreign_keys = ON
```

Operational continuity depends on the DB:

```bash
monde doctor
monde backup info
monde backup create
monde backup list
monde backup verify <backup.sqlite>
monde backup rehearse <backup.sqlite> --destination <new-directory>
```

`monde backup create` uses SQLite's online backup API. This produces a
transactionally consistent database including committed WAL state while the
service is running. The backup and its metadata are user-readable only.
Creation and verification check SHA-256, SQLite integrity, and foreign keys.
Rehearsal restores only into a new isolated destination and never overwrites
live state.

Run scratch data is stored outside SQLite under the service data directory.
The database backup intentionally contains operational metadata and immutable
manifest references, not those scratch bytes.

## Startup And Restart Behavior

On startup, the run manager marks previously active process-backed runs as
lost/interrupted because the local service no longer owns their process
handles. It releases orphaned process-slot reservations, records external
process or cancellation loss where applicable, seals run scopes, and revokes
run-scoped grants.

Queued and blocked runs remain persisted. They do not auto-start on service
restart.

## Scope And Stale Scope

Run startup resolves:

```text
monde_root
docs_root
mon_root
work_root
mon_json
monde_json
model
capabilities
workspace policy
actor context
read mounts
external MCP servers
```

All roots are resolved to canonical, existing directories at run start.
`work_root` must remain inside the canonical Monde root unless
`allow_external_work_root` is explicitly true in `mon.json`. This containment
check is applied to relative paths, absolute paths, and symlink targets.

Shared mode preserves the existing `work_root` behavior. Isolated mode creates
a unique run scope containing:

```text
context/     immutable actor-context snapshot
scratch/     current run's writable execution workspace
```

Actor-context entries are ordered, containment-checked, symlink-free, and
bounded to 32 files, 64 KiB per file, and 256 KiB total. The exact bytes are
copied and hashed before launch. Source roots are not automatically exposed to
an isolated adapter; configured `read_mounts` are explicit read capabilities.

Isolation is real only when the selected adapter declares and passes an
enforced capability. `basic-process` remains unsandboxed. Codex isolated mode
requires a matching `monde adapter verify-isolation codex` attestation.

On process exit, the run scope is sealed and retained for the configured
recovery window. Cleanup is idempotent, retried after failure, and marks local
manifest references expired while preserving operational metadata.

Stale scope detection is polling-based for MVP. The run manager periodically
checks fingerprinted scope files and adds `stale_scope` warnings when the
identity/scope root changes while a run is active.

## Process Slots

Each Mon has an atomic SQLite-backed process-slot limit. Existing Mons default
to `max_active_runs: 1`; higher limits require isolated workspaces. The
dispatcher always considers the oldest runnable queued run and fills newly
available slots after a process exits or queued work is cancelled.

HITL adapter turns reserve process capacity only while their process turn is
actually active. An open thread does not permanently occupy a process slot.

## Stable-Key Integration Runs

The narrow integration surface provides idempotent process execution without
adding caller-domain schemas to Monde:

```text
POST /mondes/:mondeId/integrations/:integrationId/runs
GET  /mondes/:mondeId/integrations/:integrationId/runs/:executionKey
POST /mondes/:mondeId/integrations/:integrationId/runs/:executionKey/cancel
```

The request contains an execution key, Mon ID, and one bounded opaque context
packet. Monde canonicalizes and hashes the request server-side. Concurrent
replays of the same key and digest resolve to one durable run and at most one
process launch; a different digest for the same integration/key conflicts.

These runs use `completion_policy = process_exit`. A clean acknowledged exit
produces `succeeded` without a completion callback or execution manifest.
Non-zero exit, process loss, and acknowledged cancellation remain distinct
operational results. Callers own any later domain-output validation.

The broader `/external-executions` surface remains available for generic
integrations that intentionally select receipt-gated completion, external
lineage metadata, or Monde execution manifests. Those optional capabilities
are not prerequisites for the stable-key process-exit path.

## Cron Scheduler

Generic cron is a Monde capability. Five-field expressions are evaluated in
the configured IANA timezone, including DST behavior. A fire creates an
ordinary `origin.type = cron` run and uses the same dispatcher and Mon limits.

Missed fires coalesce to the latest due time, and a schedule has at most one
queued, starting, or active run. Cron does not implement workflows, retry
policy, or model/machine routing.

## Runtime Events

Run events preserve process output, integration lifecycle evidence, run-scope
lifecycle, and HITL messages. Representative event names are:

```text
run_started
run_input
run_output
run_error_output
warning_added
run_process_exit
run_finished
external_execution_start_failed
external_execution_completed
external_completion_missing
external_cancellation_requested
execution_manifest_registered
execution_manifest_replayed
run_scope_sealed
run_scope_cleaned
run_scope_cleanup_failed
thread_turn_started
thread_turn_activity
thread_turn_idle_timeout
thread_turn_hard_timeout
thread_turn_finished
thread_turn_failed
user_message
mon_message
system_message
error
state_change
```

The web UI uses SSE/EventSource for selected active run event streams and
polling for open chat thread histories.
