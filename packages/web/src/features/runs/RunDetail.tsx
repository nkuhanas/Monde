import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ArtifactDetailDto, ArtifactDto, LogEventDto, RunDto, RunEventDto } from "@monde/core";
import { Badge, EmptyState, EvidencePanel } from "../../components/ui";
import { ageLabel, formatDate, tabLabel } from "../../lib/format";
import { isRecord } from "../../lib/guards";
import { monIdDisplayName } from "../../lib/mon";
import {
  hasDiffEvidence,
  outcomeTone,
  renderRunTranscript,
  runAcceptsInput,
  runStateLabel,
  runVisualState,
  statusTone
} from "./runViewModel";

export interface RunDetailProps {
  run: RunDto;
  events: RunEventDto[];
  logs: LogEventDto[];
  artifacts: ArtifactDto[];
  artifactDetails: Record<string, ArtifactDetailDto>;
  scope: Record<string, unknown> | null;
  input: string;
  setInput(value: string): void;
  onSubmitInput(event: FormEvent): void;
  onStart(): void;
  onStop(): void;
  onInterrupt(): void;
  onClose(outcome: string): void;
  onReview(outcome: string): void;
  onRefresh(): void;
  reviewSummary: string;
  setReviewSummary(value: string): void;
  reviewNotes: string;
  setReviewNotes(value: string): void;
  artifactPath: string;
  setArtifactPath(value: string): void;
  artifactTitle: string;
  setArtifactTitle(value: string): void;
  artifactType: string;
  setArtifactType(value: string): void;
  onRegisterArtifact(event: FormEvent): void;
  compact?: boolean;
}

type RunDetailTab = "overview" | "output" | "changes" | "evidence" | "configuration";
const detailTabs: RunDetailTab[] = ["overview", "output", "changes", "evidence", "configuration"];

