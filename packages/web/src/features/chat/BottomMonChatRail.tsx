import { type FormEvent, useEffect, useRef } from "react";
import type { MonDto, MondeDto, RunDto, RunEventDto } from "@monde/core";
import { MetaChip } from "../../components/MetaChip";
import { MonIcon } from "../../components/MonIcon";
import { compactPathTail } from "../../lib/format";
import { monDisplayName, monIdDisplayName } from "../../lib/mon";
import {
  chatEventAuthor,
  chatEventContent,
  chatEventTypes,
  formatChatTimestamp,
  formatChatTimestampTitle,
  isOpenThreadRuntimeState,
  threadHarnessMeta,
  threadModeMeta,
  threadStatusMeta,
  threadTitle
} from "./chatViewModel";

export interface BottomMonChatRailProps {
  monde?: MondeDto | null;
  mons: MonDto[];
  threads: RunDto[];
  activeThreadId: string | null;
  expandedThreadIds: string[];
  threadEvents: Record<string, RunEventDto[]>;
  drafts: Record<string, string>;
  isRailExpanded: boolean;
  sending: Record<string, boolean>;
  error: string | null;
  onToggleRail(): void;
  onOpenThread(thread: RunDto): void;
  onOpenMon(mon: MonDto): void;
  onMinimize(thread: RunDto): void;
  onCloseThread(thread: RunDto): void;
  onChangeDraft(threadId: string, value: string): void;
  onSend(thread: RunDto, event: FormEvent): void;
}

export function BottomMonChatRail(props: BottomMonChatRailProps) {
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!props.isRailExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") props.onToggleRail(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.isRailExpanded, props.onToggleRail]);

  useEffect(() => {
    for (const threadId of props.expandedThreadIds) {
      const container = messageRefs.current[threadId];
      if (container) container.scrollTo({ top: container.scrollHeight });
    }
  }, [props.expandedThreadIds, props.threadEvents, props.sending, props.error]);

  if (!props.monde) return null;
  return (
    <div className="bottom-mon-chat-rail" aria-label="Mon chat rail">
      <div className="mon-chat-stack"><div className="chat-rail-row">
        <MonLauncher expanded={props.isRailExpanded} mons={props.mons} onToggle={props.onToggleRail} onOpenMon={props.onOpenMon} />
        {props.threads.map((thread) => {
          const isActive = thread.id === props.activeThreadId;
          const isExpanded = props.expandedThreadIds.includes(thread.id);
          const messages = (props.threadEvents[thread.id] ?? []).filter((event) => chatEventTypes.has(event.event_type));
          const isSending = Boolean(props.sending[thread.id]);
          const canSend = isOpenThreadRuntimeState(thread.runtime_state) && !isSending && (props.drafts[thread.id] ?? "").trim().length > 0;
          const isResponding = isExpanded && (isSending || thread.runtime_state === "running");
          const threadMon = props.mons.find((mon) => mon.id === thread.mon_id);
          const title = threadTitle(thread, props.mons);
          const workRootTail = compactPathTail(threadMon?.work_root);
          const harness = threadHarnessMeta(thread, threadMon);
          const mode = threadModeMeta(thread);
          const status = threadStatusMeta(thread);
          const canCloseThread = thread.runtime_state !== "running";
          return (
            <div className="thread-rail-unit" data-expanded={isExpanded} key={thread.id}>
              {!isExpanded ? (
                <div className="mon-thread-pill" data-active={isActive} role="group" aria-label={`${title} chat controls`}>
                  <button className="mon-thread-pill-main" type="button" onClick={() => props.onOpenThread(thread)}>
                    <MonIcon mon={threadMon} label={title} compact tone="cyan" />
                    <span className="mon-thread-title">{title}</span>
                    <span className="mon-thread-meta" aria-label={`${harness.label}, ${status.label}, ${mode.label}`}><MetaChip meta={harness} /><MetaChip meta={status} /><MetaChip meta={mode} /></span>
                    <span className="mon-thread-path" title={threadMon?.work_root ?? undefined}>working in {workRootTail}</span>
                  </button>
                  <button className="mon-thread-close" type="button" onClick={() => props.onCloseThread(thread)} disabled={!canCloseThread} aria-label={`Close ${title} chat`}>x</button>
                </div>
              ) : (
                <section className="mon-chat-widget" aria-label={`${title} chat`}>
                  <header className="mon-chat-widget-header">
                    <button className="mon-chat-header-main" type="button" onClick={() => props.onMinimize(thread)} aria-label={`Minimize ${title} chat`}>
                      <MonIcon mon={threadMon} label={title} compact />
                      <span className="mon-chat-header-copy">
                        <strong className="mon-chat-title">{title}</strong>
                        <span className="mon-chat-meta" aria-label={`${harness.label}, ${status.label}, ${mode.label}`}><MetaChip meta={harness} /><MetaChip meta={status} /><MetaChip meta={mode} /></span>
                        <span className="mon-chat-path" title={threadMon?.work_root ?? undefined}>working in {workRootTail}</span>
                      </span>
                    </button>
                    <div className="mon-chat-widget-actions"><button type="button" onClick={() => props.onCloseThread(thread)} disabled={!canCloseThread} aria-label="Close thread">x</button></div>
                  </header>
                  <div className="mon-chat-messages" ref={(element) => { messageRefs.current[thread.id] = element; }}>
                    {messages.map((event) => (
                      <div className="mon-chat-message" data-author={chatEventAuthor(event)} data-state={event.event_type === "error" ? "failed" : undefined} key={event.id}>
                        <span className="mon-chat-message-body">{chatEventContent(event)}</span>
                        <time className="mon-chat-message-time" dateTime={event.created_at} title={formatChatTimestampTitle(event.created_at)}>{formatChatTimestamp(event.created_at)}</time>
                      </div>
                    ))}
                    {isResponding ? <div className="mon-chat-message mon-chat-typing" data-author="mon" aria-label="Mon is responding"><span /><span /><span /></div> : null}
                    {messages.length === 0 ? <div className="mon-chat-empty">Ask {threadMon ? monDisplayName(threadMon) : monIdDisplayName(thread.mon_id)} something from this Monde.</div> : null}
                  </div>
                  <form className="mon-chat-composer" onSubmit={(event) => props.onSend(thread, event)}>
                    <textarea className="mon-chat-input" value={props.drafts[thread.id] ?? ""} onChange={(event) => props.onChangeDraft(thread.id, event.target.value)} placeholder={`Message ${threadMon ? monDisplayName(threadMon) : monIdDisplayName(thread.mon_id)}...`} disabled={!isOpenThreadRuntimeState(thread.runtime_state)} />
                    <button className="mon-chat-send" type="submit" disabled={!canSend}>{isSending ? "..." : "Send"}</button>
                  </form>
                </section>
              )}
            </div>
          );
        })}
        {props.error ? <span className="mon-chat-rail-error">{props.error}</span> : null}
      </div></div>
    </div>
  );
}

