import type { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { createRunToken, hashRunToken, verifyRunToken } from "../run-auth.js";

export interface ExternalMcpGrantClaims {
  run_id: string;
  mon_id: string;
  monde_id: string;
  integration_id: string;
  external_execution_key: string;
  external_scope: unknown;
  audience: string;
  expires_at: string;
}

export interface ExternalMcpGrantRecord {
  id: string;
  external_execution_id: string | null;
  run_id: string;
  server_id: string;
  attempt_number: number;
  audience: string;
  token_hash: string;
  claims: ExternalMcpGrantClaims;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export class ExternalMcpGrantRepository {
  constructor(private readonly db: DatabaseSync) {}

  issue(input: {
    externalExecutionId?: string;
    runId: string;
    serverId: string;
    attemptNumber: number;
    audience: string;
    claims: Omit<ExternalMcpGrantClaims, "audience" | "expires_at">;
    expiresAt: string;
    now?: string;
  }): { grant: ExternalMcpGrantRecord; token: string } {
    if (this.getForRunServer(input.runId, input.serverId, input.attemptNumber)) {
      throw new Error(
        `External MCP grant already exists for ${input.runId}/${input.serverId}/${input.attemptNumber}.`
      );
    }
    const token = createRunToken();
    const now = input.now ?? new Date().toISOString();
    const claims: ExternalMcpGrantClaims = {
      ...input.claims,
      audience: input.audience,
      expires_at: input.expiresAt
    };
    const id = `grant_${nanoid(14)}`;
    this.db
      .prepare(
        `INSERT INTO external_mcp_grants (
           id, external_execution_id, run_id, server_id, attempt_number, audience, token_hash,
           claims_json, expires_at, revoked_at, created_at
         ) VALUES (
           @id, @external_execution_id, @run_id, @server_id, @attempt_number, @audience, @token_hash,
           @claims_json, @expires_at, NULL, @created_at
         )`
      )
      .run({
        id,
        external_execution_id: input.externalExecutionId ?? null,
        run_id: input.runId,
        server_id: input.serverId,
        attempt_number: input.attemptNumber,
        audience: input.audience,
        token_hash: hashRunToken(token),
        claims_json: JSON.stringify(claims),
        expires_at: input.expiresAt,
        created_at: now
      });
    return { grant: this.get(id)!, token };
  }

  get(id: string): ExternalMcpGrantRecord | undefined {
    const row = this.db.prepare("SELECT * FROM external_mcp_grants WHERE id = ?").get(id) as GrantRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getForRunServer(
    runId: string,
    serverId: string,
    attemptNumber?: number
  ): ExternalMcpGrantRecord | undefined {
    const row = (attemptNumber === undefined
      ? this.db
          .prepare(
            `SELECT * FROM external_mcp_grants
             WHERE run_id = ? AND server_id = ?
             ORDER BY attempt_number DESC
             LIMIT 1`
          )
          .get(runId, serverId)
      : this.db
          .prepare(
            `SELECT * FROM external_mcp_grants
             WHERE run_id = ? AND server_id = ? AND attempt_number = ?`
          )
          .get(runId, serverId, attemptNumber)) as GrantRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  introspect(token: string, now = new Date().toISOString()): ExternalMcpGrantClaims | undefined {
    const candidates = this.db
      .prepare(
        `SELECT external_mcp_grants.*
         FROM external_mcp_grants
         JOIN runs ON runs.id = external_mcp_grants.run_id
         WHERE external_mcp_grants.revoked_at IS NULL
           AND runs.status IN ('starting', 'active')
         ORDER BY external_mcp_grants.created_at DESC`
      )
      .all() as GrantRow[];
    for (const candidate of candidates) {
      if (verifyRunToken(token, candidate.token_hash)) {
        const refreshThreshold = Date.parse(now) + 5 * 60 * 1000;
        if (Date.parse(candidate.expires_at) <= refreshThreshold) {
          const expiresAt = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
          const claims = {
            ...(JSON.parse(candidate.claims_json) as ExternalMcpGrantClaims),
            expires_at: expiresAt
          };
          this.db
            .prepare(
              `UPDATE external_mcp_grants
               SET expires_at = @expires_at, claims_json = @claims_json
               WHERE id = @id AND revoked_at IS NULL`
            )
            .run({
              id: candidate.id,
              expires_at: expiresAt,
              claims_json: JSON.stringify(claims)
            });
          return claims;
        }
        return fromRow(candidate).claims;
      }
    }
    return undefined;
  }

  revokeForRun(runId: string, now = new Date().toISOString()): number {
    const result = this.db
      .prepare(
        `UPDATE external_mcp_grants
         SET revoked_at = @revoked_at
         WHERE run_id = @run_id AND revoked_at IS NULL`
      )
      .run({ run_id: runId, revoked_at: now }) as { changes: number };
    return result.changes;
  }
}

interface GrantRow {
  id: string;
  external_execution_id: string | null;
  run_id: string;
  server_id: string;
  attempt_number: number;
  audience: string;
  token_hash: string;
  claims_json: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

function fromRow(row: GrantRow): ExternalMcpGrantRecord {
  return {
    id: row.id,
    external_execution_id: row.external_execution_id,
    run_id: row.run_id,
    server_id: row.server_id,
    attempt_number: row.attempt_number,
    audience: row.audience,
    token_hash: row.token_hash,
    claims: JSON.parse(row.claims_json) as ExternalMcpGrantClaims,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at
  };
}
