import type { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";

export const planStatuses = ["draft", "active", "blocked", "completed", "superseded", "abandoned"] as const;
export const assignmentStatuses = ["pending", "queued", "active", "satisfied", "blocked", "canceled"] as const;

export type PlanStatus = (typeof planStatuses)[number];
export type PlanAssignmentStatus = (typeof assignmentStatuses)[number];

export interface PlanRecord {
  id: string;
  monde_id: string;
  title: string;
  objective: string;
  prompt: string;
  description: string;
  status: PlanStatus;
  created_at: string;
  updated_at: string;
  assignments: PlanAssignmentRecord[];
}

export interface PlanAssignmentRecord {
  id: string;
  plan_id: string;
  status: PlanAssignmentStatus;
  phase?: string | null;
  mon_id: string;
  intent: {
    title: string;
    prompt: string;
  };
  trigger: "on_activation" | "manual";
  depends_on?: string | null;
  generated_run_ids: string[];
  generation_key: string;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  id: string;
  monde_id: string;
  title: string;
  objective: string;
  prompt: string;
  description: string;
  status: PlanStatus;
  created_at: string;
  updated_at: string;
}

interface AssignmentRow {
  id: string;
  plan_id: string;
  status: PlanAssignmentStatus;
  phase: string | null;
  mon_id: string;
  intent_title: string;
  intent_prompt: string;
  trigger: "on_activation" | "manual";
  depends_on: string | null;
  generated_run_ids_json: string;
  generation_key: string;
  created_at: string;
  updated_at: string;
}

export class PlanRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    monde_id: string;
    title: string;
    objective?: string;
    prompt?: string;
    description?: string;
    assignment?: {
      mon_id: string;
      title?: string;
      prompt: string;
      phase?: string;
      trigger?: "on_activation" | "manual";
    };
  }): PlanRecord {
    const now = new Date().toISOString();
    const planId = `plan_${nanoid(10)}`;
    this.db
      .prepare(
        `INSERT INTO plans (id, monde_id, title, objective, prompt, description, status, created_at, updated_at)
         VALUES (@id, @monde_id, @title, @objective, @prompt, @description, 'draft', @now, @now)`
      )
      .run({
        id: planId,
        monde_id: input.monde_id,
        title: input.title,
        objective: input.objective ?? input.title,
        prompt: input.prompt ?? input.description ?? input.objective ?? input.title,
        description: input.description ?? input.objective ?? input.prompt ?? input.title,
        now
      });

    if (input.assignment) {
      this.addAssignment(planId, input.assignment);
    }

    return this.get(planId)!;
  }

  addAssignment(
    planId: string,
    input: {
      mon_id: string;
      title?: string;
      prompt: string;
      phase?: string;
      trigger?: "on_activation" | "manual";
    }
  ): PlanAssignmentRecord {
    const now = new Date().toISOString();
    const assignmentId = `asg_${nanoid(10)}`;
    const trigger = input.trigger ?? "on_activation";
    const generationKey = `${planId}:${assignmentId}:${trigger}`;
    this.db
      .prepare(
        `INSERT INTO plan_assignments (
           id, plan_id, status, phase, mon_id, intent_title, intent_prompt, trigger,
           depends_on, generated_run_ids_json, generation_key, created_at, updated_at
         )
         VALUES (
           @id, @plan_id, 'pending', @phase, @mon_id, @intent_title, @intent_prompt, @trigger,
           NULL, '[]', @generation_key, @now, @now
         )`
      )
      .run({
        id: assignmentId,
        plan_id: planId,
        phase: input.phase ?? null,
        mon_id: input.mon_id,
        intent_title: input.title ?? input.prompt.slice(0, 80),
        intent_prompt: input.prompt,
        trigger,
        generation_key: generationKey,
        now
      });

    this.touch(planId);
    return this.getAssignment(assignmentId)!;
  }

  list(mondeId?: string): PlanRecord[] {
    const rows = mondeId
      ? (this.db.prepare("SELECT * FROM plans WHERE monde_id = ? ORDER BY updated_at DESC").all(mondeId) as PlanRow[])
      : (this.db.prepare("SELECT * FROM plans ORDER BY updated_at DESC").all() as PlanRow[]);

    return rows.map((row) => this.fromPlanRow(row));
  }

  search(mondeId: string, query: string): PlanRecord[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM plans
         WHERE monde_id = @monde_id
           AND (title LIKE @like OR objective LIKE @like OR prompt LIKE @like OR description LIKE @like)
         ORDER BY updated_at DESC`
      )
      .all({ monde_id: mondeId, like }) as PlanRow[];
    return rows.map((row) => this.fromPlanRow(row));
  }

  get(id: string): PlanRecord | undefined {
    const row = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
    return row ? this.fromPlanRow(row) : undefined;
  }

  getAssignment(id: string): PlanAssignmentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM plan_assignments WHERE id = ?").get(id) as AssignmentRow | undefined;
    return row ? this.fromAssignmentRow(row) : undefined;
  }

  listAssignments(planId: string): PlanAssignmentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM plan_assignments WHERE plan_id = ? ORDER BY created_at ASC")
      .all(planId) as AssignmentRow[];
    return rows.map((row) => this.fromAssignmentRow(row));
  }

  updateStatus(planId: string, status: PlanStatus): void {
    this.db
      .prepare("UPDATE plans SET status = @status, updated_at = @updated_at WHERE id = @id")
      .run({ id: planId, status, updated_at: new Date().toISOString() });
  }

  updateAssignmentGeneratedRun(assignmentId: string, status: PlanAssignmentStatus, runId: string): void {
    const assignment = this.getAssignment(assignmentId);
    if (!assignment) {
      throw new Error(`Assignment not found: ${assignmentId}`);
    }

    const generated_run_ids = assignment.generated_run_ids.includes(runId)
      ? assignment.generated_run_ids
      : [...assignment.generated_run_ids, runId];

    this.db
      .prepare(
        `UPDATE plan_assignments
         SET status = @status,
             generated_run_ids_json = @generated_run_ids_json,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: assignmentId,
        status,
        generated_run_ids_json: JSON.stringify(generated_run_ids),
        updated_at: new Date().toISOString()
      });

    this.touch(assignment.plan_id);
  }

  updateAssignmentStatusForRun(assignmentId: string, status: PlanAssignmentStatus, runId: string): void {
    const assignment = this.getAssignment(assignmentId);
    if (!assignment || !assignment.generated_run_ids.includes(runId)) {
      return;
    }

    this.db
      .prepare(
        `UPDATE plan_assignments
         SET status = @status,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: assignmentId,
        status,
        updated_at: new Date().toISOString()
      });

    this.touch(assignment.plan_id);
  }

  private touch(planId: string): void {
    this.db.prepare("UPDATE plans SET updated_at = @updated_at WHERE id = @id").run({
      id: planId,
      updated_at: new Date().toISOString()
    });
  }

  private fromPlanRow(row: PlanRow): PlanRecord {
    return {
      ...row,
      assignments: this.listAssignments(row.id)
    };
  }

  private fromAssignmentRow(row: AssignmentRow): PlanAssignmentRecord {
    return {
      id: row.id,
      plan_id: row.plan_id,
      status: row.status,
      phase: row.phase,
      mon_id: row.mon_id,
      intent: {
        title: row.intent_title,
        prompt: row.intent_prompt
      },
      trigger: row.trigger,
      depends_on: row.depends_on,
      generated_run_ids: JSON.parse(row.generated_run_ids_json) as string[],
      generation_key: row.generation_key,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
}
