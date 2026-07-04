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
  capabilities: z.array(z.string()).default([]),
  created_at: z.string(),
  created_under_monde_id: z.string().optional()
});

export type MonConfig = z.infer<typeof MonConfigSchema>;

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
