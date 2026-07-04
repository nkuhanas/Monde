# Monde Runtime

Monde is a local operator runtime centered on runs. A run captures intent,
provenance, execution state, logs, artifacts, and result/review data.

## Backend Choices

Current MVP stack:

```text
TypeScript + Node.js
Fastify HTTP APIs
Fastify CORS and websocket support
Node built-in `node:sqlite`
React/Vite web UI
xterm.js terminal rendering
commander CLI
HTTP MCP endpoint plus stdio bridge
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

Environment:

```text
MONDE_HOST
MONDE_WEB_PORT
MONDE_MCP_PORT
MONDE_UI_PORT
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
```

The service token should not be passed to harnesses.

MCP rejects browser-originated requests unless `MONDE_ALLOW_BROWSER_MCP=1`.
The web backend and Vite UI use strict local-origin CORS.

## SQLite

Operational state is stored in the platform Monde data directory using
Node's built-in SQLite binding.

The DB has schema metadata and migrations. Startup fails clearly if the DB
schema is newer than the service schema.

The service currently uses WAL and foreign keys:

```text
PRAGMA journal_mode = WAL
PRAGMA foreign_keys = ON
```

Operational continuity depends on the DB file:

```bash
monde doctor
monde backup info
monde backup create
monde backup list
```

Full export/import or restore remains post-MVP.

## Startup And Restart Behavior

On startup, the run manager marks previously active process-backed runs as
lost/interrupted because the local service no longer owns their process
handles.

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
```

`work_root` is resolved from the mon root and is the expected working directory
for harness work.

Stale scope detection is polling-based for MVP. The run manager periodically
checks fingerprinted scope files and adds `stale_scope` warnings when the
identity/scope root changes while a run is active.

## Runtime Events

Run events preserve both process output and HITL messages:

```text
run_started
run_input
run_output
run_error_output
warning_added
run_process_exit
run_finished
user_message
mon_message
system_message
error
state_change
```

The web UI uses SSE/EventSource for selected active run event streams and
polling for open chat thread histories.
