import { useMemo, useState } from "react";
import type { MonDto, RunDto } from "@monde/core";
import { EmptyState } from "../../components/ui";
import { RunDetail, type RunDetailProps } from "./RunDetail";
import { RunNavigator } from "./RunNavigator";

const runStatuses = ["all", "active", "queued", "finished"] as const;

export function RunsWorkspace({ runs, mons, selectedRun, onSelectRun, detailProps }: {
  runs: RunDto[];
  mons: MonDto[];
  selectedRun?: RunDto;
  onSelectRun(run: RunDto): void;
  detailProps: Omit<RunDetailProps, "run" | "compact">;
}) {
  const [statusFilter, setStatusFilter] = useState<(typeof runStatuses)[number]>("all");
  const [originFilter, setOriginFilter] = useState("all");
  const originTypes = useMemo(() => Array.from(new Set(runs.map((run) => String(run.origin.type)))).sort(), [runs]);
  const filteredRuns = useMemo(() => runs.filter((run) => {
    if (statusFilter !== "all" && run.status !== statusFilter) return false;
    if (originFilter !== "all" && String(run.origin.type) !== originFilter) return false;
    return true;
  }), [originFilter, runs, statusFilter]);

  return (
    <div className="runs-page"><div className="runs-workspace">
      <section className="runs-panel">
        <div className="section-head">
          <div><p className="eyebrow">Runs</p><h3>Browse by mon</h3></div>
          <div className="run-filters">
            <div className="segmented">
              {runStatuses.map((status) => <button className={status === statusFilter ? "segment segment-active" : "segment"} type="button" key={status} onClick={() => setStatusFilter(status)}>{status}</button>)}
            </div>
            <select value={originFilter} onChange={(event) => setOriginFilter(event.target.value)} aria-label="Origin filter">
              <option value="all">all origins</option>
              {originTypes.map((origin) => <option value={origin} key={origin}>{origin}</option>)}
            </select>
          </div>
        </div>
        <RunNavigator mons={mons} runs={filteredRuns} selectedRunId={selectedRun?.id} onSelect={onSelectRun} />
      </section>
      <aside className="detail-rail">
        {selectedRun ? <RunDetail compact run={selectedRun} {...detailProps} /> : <EmptyState title="No run selected" body="Select a run to inspect its overview, output, changes, and evidence." />}
      </aside>
    </div></div>
  );
}
