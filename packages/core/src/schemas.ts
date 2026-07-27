import { z } from "zod";
import {
  processStatuses,
  runCloseReasons,
  runInteractionModes,
  runOutcomeStates,
  runOutcomes,
  runRuntimeStates,
  runStatuses
} from "./run-state.js";

export const MondeConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  version: z.number().int().positive(),
  created_at: z.string(),
  root: z.string(),
  docs: z.string()
});

export type MondeConfig = z.infer<typeof MondeConfigSchema>;

export const ActorContextEntrySchema = z.object({
  root: z.enum(["mon", "work"]),
  path: z.string().min(1)
});

export const ReadMountSchema = z.object({
  root: z.enum(["mon", "work"]),
  path: z.string().min(1)
});

export const ExternalMcpAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("run_claims"),
    audience: z.string().min(1).max(128),
    token_env_var: z.string().regex(/^[A-Z][A-Z0-9_]*$/)
  })
]);

export const ExternalMcpServerSchema = z.discriminatedUnion("transport", [
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/).refine((id) => id !== "monde", "The monde MCP namespace is reserved."),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).max(64).default([]),
    cwd: ReadMountSchema.optional(),
    read_mounts: z.array(ReadMountSchema).max(16).default([]),
    actor_context_access: z.boolean().default(false),
    scratch_access: z.enum(["none", "read", "write"]).default("none"),
    required: z.boolean().default(true),
    startup_timeout_seconds: z.number().int().positive().max(120).default(10),
    auth: ExternalMcpAuthSchema
  }),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/).refine((id) => id !== "monde", "The monde MCP namespace is reserved."),
    transport: z.literal("streamable_http"),
    url: z.string().url(),
    required: z.boolean().default(true),
    startup_timeout_seconds: z.number().int().positive().max(120).default(10),
    auth: ExternalMcpAuthSchema
  })
]);

export const RunWorkspacePolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("shared") }),
  z.object({
    mode: z.literal("isolated"),
    recovery_window_seconds: z.number().int().positive().max(604800).default(86400)
  })
]);

export const RetryConditionSchema = z.enum([
  "launch_error",
  "process_exit_nonzero",
  "process_interrupted",
  "required_mcp_unavailable",
  "attempt_timeout",
  "credential_expired",
  "harness_noop"
]);

export const RunRetryPolicySchema = z
  .object({
    max_attempts: z.number().int().min(1).max(10).default(1),
    initial_backoff_seconds: z.number().int().min(0).max(3600).default(5),
    backoff_multiplier: z.number().min(1).max(10).default(2),
    max_backoff_seconds: z.number().int().min(0).max(86400).default(300),
    attempt_timeout_seconds: z.number().int().positive().max(86400).optional(),
    kill_grace_seconds: z.number().int().positive().max(300).default(5),
    retryable_conditions: z
      .array(RetryConditionSchema)
      .max(RetryConditionSchema.options.length)
      .default([
        "launch_error",
        "process_exit_nonzero",
        "process_interrupted",
        "required_mcp_unavailable",
        "attempt_timeout",
        "credential_expired"
      ])
  })
  .superRefine((policy, context) => {
    if (policy.max_backoff_seconds < policy.initial_backoff_seconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_backoff_seconds"],
        message: "max_backoff_seconds must be greater than or equal to initial_backoff_seconds"
      });
    }
    const conditions = new Set<string>();
    for (const [index, condition] of policy.retryable_conditions.entries()) {
      if (conditions.has(condition)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retryable_conditions", index],
          message: `Duplicate retry condition: ${condition}`
        });
      }
      conditions.add(condition);
    }
  });

