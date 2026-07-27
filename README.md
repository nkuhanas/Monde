<p align="center">
  <img src="./docs/assets/monde_lockup_v1.png" alt="Monde" width="520" />
</p>

<p align="center">
  <strong>The local-first control plane for persistent project agents.</strong>
</p>

<p align="center">
  Monde gives named agents durable identity, bounded execution, operational memory, and a human-readable evidence trail across real project work.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-MVP-blue" alt="status MVP" />
  <img src="https://img.shields.io/badge/runtime-Node.js%2022+-green" alt="Node.js 22+" />
  <img src="https://img.shields.io/badge/frontend-React%20%2B%20Vite-646cff" alt="React and Vite" />
  <img src="https://img.shields.io/badge/local--first-operator%20runtime-0b7285" alt="local-first operator runtime" />
</p>

<p align="center">
  <a href="#why-monde-exists">Why Monde exists</a>
  ·
  <a href="#what-monde-is">What Monde is</a>
  ·
  <a href="#product-stance">Product stance</a>
  ·
  <a href="#see-it">See it</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#technical-model">Technical model</a>
  ·
  <a href="#docs">Docs</a>
</p>

---

<p align="center">
  <img src="./docs/assets/overview_dashboard_hero.png" alt="Monde overview dashboard" width="980" />
</p>

<p align="center">
  <em>One local command center for who is acting, what is running, what changed, and what still needs judgment.</em>
</p>

## Why Monde exists

AI agents can edit real projects, run commands, produce artifacts, and hold long
context threads. But when that work is scattered across terminal scrollback,
chat history, local files, and ad hoc prompts, it becomes hard to answer the
operator questions that matter:

- What is running right now?
- Which persistent actor is responsible for this work?
- What scope and write permissions did it have?
- Did it actually execute, retry, or fail—and what evidence proves that?
- What did it output, change, or register?
- Which runs still need human review?
- Can I continue the conversation without losing the operational record?

Monde exists because agent work should not disappear into chat history or be
trusted from narration alone. It gives agents bounded runtime scope, gives
humans an operator console, and turns process attempts, output, logs, artifacts,
plans, schedules, and conversations into durable local operational state.

## What Monde is

Monde is a local-first execution runtime and operator console for persistent,
scoped AI agents inside real project directories.

A **Monde** is a local project or world boundary: the place where Mons, runs,
plans, schedules, and operational evidence live.

A **Mon** is a durable project actor: identity, role, context, harness defaults,
permissions, and work-root policy. A **run** is the unit of execution and
accountability: intent, scope, attempts, output, evidence, lifecycle, and
review. Harnesses such as Codex are replaceable execution providers; the Mon
and its history remain stable.

```text
Human operator
  |
  v
Monde web console / CLI
  |
  v
Local control plane: identity, dispatch, MCP, SQLite, evidence
  |
  v
Mons + harnesses: basic-process, Codex, opencode
  |
  v
Project work roots
```

The runtime centers on runs:

```text
Plan / Cron / External / Operator / System
        -> logical Run
        -> Process Attempts
        -> Output + Logs + Artifacts + Result + Review
```

Filesystem identity is portable through `.monde/` and `*.mon` directories.
Operational state is local and service-owned in SQLite.

## Product stance

Monde is deliberately opinionated about where trust belongs:

- **Persistent actors, not anonymous sessions.** A Mon should be recognizable
  across runs, harness changes, restarts, and eventually machines.
- **Evidence, not self-report.** Process state, attempts, output, changes,
  artifacts, warnings, and review remain inspectable independently of what an
  agent says it accomplished.
- **Execution lifecycle, not domain ownership.** Monde owns generic dispatch,
  concurrency, retry, cancellation, cron, isolation, and operational evidence.
  Integrations own their workflows, business state, semantic validation, and
  artifact admission.
- **Local-first as a trust model.** The current service is single-operator and
  loopback-bound, with project files and operational state kept on the
  operator's machine. Remote and multi-machine operation must arrive through
  explicit deployment identity and authenticated inventory—not UI fiction.
