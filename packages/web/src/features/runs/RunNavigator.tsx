import { useState } from "react";
import type { MonDto, RunDto } from "@monde/core";
import { Badge, EmptyState } from "../../components/ui";
import { ageLabel } from "../../lib/format";
import { monDisplayName, monIdDisplayName } from "../../lib/mon";
import {
  compareRunsForNavigator,
  runAttentionIcon,
  runAttentionKind,
  runAttentionLabel,
  runNeedsReview,
  runRequiresAttention,
  runStateLabel,
  runStateTone,
  runVisualState
} from "./runViewModel";

export interface RunNavigatorProps {
  mons: MonDto[];
  runs: RunDto[];
  selectedRunId?: string;
  onSelect(run: RunDto): void;
}

const collapsedRunLimit = 10;

export function RunNavigator(props: RunNavigatorProps) {
  const [expandedMons, setExpandedMons] = useState<Record<string, boolean>>({});
  const knownMonIds = new Set(props.mons.map((mon) => mon.id));
  const groups = [
    ...props.mons.map((mon) => ({ id: mon.id, label: monDisplayName(mon), runs: props.runs.filter((run) => run.mon_id === mon.id) })),
    ...Array.from(new Set(props.runs.filter((run) => !knownMonIds.has(run.mon_id)).map((run) => run.mon_id))).map((monId) => ({
      id: monId,
      label: monId ? monIdDisplayName(monId) : "Unassigned / system",
      runs: props.runs.filter((run) => run.mon_id === monId)
    }))
  ].filter((group) => group.runs.length > 0);

  if (!groups.length) {
    return <EmptyState title="No matching runs" body="Adjust the status or origin filter to browse more run history." />;
  }

  return (
    <div className="run-navigator">
      {groups.map((group) => {
        const sortedRuns = [...group.runs].sort(compareRunsForNavigator);
        const expanded = expandedMons[group.id] ?? false;
        const priorityRuns = sortedRuns.filter(runRequiresAttention);
        const recentRuns = sortedRuns.filter((run) => !runRequiresAttention(run)).slice(0, collapsedRunLimit);
        const visibleRuns = expanded ? sortedRuns : [...priorityRuns, ...recentRuns].slice(0, collapsedRunLimit);
        const hiddenCount = sortedRuns.length - visibleRuns.length;
        const activeCount = sortedRuns.filter((run) => run.status === "active" || run.status === "starting").length;
        const reviewCount = sortedRuns.filter(runNeedsReview).length;

        return (
          <section className="mon-run-group" key={group.id}>
            <button
              className="mon-run-head"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedMons((current) => ({ ...current, [group.id]: !expanded }))}
            >
              <span className={activeCount ? "mon-run-presence mon-run-presence-active" : "mon-run-presence"} />
              <strong>{group.label}</strong>
              <span>{sortedRuns.length} run{sortedRuns.length === 1 ? "" : "s"}</span>
              {activeCount ? <Badge tone="green">{activeCount} active</Badge> : null}
              {reviewCount ? <Badge tone="amber">{reviewCount} review</Badge> : null}
              <span className="mon-run-chevron">{expanded ? "−" : "+"}</span>
            </button>
            <div className="mon-run-list">
              {visibleRuns.map((run) => (
                <RunRow key={run.id} run={run} selected={run.id === props.selectedRunId} onSelect={() => props.onSelect(run)} />
              ))}
            </div>
            {hiddenCount > 0 ? (
              <button className="show-mon-runs" type="button" onClick={() => setExpandedMons((current) => ({ ...current, [group.id]: true }))}>
                Show {hiddenCount} more run{hiddenCount === 1 ? "" : "s"}
              </button>
            ) : expanded && sortedRuns.length > collapsedRunLimit ? (
              <button className="show-mon-runs" type="button" onClick={() => setExpandedMons((current) => ({ ...current, [group.id]: false }))}>
                Show less
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function RunRow({ run, selected, onSelect }: { run: RunDto; selected: boolean; onSelect(): void }) {
  const attentionKind = runAttentionKind(run);
  const visualState = runVisualState(run);
  const className = [
    "run-row",
    `run-row-state-${visualState}`,
    selected ? "run-row-selected" : "",
    attentionKind ? `run-row-attention run-row-attention-${attentionKind}` : ""
  ].filter(Boolean).join(" ");

  return (
    <button className={className} type="button" aria-selected={selected} onClick={onSelect}>
      <span className="run-row-indicator">
        <span className={`run-status-dot run-status-${visualState}`} />
        {attentionKind && !(run.status === "finished" && attentionKind === "warning") ? (
          <span className="run-attention-icon" title={runAttentionLabel(run)} aria-label={runAttentionLabel(run)}>
            {runAttentionIcon(attentionKind)}
          </span>
        ) : null}
      </span>
      <span className="run-row-main">
        <strong title={run.intent.title}>{run.intent.title}</strong>
        <span>{String(run.origin.type)} · {ageLabel(run.started_at ?? run.created_at)}</span>
      </span>
      <span className="run-row-pills">
        <Badge tone={runStateTone(run)}>{runStateLabel(run)}</Badge>
        {run.interaction_mode === "hitl_thread" ? <Badge>thread</Badge> : null}
        {run.execution?.can_write === true ? <Badge tone="amber">write</Badge> : null}
        {run.warnings?.length ? <Badge tone="red">!{run.warnings.length}</Badge> : null}
      </span>
    </button>
  );
}
