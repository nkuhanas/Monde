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
    audience: string;
    claims: Omit<ExternalMcpGrantClaims, "audience" | "expires_at">;
    expiresAt: string;
    now?: string;
  }): { grant: ExternalMcpGrantRecord; token: string } {
    if (this.getForRunServer(input.runId, input.serverId)) {
      throw new Error(`External MCP grant already exists for ${input.runId}/${input.serverId}.`);
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
           id, external_execution_id, run_id, server_id, audience, token_hash,
           claims_json, expires_at, revoked_at, created_at
         ) VALUES (
           @id, @external_execution_id, @run_id, @server_id, @audience, @token_hash,
           @claims_json, @expires_at, NULL, @created_at
         )`
      )
      .run({
        id,
        external_execution_id: input.externalExecutionId ?? null,
        run_id: input.runId,
        server_id: input.serverId,
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

  getForRunServer(runId: string, serverId: string): ExternalMcpGrantRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM external_mcp_grants WHERE run_id = ? AND server_id = ?")
      .get(runId, serverId) as GrantRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  introspect(token: string, now = new Date().toISOString()): ExternalMcpGrantClaims | undefined {
    const candidates = this.db
      .prepare(
        `SELECT external_mcp_grants.*
         FROM external_mcp_grants
         JOIN runs ON runs.id = external_mcp_grants.run_id
         WHERE external_mcp_grants.revoked_at IS NULL
           AND external_mcp_grants.expires_at > ?
           AND runs.status IN ('starting', 'active')
         ORDER BY external_mcp_grants.created_at DESC`
      )
      .all(now) as GrantRow[];
    for (const candidate of candidates) {
      if (verifyRunToken(token, candidate.token_hash)) {
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
    audience: row.audience,
    token_hash: row.token_hash,
    claims: JSON.parse(row.claims_json) as ExternalMcpGrantClaims,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at
  };
}