- **Human legibility is a runtime feature.** The web console is not a decorative
  dashboard over a black box; it is where execution state, evidence, and human
  judgment meet.

Monde is not trying to be a model router, a hosted multi-tenant agent platform,
a domain workflow engine, or a replacement for an integration's source of
truth. It is the execution and evidence layer beneath those decisions.

## See it

The UI is the main product surface. It should answer the operational questions
before requiring raw logs: where the operator is, which actor is working, what
state the run is in, whether it retried, what evidence exists, and whether a
human decision remains.

### Mon threads and chat rail

<table>
  <tr>
    <td align="center" width="44%">
      <img src="./docs/assets/chat_demo.gif" alt="Monde mon thread chat demo" width="340" />
    </td>
    <td align="center" width="56%">
      <img src="./docs/assets/chat_rail.png" alt="Monde chat rail" width="470" />
    </td>
  </tr>
</table>

Human-in-the-loop Mon threads keep conversation grounded in run records. Draft
chats become server-backed `hitl_thread` runs on first send. Failures, typing
states, timestamps, harness chips, and write/read mode stay visible while the
operator keeps working elsewhere in the console.

### Mons and permissions

<p align="center">
  <img src="./docs/assets/mons_overview.png" alt="Monde mons overview" width="820" />
</p>

Mons are persistent local actor identities rather than disposable chat
sessions. The Mons tab keeps harness defaults, permissions, work roots, queues,
chat entry points, and management actions in one place.

### Runs and review

<p align="center">
  <img src="./docs/assets/runs_overview_hero.png" alt="Monde runs and review" width="920" />
</p>

The Runs and Review surfaces expose logical-run state, process attempts,
terminal output, logs, artifacts, scope, warnings, write evidence, and explicit
operator review.

## Quick start

```bash
npm install
npm run check
npm run dev:service
npm run dev:web
```

Open the web UI:

```text
http://127.0.0.1:5175
```

The UI needs the local service token. With the service running:

```bash
npm run monde -- service paths
```

Read the token from the reported token path and paste it into the UI.

## Core surfaces

| Surface | Purpose |
|---|---|
| Overview | Operational home for the selected Monde, current machine, attention, and activity |
| Mons | Persistent project actors, harness defaults, permissions, work roots, and chat entry points |
| Chat rail | Human-in-the-loop Mon conversations backed by run records |
| Runs | Logical execution lifecycle, process attempts, terminal output, queue state, and retry |
| Review | Evidence, runtime scope, write changes, result notes, and human judgment |
| Plans | Coordination contracts that generate queued runs from assignments |
| Cron | Generic timezone-aware schedules for ordinary or stable-key integration runs |
| Artifacts | Path-referenced evidence with bounded previews and path status |
| Status | Service health, adapter detection, backup state, doctor findings, and DB metadata |

## Technical model

Monde is a TypeScript monorepo on Node.js:

```text
packages/core      Shared schemas, DTOs, IDs, paths, and run state helpers
packages/service   Local HTTP/MCP service, SQLite persistence, run manager
packages/cli       `monde` command-line interface
packages/web       React/Vite operator console
packages/adapters  Harness adapter definitions
```

Current stack:

```text
Runtime/service:   TypeScript + Node.js
HTTP/API:          Fastify
MCP:               loopback HTTP JSON-RPC plus `monde mcp bridge`
Database:          Node built-in `node:sqlite` with local migrations
Frontend:          React + Vite + xterm.js
CLI:               TypeScript + commander
Auth:              local service token plus run-scoped MCP tokens
```

One-shot runs are process-bounded work. HITL threads are user-session-bounded
conversations. Both share one evidence model without pretending that a
conversation and a task have the same success semantics.

Each Mon defaults to one process slot and a shared work root. Opt-in concurrent
Mons use atomic process slots and isolated run scopes with unique scratch
workspaces, immutable actor context, and explicit read mounts.

