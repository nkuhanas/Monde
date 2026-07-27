# Security Model

Monde is a single-user, local operator runtime. Its supported deployment is a
trusted desktop or development account with the web/API and MCP listeners bound
to loopback. Local-only protects the service from network exposure; it does not
make an untrusted harness safe and it does not isolate processes running as the
same operating-system user.

## Supported Trust Boundary

- `MONDE_HOST=127.0.0.1` is the supported service binding.
- The service token is a local bearer capability stored with user-only file
  permissions and is intended for the CLI, web UI, and backend.
- Non-loopback exposure is unsupported. Monde does not currently supply TLS,
  remote identity, a hardened reverse-proxy contract, or multi-user isolation.
- A malicious process running as the same OS user may be able to read files
  available to that user, including local application state. File modes and
  loopback binding do not defend against a compromised same-user process.

## Filesystem Scope

At run start, Monde resolves the Monde, docs, mon, and work roots to canonical,
existing directories. The work root must be within the canonical Monde root
unless the mon explicitly sets `allow_external_work_root: true`. This check
covers relative traversal, absolute paths, and symlink targets and is repeated
for each run start.

The resulting scope is an authorization input and adapter configuration. Shared
and isolated runs have different guarantees:

- Codex read-only or workspace-write behavior is enforced by the Codex CLI
  sandbox selected for that run.
- An isolated Codex run gets a unique scratch directory, an immutable
  actor-context snapshot, and only explicitly configured read mounts. Its
  permission profile denies the run-scope parent, then grants the current
  context snapshot read-only and the current scratch directory writable.
- Monde advertises isolated Codex support only after a real local verification
  has proved sibling denial for both Codex and an isolated stdio MCP child. The
  attestation is bound to the Codex and bubblewrap binaries, Monde sandbox
  policy, Node version, OS/kernel release, platform, and architecture.
- **Unsandboxed execution under the Monde service user’s operating-system
  permissions.** This is the `basic-process` model. Its working directory and
  `MONDE_WORK_ROOT` are guidance, not an OS filesystem boundary.

File mode `0700` is defense in depth, not the isolation claim. Isolated mode is
an adapter capability; an adapter that cannot enforce it is refused. Verify
the installed Codex adapter with:

```bash
monde adapter verify-isolation codex
```

Configured actor-context files are resolved without symlink traversal, bounded
to 32 files and 256 KiB total, copied into the run scope, hashed, and sealed
before launch. Source Mon/work roots are not implicitly readable by isolated
Codex. Repository access must be declared through `read_mounts`.

## Harness Environment

Harnesses receive explicit run context such as `MONDE_RUN_ID`,
`MONDE_RUN_TOKEN`, service/MCP addresses, resolved roots, adapter identity, and
terminal dimensions. From the service environment, only this compatibility
allowlist is inherited:

```text
PATH HOME USER LOGNAME SHELL
TMPDIR TMP TEMP
LANG LC_ALL LC_CTYPE COLORTERM NO_COLOR FORCE_COLOR
XDG_CONFIG_HOME XDG_CACHE_HOME
```

All other ambient variables are denied by default. This includes cloud and API
credentials, SSH agent sockets, `NODE_OPTIONS`, and the Monde service token.
Run scopes additionally provide `MONDE_RUN_SCRATCH` and
`MONDE_ACTOR_CONTEXT` when present. Adapter-defined explicit variables are
still supplied where required.

## Run-Scoped Authorization

Harness MCP access requires both a run ID and a cryptographically random
run-scoped token. The database stores only its hash.

- A one-shot token is accepted only while the run is starting or active.
- A HITL token is accepted only during the current adapter turn and while that
  turn has not timed out.
- On completion, failure, stop, cancellation, lost-process recovery, turn end,
  or timeout, Monde removes the stored token hash and records revocation time.

The root service token is not intentionally injected into harnesses. This
separation limits accidental capability spread, but it cannot protect against a
malicious same-user process that can independently read service-owned files.

## External MCP Grants

Each external MCP server configured with `run_claims` receives a separate
random grant. The database stores only its hash. Introspection returns the
run ID, Mon and Monde IDs, integration and external execution keys, opaque
external scope, audience, and expiry.

Grants are accepted only while their run is starting or active. They use a
short expiry that introspection renews while that active-state check continues
to pass. A new process attempt receives new grants; prior-attempt grants are
revoked before retry backoff, and all grants are revoked when the logical run
terminates. Authenticated streamable-HTTP MCP is constrained to loopback in
v1. An isolated stdio MCP process runs under its own bubblewrap profile and
sees only its declared read mounts, actor-context access, and scratch access.

## Backups

`monde backup create` uses SQLite's online backup operation rather than copying
the database file. The resulting user-only backup includes committed WAL state
and records a SHA-256 checksum after SQLite integrity and foreign-key checks.
`monde backup verify` repeats those checks. `monde backup rehearse` restores
only into an explicit, new directory outside the live data directory and never
replaces live state.

Scratch directories are outside SQLite and are not copied by the backup
command. Prompt and event payloads remain durable operational data and are
included in backups; selective redaction and backup exclusion are not part of
this local-first progression.

Opaque integration context packets are bounded to 64 KiB, canonicalized for
hashing and prompt forwarding, and never interpreted by Monde. They are
durable run content. Integrations must keep credentials and sensitive binary
payloads out of them.

## Out Of Scope

The current model does not claim container isolation, operating-system sandbox
enforcement for basic processes, safe multi-user hosting, secure public
network exposure, or prompt/event secrecy from the local operator. Those
require separate architecture and are not implied by the local bearer-token
design.
