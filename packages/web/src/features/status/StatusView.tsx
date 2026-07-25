import type { AdapterInfoDto, BackupInfoDto, DoctorStatusDto, HealthDto, RunDto } from "@monde/core";
import { EvidencePanel } from "../../components/ui";

export function StatusView({ health, adapters, warningRuns, backupInfo, doctorStatus, canRefresh, onRefresh }: {
  health: HealthDto | null;
  adapters: AdapterInfoDto[];
  warningRuns: RunDto[];
  backupInfo: BackupInfoDto | null;
  doctorStatus: DoctorStatusDto | null;
  canRefresh: boolean;
  onRefresh(): void;
}) {
  return (
    <section className="tab-panel">
      <div className="section-head"><div><p className="eyebrow">Doctor / Status</p><h3>Local service and continuity</h3></div><button type="button" onClick={onRefresh} disabled={!canRefresh}>Refresh</button></div>
      <div className="status-grid">
        <EvidencePanel title="Service" content={JSON.stringify(health ?? { state: "checking" }, null, 2)} />
        <EvidencePanel title="Adapters" content={JSON.stringify(adapters, null, 2)} />
        <EvidencePanel title="Warnings" content={warningRuns.length ? warningRuns.map((run) => `${run.id} ${run.warnings?.join(", ")}`).join("\n") : "No run warnings."} />
        <EvidencePanel title="Continuity" content={backupInfo ? [`SQLite DB: ${backupInfo.db_path}`, `Backup directory: ${backupInfo.backup_directory}`, `Latest backup: ${backupInfo.latest_backup ?? "none"}`, backupInfo.continuity_warning, `Future path: ${backupInfo.future_recovery_path}`].join("\n") : health ? `SQLite DB: ${health.db_path}\nSchema: ${health.schema_version ?? "unknown"}\nUse monde backup info/create for local DB copies.` : "Service health is not loaded."} />
        <EvidencePanel title="Doctor" content={doctorStatus?.findings.length ? doctorStatus.findings.map((finding) => `${finding.level.toUpperCase()}\t${finding.message}`).join("\n") : "No service doctor findings loaded."} />
      </div>
    </section>
  );
}