Each Mon also defaults to one process attempt per logical run. Opt-in generic
retry keeps the same run and stable execution key while recording durable
attempts, persisted backoff, timeouts, and cancellation. The operator review
surface shows attempt history and scheduled retry state.

Retry does not prove that a failed attempt had no side effects. Enable multiple
attempts only for harness work that is idempotent or explicitly resumable,
especially when the process can write files or call external tools.

Codex write-capable runs are explicit. Codex defaults to read-only unless a
write sandbox is requested, and write runs capture metadata and diff evidence
when Git context is available. Isolated Codex support requires a locally
verified adapter capability. `basic-process` has a different trust boundary:
it is unsandboxed and runs with the Monde service user's operating-system
permissions.

Generic integration runs add durable idempotency keys, opaque bounded context,
process-exit outcomes, cancellation reconciliation, and external MCP grants
without moving workflow, caller-domain retry, semantic validation, or artifact
bytes into Monde. Monde can apply its own generic process-attempt retry policy
inside that stable logical run. Optional receipt-gated completion and immutable
output manifests remain available for other integrations but are not TeaParty
v1 dependencies.

## Runtime support today

| Harness | Status | Use when |
|---|---|---|
| `basic-process` | Unsandboxed local fallback | You want trusted shell/process runs, smoke tests, and stdin-capable local work |
| Codex | Supported through `codex exec` | You want scoped read/write agent work with run evidence |
| opencode | Detection and conservative integration path | You are evaluating adapter breadth or future harness support |

Monde keeps harness credentials run-scoped. Harnesses receive `MONDE_RUN_ID`
and `MONDE_RUN_TOKEN`; they do not intentionally receive the root local service
token. Run tokens expire when a one-shot process finishes or a HITL adapter
turn ends or times out.

## Docs

Detailed docs live in `.monde/docs/`:

- `.monde/docs/development.md` - local setup, CLI flow, ports, smoke suites
- `.monde/docs/runtime.md` - package layout, stack, service, auth, SQLite
- `.monde/docs/run-model.md` - runs, HITL threads, queue semantics, evidence
- `.monde/docs/operator-console.md` - web UI layout and product rules
- `.monde/docs/harnesses.md` - basic-process, Codex, opencode, adapter metadata
- `.monde/docs/mcp.md` - run-scoped MCP tools and auth model
- `.monde/docs/write-runs.md` - write-capable runs and evidence capture
- `.monde/docs/plans.md` - coordination contracts and assignments
- `.monde/docs/review-flow.md` - review and semantic outcome handling
- `.monde/docs/api-contracts.md` - frontend/backend DTO and endpoint contracts
- `.monde/docs/harness-liveness.md` - HITL idle and hard timeout model
- `.monde/docs/security-model.md` - local trust boundary, scope, environment, auth
- `.monde/docs/tea-party-integration.md` - TeaParty v1 stable-key start, inspect, cancel, and process-exit contract
- `.monde/docs/tea-party-acceptance.md` - implementation-to-test acceptance map
- `.monde/docs/compatibility.md` - defaults and schema migration behavior
- `.monde/docs/backup-restore.md` - checksum verification and isolated rehearsal

Harnesses can search these docs through Monde's `search_docs` tool.

## Status

Monde is an MVP with a working local execution substrate and operator console.
The current direction is:

- make execution legible from first glance through forensic review
- strengthen persistent Mon identity across chat, scheduled, and integration work
- harden generic dispatch, retry, cancellation, isolation, and recovery
- make write effects and artifact evidence easier to verify
- keep domain workflow and semantic success outside Monde's generic substrate
- prepare explicit CI/CD, deployment identity, and authenticated machine inventory
- expand harness support without weakening scope or evidence guarantees

The next expansion is not synthetic distributed UI. It is packaged deployment,
repeatable CI/CD, durable machine identity, and real cross-machine inventory
for operator-owned VMs—while keeping the current local machine first.
