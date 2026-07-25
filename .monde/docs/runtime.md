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

The DB has schema metadata and migrations. Startup fails clearly if the DB
schema is newer than the service schema.

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
```

`monde backup create` uses SQLite's online backup API. This produces a
transactionally consistent database including committed WAL state while the
service is running. The backup and its metadata are user-readable only. Full
export/import and an operator-facing restore command remain post-MVP.

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

All roots are resolved to canonical, existing directories at run start.
`work_root` must remain inside the canonical Monde root unless
`allow_external_work_root` is explicitly true in `mon.json`. This containment
check is applied to relative paths, absolute paths, and symlink targets.

`work_root` is the expected working directory for harness work. It is a real
sandbox boundary only when the selected adapter enforces one. In particular,
`basic-process` is unsandboxed and retains all filesystem permissions of the
service user.

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
