import { nanoid } from "nanoid";
import {
  canonicalJson,
  type ExternalExecutionCompletionPolicy,
  type RunOrigin,
  type RunRecord
} from "@monde/core";

export function createExternalRun(input: {
  integrationId: string;
  externalExecutionKey: string;
  mondeId: string;
  monId: string;
  prompt: string;
  completionPolicy: ExternalExecutionCompletionPolicy;
  contextPacketDigest?: string;
  harnessOverride?: string;
  sandboxMode?: string;
  origin?: RunOrigin;
  title?: string;
  createdAt?: string;
}): RunRecord {
  const now = input.createdAt ?? new Date().toISOString();
  return {
    id: `run_${nanoid(10)}`,
    monde_id: input.mondeId,
    mon_id: input.monId,
    status: "queued",
    process_status: "not_started",
    outcome: "unknown",
    interaction_mode: "one_shot",
    runtime_state: "queued",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin:
      input.origin ?? {
        type: "system",
        label: `external:${input.integrationId}:${input.externalExecutionKey}`
      },
    intent: {
      title:
        input.title ?? `External execution ${input.externalExecutionKey}`,
      prompt: input.prompt
    },
    execution: {
      externally_managed: true,
      integration_id: input.integrationId,
      external_execution_key: input.externalExecutionKey,
      completion_policy: input.completionPolicy,
      ...(input.contextPacketDigest
        ? { context_packet_digest: input.contextPacketDigest }
        : {}),
      ...(input.harnessOverride
        ? { harness_override: input.harnessOverride }
        : {}),
      ...(input.sandboxMode ? { sandbox_mode: input.sandboxMode } : {})
    },
    result: {},
    created_at: now,
    updated_at: now
  };
}

export function integrationContextPrompt(contextPacket: unknown): string {
  return [
    "Execute this integration run using the configured MCP tools.",
    "Monde forwards the following bounded context packet opaquely and does not interpret its fields.",
    "",
    canonicalJson(contextPacket)
  ].join("\n");
}
