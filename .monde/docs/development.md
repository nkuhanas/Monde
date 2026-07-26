# Development And Onboarding

This doc owns the local setup and contributor workflow that used to live in
the root README.

## Prerequisites

Monde is a TypeScript monorepo on Node.js. Use Node.js 22.16.0 or newer; the
backup command uses the online-backup API provided by Node's built-in SQLite
binding.

The repo uses npm workspaces:

```bash
npm install
npm run build
npm run check
npm test
```

`npm run check` builds shared packages first, then runs no-emit TypeScript
checks across workspaces.

## Local Development

Run the service and web UI in separate terminals:

```bash
npm run dev:service
npm run dev:web
```

Or start both from one shell:

```bash
npm run dev:all
```

Default local endpoints:

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

## Local CLI Flow

During local development, either run the CLI through npm:

```bash
npm run monde -- service status
```

Or build and link it:

```bash
npm run build
npm link
monde service status
```

The web UI needs the local service token. Use:

```bash
monde service paths
```

Then read the token from the reported token path and paste it into the web UI.
For quick local testing, the token can also be appended to the Vite URL as
`?token=...`.

## Fresh Monde Quickstart

For a new local Monde:

```bash
npm install
npm run build
npm link
monde init . --name "Monde"
monde mon create frontend.mon --path packages/web
monde message frontend.mon "Review this package"
```

Open the Vite URL, provide the service token, and use the operator console to
inspect runs, mons, plans, artifacts, status, and review state.

## Smoke Suites

Focused security and backup regressions run with:

```bash
npm test
```

The suite covers process-slot concurrency, isolated scope snapshots and
cleanup, stable-key process-exit integration runs, optional receipt-gated
external execution, process-group cancellation, external MCP grants and stdio
containment, immutable manifests, cron coalescing/timezones, and backup
rehearsal.

The deterministic smoke gate builds once, does not invoke external agent
providers, and runs each smoke independently:

```bash
npm run smoke:ci
```

`npm run smoke:all` runs the focused tests followed by `smoke:ci`.

Useful targeted smoke suites:

```bash
npm run smoke:vertical-slice-1
npm run smoke:local-alpha
npm run smoke:harness-alpha
npm run smoke:harness-beta
npm run smoke:write-evidence
npm run smoke:beta-review
```

External Codex invocations are deliberately opt-in and separate from the
deterministic gate:

```bash
npm run smoke:external
monde adapter verify-isolation codex
```

The second command is the required release/manual gate before advertising the
current Codex installation as isolation-capable. It runs a real sibling-access
denial probe for Codex and an isolated stdio MCP child, then stores a local
attestation bound to the Codex and bubblewrap binaries, Monde sandbox-policy
hash, Node version, OS/kernel release, platform, and architecture. A change to
any of those inputs invalidates isolated-run admission until verification is
run again.

Smoke tests create temporary Monde roots and runtime state. They should not
depend on the operator's active local SQLite DB.

## Browser Preview

Install the workspace-scoped Chromium build once:

```bash
npm run browser:install
```

Run the authenticated Chromium preview smoke with:

```bash
npm run test:web
```

Playwright starts dedicated Monde service and Vite processes, saves a full-page
overview screenshot under `test-results/`, and retains traces and screenshots
on failures. Use `npm run test:web:headed` for an interactive browser.

The browser smoke does not reuse the operator's normal listeners or SQLite
database. It starts dedicated listeners, resets temporary XDG state under
`/tmp/monde-playwright-preview`, seeds a known Monde and mon through the API,
and verifies that the UI is authenticated against that isolated database.
Override its defaults only when needed:

```text
MONDE_WEB_TEST_UI_PORT       default 45175
MONDE_WEB_TEST_SERVICE_PORT  default 43761
MONDE_WEB_TEST_MCP_PORT      default 43762
MONDE_WEB_TEST_ROOT          default /tmp/monde-playwright-preview
```

The local `.codex/config.toml` enables an isolated, headless Chrome DevTools MCP
server for this trusted repository. It uses the same workspace Chromium build
and does not use a personal browser profile. Restart Codex after changing MCP
configuration so the browser tools become available in a new session.

## Operational Continuity

For local service state and backups:

```bash
monde doctor
monde backup info
monde backup create
monde backup list
monde backup verify <backup.sqlite>
monde backup rehearse <backup.sqlite> --destination <new-directory>
```

`doctor` and backup info print the DB path because the SQLite file is the
source of local operational continuity. `backup create` uses SQLite's online
backup operation, so it includes committed WAL state without requiring the
service to stop. Verification checks the recorded checksum, SQLite integrity,
and foreign keys. Rehearsal restores only into the explicit new destination
and never replaces the live DB. See `backup-restore.md`.
