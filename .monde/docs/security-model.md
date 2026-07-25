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

The resulting scope is an authorization input and adapter configuration. Its
enforcement depends on the harness:

- Codex read-only or workspace-write behavior is enforced by the Codex CLI
  sandbox selected for that run.
- **Unsandboxed execution under the Monde service user’s operating-system
  permissions.** This is the `basic-process` model. Its working directory and
  `MONDE_WORK_ROOT` are guidance, not an OS filesystem boundary.

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
Adapter-defined explicit variables are still supplied where required.

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

## Backups

`monde backup create` uses SQLite's online backup operation rather than copying
the database file. The resulting user-only backup includes committed WAL state
and is integrity-tested by the focused automated suite. Restore automation is
not yet part of the operator CLI; recovery currently means copying a verified
backup into a separate location and opening it with a compatible Monde version.

## Out Of Scope

The current model does not claim container isolation, operating-system sandbox
enforcement for basic processes, safe multi-user hosting, or secure public
network exposure. Those require separate architecture and are not implied by
the local bearer-token design.
