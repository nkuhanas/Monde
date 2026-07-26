# MCP Run-Scoped Tools

Monde exposes its built-in MCP server over the local loopback service and
through `monde mcp bridge` for stdio-only harnesses. A Mon may also declare
provider-neutral external MCP servers for Codex.

Every MCP call must identify and authorize a run. Harnesses receive:

```text
MONDE_RUN_ID
MONDE_RUN_TOKEN
MONDE_SERVICE_ADDR
MONDE_MCP_ADDR
```

`MONDE_RUN_ID` is identity. `MONDE_RUN_TOKEN` is run-scoped authorization.
Harnesses must not receive or print the root local service token.

## Transports

Current transports:

- HTTP JSON-RPC to `http://127.0.0.1:3762/mcp`
- stdio bridge via `monde mcp bridge`
- external stdio servers declared in `mon.json`
- external streamable-HTTP servers declared in `mon.json`

The bridge accepts both newline-delimited JSON-RPC and
Content-Length-framed JSON-RPC. Codex exec uses framed transport.

Browser-originated MCP requests are rejected unless:

```text
MONDE_ALLOW_BROWSER_MCP=1
```

The web UI should use backend API endpoints, not browser MCP, unless there is a
specific local development need.

Codex receives both the reserved `monde` server and every declared external
server. External IDs must be unique and cannot use the `monde` namespace.
Servers may be required or optional and have bounded startup timeouts.

## External Run Claims

External servers may use `auth.type = run_claims`. Monde issues a separate
random grant for each server and stores only its hash. The grant is not the
local service token and is valid only while the run is starting or active.

The server calls:

```http
POST /external-mcp/introspect
Authorization: Bearer <server-specific-run-grant>
```

Claims include:

```text
run_id
mon_id
monde_id
integration_id
external_execution_key
external_scope
audience
expires_at
```

Stable-key integration runs use these same grant mechanics. Their claims carry
the configured integration ID and execution key; `external_scope` is null on
the narrow process-exit endpoint. The bounded opaque context packet is
persisted and prompt-forwarded separately. Monde does not parse it into queue,
lease, persona, pipeline, artifact, or lineage claims.

Authenticated streamable-HTTP servers must use a loopback URL in v1 so they
can reach the local introspection endpoint. An external stdio server receives
only its declared token variable and introspection address. During isolated
runs it is launched through bubblewrap with separate declarations for read
mounts, actor-context access, and scratch read/write access.

## MVP Tools

Required/read-write tools:

- `runtime_scope`
- `search_docs`
- `list_plans`
- `get_plan`
- `search_plans`
- `list_runs`
- `get_run`
- `write_log`
- `register_artifact`
- `list_artifacts`
- `get_artifact`

There is intentionally no `open_doc` MVP tool. `search_docs` returns bounded
snippets from `.monde/docs`; traversal/open mechanics are post-MVP.

`runtime_scope` is the first tool a harness should call when it is uncertain
about:

- Monde identity
- mon identity
- work root
- docs root
- origin/intent
- warnings
- current run state
- available evidence surfaces

`write_log` accepts typed evidence events such as:

```text
decision
milestone
observation
error
tool_call
artifact_registered
warning_added
review
audit
```

`register_artifact` stores path references, not immutable blobs. The service
reports current path status so missing or inaccessible artifacts remain
visible. The optional execution-manifest API is a separate generic
metadata/reference facility and is not required for a stable-key process-exit
integration run.
