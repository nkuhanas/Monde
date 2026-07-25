import { useEffect, useState } from "react";
import type { MonDto, RunDto } from "@monde/core";
import { MetaChip } from "../../components/MetaChip";
import { MonIcon } from "../../components/MonIcon";
import { EmptyState } from "../../components/ui";
import { compactPathTail } from "../../lib/format";
import { monDisplayName } from "../../lib/mon";
import { monHarnessMeta, monModeMeta, monStatusMeta } from "./monViewModel";

export function MonsView({ mons, runs, threads, prompt, setPrompt, onChat, onWake, onRunPrompt, onEditPermissions, onChangeHarness, onMoveWorkRoot, onUnregister }: {
  mons: MonDto[];
  runs: RunDto[];
  threads: RunDto[];
  prompt: string;
  setPrompt(value: string): void;
  onChat(mon: MonDto): void;
  onWake(mon: MonDto): void;
  onRunPrompt(mon: MonDto): void;
  onEditPermissions(mon: MonDto): void;
  onChangeHarness(mon: MonDto): void;
  onMoveWorkRoot(mon: MonDto): void;
  onUnregister(mon: MonDto): void;
}) {
  const [openActionMenu, setOpenActionMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!openActionMenu) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".mon-action-menu")) setOpenActionMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenActionMenu(null); };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openActionMenu]);
  return (
    <section className="tab-panel">
      <div className="section-head"><div><p className="eyebrow">Mons</p><h3>Actors in this Monde</h3></div><input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Run prompt for selected mon" /></div>
      <div className="mon-entity-grid">
        {mons.map((mon) => {
          const monRuns = runs.filter((run) => run.mon_id === mon.id);
          const monThreads = threads.filter((thread) => thread.mon_id === mon.id);
          const activeCount = monRuns.filter((run) => run.status === "active" || run.status === "starting").length;
          const queuedCount = monRuns.filter((run) => run.status === "queued").length;
          const finishedCount = monRuns.filter((run) => run.status === "finished").length;
          const actionKey = `${mon.monde_id}:${mon.id}`;
          const invoke = (action: (target: MonDto) => void) => { setOpenActionMenu(null); action(mon); };
          return (
            <article className="mon-entity" key={mon.id}>
              <MonIcon mon={mon} tone="cyan" />
              <div className="entity-body">
                <div className="mon-entity-title-row"><h4>{monDisplayName(mon)}</h4><span>{mon.id}</span></div>
                <p>{mon.role}</p>
                <div className="entity-meta"><MetaChip meta={monHarnessMeta(mon)} /><MetaChip meta={monStatusMeta(monRuns, monThreads)} /><MetaChip meta={monModeMeta(mon)} /></div>
                <div className="mon-value-pills" aria-label={`${monDisplayName(mon)} run counts`}><span><strong>{activeCount}</strong> active</span><span><strong>{queuedCount}</strong> queued</span><span><strong>{finishedCount}</strong> finished</span><span><strong>{monThreads.length}</strong> chats</span></div>
                <span className="mon-entity-path" title={mon.work_root}>working in {compactPathTail(mon.work_root)}</span>
              </div>
              <div className="entity-actions">
                <button type="button" onClick={() => onChat(mon)}>Chat</button>
                <details className="mon-action-menu" open={openActionMenu === actionKey} onToggle={(event) => setOpenActionMenu(event.currentTarget.open ? actionKey : (current) => current === actionKey ? null : current)}>
                  <summary>Actions</summary>
                  <div className="mon-action-list" role="menu">
                    <button type="button" role="menuitem" onClick={() => invoke(onWake)}>Open or start run</button>
                    <button type="button" role="menuitem" onClick={() => invoke(onRunPrompt)} disabled={!prompt}>Run prompt</button>
                    <button type="button" role="menuitem" onClick={() => invoke(onEditPermissions)}>Edit permissions</button>
                    <button type="button" role="menuitem" onClick={() => invoke(onChangeHarness)}>Change harness</button>
                    <button type="button" role="menuitem" onClick={() => invoke(onMoveWorkRoot)}>Move work root</button>
                    <button className="danger-menu-item" type="button" role="menuitem" onClick={() => invoke(onUnregister)}>Unregister mon</button>
                  </div>
                </details>
              </div>
            </article>
          );
        })}
        {mons.length === 0 ? <EmptyState title="No mons registered" body="Sync a mon from the CLI or repair this Monde to populate actors." /> : null}
      </div>
    </section>
  );
}
