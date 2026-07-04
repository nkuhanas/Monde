# MCP Run-Scoped Tools

Monde exposes MCP over the local loopback MCP service and through
`monde mcp bridge` for stdio-only harnesses.

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

The bridge accepts both newline-delimited JSON-RPC and
Content-Length-framed JSON-RPC. Codex exec uses framed transport.

Browser-originated MCP requests are rejected unless:

```text
MONDE_ALLOW_BROWSER_MCP=1
```

The web UI should use backend API endpoints, not browser MCP, unless there is a
specific local development need.

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
reports current path status so missing or inaccessible artifacts remain visible.
