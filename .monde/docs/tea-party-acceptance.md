# TeaParty Progression Acceptance Map

This map records the implemented code and regression evidence for the revised
Monde delta. Paths are repository-relative.

| # | Acceptance | Implementation | Regression evidence |
|---|---|---|---|
| 1 | Same-Mon concurrency is bounded and can admit two process runs | `process-slots.ts`, `run-manager.ts`, `MonConfigSchema.max_active_runs` | `tests/run-dispatch.test.ts`; real Codex execution remains part of the adapter release attestation |
| 2 | Isolated runs have distinct scratch paths and sibling access is denied | `scope.ts`, Codex permission profile, stdio bubblewrap launcher | `tests/run-isolation.test.ts`, `tests/codex-external-mcp.test.ts`, `monde adapter verify-isolation codex` |
| 3 | Twenty duplicate external starts create one run | transactional `ExternalExecutionRepository.createOrGet` | `tests/external-execution.test.ts` |
| 4 | Same key with a different request digest conflicts | external execution unique key and digest check | `tests/external-execution.test.ts` |
| 5 | Lost start response is recovered by external key | lookup endpoint and persistent external ledger | `tests/external-execution.test.ts` |
| 6 | Codex receives Monde MCP, external MCP, and actor context | Codex adapter MCP composition and immutable context snapshot | `tests/codex-external-mcp.test.ts`, `tests/run-isolation.test.ts` |
| 7 | External MCP verifies narrow claims without service token | `external_mcp_grants`, introspection endpoint, environment allowlist | `tests/codex-external-mcp.test.ts`, `tests/environment.test.ts` |
| 8 | Clean exit alone does not report semantic success | external `phase/outcome` projection and completion deadline | `tests/external-execution.test.ts`, `tests/run-auth-and-state.test.ts` |
| 9 | Completion and manifest registration are idempotent | completion digest ledger and one immutable manifest per execution | `tests/external-execution.test.ts`, `tests/execution-manifest.test.ts` |
| 10 | Active cancellation reaches acknowledged terminal state | cancellation requested/signalled/acknowledged ledger | `tests/external-execution.test.ts` |
| 11 | Manifests reject escapes, symlinks, swaps, and conflicting identities | descriptor-based local verification and execution-local output keys | `tests/execution-manifest.test.ts` |
| 12 | Scratch expiry deletes bytes and retains operational metadata | `run_workspaces` cleanup/retry and manifest availability expiry | `tests/run-isolation.test.ts`, `tests/execution-manifest.test.ts` |
| 13 | Backups exclude scratch bytes | SQLite-only online backup; run scopes remain external to DB | `tests/backup.test.ts` |
| 14 | Backup restores and passes checks in an isolated destination | checksum verification and rehearsal CLI | `tests/backup.test.ts` |
| 15 | Existing Mons retain one-slot/shared behavior and current retention | schema defaults and compatibility parsing | `tests/run-isolation.test.ts`, `.monde/docs/compatibility.md` |

## Corrections To The Original Gate

The original redaction requirement is intentionally not claimed. Prompt and
event payload retention is unchanged and those durable DB rows remain in
backups. Acceptance 12 covers scratch cleanup; acceptance 13 covers exclusion
of out-of-database scratch bytes.

Generic cron and backup rehearsal are independent Monde continuity features.
They do not gate the semantic correctness of TeaParty execution, and cron does
not implement TeaParty workflows or retry policy.

The security claim for isolated Codex execution requires:

```bash
monde adapter verify-isolation codex
```

The automated suite checks configuration, snapshots, process slots, and a real
bubblewrap stdio-child sibling denial when the adapter fingerprint is
attested. Release/manual acceptance must rerun the attestation after Codex,
bubblewrap, kernel, OS release, or architecture changes.