export const MonConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  version: z.number().int().positive(),
  default_harness: z.string().nullable(),
  default_model: z.string().nullable(),
  harness_defaults: z
    .record(
      z.object({
        sandbox_mode: z.string().optional()
      })
    )
    .optional(),
  work_root: z.string().default(".."),
  allow_external_work_root: z.boolean().optional(),
  max_active_runs: z.number().int().min(1).max(32).default(1),
  retry_policy: RunRetryPolicySchema.default({
    max_attempts: 1,
    initial_backoff_seconds: 5,
    backoff_multiplier: 2,
    max_backoff_seconds: 300,
    kill_grace_seconds: 5,
    retryable_conditions: [
      "launch_error",
      "process_exit_nonzero",
      "process_interrupted",
      "required_mcp_unavailable",
      "attempt_timeout",
      "credential_expired"
    ]
  }),
  run_workspace: RunWorkspacePolicySchema.default({ mode: "shared" }),
  actor_context: z.array(ActorContextEntrySchema).max(32).default([]),
  read_mounts: z.array(ReadMountSchema).max(16).default([]),
  external_mcp_servers: z.array(ExternalMcpServerSchema).max(8).default([]),
  capabilities: z.array(z.string()).default([]),
  created_at: z.string(),
  created_under_monde_id: z.string().optional()
}).superRefine((config, context) => {
  if (config.max_active_runs > 1 && config.run_workspace.mode !== "isolated") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["run_workspace"],
      message: "max_active_runs greater than 1 requires run_workspace.mode=isolated"
    });
  }
  const ids = new Set<string>();
  const tokenEnvNames = new Set<string>();
  for (const [index, server] of config.external_mcp_servers.entries()) {
    if (ids.has(server.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["external_mcp_servers", index, "id"],
        message: `Duplicate external MCP server id: ${server.id}`
      });
    }
    ids.add(server.id);
    if (server.auth.type === "run_claims") {
      if (tokenEnvNames.has(server.auth.token_env_var)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["external_mcp_servers", index, "auth", "token_env_var"],
          message: `Duplicate external MCP token environment name: ${server.auth.token_env_var}`
        });
      }
      tokenEnvNames.add(server.auth.token_env_var);
      if (server.transport === "streamable_http") {
        const hostname = new URL(server.url).hostname;
        if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["external_mcp_servers", index, "url"],
            message: "run_claims HTTP MCP servers must use a loopback URL in v1"
          });
        }
      }
    }
  }
});

export type MonConfig = z.infer<typeof MonConfigSchema>;
export type RetryCondition = z.infer<typeof RetryConditionSchema>;
export type RunRetryPolicy = z.infer<typeof RunRetryPolicySchema>;

export const RunStatusSchema = z.enum(runStatuses);
export const ProcessStatusSchema = z.enum(processStatuses);
export const RunOutcomeSchema = z.enum(runOutcomes);
export const RunInteractionModeSchema = z.enum(runInteractionModes);
export const RunRuntimeStateSchema = z.enum(runRuntimeStates);
export const RunOutcomeStateSchema = z.enum(runOutcomeStates);
export const RunCloseReasonSchema = z.enum(runCloseReasons);

export const RunOriginSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("operator"), label: z.string().optional() }),
  z.object({
    type: z.literal("plan"),
    plan_id: z.string(),
    phase: z.string().optional(),
    assignment: z.string().optional()
  }),
  z.object({
    type: z.literal("cron"),
    cron_id: z.string(),
    scheduled_fire_time: z.string().optional(),
    fired_at: z.string().optional()
  }),
  z.object({ type: z.literal("system"), label: z.string().optional() })
]);

export type RunOrigin = z.infer<typeof RunOriginSchema>;

export const RunRecordSchema = z.object({
  id: z.string(),
  monde_id: z.string(),
  mon_id: z.string(),
  status: RunStatusSchema,
  process_status: ProcessStatusSchema,
  outcome: RunOutcomeSchema,
  interaction_mode: RunInteractionModeSchema.default("one_shot"),
  runtime_state: RunRuntimeStateSchema.default("queued"),
  outcome_state: RunOutcomeStateSchema.default("unknown"),
  close_reason: RunCloseReasonSchema.nullable().optional(),
  warnings: z.array(z.string()),
  origin: RunOriginSchema,
  intent: z.object({
    title: z.string(),
    prompt: z.string()
  }),
  execution: z.record(z.unknown()).default({}),
  scope_snapshot: z.record(z.unknown()).optional(),
  result: z
    .object({
      summary: z.string().optional(),
      reviewed_by: z.string().optional(),
      reviewed_at: z.string().optional(),
      notes: z.string().optional()
    })
    .default({}),
  blocked_reason: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  opened_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional()
});

export type RunRecord = z.infer<typeof RunRecordSchema>;