function MonLauncher({ expanded, mons, onToggle, onOpenMon }: { expanded: boolean; mons: MonDto[]; onToggle(): void; onOpenMon(mon: MonDto): void }) {
  return (
    <div className="floating-mon-chat-rail" data-expanded={expanded}>
      {expanded ? (
        <div className="mon-rail-panel">
          <button className="mon-rail-panel-header" type="button" onClick={onToggle} aria-expanded={expanded} aria-controls="mon-rail-list">
            <span className="mon-rail-plus" aria-hidden="true">+</span><span className="mon-rail-copy"><strong>Add new .mon chat</strong><small>Choose a mon below</small></span><span className="mon-rail-caret" aria-hidden="true">v</span>
          </button>
          <div className="mon-rail-list" id="mon-rail-list" role="menu" aria-label="Available mons">
            {mons.map((mon) => <button className="mon-rail-list-item" type="button" role="menuitem" key={mon.id} onClick={() => onOpenMon(mon)}><MonIcon mon={mon} compact /><span className="mon-name">{monDisplayName(mon)}</span><span className="mon-status">Idle</span></button>)}
            {mons.length === 0 ? <p className="mon-rail-empty">No mons are registered in this Monde yet.</p> : null}
          </div>
        </div>
      ) : (
        <button className="mon-rail-toggle" type="button" onClick={onToggle} aria-expanded={expanded} aria-controls="mon-rail-list">
          <span className="mon-rail-plus" aria-hidden="true">+</span><span className="mon-rail-copy"><strong>Add new .mon chat</strong><small>Open the mon launcher</small></span><span className="mon-rail-caret" aria-hidden="true">^</span>
        </button>
      )}
    </div>
  );
}
