import type { FormEvent } from "react";
import type { MonDto, PlanDto, PlanEvidenceDto, RunDto } from "@monde/core";
import { Badge } from "../../components/ui";
import { monDisplayName, monIdDisplayName } from "../../lib/mon";
import { PlanEvidenceSummary } from "./PlanEvidenceSummary";

export function PlansView({ plans, mons, runs, evidence, canCreate, title, setTitle, monId, setMonId, prompt, setPrompt, onCreate, onOpenRun, onStartRun, onActivate }: {
  plans: PlanDto[];
  mons: MonDto[];
  runs: RunDto[];
  evidence: Record<string, PlanEvidenceDto>;
  canCreate: boolean;
  title: string;
  setTitle(value: string): void;
  monId: string;
  setMonId(value: string): void;
  prompt: string;
  setPrompt(value: string): void;
  onCreate(event: FormEvent): void;
  onOpenRun(runId: string): void;
  onStartRun(run: RunDto): void;
  onActivate(plan: PlanDto): void;
}) {
  return (
    <section className="tab-panel">
      <div className="section-head"><div><p className="eyebrow">Plans</p><h3>Coordination and generated runs</h3></div><span className="subtle-count">{plans.length} plan(s)</span></div>
      <form className="plan-create" onSubmit={onCreate}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Plan title" />
        <select value={monId} onChange={(event) => setMonId(event.target.value)}>{mons.map((mon) => <option value={mon.id} key={mon.id}>{monDisplayName(mon)}</option>)}</select>
        <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Assignment prompt" />
        <button className="primary-action" type="submit" disabled={!canCreate || !title || !prompt || !monId}>Create plan</button>
      </form>
      <div className="plan-grid">
        {plans.map((plan) => (
          <article className="plan-card" key={plan.id}>
            <div><div className="card-kicker">{plan.id}</div><h4>{plan.title}</h4><p>{plan.objective}</p></div>
            <div className="plan-card-meta"><Badge tone={plan.status === "active" ? "green" : "default"}>{plan.status}</Badge><Badge>{plan.assignments.length} assignments</Badge></div>
            <div className="assignment-list">
              {plan.assignments.map((assignment) => (
                <div className="assignment-row" key={assignment.id}>
                  <button type="button" onClick={() => { const runId = assignment.generated_run_ids[0]; if (runId) onOpenRun(runId); }}>
                    <span>{assignment.phase ?? "default"} / {monIdDisplayName(assignment.mon_id)}</span><small>{assignment.status} · {assignment.generated_run_ids.join(",") || "no runs"}</small>
                  </button>
                  {assignment.generated_run_ids.map((runId) => runs.find((run) => run.id === runId)).filter((run): run is RunDto => Boolean(run)).map((run) => (
                    <button className="assignment-start" type="button" key={run.id} onClick={() => run.status === "queued" ? onStartRun(run) : onOpenRun(run.id)}>{run.status === "queued" ? "Start queued run" : "Open run"}</button>
                  ))}
                </div>
              ))}
            </div>
            <PlanEvidenceSummary evidence={evidence[plan.id]} onOpenRun={onOpenRun} />
            <button type="button" onClick={() => onActivate(plan)}>Activate</button>
          </article>
        ))}
      </div>
    </section>
  );
}
