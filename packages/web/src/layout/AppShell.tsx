import type { ReactNode } from "react";
import type { HealthDto, MondeDto } from "@monde/core";
import { UiIcon } from "../components/UiIcon";
import { Badge, Metric } from "../components/ui";
import { tabLabel } from "../lib/format";
import { mondeDisplayName } from "../lib/mon";

export const appTabs = ["overview", "runs", "mons", "plans", "artifacts", "status", "review"] as const;
export type ActiveTab = (typeof appTabs)[number];

export interface SidebarMachine {
  id: string;
  displayName: string;
  online: boolean;
  mondes: MondeDto[];
}

const BRAND_ICON_LOGO = "/brand/icon_logo_v1.png";
const MASCOT_LARGE_LOGO = "/brand/mascot_large_logo_v1.png";

export function AppShell({ activeTab, onSelectTab, machines, collapsedMachines, onToggleMachine, currentMonde, onSelectMonde, health, token, onTokenChange, onRefresh, error, metrics, floatingLayer, children }: {
  activeTab: ActiveTab;
  onSelectTab(tab: ActiveTab): void;
  machines: SidebarMachine[];
  collapsedMachines: Record<string, boolean>;
  onToggleMachine(machineId: string): void;
  currentMonde?: MondeDto;
  onSelectMonde(mondeId: string): void;
  health: HealthDto | null;
  token: string;
  onTokenChange(token: string): void;
  onRefresh(): void;
  error: string | null;
  metrics: { mons: number; active: number; queued: number; finished: number; warnings: number };
  floatingLayer?: ReactNode;
  children: ReactNode;
}) {
  const shellClassName = [
    "app-shell",
    activeTab === "overview" ? "app-shell-overview" : "",
    activeTab === "runs" ? "app-shell-runs" : ""
  ].filter(Boolean).join(" ");

  return (
    <main className={shellClassName}>
      <aside className="resource-tree" aria-label="Monde browser">
        <div className="brand-block"><div className="brand-mark"><img src={BRAND_ICON_LOGO} alt="" /></div><div><h1>Monde</h1><p>Local operator console</p></div></div>
        <div className="tree-section">
          <div className="tree-heading">Machines</div>
          <div className="machine-list">
            {machines.map((machine) => {
              const collapsed = Boolean(collapsedMachines[machine.id]);
              return (
                <section className="machine-section" key={machine.id}>
                  <button className="machine-header" type="button" aria-expanded={!collapsed} onClick={() => onToggleMachine(machine.id)}>
                    <span className={collapsed ? "machine-chevron machine-chevron-collapsed" : "machine-chevron"} aria-hidden="true" />
                    <span className="machine-icon" aria-hidden="true"><UiIcon name="machine" /></span><span className="machine-name">{machine.displayName}</span><span className="machine-count">{machine.mondes.length} monde{machine.mondes.length === 1 ? "" : "s"}</span>
                  </button>
                  {!collapsed ? <div className="monde-list">
                    {machine.mondes.map((monde) => <button className={monde.id === currentMonde?.id ? "monde-row monde-row-active" : "monde-row"} type="button" key={monde.id} onClick={() => onSelectMonde(monde.id)}>
                      <span className="monde-icon" aria-hidden="true"><UiIcon name="monde" /></span><span className="monde-name">{mondeDisplayName(monde)}</span><span className="monde-status"><span className={machine.online ? "status-dot status-dot-online" : "status-dot"} aria-hidden="true" /><span>{machine.online ? "Online" : "Offline"}</span></span>
                    </button>)}
                    {machine.mondes.length === 0 ? <div className="sidebar-empty">No mondes registered on this machine.</div> : null}
                  </div> : null}
                </section>
              );
            })}
          </div>
        </div>
        <div className="operator-area"><img className="operator-mascot" src={MASCOT_LARGE_LOGO} alt="" /><div className="operator-card"><div><span>Operator</span><strong>local console</strong></div><Badge tone={health?.ok ? "green" : "default"}>{health?.ok ? "Online" : "Offline"}</Badge></div></div>
      </aside>

      <section className="workspace-shell">
        <header className="workspace-header">
          <div className="workspace-title"><div className={health?.ok ? "service-dot service-dot-online" : "service-dot"} /><div><p className="eyebrow">Selected Monde</p><h2>{currentMonde ? mondeDisplayName(currentMonde) : "No Monde selected"}</h2><span>{currentMonde ? currentMonde.root : "Enter the service token to load state."}</span></div></div>
          <div className="header-controls"><label>Token<input value={token} onChange={(event) => onTokenChange(event.target.value)} placeholder="Local token" type="password" /></label><button className="primary-action" type="button" onClick={onRefresh} disabled={!token}>Refresh</button></div>
        </header>
        {error ? <div className="warning-band">{error}</div> : null}
        {!token ? <div className="warning-band">Enter the local service token to load Monde state.</div> : null}
        <nav className="tabbar" aria-label="Monde sections">{appTabs.map((tab) => <button className={tab === activeTab ? "tab-button tab-button-active" : "tab-button"} type="button" key={tab} onClick={() => onSelectTab(tab)}>{tabLabel(tab)}</button>)}</nav>
        {activeTab === "runs" ? (
          <section className="runs-status-strip" aria-label="Runs summary">
            <div className="runs-status-metrics">
              <span><strong className="runs-metric-mons">{metrics.mons}</strong> Mons</span>
              <span><strong className="runs-metric-active">{metrics.active}</strong> Active</span>
              <span><strong className="runs-metric-queued">{metrics.queued}</strong> Queued</span>
              <span><strong className="runs-metric-finished">{metrics.finished}</strong> Finished</span>
              <span><strong className="runs-metric-warnings">{metrics.warnings}</strong> Warnings</span>
            </div>
            <div className="runs-db-path">{health ? `${health.db_path} · schema ${health.schema_version ?? "?"}` : "Checking service..."}</div>
          </section>
        ) : (
          <section className="status-strip" aria-label="Workspace summary">
            <Metric label="Mons" value={metrics.mons} tone="blue" /><Metric label="Active" value={metrics.active} tone="green" /><Metric label="Queued" value={metrics.queued} tone="amber" /><Metric label="Finished" value={metrics.finished} tone="purple" /><Metric label="Warnings" value={metrics.warnings} tone="red" />
            <div className="db-pill">{health ? `${health.db_path} · schema ${health.schema_version ?? "?"}` : "Checking service..."}</div>
          </section>
        )}
        <section className="tab-surface">{children}</section>
      </section>
      {floatingLayer}
    </main>
  );
}
