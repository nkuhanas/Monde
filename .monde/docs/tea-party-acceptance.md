# TeaParty V1 Monde Acceptance Map

This map follows the current TeaParty v1 process-exit contract. Receipt-gated
completion and Monde execution manifests are optional generic capabilities and
are not part of this gate.

| # | TeaParty v1 acceptance | Monde implementation | Regression evidence |
|---|---|---|---|
| 1 | Twenty identical starts produce one run and one process launch | narrow integration-run endpoint plus transactional external ledger | `tests/integration-run.test.ts` |
| 2 | Clean exit succeeds without a completion callback | `completion_policy = process_exit` | `tests/integration-run.test.ts`, `tests/external-execution.test.ts` |
| 3 | TeaParty domain validation can fail independently after Monde success | normalized Monde snapshot remains terminal and immutable after process success; QueueItem transition remains TeaParty-owned | Monde side: `tests/integration-run.test.ts`; QueueItem divergence test belongs in TeaParty |
| 4 | No Monde manifest is required | integration-run completion has no manifest lookup or attachment | `tests/integration-run.test.ts` |
| 5 | Cancellation persists intent, terminates the process group, and awaits acknowledgement | external cancellation ledger and process-group signalling | `tests/integration-run.test.ts`, `tests/environment.test.ts` |
| 6 | The actual process-exit path receives isolation, actor context, MCP grants, and credential scrubbing | normal RunManager scope/MCP pipeline shared by integration runs | `tests/integration-run.test.ts`, `tests/codex-external-mcp.test.ts`, `tests/environment.test.ts` |
| 7 | Stale isolation attestation blocks admission | binary, sandbox-policy, Node, OS/kernel, platform, and architecture fingerprint matching | `tests/run-isolation.test.ts` |
| 8 | A changed context packet under the same key conflicts | server-computed canonical request digest | `tests/integration-run.test.ts` |
| 9 | Lost start response is recoverable by execution key | persistent lookup route and ledger | `tests/integration-run.test.ts`, `tests/external-execution.test.ts` |
| 10 | Existing Mons retain one-slot/shared behavior | schema defaults and workspace invariant | `tests/run-isolation.test.ts`, `.monde/docs/compatibility.md` |
| 11 | Persisted queued work resumes after service startup without relaunching uncertain active work | restart reconciliation followed by oldest-runnable dispatch | `tests/integration-run.test.ts`, `tests/run-dispatch.test.ts` |
| 12 | A retryable operational failure keeps one run and execution key across durable process attempts | Mon retry policy, `run_attempts`, persisted backoff | `tests/integration-run.test.ts` |
| 13 | Cancellation during retry backoff prevents another launch | persistent cancellation plus retry-wake removal | `tests/integration-run.test.ts` |
| 14 | Stable-key schedule registration and fires are idempotent | integration schedule ledger and deterministic per-fire execution key | `tests/integration-run.test.ts`, `tests/cron-schedule.test.ts` |
| 15 | An active external MCP grant remains usable without surviving termination or backoff | active-only grant renewal and per-attempt revocation | `tests/integration-run.test.ts`, `tests/codex-external-mcp.test.ts` |

## TeaParty-Owned Acceptance

Monde cannot implement or prove this domain transition:

```text
Monde snapshot = succeeded
TeaParty output validation = failed
TeaParty QueueItem = failed
Monde snapshot remains succeeded
```

The Monde API makes the states independent and performs no callback into
TeaParty. The QueueItem transition and its regression belong in the TeaParty
repository.

Likewise, Monde's process-attempt retry is generic operational recovery inside
one logical Monde run. TeaParty still owns validation of materialized effects
and any domain retry decision after Monde reaches a terminal result.

## Release Gate

The deterministic suite validates contracts and containment construction. The
deployed adapter must also pass:

```bash
monde adapter verify-isolation codex
```

The actual integration-path test runs the contained stdio MCP sibling-denial
probe when the current attestation is present. Verification must be rerun after
any fingerprinted binary, sandbox policy, runtime, or host change.

## Optional Capabilities Outside This Gate

The following tests remain valuable Monde coverage but do not represent a
TeaParty v1 dependency:

- receipt-gated `awaiting_completion`
- idempotent `/external-executions/:id/complete`
- immutable Monde execution manifests
- caller-supplied external attempt lineage
- manifest availability and local-reference expiry
