import type { ReactNode } from "react";
import type { HealthDto, MonDto, RunDto } from "@monde/core";
import { MonIcon } from "../../components/MonIcon";
import { monDisplayName } from "../../lib/mon";

export type SectorTab = "runs" | "mons" | "plans" | "artifacts" | "status" | "review";
export type SectorTone = "blue" | "green" | "purple" | "cyan" | "pink" | "mint";

export interface SectorCardModel {
  id: SectorTab;
  title: string;
  description: string;
  metricLabel?: string;
  metricValue?: number | string;
  icon: ReactNode;
  tone: SectorTone;
}

const WORLD_OVERVIEW_IMAGE = "/placeholders/monde-world-overview.webp";
const MASCOT_LOGO = "/brand/mascot_logo_v3.png";

export function WorldOverview({ sectors, runs, mons, health, warningCount, onSelectTab }: {
  sectors: SectorCardModel[];
  runs: RunDto[];
  mons: MonDto[];
  health: HealthDto | null;
  warningCount: number;
  onSelectTab(tab: SectorTab): void;
}) {
  const activeCount = runs.filter((run) => run.status === "active" || run.status === "starting").length;
  const queuedCount = runs.filter((run) => run.status === "queued").length;
  const finishedCount = runs.filter((run) => run.status === "finished").length;

  return (
    <section className="world-overview" aria-label="Monde overview">
      <div className="overview-main">
        <div className="world-canvas">
          <img className="world-island-image" src={WORLD_OVERVIEW_IMAGE} alt="" />
          {sectors.map((sector) => <SectorCard sector={sector} key={sector.id} onSelect={onSelectTab} />)}
          <button className="add-world-item" type="button" onClick={() => onSelectTab("mons")}>
            <span aria-hidden="true">+</span><small>Add new .mon</small>
          </button>
        </div>
      </div>
      <RightWorldPanel
        health={health}
        mons={mons}
        activeCount={activeCount}
        queuedCount={queuedCount}
        finishedCount={finishedCount}
        warningCount={warningCount}
        onViewMons={() => onSelectTab("mons")}
      />
    </section>
  );
}

function SectorCard({ sector, onSelect }: { sector: SectorCardModel; onSelect(tab: SectorTab): void }) {
  return (
    <button className={`sector-card sector-card-${sector.tone}`} data-sector={sector.id} type="button" onClick={() => onSelect(sector.id)}>
      <span className="sector-icon" aria-hidden="true">{sector.icon}</span>
      <span className="sector-body"><strong>{sector.title}</strong><small>{sector.description}</small></span>
      <span className="sector-metric"><b>{sector.metricValue ?? "-"}</b>{sector.metricLabel ? <em>{sector.metricLabel}</em> : null}</span>
    </button>
  );
}

function RightWorldPanel({ health, mons, activeCount, queuedCount, finishedCount, warningCount, onViewMons }: {
  health: HealthDto | null;
  mons: MonDto[];
  activeCount: number;
  queuedCount: number;
  finishedCount: number;
  warningCount: number;
  onViewMons(): void;
}) {
  const recentMons = mons.slice(0, 5);
  return (
    <aside className="right-world-panel" aria-label="Monde status">
      <WorldHealthCard health={health} />
      <div className="world-panel-card">
        <div className="world-panel-heading">
          <h3>Monde Overview</h3>
          <div className="world-flavor-row">
            <img className="world-panel-mascot" src={MASCOT_LOGO} alt="" />
            <p><span>Monde is your world.</span><span>Mons are your companions.</span><span>Together, build useful local systems.</span></p>
          </div>
        </div>
        <div className="activity-list">
          <h4>Activity</h4>
          <ActivityRow label="Queued" value={queuedCount} tone="amber" />
          <ActivityRow label="Running" value={activeCount} tone="green" />
          <ActivityRow label="Finished" value={finishedCount} tone="blue" />
          <ActivityRow label="Warnings" value={warningCount} tone="orange" />
        </div>
        <div className="recent-mons">
          <h4>Recent Mons</h4>
          {recentMons.map((mon) => <div className="recent-mon-row" key={mon.id}><MonIcon mon={mon} tone="cyan" compact /><span>{monDisplayName(mon)}</span><small>Idle</small></div>)}
          {recentMons.length === 0 ? <p className="panel-empty">No mons registered yet.</p> : null}
        </div>
        <button className="view-all-button" type="button" onClick={onViewMons}>View All Mons</button>
      </div>
    </aside>
  );
}

function WorldHealthCard({ health }: { health: HealthDto | null }) {
  return <div className="world-health-card"><div className="weather-glyph" aria-hidden="true"><span /></div><div><strong>Clear Skies</strong><b>{health?.ok ? "Healthy" : health ? "Attention" : "Checking"}</b><small>{health?.ok ? "Local operator console stable" : "Service health is loading"}</small></div></div>;
}

function ActivityRow({ label, value, tone }: { label: string; value: number; tone: "amber" | "green" | "blue" | "orange" }) {
  return <div className="activity-row"><span className={`activity-dot activity-dot-${tone}`} aria-hidden="true" /><span>{label}</span><strong>{value}</strong></div>;
}