export function RunDetail(props: RunDetailProps) {
  const { run } = props;
  const acceptsInput = runAcceptsInput(run);
  const reviewed = typeof run.result?.reviewed_at === "string";
  const processUnknown = run.status === "finished" && run.outcome === "unknown";
  const [activeDetailTab, setActiveDetailTab] = useState<RunDetailTab>("overview");

  useEffect(() => setActiveDetailTab("overview"), [run.id]);

  return (
    <div className={props.compact ? "run-review run-review-compact" : "run-review"}>
      <div className="run-detail-sticky">
        <div className="run-detail-inner">
          <header className="review-head">
            <div className="review-title">
              <div className="review-title-kicker">
                <span className={`run-state-label run-state-label-${runVisualState(run)}`}>{runStateLabel(run)}</span>
                <span aria-hidden="true">·</span>
                <span>{monIdDisplayName(run.mon_id)}</span>
                <span aria-hidden="true">·</span>
                <span>{ageLabel(run.started_at ?? run.created_at)}</span>
              </div>
              <h3 title={run.intent.title}>{run.intent.title}</h3>
              <span className="run-id" title={run.id}>{run.id}</span>
            </div>
            <div className="review-actions">
              {run.status === "queued" ? <button className="run-primary-action" onClick={props.onStart}>Start</button> : null}
              {run.status === "active" || run.status === "starting" ? (
                <>
                  <button onClick={props.onInterrupt}>Interrupt</button>
                  <button onClick={props.onStop}>Stop</button>
                </>
              ) : null}
              <button onClick={props.onRefresh}>Refresh</button>
            </div>
          </header>

          <div className="run-summary-strip">
            <Badge>{run.interaction_mode === "hitl_thread" ? "Thread" : "One-shot"}</Badge>
            <Badge>{threadRuntimeLabel(run.runtime_state)}</Badge>
            {run.outcome !== "unknown" ? <Badge tone={outcomeTone(run.outcome)}>{run.outcome}</Badge> : null}
            <Badge>{String(run.execution?.runner_type ?? run.execution?.runner ?? "runner unknown")}</Badge>
            <Badge tone={run.execution?.can_write === true ? "amber" : "default"}>{run.execution?.can_write === true ? "write enabled" : "read only"}</Badge>
            {run.warnings?.length ? <Badge tone="red">{run.warnings.length} warning{run.warnings.length === 1 ? "" : "s"}</Badge> : null}
          </div>

          <nav className="run-detail-tabs" aria-label="Run detail sections">
            {detailTabs.map((detailTab) => (
              <button
                className={activeDetailTab === detailTab ? "run-detail-tab run-detail-tab-active" : "run-detail-tab"}
                type="button"
                key={detailTab}
                onClick={() => setActiveDetailTab(detailTab)}
              >
                {tabLabel(detailTab)}
                {detailTab === "evidence" && (props.artifacts.length || props.logs.length) ? <span>{props.artifacts.length + props.logs.length}</span> : null}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div className="run-detail-content" data-detail-tab={activeDetailTab}>
        <div className="run-detail-inner">
          {activeDetailTab === "overview" ? (
            <OverviewTab props={props} reviewed={reviewed} processUnknown={processUnknown} />
          ) : null}
          {activeDetailTab === "output" ? <OutputTab props={props} acceptsInput={acceptsInput} /> : null}
          {activeDetailTab === "changes" ? <ChangesTab run={run} artifacts={props.artifacts} artifactDetails={props.artifactDetails} /> : null}
          {activeDetailTab === "evidence" ? <EvidenceTab props={props} /> : null}
          {activeDetailTab === "configuration" ? <ConfigurationTab props={props} acceptsInput={acceptsInput} /> : null}
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ props, reviewed, processUnknown }: { props: RunDetailProps; reviewed: boolean; processUnknown: boolean }) {
  const { run } = props;
  return (
    <section className="run-detail-page run-overview-page">
      <div className="run-overview">
        <div className="run-overview-main">
          {run.status === "finished" && !reviewed ? (
            <section className="review-decision operator-review">
              <div className="review-decision-copy">
                <p className="eyebrow">Operator review</p>
                <h4>{processUnknown ? "This run needs an outcome" : "Confirm this run's outcome"}</h4>
                <p>{processUnknown ? "The process exited, but its semantic result has not been reviewed." : `The recorded outcome is ${run.outcome}.`}</p>
              </div>
              <div className="review-decision-fields">
                <label>
                  <span>Outcome summary</span>
                  <input value={props.reviewSummary} onChange={(event) => props.setReviewSummary(event.target.value)} placeholder="Optional summary" />
                </label>
                <label>
                  <span>Review notes</span>
                  <textarea value={props.reviewNotes} onChange={(event) => props.setReviewNotes(event.target.value)} placeholder="Optional notes" />
                </label>
              </div>
              <div className="review-form-actions">
                <div className="review-secondary-actions">
                  <button className="run-failure-action" type="button" onClick={() => props.onReview("failed")}>Mark failed</button>
                  <button type="button" onClick={() => props.onReview("stopped")}>Mark stopped</button>
                </div>
                <button className="run-primary-action" type="button" onClick={() => props.onReview("completed")}>Approve completed</button>
              </div>
            </section>
          ) : reviewed ? (
            <div className="review-notice review-notice-reviewed">
              Reviewed by {String(run.result?.reviewed_by ?? "operator")} at {formatDate(String(run.result?.reviewed_at))}.
            </div>
          ) : null}

          <section className="intent-summary requested-work">
            <div className="section-head compact-head">
              <div><p className="eyebrow">Requested work</p><h4>{run.intent.title}</h4></div>
              <Badge>{String(run.origin.type)}</Badge>
            </div>
            <pre className="requested-work-body">{run.intent.prompt}</pre>
          </section>

          {run.result && Object.keys(run.result).length ? (
            <div className="result-summary">
              <span className="eyebrow">Recorded result</span>
              <strong>{String(run.result.summary ?? "No summary recorded.")}</strong>
              {run.result.notes ? <p>{String(run.result.notes)}</p> : null}
            </div>
          ) : null}
          {run.warnings?.length ? <div className="run-warning-list"><strong>Warnings</strong>{run.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
        </div>

        <aside className="run-context" aria-label="Run context">
          <p className="eyebrow">Run context</p>
          <OverviewStat label="Current state" value={threadRuntimeLabel(run.runtime_state)} detail={`${run.process_status} process`} />
          <OverviewStat label="Outcome" value={run.outcome_state === "unknown" ? run.outcome : run.outcome_state} detail={run.close_reason ?? "No close reason"} />
          <OverviewStat label="Evidence" value={`${props.artifacts.length} artifacts`} detail={`${props.logs.length} log events`} />
          <OverviewStat label="Execution" value={String(run.execution?.runner_type ?? run.execution?.runner ?? "Unknown runner")} detail={run.execution?.can_write === true ? "Write enabled" : "Read only"} />
        </aside>
      </div>
    </section>
  );
}

function OverviewStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="run-context-section"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function OutputTab({ props, acceptsInput }: { props: RunDetailProps; acceptsInput: boolean }) {
  const { run } = props;
  return (
    <section className="run-detail-page">
      <div className="terminal-shell"><div className="terminal-title">Run terminal / output</div><TerminalPane events={props.events} /></div>
      <form className="input-row" onSubmit={props.onSubmitInput}>
        <input
          disabled={run.status !== "active" || !acceptsInput}
          value={props.input}
          onChange={(event) => props.setInput(event.target.value)}
          placeholder={run.status === "active" ? (acceptsInput ? "Send input to active run" : "Harness does not accept stdin turns") : "Run is not active"}
        />
        <button className="run-primary-action" disabled={run.status !== "active" || !acceptsInput || !props.input} type="submit">Send</button>
      </form>
      {run.status === "active" && !acceptsInput ? <div className="input-disabled-note">Input is disabled because this run is {String(run.execution?.interaction_mode ?? "single-shot")} with input_mode={String(run.execution?.input_mode ?? "closed")}.</div> : null}
    </section>
  );
}

function ChangesTab({ run, artifacts, artifactDetails }: { run: RunDto; artifacts: ArtifactDto[]; artifactDetails: Record<string, ArtifactDetailDto> }) {
  return (
    <section className="run-detail-page">
      <DiffReviewSurface run={run} artifacts={artifacts} artifactDetails={artifactDetails} />
      {!hasDiffEvidence(run, artifacts) ? <EmptyState title="No captured changes" body={run.execution?.can_write === true ? "This write-capable run has no diff evidence yet." : "This run was read-only and has no file changes."} /> : null}
    </section>
  );
}

function EvidenceTab({ props }: { props: RunDetailProps }) {
  const { run } = props;
  return (
    <section className="run-detail-page">
      <div className="evidence-grid">
        <EvidencePanel title={`Artifacts (${props.artifacts.length})`} content={props.artifacts.length ? props.artifacts.map((artifact) => `${artifact.type} · ${artifact.path_status}\n${artifact.title}\n${artifact.path ?? "no path"}`).join("\n\n") : "No artifacts."} />
        <EvidencePanel title={`Logs (${props.logs.length})`} content={props.logs.length ? props.logs.map((log) => `${log.created_at} ${log.event_type} ${JSON.stringify(log.payload)}`).join("\n") : "No logs."} />
        <EvidencePanel title="Warnings" content={run.warnings?.length ? run.warnings.join("\n") : "No warnings."} />
        <EvidencePanel title="Result" content={JSON.stringify(run.result ?? {}, null, 2)} />
      </div>
      <details className="artifact-register-panel">
        <summary>Add artifact</summary>
        <form className="artifact-create" onSubmit={props.onRegisterArtifact}>
          <select value={props.artifactType} onChange={(event) => props.setArtifactType(event.target.value)}>
            {["file", "note", "diff", "report", "schema", "test_suite", "screenshot", "generated_asset", "prompt_pack", "other"].map((type) => <option value={type} key={type}>{type}</option>)}
          </select>
          <input value={props.artifactPath} onChange={(event) => props.setArtifactPath(event.target.value)} placeholder="Artifact path" />
          <input value={props.artifactTitle} onChange={(event) => props.setArtifactTitle(event.target.value)} placeholder="Artifact title" />
          <button type="submit">Register artifact</button>
        </form>
      </details>
    </section>
  );
}

function ConfigurationTab({ props, acceptsInput }: { props: RunDetailProps; acceptsInput: boolean }) {
  const { run } = props;
  return (
    <section className="run-detail-page">
      <div className="review-state">
        <MetadataGroup title="Run Kind">
          <Badge>{run.interaction_mode === "hitl_thread" ? "HITL Thread" : "One-shot"}</Badge>
          <Badge>{threadRuntimeLabel(run.runtime_state)}</Badge>
          <Badge tone={run.outcome_state === "succeeded" ? "green" : run.outcome_state === "failed" ? "red" : "default"}>{run.outcome_state}</Badge>
          {run.close_reason ? <Badge>{run.close_reason}</Badge> : null}
        </MetadataGroup>
        <MetadataGroup title="Lifecycle"><Badge tone={statusTone(run.status)}>{run.status}</Badge><Badge>{run.process_status}</Badge><Badge tone={outcomeTone(run.outcome)}>{run.outcome}</Badge></MetadataGroup>
        <MetadataGroup title="Harness">
          <Badge>{String(run.execution?.runner_type ?? run.execution?.runner ?? "runner unknown")}</Badge>
          <Badge>{String(run.execution?.interaction_mode ?? (acceptsInput ? "interactive" : "single-shot"))}</Badge>
          <Badge tone={acceptsInput ? "green" : "default"}>input {String(run.execution?.input_mode ?? (acceptsInput ? "open" : "closed"))}</Badge>
          <Badge>{String(run.execution?.output_mode ?? "output unknown")}</Badge>
        </MetadataGroup>
        <MetadataGroup title="Write & approvals">
          <Badge tone={run.execution?.can_write === true ? "amber" : "default"}>{run.execution?.can_write === true ? "write enabled" : "no write"}</Badge>
          <Badge>{String(run.execution?.write_scope ?? "none")}</Badge><Badge>sandbox {String(run.execution?.sandbox_mode ?? "unknown")}</Badge><Badge>approval {String(run.execution?.approval_mode ?? "unknown")}</Badge>
        </MetadataGroup>
      </div>
      <details className="intent-panel" open>
        <summary>Origin and identity</summary>
        <div className="origin-grid">
          <span>run</span><strong>{run.id}</strong><span>mon</span><strong>{monIdDisplayName(run.mon_id)}</strong>
          {Object.entries(run.origin).map(([key, value]) => <div className="origin-row" key={key}><span>origin.{key}</span><strong>{String(value)}</strong></div>)}
        </div>
      </details>
      <EvidencePanel title="Runtime scope" content={JSON.stringify(props.scope ?? run.scope_snapshot ?? {}, null, 2)} collapsible />
    </section>
  );
}

function MetadataGroup({ title, children }: { title: string; children: ReactNode }) {
  return <div className="metadata-group"><span>{title}</span><div>{children}</div></div>;
}

function DiffReviewSurface({ run, artifacts, artifactDetails }: { run: RunDto; artifacts: ArtifactDto[]; artifactDetails: Record<string, ArtifactDetailDto> }) {
  const diffCapture = isRecord(run.execution?.diff_capture) ? run.execution.diff_capture : {};
  const changedFiles = Array.isArray(diffCapture.changed_files) ? diffCapture.changed_files.map(String) : [];
  const diffStat = typeof diffCapture.diff_stat === "string" ? diffCapture.diff_stat.trim() : "";
  const diffArtifacts = artifacts.filter((artifact) => artifact.type === "diff");
  const changedFileArtifacts = artifacts.filter((artifact) => artifact.type === "file" && changedFiles.includes(artifact.title));
  const primaryDiff = diffArtifacts.map((artifact) => artifactDetails[artifact.id]).find((artifact) => artifact?.content_excerpt?.trim());
  if (!diffArtifacts.length && !changedFiles.length && !diffStat) return null;

  return (
    <section className="diff-review">
      <div className="section-head compact-head"><div><p className="eyebrow">Write Evidence</p><h4>Run diff summary</h4></div><Badge tone={diffCapture.diff_truncated === true ? "amber" : "green"}>{diffCapture.diff_truncated === true ? "bounded excerpt" : "captured"}</Badge></div>
      {diffStat ? <pre className="diff-stat">{diffStat}</pre> : null}
      {changedFiles.length ? <div className="changed-files">{changedFiles.map((file) => {
        const artifact = changedFileArtifacts.find((candidate) => candidate.title === file);
        return <div className="changed-file" key={file}><span>{file}</span><Badge tone={artifact?.path_status === "exists" ? "green" : artifact?.path_status === "missing" ? "amber" : "default"}>{artifact?.path_status ?? "not registered"}</Badge></div>;
      })}</div> : null}
      <div className="diff-artifacts">{diffArtifacts.map((artifact) => <div className="diff-artifact" key={artifact.id}><strong>{artifact.title}</strong><span>{artifact.id} · {artifact.path_status}</span><small>{artifact.path ?? "no path"}</small></div>)}</div>
      {primaryDiff?.content_excerpt ? <details className="evidence-panel diff-excerpt" open><summary>{primaryDiff.title}{primaryDiff.content_truncated ? " (truncated)" : ""}</summary><pre>{primaryDiff.content_excerpt}</pre></details> : null}
    </section>
  );
}

function TerminalPane({ events }: { events: RunEventDto[] }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const transcript = useMemo(() => renderRunTranscript(events), [events]);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: "#16191f", foreground: "#d8dee9" }
    });
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    return () => { terminal.dispose(); terminalRef.current = null; };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    terminal.write(transcript || "No output yet.");
  }, [transcript]);

  return <><div className="xterm-host" ref={hostRef} /><pre className="terminal-fallback">{transcript || "No output yet."}</pre></>;
}

function threadRuntimeLabel(runtimeState: string): string {
  if (runtimeState === "waiting_for_user") return "waiting for you";
  if (runtimeState === "running") return "responding";
  return runtimeState.replaceAll("_", " ");
}
