import type { PlanEvidenceDto } from "@monde/core";
import { Badge } from "../../components/ui";
import { monIdDisplayName } from "../../lib/mon";

export function PlanEvidenceSummary({ evidence, onOpenRun }: { evidence?: PlanEvidenceDto; onOpenRun(runId: string): void }) {
  if (!evidence) return <div className="plan-evidence-empty">Evidence has not loaded yet.</div>;
  return (
    <div className="plan-evidence">
      <div className="plan-evidence-metrics">
        <Badge>{evidence.summary.linked_runs} runs</Badge><Badge>{evidence.summary.artifacts} artifacts</Badge><Badge>{evidence.summary.logs} logs</Badge>
        <Badge tone={evidence.summary.warnings ? "amber" : "default"}>{evidence.summary.warnings} warnings</Badge>
      </div>
      {evidence.assignments.map((assignment) => (
        <div className="plan-evidence-assignment" key={assignment.assignment.id}>
          <strong>{assignment.assignment.phase ?? "default"} / {monIdDisplayName(assignment.assignment.mon_id)}</strong>
          {assignment.runs.map((entry) => (
            <button type="button" key={entry.run.id} onClick={() => onOpenRun(entry.run.id)}>
              <span>{entry.run.id}</span>
              <small>{entry.run.status}/{entry.run.process_status}/{entry.run.outcome} · {entry.artifacts.length} artifacts · {entry.logs.length} logs</small>
              {entry.result_summary ? <em>{entry.result_summary}</em> : null}
            </button>
          ))}
        </div>
      ))}
      {evidence.result_summaries.length ? <div className="plan-evidence-notes">{evidence.result_summaries.map((summary) => <small key={summary.run_id}>{summary.run_id}: {summary.summary}</small>)}</div> : null}
    </div>
  );
}
