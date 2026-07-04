# Monde

Monde is a local-first operator console and runtime for scoped AI agents inside
project directories.

The current MVP is implemented in TypeScript on Node.js. It centers on runs:

```text
Plan / Cron / Operator / System
        -> Run
        -> Logs + Artifacts + Result
```

Monde keeps filesystem identity portable through `.monde/` and `*.mon`
directories, while the local service owns operational state in SQLite.

## Workspace

```text
packages/core      Shared schemas, IDs, paths, DTOs, and run state helpers
packages/service   Local Fastify service, HTTP API, MCP endpoint, SQLite, run manager
packages/cli       `monde` command-line interface
packages/web       React/Vite operator console
packages/adapters  Harness adapter definitions for basic-process, Codex, opencode
```

## Stack

```text
Runtime/service:   TypeScript + Node.js
HTTP/API:          Fastify
MCP:               loopback HTTP JSON-RPC plus `monde mcp bridge` for stdio harnesses
Database:          Node built-in `node:sqlite` with local schema migrations
Frontend:          React + Vite + xterm.js
CLI:               TypeScript + commander
Auth:              local service token plus run-scoped MCP tokens
```

The service binds to loopback by default and writes service metadata, the local
token path, and the SQLite DB path into the platform Monde data/runtime
directories.

Default local ports:

```text
HTTP API / web backend: http://127.0.0.1:3761
MCP endpoint:           http://127.0.0.1:3762/mcp
Vite web UI:            http://127.0.0.1:5175
```

Environment overrides:

```text
MONDE_HOST       default 127.0.0.1
MONDE_WEB_PORT   default 3761
MONDE_MCP_PORT   default 3762
MONDE_UI_PORT    default 5175
```

## Development

```bash
npm install
npm run build
npm run dev:service
npm run dev:web
```

Or run both service and web UI:

```bash
npm run dev:all
```

Useful smoke suites:

```bash
npm run smoke:vertical-slice-1
npm run smoke:local-alpha
npm run smoke:harness-alpha
npm run smoke:harness-beta
npm run smoke:write-evidence
npm run smoke:codex-write
npm run smoke:beta-review
npm run smoke:all
```

## Quickstart

```bash
npm install
npm run build
npm link
npm run dev:all
monde init . --name "Monde"
monde mon create frontend.mon --path packages/web
monde message frontend.mon "Review this package"
```

Open the web UI at the Vite URL. The UI needs the local service token. Use:

```bash
monde service paths
```

Then read the token from the reported token path and paste it into the web UI.
During local development you can also append it to the Vite URL as
`?token=...`.

## Current Web UI

The web UI is an operator console, not a landing page.

Current primary surfaces:

- machine-grouped left sidebar: machine -> Monde
- overview tab with visual backdrop, status strip, sector cards, and right-side Monde panel
- runs, mons, plans, artifacts, status, and review tabs
- bottom-left floating mon chat rail
- reusable confirmation overlay for destructive/closing actions

The bottom chat rail is human-in-the-loop:

- `Add new .mon chat` expands into the mon launcher list.
- Choosing a mon creates a local draft thread in the UI.
- The thread is not server-backed until the first message is sent.
- First send creates a `hitl_thread` run and sends the user message.
- User messages render immediately, then the mon side shows a typing state.
- Responses render as mon messages; failures render as mon-side errors.
- Multiple thread widgets can be expanded at once.
- Closing a draft is immediate.
- Closing a server-backed thread prompts for confirmation.

Chat thread cards show:

- mon name
- harness / status / mode chips
- work root tail
- message timestamps using the browser/computer timezone

## Runtime Behavior

One-shot runs and HITL threads share the run record but have different user
semantics.

One-shot runs are process-bounded work:

```text
interaction_mode = one_shot
status/process_status/outcome describe lifecycle, process, and semantic result
```

HITL threads are user-session-bounded conversations:

```text
interaction_mode = hitl_thread
runtime_state = idle_open | running | waiting_for_user | closed | failed | cancelled
outcome_state remains unknown unless an explicit resolve/review path sets it
```

For one-shot operator messages:

- If the assigned mon has an active one-shot run and the active run accepts
  input, `monde message` can attach/send to it.
- If the active run has closed input, Monde creates a new queued operator run.
- If the mon is idle, Monde creates and starts a new operator-origin run.

For `monde wake`:

- active run: attach
- idle with queued runs: start the oldest queued run, after disclosing origin
- idle with no queued runs: create a manual operator run

The MVP still treats a mon being busy as queue pressure, not a separate
blocker lifecycle.

## Harnesses

`basic-process` is the local fallback harness. It runs shell/process commands
from the mon root, preserves output events, and accepts stdin where available.

Codex is supported through `codex exec` when installed. It is single-shot and
closed-input after launch. Read-only is the default:

```bash
monde message frontend.mon "Review auth state" --harness codex
```

Write mode is explicit:

```bash
monde message frontend.mon "Make the small UI fix" --harness codex --write
monde wake frontend.mon --harness codex --sandbox workspace-write
```

opencode detection exists, but automatic MCP configuration is still conservative
and remains adapter-breadth work rather than core runtime work.

## MCP And Auth

The local service token authenticates the CLI, web UI, and backend API calls.
Harness MCP calls use run-scoped authorization:

```text
MONDE_RUN_ID       run identity
MONDE_RUN_TOKEN    run-scoped authorization
MONDE_SERVICE_ADDR local API base URL
MONDE_MCP_ADDR     MCP endpoint URL
```

MCP browser-origin requests are rejected unless `MONDE_ALLOW_BROWSER_MCP=1` is
set. The web UI talks to the backend API with the local service token, not the
MCP run token.

## SQLite And Continuity

Operational state lives in the local SQLite DB. The database stores schema
version metadata and the service runs migrations on startup.

Use:

```bash
monde doctor
monde backup info
monde backup create
monde backup list
```

`doctor` and backup info print the DB path because operational continuity
depends on that file. Full import/export or restore is still post-MVP.

## More Docs

Self-hosted Monde docs live in `.monde/docs/` and are searchable by harnesses
through `search_docs`.
