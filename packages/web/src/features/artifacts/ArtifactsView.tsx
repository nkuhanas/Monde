import type { ArtifactDto } from "@monde/core";
import { Badge, EmptyState } from "../../components/ui";

export function ArtifactsView({ artifacts, onOpenRun }: { artifacts: ArtifactDto[]; onOpenRun(runId: string): void }) {
  return (
    <section className="tab-panel">
      <div className="section-head"><div><p className="eyebrow">Artifacts</p><h3>Evidence registered by runs</h3></div><span className="subtle-count">{artifacts.length} artifact(s)</span></div>
      <div className="artifact-list">
        {artifacts.map((artifact) => (
          <article className="artifact-row" key={artifact.id}>
            <Badge tone={artifact.path_status === "exists" ? "green" : artifact.path_status === "missing" ? "amber" : "default"}>{artifact.path_status}</Badge>
            <div><strong>{artifact.title}</strong><span>{artifact.id} · {artifact.type} · {artifact.run_id ?? "unknown run"}</span><small>{artifact.path ?? "no path"}</small></div>
            {artifact.run_id ? <button type="button" onClick={() => onOpenRun(artifact.run_id!)}>Open run</button> : null}
          </article>
        ))}
        {artifacts.length === 0 ? <EmptyState title="No artifacts" body="Registered run artifacts will appear here." /> : null}
      </div>
    </section>
  );
}
