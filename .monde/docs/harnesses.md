# Harnesses

Harnesses are adapters that turn a run into a concrete local process or CLI
invocation. They receive resolved runtime scope and run-scoped MCP credentials.

## Common Environment

Harness processes receive:

```text
MONDE_RUN_ID
MONDE_RUN_TOKEN
MONDE_SERVICE_ADDR
MONDE_MCP_ADDR
MONDE_MON_ID
MONDE_MON_ROOT
MONDE_WORK_ROOT
MONDE_DOCS_ROOT
MONDE_RUN_SCRATCH
MONDE_ACTOR_CONTEXT
MONDE_HARNESS_ADAPTER
MONDE_RUNNER_TYPE
```

The service inherits only this allowlist from its own environment:

```text
PATH HOME USER LOGNAME SHELL
TMPDIR TMP TEMP
LANG LC_ALL LC_CTYPE COLORTERM NO_COLOR FORCE_COLOR
XDG_CONFIG_HOME XDG_CACHE_HOME
```

Adapter-defined values and the explicit `MONDE_*`, terminal-size, and terminal
type values above are added separately. Other service environment variables,
including cloud credentials, API keys, SSH agent sockets, `NODE_OPTIONS`, and
the local service token, are not inherited by harness processes.

MCP calls authenticate with `MONDE_RUN_ID` and `MONDE_RUN_TOKEN`.
The local service token is reserved for the CLI/web/backend and should not be
injected into harnesses. A one-shot token expires when its process finishes. A
HITL token is valid only during its current adapter turn and expires when that
turn ends or times out.

## Basic Process

`basic-process` is the reliable fallback harness for local smoke tests. It
spawns a local shell/process from the mon root, captures output as run events,
and accepts stdin where the process supports it.

**Unsandboxed execution under the Monde service user’s operating-system
permissions.** `MONDE_WORK_ROOT` and the process working directory guide the
command, but they are not an OS-enforced filesystem boundary. A trusted
`basic-process` command can access any path and network resource available to
that user.

It is useful for proving:

- scope resolution
- run lifecycle
- event streaming/history
- stdin/input behavior
- stop/interrupt controls
- artifact and log registration

## Codex

The Codex adapter launches `codex exec` when the Codex CLI is installed.

Codex runs are single-shot:

```text
interaction_mode = one_shot
input_mode = closed after launch
output_mode = event/json filtered into readable run events
```

The operator should send a complete prompt:

```bash
monde message frontend.mon "Review auth state" --harness codex
```

Codex is read-only by default. Write mode must be explicit:

```bash
monde message frontend.mon "Make the small UI fix" --harness codex --write
monde wake frontend.mon --harness codex --sandbox workspace-write
```

Write-capable Codex runs record:

```text
can_write
write_scope
sandbox_mode
approval_mode
diff_capture
```

For shared runs, `write_scope` is the resolved Mon `work_root`. For isolated
runs, Codex executes from the unique writable scratch directory. It receives
an immutable actor-context snapshot plus explicitly configured read mounts;
the Mon and work roots are not implicitly readable.

Isolated Codex support is capability-gated. Monde refuses to claim or launch it
until the installed Codex/bubblewrap/host fingerprint passes:

```bash
monde adapter verify-isolation codex
```

The generated permission profile denies the run-scope parent, grants only the
current context snapshot read-only and current scratch writable, and grants
configured read mounts read-only. Codex sandbox behavior is enforced by Codex;
isolated stdio MCP children receive an independent bubblewrap profile.

## External MCP Servers

Codex composes Monde's built-in MCP server with provider-neutral stdio and
streamable-HTTP servers declared by the Mon. Server IDs are namespaced,
startup can be required or optional, and run-claims auth uses a narrow
server-specific grant rather than the Monde service token.

Authenticated HTTP servers are loopback-only in v1. Isolated stdio children
must separately opt into actor context, scratch access, a working directory,
and read mounts. They cannot inherit Codex's full filesystem view.

## Liveness And Timeouts

HITL chat turns should distinguish idle or dead harnesses from long-running but
active work. See `harness-liveness.md` for the watchdog model, activity
signals, timeout metadata, and acceptance criteria.

## opencode

opencode detection exists, but automatic MCP configuration remains
conservative. This is adapter breadth work and does not block the core Monde
runtime or frontend UX.

## Adapter Inspection

Use:

```bash
monde adapter list
monde adapter inspect codex
monde adapter verify-isolation codex
```

Adapter inspect output includes:

- detected/missing/partial status
- command/path/version when available
- MCP status
- prompt injection status
- read/write support
- supported sandbox modes
- external MCP support
- isolated-run support and attestation status
- default sandbox mode
- interactive-input support
- manual requirements

## Runtime Prompt

Harness prompts include Monde runtime context and steer models toward:

- respecting `work_root`
- using `runtime_scope`
- searching docs with `search_docs`
- registering artifacts
- writing typed logs
- not overclaiming semantic completion
