import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  AdapterInfoDto,
  ArtifactDetailDto,
  ArtifactDto,
  BackupInfoDto,
  DoctorStatusDto,
  HealthDto,
  LogEventDto,
  MonDto,
  MondeDto,
  PlanDto,
  PlanEvidenceDto,
  RunDto,
  RunEventDto
} from "@monde/core";
import { deriveAttentionRuns, type AttentionItem } from "./attention";

type Health = HealthDto;
type Monde = MondeDto;
type Mon = MonDto;
type Run = RunDto;
type Plan = PlanDto;
type RunEvent = RunEventDto;
type LogEvent = LogEventDto;
type Artifact = ArtifactDto;
type ArtifactDetail = ArtifactDetailDto;
type PlanEvidence = PlanEvidenceDto;
type AdapterInfo = AdapterInfoDto;

const storedTokenKey = "monde.serviceToken";
const runStatuses = ["all", "active", "queued", "finished"] as const;
const tabs = ["overview", "runs", "mons", "plans", "artifacts", "status", "review"] as const;
type ActiveTab = (typeof tabs)[number];
type SectorTab = Exclude<ActiveTab, "overview">;
type SectorTone = "blue" | "green" | "purple" | "cyan" | "pink" | "mint";
type IconName = SectorTab | "machine" | "monde";
type ChipTone = "green" | "blue" | "amber" | "red" | "neutral";
type ChipMeta = { label: string; tone: ChipTone };

type ConfirmationRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm(): void | Promise<void>;
};

type SidebarMachine = {
  id: string;
  displayName: string;
  online: boolean;
  mondes: Monde[];
};

const sidebarMachineTemplates = [
  { id: "cli-machine", displayName: "CLI Machine" },
  { id: "ui-demo-machine", displayName: "UI Demo Machine" },
  { id: "nightstand-machine", displayName: "Nightstand Machine" }
] as const;

type SectorCardModel = {
  id: SectorTab;
  title: string;
  description: string;
  metricLabel?: string;
  metricValue?: number | string;
  icon: ReactNode;
  tone: SectorTone;
};

const WORLD_OVERVIEW_IMAGE = "/placeholders/monde-world-overview.webp";
const BRAND_ICON_LOGO = "/brand/icon_logo_v1.png";
const MASCOT_LOGO = "/brand/mascot_logo_v3.png";
const MASCOT_LARGE_LOGO = "/brand/mascot_large_logo_v1.png";
const chatEventTypes = new Set(["user_message", "mon_message", "system_message", "error"]);

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [token, setToken] = useState(() => new URLSearchParams(window.location.search).get("token") ?? localStorage.getItem(storedTokenKey) ?? "");
  const [mondes, setMondes] = useState<Monde[]>([]);
  const [selectedMondeId, setSelectedMondeId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");
  const [mons, setMons] = useState<Mon[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [threads, setThreads] = useState<Run[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadEvents, setThreadEvents] = useState<Record<string, RunEvent[]>>({});
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [monRailExpanded, setMonRailExpanded] = useState(false);
  const [openMonActionMenu, setOpenMonActionMenu] = useState<string | null>(null);
  const [expandedThreadIds, setExpandedThreadIds] = useState<string[]>([]);
  const [threadSendingIds, setThreadSendingIds] = useState<Record<string, boolean>>({});
  const [threadError, setThreadError] = useState<string | null>(null);
  const [artifactDetails, setArtifactDetails] = useState<Record<string, ArtifactDetail>>({});
  const [allArtifacts, setAllArtifacts] = useState<Artifact[]>([]);
  const [planEvidence, setPlanEvidence] = useState<Record<string, PlanEvidence>>({});
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [backupInfo, setBackupInfo] = useState<BackupInfoDto | null>(null);
  const [doctorStatus, setDoctorStatus] = useState<DoctorStatusDto | null>(null);
  const [scope, setScope] = useState<Record<string, unknown> | null>(null);
  const [input, setInput] = useState("");
  const [reviewSummary, setReviewSummary] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [monPrompt, setMonPrompt] = useState("echo hello from Monde");
  const [statusFilter, setStatusFilter] = useState<(typeof runStatuses)[number]>("all");
  const [originFilter, setOriginFilter] = useState("all");
  const [monFilter, setMonFilter] = useState("all");
  const [planTitle, setPlanTitle] = useState("Improve Monde operator console");
  const [planPrompt, setPlanPrompt] = useState("Review the operator console and record one useful improvement.");
  const [planMon, setPlanMon] = useState("");
  const [artifactPath, setArtifactPath] = useState("");
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactType, setArtifactType] = useState("file");
  const [collapsedMachines, setCollapsedMachines] = useState<Record<string, boolean>>({});
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentMonde = useMemo(
    () => mondes.find((monde) => monde.id === selectedMondeId) ?? mondes[0],
    [mondes, selectedMondeId]
  );
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? runs[0], [runs, selectedRunId]);
  const expandedThreads = useMemo(
    () => threads.filter((thread) => expandedThreadIds.includes(thread.id)),
    [expandedThreadIds, threads]
  );
  const originTypes = useMemo(() => Array.from(new Set(runs.map((run) => String(run.origin.type)))).sort(), [runs]);
  const filteredRuns = useMemo(
    () =>
      runs.filter((run) => {
        if (statusFilter !== "all" && run.status !== statusFilter) return false;
        if (originFilter !== "all" && String(run.origin.type) !== originFilter) return false;
        if (monFilter !== "all" && run.mon_id !== monFilter) return false;
        return true;
      }),
    [runs, statusFilter, originFilter, monFilter]
  );
  const activeRuns = runs.filter((run) => run.status === "active" || run.status === "starting");
  const queuedRuns = runs.filter((run) => run.status === "queued");
  const finishedRuns = runs.filter((run) => run.status === "finished");
  const warningRuns = runs.filter((run) => run.warnings?.length);
  const attentionItems = useMemo(() => deriveAttentionRuns(runs), [runs]);
  const pendingReviews = runs.filter((run) => run.status === "finished" && run.outcome === "unknown").length;
  const healthLabel = health?.ok ? "Healthy" : health ? "Needs attention" : "Checking";
  // TODO: replace this deterministic presentation grouping when the service exposes machine inventory.
  const machineGroups = useMemo<SidebarMachine[]>(
    () => {
      const groups = new Map<string, SidebarMachine>(
        sidebarMachineTemplates.map((machine) => [
          machine.id,
          {
            id: machine.id,
            displayName: machine.displayName,
            online: health?.ok ?? false,
            mondes: []
          }
        ])
      );

      for (const monde of mondes) {
        const machineId = sidebarMachineIdForMonde(monde);
        const group = groups.get(machineId) ?? groups.get("nightstand-machine");
        group?.mondes.push(monde);
      }

      return sidebarMachineTemplates.map((machine) => groups.get(machine.id)).filter((machine): machine is SidebarMachine => Boolean(machine));
    },
    [health?.ok, mondes]
  );
  const sectorCards = useMemo<SectorCardModel[]>(
    () => [
      {
        id: "runs",
        title: "Runs",
        description: "Execute and orchestrate workflows.",
        metricValue: activeRuns.length,
        metricLabel: "active",
        icon: <UiIcon name="runs" />,
        tone: "blue"
      },
      {
        id: "plans",
        title: "Plans",
        description: "Design and schedule your workflows.",
        metricValue: plans.length,
        metricLabel: "plans",
        icon: <UiIcon name="plans" />,
        tone: "green"
      },
      {
        id: "artifacts",
        title: "Artifacts",
        description: "Store and manage artifacts, items, and history.",
        metricValue: allArtifacts.length,
        metricLabel: "items",
        icon: <UiIcon name="artifacts" />,
        tone: "purple"
      },
      {
        id: "status",
        title: "Status",
        description: "Monitor system health and performance.",
        metricValue: healthLabel,
        metricLabel: health?.ok ? "all good" : "service",
        icon: <UiIcon name="status" />,
        tone: "cyan"
      },
      {
        id: "review",
        title: "Review",
        description: "Evaluate results and improve continuously.",
        metricValue: pendingReviews,
        metricLabel: "pending",
        icon: <UiIcon name="review" />,
        tone: "pink"
      },
      {
        id: "mons",
        title: "Mons",
        description: "Your local actors and harness identities.",
        metricValue: mons.length,
        metricLabel: "mons",
        icon: <UiIcon name="mons" />,
        tone: "mint"
      }
    ],
    [activeRuns.length, allArtifacts.length, health?.ok, healthLabel, mons.length, pendingReviews, plans.length]
  );

  useEffect(() => {
    fetch("/api/health")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as Health;
      })
      .then(setHealth)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, []);

  useEffect(() => {
    if (!openMonActionMenu) return;

    function closeOnOutsidePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest(".mon-action-menu")) {
        return;
      }

      setOpenMonActionMenu(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMonActionMenu(null);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMonActionMenu]);

  useEffect(() => {
    if (token) {
      localStorage.setItem(storedTokenKey, token);
      void refreshAll();
    }
  }, [token, selectedMondeId]);

  useEffect(() => {
    if (!selectedRun || !token) {
      setEvents([]);
      setLogs([]);
      setArtifacts([]);
      setScope(null);
      return;
    }

    setSelectedRunId(selectedRun.id);
    void refreshRunSurfaces(selectedRun.id);

    if (selectedRun.status === "active" || selectedRun.status === "starting") {
      const source = new EventSource(`/api/runs/${selectedRun.id}/events?token=${encodeURIComponent(token)}`);
      for (const eventName of [
        "run_started",
        "run_input",
        "run_output",
        "run_error_output",
        "warning_added",
        "run_process_exit",
        "run_finished"
      ]) {
        source.addEventListener(eventName, (event) => appendEvent(JSON.parse((event as MessageEvent).data) as RunEvent));
      }
      source.addEventListener("run_finished", () => {
        source.close();
        void refreshAll();
      });
      source.onerror = () => source.close();
      return () => source.close();
    }
  }, [selectedRun?.id, selectedRun?.status, token]);

  useEffect(() => {
    setReviewSummary(typeof selectedRun?.result?.summary === "string" ? selectedRun.result.summary : "");
    setReviewNotes(typeof selectedRun?.result?.notes === "string" ? selectedRun.result.notes : "");
  }, [selectedRun?.id]);

  useEffect(() => {
    if (activeThreadId && !threads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(null);
    }

    const threadIds = new Set(threads.map((thread) => thread.id));
    setExpandedThreadIds((current) => current.filter((threadId) => threadIds.has(threadId)));
  }, [activeThreadId, threads]);

  useEffect(() => {
    if (!token) {
      return;
    }

    for (const thread of expandedThreads) {
      if (!isDraftThreadRun(thread)) {
        void refreshThreadEvents(thread.id);
      }
    }
  }, [expandedThreads, token]);

  useEffect(() => {
    const pollableThreads = expandedThreads.filter((thread) => !isDraftThreadRun(thread));
    if (pollableThreads.length === 0 || !token || !currentMonde) {
      return;
    }

    let cancelled = false;
    const refreshExpandedThreads = async () => {
      try {
        await Promise.all([
          ...pollableThreads.map((thread) => refreshThreadEvents(thread.id)),
          refreshThreads(currentMonde.id)
        ]);
      } catch (caught) {
        if (!cancelled) {
          setThreadError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    };

    const interval = window.setInterval(() => {
      void refreshExpandedThreads();
    }, pollableThreads.some((thread) => thread.runtime_state === "running") ? 1500 : 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [expandedThreads, currentMonde?.id, token]);

  async function refreshAll() {
    if (!token) return;
    try {
      const mondeResponse = await authFetch<{ mondes: Monde[] }>("/api/mondes");
      const monde = mondeResponse.mondes.find((candidate) => candidate.id === selectedMondeId) ?? mondeResponse.mondes[0];
      if (monde && monde.id !== selectedMondeId) {
        setSelectedMondeId(monde.id);
      }
      const [monResponse, runResponse, planResponse, artifactResponse, threadResponse, adapterResponse, backupResponse, doctorResponse] = await Promise.all([
        authFetch<{ mons: Mon[] }>(monde ? `/api/mons?monde_id=${encodeURIComponent(monde.id)}` : "/api/mons"),
        authFetch<{ runs: Run[] }>(monde ? `/api/runs?monde_id=${encodeURIComponent(monde.id)}` : "/api/runs"),
        authFetch<{ plans: Plan[] }>(monde ? `/api/plans?monde_id=${encodeURIComponent(monde.id)}` : "/api/plans"),
        authFetch<{ artifacts: Artifact[] }>(monde ? `/api/artifacts?monde_id=${encodeURIComponent(monde.id)}` : "/api/artifacts"),
        monde
          ? authFetch<{ threads: Run[] }>(`/api/mondes/${encodeURIComponent(monde.id)}/threads?runtime_state=open`).catch(() => ({ threads: [] }))
          : Promise.resolve({ threads: [] }),
        authFetch<{ adapters: AdapterInfo[] }>("/api/adapters").catch(() => ({ adapters: [] })),
        authFetch<{ backup: BackupInfoDto | null }>("/api/backup/info").catch(() => ({ backup: null })),
        authFetch<DoctorStatusDto>("/api/doctor").catch(() => ({ findings: [] }))
      ]);
      setMondes(mondeResponse.mondes);
      setMons(monResponse.mons);
      setRuns(runResponse.runs);
      setPlans(planResponse.plans);
      setAllArtifacts(artifactResponse.artifacts);
      setThreads((current) => mergeServerAndDraftThreads(threadResponse.threads, current));
      setAdapters(adapterResponse.adapters);
      setBackupInfo(backupResponse.backup);
      setDoctorStatus(doctorResponse);
      const evidenceEntries = await Promise.all(
        planResponse.plans.map(async (plan) => {
          try {
            const response = await authFetch<{ evidence: PlanEvidence }>(`/api/plans/${plan.id}/evidence`);
            return [plan.id, response.evidence] as const;
          } catch {
            return [plan.id, null] as const;
          }
        })
      );
      setPlanEvidence(
        Object.fromEntries(evidenceEntries.filter((entry): entry is readonly [string, PlanEvidence] => entry[1] !== null))
      );
      if (!planMon && monResponse.mons[0]) setPlanMon(monResponse.mons[0].id);
      if (!selectedRunId && runResponse.runs[0]) setSelectedRunId(runResponse.runs[0].id);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function refreshRunSurfaces(runId: string) {
    const [history, logResponse, artifactResponse, scopeResponse] = await Promise.all([
      authFetch<{ events: RunEvent[] }>(`/api/runs/${runId}/events/history`),
      authFetch<{ logs: LogEvent[] }>(`/api/logs?run_id=${encodeURIComponent(runId)}`),
      authFetch<{ artifacts: Artifact[] }>(`/api/artifacts?run_id=${encodeURIComponent(runId)}`),
      authFetch<Record<string, unknown>>(`/api/tools/runtime_scope`, {
        method: "POST",
        body: JSON.stringify({ run_id: runId })
      }).catch(() => null)
    ]);
    setEvents(history.events);
    setLogs(logResponse.logs);
    setArtifacts(artifactResponse.artifacts);
    setScope(scopeResponse);
    const detailEntries = await Promise.all(
      artifactResponse.artifacts.map(async (artifact) => {
        try {
          const response = await authFetch<
            { artifact: ArtifactDetail; content_available?: boolean; content_excerpt?: string; content_truncated?: boolean; size?: number }
          >(`/api/artifacts/${artifact.id}`);
          return [
            artifact.id,
            {
              ...response.artifact,
              content_available: response.content_available,
              content_excerpt: response.content_excerpt,
              content_truncated: response.content_truncated,
              size: response.size
            }
          ] as const;
        } catch {
          return [artifact.id, artifact] as const;
        }
      })
    );
    setArtifactDetails(Object.fromEntries(detailEntries));
  }

  async function refreshThreads(mondeId = currentMonde?.id): Promise<Run[]> {
    if (!token || !mondeId) return [];
    const response = await authFetch<{ threads: Run[] }>(`/api/mondes/${encodeURIComponent(mondeId)}/threads?runtime_state=open`);
    setThreads((current) => mergeServerAndDraftThreads(response.threads, current));
    return response.threads;
  }

  async function refreshThreadEvents(threadId: string): Promise<RunEvent[]> {
    const response = await authFetch<{ events: RunEvent[] }>(`/api/runs/${encodeURIComponent(threadId)}/events/history`);
    setThreadEvents((current) => ({ ...current, [threadId]: response.events }));
    return response.events;
  }

  async function authFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...init, headers });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
    return payload as T;
  }

  function appendEvent(event: RunEvent) {
    setEvents((current) => (current.some((existing) => existing.id === event.id) ? current : [...current, event]));
  }

  function selectMonde(mondeId: string) {
    setSelectedMondeId(mondeId);
    setSelectedRunId(null);
  }

  function toggleMachine(machineId: string) {
    setCollapsedMachines((current) => ({ ...current, [machineId]: !current[machineId] }));
  }

  async function startRun(run: Run) {
    await authFetch(`/api/runs/${run.id}/start`, { method: "POST" });
    setSelectedRunId(run.id);
    setActiveTab("review");
    await refreshAll();
  }

  async function stopRun(run: Run) {
    await authFetch(`/api/runs/${run.id}/close`, { method: "POST", body: JSON.stringify({ outcome: "stopped" }) });
    await refreshAll();
  }

  async function interruptRun(run: Run) {
    await authFetch(`/api/runs/${run.id}/interrupt`, { method: "POST" });
    await refreshRunSurfaces(run.id);
  }

  async function closeRun(run: Run, outcome: string) {
    await authFetch(`/api/runs/${run.id}/close`, { method: "POST", body: JSON.stringify({ outcome }) });
    await refreshAll();
  }

  async function reviewRun(run: Run, outcome: string) {
    await authFetch(`/api/runs/${run.id}/review`, {
      method: "POST",
      body: JSON.stringify({
        outcome,
        summary: reviewSummary || undefined,
        notes: reviewNotes || undefined
      })
    });
    await refreshAll();
  }

  async function sendInput(event: FormEvent) {
    event.preventDefault();
    if (!selectedRun || !input) return;
    await authFetch(`/api/runs/${selectedRun.id}/input`, { method: "POST", body: JSON.stringify({ input: `${input}\n` }) });
    setInput("");
  }

  async function messageMon(mon: Mon) {
    if (!monPrompt) return;
    const response = await authFetch<{ run: Run }>("/api/runs/operator", {
      method: "POST",
      body: JSON.stringify({
        monde_id: mon.monde_id,
        mon_id: mon.id,
        title: monPrompt.slice(0, 80),
        prompt: monPrompt
      })
    });
    setSelectedRunId(response.run.id);
    setActiveTab("review");
    await refreshAll();
  }

  async function wakeMon(mon: Mon) {
    const monRuns = runs.filter((run) => run.mon_id === mon.id);
    const active = monRuns.find((run) => run.status === "active" || run.status === "starting");
    if (active) {
      setSelectedRunId(active.id);
      setActiveTab("review");
      return;
    }

    const queued = monRuns.filter((run) => run.status === "queued").sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (queued) {
      await startRun(queued);
      return;
    }

    const response = await authFetch<{ run: Run }>("/api/runs/operator", {
      method: "POST",
      body: JSON.stringify({
        monde_id: mon.monde_id,
        mon_id: mon.id,
        title: "Manual wake",
        prompt: "exec /bin/sh"
      })
    });
    setSelectedRunId(response.run.id);
    setActiveTab("review");
    await refreshAll();
  }

  async function updateMon(mon: Mon, patch: Partial<Mon>): Promise<Mon | undefined> {
    try {
      const response = await authFetch<{ mon: Mon }>(`/api/mons/${encodeURIComponent(mon.monde_id)}/${encodeURIComponent(mon.id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      setMons((current) => current.map((candidate) => (candidate.id === mon.id && candidate.monde_id === mon.monde_id ? response.mon : candidate)));
      await refreshAll();
      return response.mon;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    }
  }

  async function changeMonHarness(mon: Mon): Promise<void> {
    const knownHarnesses = adapters.map((adapter) => adapter.id).filter(Boolean);
    const promptSuffix = knownHarnesses.length ? ` Known: ${knownHarnesses.join(", ")}` : "";
    const next = window.prompt(`Target harness for ${monDisplayName(mon)}.${promptSuffix}`, mon.default_harness ?? "basic-process");
    if (next === null) return;

    await updateMon(mon, { default_harness: next.trim() || null });
  }

  async function moveMonWorkRoot(mon: Mon): Promise<void> {
    const current = mon.configured_work_root ?? mon.work_root;
    const next = window.prompt(`Work root for ${monDisplayName(mon)}`, current);
    if (next === null || !next.trim()) return;

    await updateMon(mon, { work_root: next.trim() });
  }

  async function editMonPermissions(mon: Mon): Promise<void> {
    const harness = window.prompt("Harness permission profile", mon.default_harness ?? "codex");
    if (harness === null || !harness.trim()) return;

    const harnessId = harness.trim();
    const currentDefaults = mon.harness_defaults ?? {};
    const currentSandbox = currentDefaults[harnessId]?.sandbox_mode ?? "read-only";
    const sandboxMode = window.prompt("Sandbox mode", currentSandbox);
    if (sandboxMode === null) return;

    await updateMon(mon, {
      harness_defaults: {
        ...currentDefaults,
        [harnessId]: {
          ...(currentDefaults[harnessId] ?? {}),
          sandbox_mode: sandboxMode.trim() || undefined
        }
      }
    });
  }

  function requestDeleteMon(mon: Mon): void {
    setConfirmation({
      title: `Unregister ${monDisplayName(mon)}?`,
      body: "This removes the mon from the service list. Its files and historical runs are kept.",
      confirmLabel: "Unregister mon",
      tone: "danger",
      onConfirm: async () => {
        try {
          await authFetch<void>(`/api/mons/${encodeURIComponent(mon.monde_id)}/${encodeURIComponent(mon.id)}`, { method: "DELETE" });
          setMons((current) => current.filter((candidate) => candidate.id !== mon.id || candidate.monde_id !== mon.monde_id));
          await refreshAll();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    });
  }

  async function createPlan(event: FormEvent) {
    event.preventDefault();
    if (!currentMonde || !planTitle || !planPrompt || !planMon) return;
    await authFetch("/api/plans", {
      method: "POST",
      body: JSON.stringify({
        monde_id: currentMonde.id,
        title: planTitle,
        objective: planTitle,
        prompt: planPrompt,
        assignment: {
          mon_id: planMon,
          title: planTitle,
          prompt: planPrompt,
          phase: "mvp"
        }
      })
    });
    await refreshAll();
  }

  async function activatePlan(plan: Plan) {
    await authFetch(`/api/plans/${plan.id}/activate`, { method: "POST" });
    setActiveTab("runs");
    await refreshAll();
  }

  async function registerArtifact(event: FormEvent) {
    event.preventDefault();
    if (!selectedRun || !artifactType) return;
    await authFetch("/api/artifacts", {
      method: "POST",
      body: JSON.stringify({
        run_id: selectedRun.id,
        type: artifactType,
        path: artifactPath || undefined,
        title: artifactTitle || artifactPath || "Artifact"
      })
    });
    setArtifactPath("");
    setArtifactTitle("");
    await refreshRunSurfaces(selectedRun.id);
    await refreshAll();
  }

  async function openMonThread(mon: Mon) {
    if (!currentMonde) return;
    setThreadError(null);
    const existing = threads.find((thread) => isDraftThreadRun(thread) && thread.monde_id === currentMonde.id && thread.mon_id === mon.id);
    const draft = existing ?? createDraftThreadRun(currentMonde.id, mon);
    setThreads((current) => (existing ? current : appendById(current, draft)));
    setActiveThreadId(draft.id);
    setExpandedThreadIds((current) => upsertString(current, draft.id));
  }

  async function sendThreadMessage(thread: Run, event: FormEvent) {
    event.preventDefault();
    const content = (threadDrafts[thread.id] ?? "").trim();
    if (!content) return;
    let threadId = thread.id;
    const draftThreadId = isDraftThreadRun(thread) ? thread.id : null;
    const context = currentSurfaceContext();
    const now = new Date().toISOString();
    let localUserMessage = createLocalRunEvent(threadId, "user_message", {
      run_id: threadId,
      author_type: "user",
      content,
      context
    });

    setThreadDrafts((current) => ({ ...current, [threadId]: "" }));
    setThreadEvents((current) => ({
      ...current,
      [threadId]: appendLocalEvent(current[threadId] ?? [], localUserMessage)
    }));
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId ? { ...thread, runtime_state: "running" as Run["runtime_state"], updated_at: now } : thread
      )
    );

    try {
      setThreadSendingIds((current) => ({ ...current, [threadId]: true }));
      setThreadError(null);

      if (draftThreadId && !currentMonde) {
        throw new Error("Cannot create a mon chat without an active Monde.");
      }

      if (draftThreadId && currentMonde) {
        const response = await authFetch<{ thread: Run }>(`/api/mondes/${encodeURIComponent(currentMonde.id)}/threads`, {
          method: "POST",
          body: JSON.stringify({
            mon_id: thread.mon_id,
            title: `${threadTitle(thread, mons)} chat`,
            context
          })
        });
        threadId = response.thread.id;
        localUserMessage = {
          ...localUserMessage,
          id: `${localUserMessage.id}_${threadId}`,
          run_id: threadId,
          payload: {
            ...localUserMessage.payload,
            run_id: threadId
          }
        };
        setActiveThreadId(threadId);
        setExpandedThreadIds((current) => upsertString(current.filter((id) => id !== draftThreadId), threadId));
        setThreadDrafts((current) => {
          const next = { ...current };
          delete next[draftThreadId];
          next[threadId] = next[threadId] ?? "";
          return next;
        });
        setThreadSendingIds((current) => {
          const next = { ...current };
          delete next[draftThreadId];
          next[threadId] = true;
          return next;
        });
        setThreads((current) =>
          replaceById(
            current,
            draftThreadId,
            { ...response.thread, runtime_state: "running" as Run["runtime_state"], updated_at: new Date().toISOString() }
          )
        );
        setThreadEvents((current) => {
          const next = { ...current };
          delete next[draftThreadId];
          next[threadId] = appendLocalEvent(next[threadId] ?? [], localUserMessage);
          return next;
        });
      }

      const response = await authFetch<{ run: Run; message: RunEvent; error?: string }>(`/api/runs/${encodeURIComponent(threadId)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content,
          context
        })
      });
      if (response.run) setThreads((current) => upsertById(current, response.run));
      await refreshThreadEvents(threadId);
      await refreshAll();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const targetThreadId = threadId;
      setThreadError(message);
      setThreadEvents((current) => ({
        ...current,
        [targetThreadId]: appendLocalEvent(
          current[targetThreadId] ?? [],
          createLocalRunEvent(targetThreadId, "error", {
            run_id: targetThreadId,
            author_type: "mon",
            content: "Response failed.",
            detail: message,
            context
          })
        )
      }));
      setThreads((current) =>
        current.map((thread) =>
          thread.id === targetThreadId ? { ...thread, runtime_state: "waiting_for_user" as Run["runtime_state"], updated_at: new Date().toISOString() } : thread
        )
      );
    } finally {
      setThreadSendingIds((current) => ({ ...current, [threadId]: false }));
    }
  }

  async function closeThread(thread: Run, closeReason = "user_closed_widget") {
    if (thread.runtime_state === "running") return;
    if (isDraftThreadRun(thread)) {
      setThreads((current) => current.filter((candidate) => candidate.id !== thread.id));
      setThreadEvents((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
      if (activeThreadId === thread.id) setActiveThreadId(null);
      setExpandedThreadIds((current) => current.filter((threadId) => threadId !== thread.id));
      setThreadDrafts((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
      setThreadSendingIds((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
      return;
    }

    try {
      setThreadError(null);
      await authFetch<{ run: Run }>(`/api/runs/${encodeURIComponent(thread.id)}/close`, {
        method: "POST",
        body: JSON.stringify({ close_reason: closeReason })
      });
      setThreads((current) => current.filter((candidate) => candidate.id !== thread.id));
      setThreadEvents((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
      if (activeThreadId === thread.id) setActiveThreadId(null);
      setExpandedThreadIds((current) => current.filter((threadId) => threadId !== thread.id));
      setThreadDrafts((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
      setThreadSendingIds((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
      await refreshAll();
    } catch (caught) {
      setThreadError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function requestCloseThread(thread: Run): void {
    if (isDraftThreadRun(thread)) {
      void closeThread(thread);
      return;
    }

    const title = threadTitle(thread, mons);
    setConfirmation({
      title: `Close ${title} thread?`,
      body: "This closes the active Monde chat thread. The run record and message history remain available after closure.",
      confirmLabel: "Close thread",
      cancelLabel: "Keep open",
      tone: "danger",
      onConfirm: () => closeThread(thread)
    });
  }

  async function confirmRequestedAction(): Promise<void> {
    if (!confirmation) return;
    setConfirmationBusy(true);
    try {
      await confirmation.onConfirm();
      setConfirmation(null);
    } finally {
      setConfirmationBusy(false);
    }
  }

  function currentSurfaceContext(): Record<string, unknown> {
    const selected =
      (activeTab === "runs" || activeTab === "review") && selectedRun
        ? { selected_entity_type: "run", selected_entity_id: selectedRun.id }
        : activeTab === "plans" && plans[0]
          ? { selected_entity_type: "plan", visible_entity_ids: plans.map((plan) => plan.id).slice(0, 25) }
          : activeTab === "artifacts" && allArtifacts[0]
            ? { selected_entity_type: "artifact", visible_entity_ids: allArtifacts.map((artifact) => artifact.id).slice(0, 25) }
            : activeTab === "mons" && mons[0]
              ? { selected_entity_type: "mon", visible_entity_ids: mons.map((mon) => mon.id).slice(0, 25) }
              : {};

    return {
      route: `/mondes/${currentMonde?.id ?? "unknown"}/${activeTab}`,
      surface: activeTab,
      ...selected
    };
  }

  return (
    <main className={activeTab === "overview" ? "app-shell app-shell-overview" : "app-shell"}>
      <aside className="resource-tree" aria-label="Monde browser">
        <div className="brand-block">
          <div className="brand-mark">
            <img src={BRAND_ICON_LOGO} alt="" />
          </div>
          <div>
            <h1>Monde</h1>
            <p>Local operator console</p>
          </div>
        </div>

        <div className="tree-section">
          <div className="tree-heading">Machines</div>
          <div className="machine-list">
            {machineGroups.map((machine) => {
              const collapsed = Boolean(collapsedMachines[machine.id]);
              return (
                <section className="machine-section" key={machine.id}>
                  <button
                    className="machine-header"
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => toggleMachine(machine.id)}
                  >
                    <span className={collapsed ? "machine-chevron machine-chevron-collapsed" : "machine-chevron"} aria-hidden="true" />
                    <span className="machine-icon" aria-hidden="true"><UiIcon name="machine" /></span>
                    <span className="machine-name">{machine.displayName}</span>
                    <span className="machine-count">{machine.mondes.length} monde{machine.mondes.length === 1 ? "" : "s"}</span>
                  </button>
                  {!collapsed ? (
                    <div className="monde-list">
                      {machine.mondes.map((monde) => (
                        <button
                          className={monde.id === currentMonde?.id ? "monde-row monde-row-active" : "monde-row"}
                          type="button"
                          key={monde.id}
                          onClick={() => selectMonde(monde.id)}
                        >
                          <span className="monde-icon" aria-hidden="true"><UiIcon name="monde" /></span>
                          <span className="monde-name">{mondeDisplayName(monde)}</span>
                          <span className="monde-status">
                            <span className={machine.online ? "status-dot status-dot-online" : "status-dot"} aria-hidden="true" />
                            <span>{machine.online ? "Online" : "Offline"}</span>
                          </span>
                        </button>
                      ))}
                      {machine.mondes.length === 0 ? (
                        <div className="sidebar-empty">No mondes registered on this machine.</div>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>

        <div className="operator-area">
          <img className="operator-mascot" src={MASCOT_LARGE_LOGO} alt="" />
          <div className="operator-card">
            <div>
              <span>Operator</span>
              <strong>local console</strong>
            </div>
            <Badge tone={health?.ok ? "green" : "default"}>{health?.ok ? "Online" : "Offline"}</Badge>
          </div>
        </div>
      </aside>

      <section className="workspace-shell">
        <header className="workspace-header">
          <div className="workspace-title">
            <div className={health?.ok ? "service-dot service-dot-online" : "service-dot"} />
            <div>
              <p className="eyebrow">Selected Monde</p>
              <h2>{currentMonde ? mondeDisplayName(currentMonde) : "No Monde selected"}</h2>
              <span>{currentMonde ? currentMonde.root : "Enter the service token to load state."}</span>
            </div>
          </div>

          <div className="header-controls">
            <label>
              Token
              <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Local token" type="password" />
            </label>
            <button className="primary-action" type="button" onClick={() => void refreshAll()} disabled={!token}>
              Refresh
            </button>
          </div>
        </header>

        {error ? <div className="warning-band">{error}</div> : null}
        {!token ? <div className="warning-band">Enter the local service token to load Monde state.</div> : null}

        <nav className="tabbar" aria-label="Monde sections">
          {tabs.map((tab) => (
            <button
              className={tab === activeTab ? "tab-button tab-button-active" : "tab-button"}
              type="button"
              key={tab}
              onClick={() => setActiveTab(tab)}
            >
              {tabLabel(tab)}
            </button>
          ))}
        </nav>

        <section className="status-strip" aria-label="Workspace summary">
          <Metric label="Mons" value={mons.length} tone="blue" />
          <Metric label="Active" value={activeRuns.length} tone="green" />
          <Metric label="Queued" value={queuedRuns.length} tone="amber" />
          <Metric label="Finished" value={finishedRuns.length} tone="purple" />
          <Metric label="Warnings" value={warningRuns.length} tone="red" />
          <div className="db-pill">{health ? `${health.db_path} · schema ${health.schema_version ?? "?"}` : "Checking service..."}</div>
        </section>

        <section className="tab-surface">
          {activeTab === "overview" ? (
            <WorldOverviewView
              sectors={sectorCards}
              runs={runs}
              mons={mons}
              health={health}
              warningCount={warningRuns.length}
              onSelectTab={setActiveTab}
            />
          ) : null}

          {activeTab === "runs" ? (
            <div className="runs-workspace">
              <section className="runs-panel">
                <div className="section-head">
                  <div>
                    <p className="eyebrow">Runs</p>
                    <h3>Execution queue and history</h3>
                  </div>
                  <div className="run-filters">
                    <div className="segmented">
                      {runStatuses.map((status) => (
                        <button
                          className={status === statusFilter ? "segment segment-active" : "segment"}
                          type="button"
                          key={status}
                          onClick={() => setStatusFilter(status)}
                        >
                          {status}
                        </button>
                      ))}
                    </div>
                    <select value={originFilter} onChange={(event) => setOriginFilter(event.target.value)} aria-label="Origin filter">
                      <option value="all">all origins</option>
                      {originTypes.map((origin) => (
                        <option value={origin} key={origin}>
                          {origin}
                        </option>
                      ))}
                    </select>
                    <select value={monFilter} onChange={(event) => setMonFilter(event.target.value)} aria-label="Mon filter">
                      <option value="all">all mons</option>
                      {mons.map((mon) => (
                        <option value={mon.id} key={mon.id}>
                          {monDisplayName(mon)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <AttentionSection
                  items={attentionItems}
                  selectedRunId={selectedRun?.id}
                  onView={(run) => {
                    setSelectedRunId(run.id);
                    setActiveTab("review");
                  }}
                  onStart={(run) => void startRun(run)}
                  onStop={(run) => void stopRun(run)}
                />

                <div className="run-grid">
                  {filteredRuns.map((run) => (
                    <RunCard
                      key={run.id}
                      run={run}
                      selected={run.id === selectedRun?.id}
                      onSelect={() => setSelectedRunId(run.id)}
                      onReview={() => {
                        setSelectedRunId(run.id);
                        setActiveTab("review");
                      }}
                    />
                  ))}
                </div>
              </section>

              <aside className="detail-rail">
                {selectedRun ? (
                  <RunDetail
                    compact
                    run={selectedRun}
                    events={events}
                    logs={logs}
                    artifacts={artifacts}
                    artifactDetails={artifactDetails}
                    scope={scope}
                    input={input}
                    setInput={setInput}
                    onSubmitInput={sendInput}
                    onStart={() => void startRun(selectedRun)}
                    onStop={() => void stopRun(selectedRun)}
                    onInterrupt={() => void interruptRun(selectedRun)}
                    onClose={(outcome) => void closeRun(selectedRun, outcome)}
                    onReview={(outcome) => void reviewRun(selectedRun, outcome)}
                    onRefresh={() => void refreshRunSurfaces(selectedRun.id)}
                    reviewSummary={reviewSummary}
                    setReviewSummary={setReviewSummary}
                    reviewNotes={reviewNotes}
                    setReviewNotes={setReviewNotes}
                    artifactPath={artifactPath}
                    setArtifactPath={setArtifactPath}
                    artifactTitle={artifactTitle}
                    setArtifactTitle={setArtifactTitle}
                    artifactType={artifactType}
                    setArtifactType={setArtifactType}
                    onRegisterArtifact={registerArtifact}
                  />
                ) : (
                  <EmptyState title="No run selected" body="Select a run card to inspect output, artifacts, and scope." />
                )}
              </aside>
            </div>
          ) : null}

          {activeTab === "mons" ? (
            <section className="tab-panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Mons</p>
                  <h3>Actors in this Monde</h3>
                </div>
                <input value={monPrompt} onChange={(event) => setMonPrompt(event.target.value)} placeholder="Run prompt for selected mon" />
              </div>
              <div className="mon-entity-grid">
                {mons.map((mon) => {
                  const monRuns = runs.filter((run) => run.mon_id === mon.id);
                  const monThreads = threads.filter((thread) => thread.mon_id === mon.id);
                  const activeCount = monRuns.filter((run) => run.status === "active" || run.status === "starting").length;
                  const queuedCount = monRuns.filter((run) => run.status === "queued").length;
                  const finishedCount = monRuns.filter((run) => run.status === "finished").length;
                  const status = monStatusMeta(monRuns, monThreads);
                  const harness = monHarnessMeta(mon);
                  const mode = monModeMeta(mon);
                  const monActionKey = `${mon.monde_id}:${mon.id}`;
                  return (
                    <article className="mon-entity" key={mon.id}>
                      <MonIcon mon={mon} tone="cyan" />
                      <div className="entity-body">
                        <div className="mon-entity-title-row">
                          <h4>{monDisplayName(mon)}</h4>
                          <span>{mon.id}</span>
                        </div>
                        <p>{mon.role}</p>
                        <div className="entity-meta">
                          <MetaChip meta={harness} />
                          <MetaChip meta={status} />
                          <MetaChip meta={mode} />
                        </div>
                        <div className="mon-value-pills" aria-label={`${monDisplayName(mon)} run counts`}>
                          <span><strong>{activeCount}</strong> active</span>
                          <span><strong>{queuedCount}</strong> queued</span>
                          <span><strong>{finishedCount}</strong> finished</span>
                          <span><strong>{monThreads.length}</strong> chats</span>
                        </div>
                        <span className="mon-entity-path" title={mon.work_root}>working in {compactPathTail(mon.work_root)}</span>
                      </div>
                      <div className="entity-actions">
                        <button type="button" onClick={() => void openMonThread(mon)}>
                          Chat
                        </button>
                        <details
                          className="mon-action-menu"
                          open={openMonActionMenu === monActionKey}
                          onToggle={(event) => {
                            if (event.currentTarget.open) {
                              setOpenMonActionMenu(monActionKey);
                              return;
                            }

                            setOpenMonActionMenu((current) => (current === monActionKey ? null : current));
                          }}
                        >
                          <summary>Actions</summary>
                          <div className="mon-action-list" role="menu">
                            <button type="button" role="menuitem" onClick={() => {
                              setOpenMonActionMenu(null);
                              void wakeMon(mon);
                            }}>
                              Open or start run
                            </button>
                            <button type="button" role="menuitem" onClick={() => {
                              setOpenMonActionMenu(null);
                              void messageMon(mon);
                            }} disabled={!monPrompt}>
                              Run prompt
                            </button>
                            <button type="button" role="menuitem" onClick={() => {
                              setOpenMonActionMenu(null);
                              void editMonPermissions(mon);
                            }}>
                              Edit permissions
                            </button>
                            <button type="button" role="menuitem" onClick={() => {
                              setOpenMonActionMenu(null);
                              void changeMonHarness(mon);
                            }}>
                              Change harness
                            </button>
                            <button type="button" role="menuitem" onClick={() => {
                              setOpenMonActionMenu(null);
                              void moveMonWorkRoot(mon);
                            }}>
                              Move work root
                            </button>
                            <button className="danger-menu-item" type="button" role="menuitem" onClick={() => {
                              setOpenMonActionMenu(null);
                              requestDeleteMon(mon);
                            }}>
                              Unregister mon
                            </button>
                          </div>
                        </details>
                      </div>
                    </article>
                  );
                })}
                {mons.length === 0 ? <EmptyState title="No mons registered" body="Sync a mon from the CLI or repair this Monde to populate actors." /> : null}
              </div>
            </section>
          ) : null}

          {activeTab === "plans" ? (
            <section className="tab-panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Plans</p>
                  <h3>Coordination and generated runs</h3>
                </div>
                <span className="subtle-count">{plans.length} plan(s)</span>
              </div>

              <form className="plan-create" onSubmit={(event) => void createPlan(event)}>
                <input value={planTitle} onChange={(event) => setPlanTitle(event.target.value)} placeholder="Plan title" />
                <select value={planMon} onChange={(event) => setPlanMon(event.target.value)}>
                  {mons.map((mon) => (
                    <option value={mon.id} key={mon.id}>
                      {monDisplayName(mon)}
                    </option>
                  ))}
                </select>
                <input value={planPrompt} onChange={(event) => setPlanPrompt(event.target.value)} placeholder="Assignment prompt" />
                <button className="primary-action" type="submit" disabled={!currentMonde || !planTitle || !planPrompt || !planMon}>
                  Create plan
                </button>
              </form>

              <div className="plan-grid">
                {plans.map((plan) => (
                  <article className="plan-card" key={plan.id}>
                    <div>
                      <div className="card-kicker">{plan.id}</div>
                      <h4>{plan.title}</h4>
                      <p>{plan.objective}</p>
                    </div>
                    <div className="plan-card-meta">
                      <Badge tone={plan.status === "active" ? "green" : "default"}>{plan.status}</Badge>
                      <Badge>{plan.assignments.length} assignments</Badge>
                    </div>
                    <div className="assignment-list">
                      {plan.assignments.map((assignment) => (
                        <div className="assignment-row" key={assignment.id}>
                          <button
                            type="button"
                            onClick={() => {
                              const runId = assignment.generated_run_ids[0];
                              if (runId) {
                                setSelectedRunId(runId);
                                setActiveTab("review");
                              }
                            }}
                          >
                            <span>{assignment.phase ?? "default"} / {monIdDisplayName(assignment.mon_id)}</span>
                            <small>{assignment.status} · {assignment.generated_run_ids.join(",") || "no runs"}</small>
                          </button>
                          {assignment.generated_run_ids
                            .map((runId) => runs.find((run) => run.id === runId))
                            .filter((run): run is Run => !!run)
                            .map((run) => (
                              <button
                                className="assignment-start"
                                type="button"
                                key={run.id}
                                onClick={() => {
                                  if (run.status === "queued") {
                                    void startRun(run);
                                  } else {
                                    setSelectedRunId(run.id);
                                    setActiveTab("review");
                                  }
                                }}
                              >
                                {run.status === "queued" ? "Start queued run" : "Open run"}
                              </button>
                            ))}
                        </div>
                      ))}
                    </div>
                    <PlanEvidenceSummary
                      evidence={planEvidence[plan.id]}
                      onOpenRun={(runId) => {
                        setSelectedRunId(runId);
                        setActiveTab("review");
                      }}
                    />
                    <button type="button" onClick={() => void activatePlan(plan)}>
                      Activate
                    </button>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {activeTab === "artifacts" ? (
            <section className="tab-panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Artifacts</p>
                  <h3>Evidence registered by runs</h3>
                </div>
                <span className="subtle-count">{allArtifacts.length} artifact(s)</span>
              </div>
              <div className="artifact-list">
                {allArtifacts.map((artifact) => (
                  <article className="artifact-row" key={artifact.id}>
                    <Badge tone={artifact.path_status === "exists" ? "green" : artifact.path_status === "missing" ? "amber" : "default"}>
                      {artifact.path_status}
                    </Badge>
                    <div>
                      <strong>{artifact.title}</strong>
                      <span>{artifact.id} · {artifact.type} · {artifact.run_id ?? "unknown run"}</span>
                      <small>{artifact.path ?? "no path"}</small>
                    </div>
                    {artifact.run_id ? (
                      <button type="button" onClick={() => {
                        setSelectedRunId(artifact.run_id ?? null);
                        setActiveTab("review");
                      }}>
                        Open run
                      </button>
                    ) : null}
                  </article>
                ))}
                {allArtifacts.length === 0 ? <EmptyState title="No artifacts" body="Registered run artifacts will appear here." /> : null}
              </div>
            </section>
          ) : null}

          {activeTab === "status" ? (
            <section className="tab-panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Doctor / Status</p>
                  <h3>Local service and continuity</h3>
                </div>
                <button type="button" onClick={() => void refreshAll()} disabled={!token}>
                  Refresh
                </button>
              </div>
              <div className="status-grid">
                <EvidencePanel title="Service" content={JSON.stringify(health ?? { state: "checking" }, null, 2)} />
                <EvidencePanel title="Adapters" content={JSON.stringify(adapters, null, 2)} />
                <EvidencePanel title="Warnings" content={warningRuns.length ? warningRuns.map((run) => `${run.id} ${run.warnings?.join(", ")}`).join("\n") : "No run warnings."} />
                <EvidencePanel
                  title="Continuity"
                  content={
                    backupInfo
                      ? [
                          `SQLite DB: ${backupInfo.db_path}`,
                          `Backup directory: ${backupInfo.backup_directory}`,
                          `Latest backup: ${backupInfo.latest_backup ?? "none"}`,
                          backupInfo.continuity_warning,
                          `Future path: ${backupInfo.future_recovery_path}`
                        ].join("\n")
                      : health
                        ? `SQLite DB: ${health.db_path}\nSchema: ${health.schema_version ?? "unknown"}\nUse monde backup info/create for local DB copies.`
                        : "Service health is not loaded."
                  }
                />
                <EvidencePanel
                  title="Doctor"
                  content={
                    doctorStatus?.findings.length
                      ? doctorStatus.findings.map((finding) => `${finding.level.toUpperCase()}\t${finding.message}`).join("\n")
                      : "No service doctor findings loaded."
                  }
                />
              </div>
            </section>
          ) : null}

          {activeTab === "review" ? (
            <section className="review-workspace">
              {selectedRun ? (
                <RunDetail
                  run={selectedRun}
                  events={events}
                  logs={logs}
                  artifacts={artifacts}
                  artifactDetails={artifactDetails}
                  scope={scope}
                  input={input}
                  setInput={setInput}
                  onSubmitInput={sendInput}
                  onStart={() => void startRun(selectedRun)}
                  onStop={() => void stopRun(selectedRun)}
                  onInterrupt={() => void interruptRun(selectedRun)}
                  onClose={(outcome) => void closeRun(selectedRun, outcome)}
                  onReview={(outcome) => void reviewRun(selectedRun, outcome)}
                  onRefresh={() => void refreshRunSurfaces(selectedRun.id)}
                  reviewSummary={reviewSummary}
                  setReviewSummary={setReviewSummary}
                  reviewNotes={reviewNotes}
                  setReviewNotes={setReviewNotes}
                  artifactPath={artifactPath}
                  setArtifactPath={setArtifactPath}
                  artifactTitle={artifactTitle}
                  setArtifactTitle={setArtifactTitle}
                  artifactType={artifactType}
                  setArtifactType={setArtifactType}
                  onRegisterArtifact={registerArtifact}
                />
              ) : (
                <EmptyState title="No run selected" body="Choose a run from the Runs tab to review execution evidence." />
              )}
            </section>
          ) : null}
        </section>
      </section>
      <BottomMonChatRail
        monde={currentMonde}
        mons={mons}
        threads={threads}
        activeThreadId={activeThreadId}
        expandedThreadIds={expandedThreadIds}
        threadEvents={threadEvents}
        drafts={threadDrafts}
        isRailExpanded={monRailExpanded}
        sending={threadSendingIds}
        error={threadError}
        onToggleRail={() => setMonRailExpanded((expanded) => !expanded)}
        onOpenThread={(thread) => {
          setActiveThreadId(thread.id);
          setExpandedThreadIds((current) => upsertString(current, thread.id));
        }}
        onOpenMon={(mon) => void openMonThread(mon)}
        onMinimize={(thread) => {
          setExpandedThreadIds((current) => current.filter((threadId) => threadId !== thread.id));
          if (activeThreadId === thread.id) setActiveThreadId(null);
        }}
        onCloseThread={requestCloseThread}
        onChangeDraft={(threadId, value) => setThreadDrafts((current) => ({ ...current, [threadId]: value }))}
        onSend={(thread, event) => void sendThreadMessage(thread, event)}
      />
      <ConfirmationOverlay
        request={confirmation}
        busy={confirmationBusy}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void confirmRequestedAction()}
      />
    </main>
  );
}

function WorldOverviewView(props: {
  sectors: SectorCardModel[];
  runs: Run[];
  mons: Mon[];
  health: Health | null;
  warningCount: number;
  onSelectTab(tab: ActiveTab): void;
}) {
  const activeCount = props.runs.filter((run) => run.status === "active" || run.status === "starting").length;
  const queuedCount = props.runs.filter((run) => run.status === "queued").length;
  const finishedCount = props.runs.filter((run) => run.status === "finished").length;

  return (
    <section className="world-overview" aria-label="Monde overview">
      <div className="overview-main">
        <div className="world-canvas">
          <img className="world-island-image" src={WORLD_OVERVIEW_IMAGE} alt="" />
          {props.sectors.map((sector) => (
            <SectorCard sector={sector} key={sector.id} onSelect={props.onSelectTab} />
          ))}
          <button className="add-world-item" type="button" onClick={() => props.onSelectTab("mons")}>
            <span aria-hidden="true">+</span>
            <small>Add new .mon</small>
          </button>
        </div>
      </div>

      <RightWorldPanel
        health={props.health}
        mons={props.mons}
        activeCount={activeCount}
        queuedCount={queuedCount}
        finishedCount={finishedCount}
        warningCount={props.warningCount}
        onViewMons={() => props.onSelectTab("mons")}
      />
    </section>
  );
}

function SectorCard({ sector, onSelect }: { sector: SectorCardModel; onSelect(tab: SectorTab): void }) {
  return (
    <button
      className={`sector-card sector-card-${sector.tone}`}
      data-sector={sector.id}
      type="button"
      onClick={() => onSelect(sector.id)}
    >
      <span className="sector-icon" aria-hidden="true">{sector.icon}</span>
      <span className="sector-body">
        <strong>{sector.title}</strong>
        <small>{sector.description}</small>
      </span>
      <span className="sector-metric">
        <b>{sector.metricValue ?? "-"}</b>
        {sector.metricLabel ? <em>{sector.metricLabel}</em> : null}
      </span>
    </button>
  );
}

function RightWorldPanel(props: {
  health: Health | null;
  mons: Mon[];
  activeCount: number;
  queuedCount: number;
  finishedCount: number;
  warningCount: number;
  onViewMons(): void;
}) {
  const recentMons = props.mons.slice(0, 5);
  return (
    <aside className="right-world-panel" aria-label="Monde status">
      <WorldHealthCard health={props.health} />
      <div className="world-panel-card">
        <div className="world-panel-heading">
          <h3>Monde Overview</h3>
          <div className="world-flavor-row">
            <img className="world-panel-mascot" src={MASCOT_LOGO} alt="" />
            <p>
              <span>Monde is your world.</span>
              <span>Mons are your companions.</span>
              <span>Together, build useful local systems.</span>
            </p>
          </div>
        </div>

        <div className="activity-list">
          <h4>Activity</h4>
          <ActivityRow label="Queued" value={props.queuedCount} tone="amber" />
          <ActivityRow label="Running" value={props.activeCount} tone="green" />
          <ActivityRow label="Finished" value={props.finishedCount} tone="blue" />
          <ActivityRow label="Warnings" value={props.warningCount} tone="orange" />
        </div>

        <div className="recent-mons">
          <h4>Recent Mons</h4>
          {recentMons.map((mon) => (
            <div className="recent-mon-row" key={mon.id}>
              <MonIcon mon={mon} tone="cyan" compact />
              <span>{monDisplayName(mon)}</span>
              <small>Idle</small>
            </div>
          ))}
          {recentMons.length === 0 ? <p className="panel-empty">No mons registered yet.</p> : null}
        </div>

        <button className="view-all-button" type="button" onClick={props.onViewMons}>
          View All Mons
        </button>
      </div>
    </aside>
  );
}

function WorldHealthCard({ health }: { health: Health | null }) {
  return (
    <div className="world-health-card">
      <div className="weather-glyph" aria-hidden="true">
        <span />
      </div>
      <div>
        <strong>Clear Skies</strong>
        <b>{health?.ok ? "Healthy" : health ? "Attention" : "Checking"}</b>
        <small>{health?.ok ? "Local operator console stable" : "Service health is loading"}</small>
      </div>
    </div>
  );
}

function ActivityRow({ label, value, tone }: { label: string; value: number; tone: "amber" | "green" | "blue" | "orange" }) {
  return (
    <div className="activity-row">
      <span className={`activity-dot activity-dot-${tone}`} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ConfirmationOverlay(props: {
  request: ConfirmationRequest | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  useEffect(() => {
    if (!props.request) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !props.busy) {
        props.onCancel();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props]);

  if (!props.request) return null;

  return (
    <div className="confirmation-overlay" onMouseDown={() => { if (!props.busy) props.onCancel(); }}>
      <section
        className="confirmation-card"
        data-tone={props.request.tone ?? "default"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-body"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirmation-mark" aria-hidden="true">!</div>
        <div className="confirmation-copy">
          <h2 id="confirmation-title">{props.request.title}</h2>
          <p id="confirmation-body">{props.request.body}</p>
        </div>
        <div className="confirmation-actions">
          <button type="button" onClick={props.onCancel} disabled={props.busy}>
            {props.request.cancelLabel ?? "Cancel"}
          </button>
          <button className="confirmation-confirm" type="button" onClick={props.onConfirm} disabled={props.busy}>
            {props.busy ? "Working..." : props.request.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function BottomMonChatRail(props: {
  monde?: Monde | null;
  mons: Mon[];
  threads: Run[];
  activeThreadId: string | null;
  expandedThreadIds: string[];
  threadEvents: Record<string, RunEvent[]>;
  drafts: Record<string, string>;
  isRailExpanded: boolean;
  sending: Record<string, boolean>;
  error: string | null;
  onToggleRail(): void;
  onOpenThread(thread: Run): void;
  onOpenMon(mon: Mon): void;
  onMinimize(thread: Run): void;
  onCloseThread(thread: Run): void;
  onChangeDraft(threadId: string, value: string): void;
  onSend(thread: Run, event: FormEvent): void;
}) {
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!props.isRailExpanded) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onToggleRail();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.isRailExpanded, props.onToggleRail]);

  useEffect(() => {
    for (const threadId of props.expandedThreadIds) {
      const container = messageRefs.current[threadId];
      if (container) {
        container.scrollTo({ top: container.scrollHeight });
      }
    }
  }, [props.expandedThreadIds, props.threadEvents, props.sending, props.error]);

  if (!props.monde) {
    return null;
  }

  return (
    <div className="bottom-mon-chat-rail" aria-label="Mon chat rail">
      <div className="mon-chat-stack">
        <div className="chat-rail-row">
          <div className="floating-mon-chat-rail" data-expanded={props.isRailExpanded}>
            {props.isRailExpanded ? (
              <div className="mon-rail-panel">
                <button
                  className="mon-rail-panel-header"
                  type="button"
                  onClick={props.onToggleRail}
                  aria-expanded={props.isRailExpanded}
                  aria-controls="mon-rail-list"
                >
                  <span className="mon-rail-plus" aria-hidden="true">+</span>
                  <span className="mon-rail-copy">
                    <strong>Add new .mon chat</strong>
                    <small>Choose a mon below</small>
                  </span>
                  <span className="mon-rail-caret" aria-hidden="true">v</span>
                </button>
                <div className="mon-rail-list" id="mon-rail-list" role="menu" aria-label="Available mons">
                  {props.mons.map((mon) => (
                    <button className="mon-rail-list-item" type="button" role="menuitem" key={mon.id} onClick={() => props.onOpenMon(mon)}>
                      <MonIcon mon={mon} compact />
                      <span className="mon-name">{monDisplayName(mon)}</span>
                      <span className="mon-status">Idle</span>
                    </button>
                  ))}
                  {props.mons.length === 0 ? <p className="mon-rail-empty">No mons are registered in this Monde yet.</p> : null}
                </div>
              </div>
            ) : (
              <button
                className="mon-rail-toggle"
                type="button"
                onClick={props.onToggleRail}
                aria-expanded={props.isRailExpanded}
                aria-controls="mon-rail-list"
              >
                <span className="mon-rail-plus" aria-hidden="true">+</span>
                <span className="mon-rail-copy">
                  <strong>Add new .mon chat</strong>
                  <small>Open the mon launcher</small>
                </span>
                <span className="mon-rail-caret" aria-hidden="true">^</span>
              </button>
            )}
          </div>

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
              {isExpanded ? null : (
                <div className="mon-thread-pill" data-active={isActive} role="group" aria-label={`${title} chat controls`}>
                  <button className="mon-thread-pill-main" type="button" onClick={() => props.onOpenThread(thread)}>
                    <MonIcon mon={threadMon} label={title} compact tone="cyan" />
                    <span className="mon-thread-title">{title}</span>
                    <span className="mon-thread-meta" aria-label={`${harness.label}, ${status.label}, ${mode.label}`}>
                      <MetaChip meta={harness} />
                      <MetaChip meta={status} />
                      <MetaChip meta={mode} />
                    </span>
                    <span className="mon-thread-path" title={threadMon?.work_root ?? undefined}>working in {workRootTail}</span>
                  </button>
                  <button className="mon-thread-close" type="button" onClick={() => props.onCloseThread(thread)} disabled={!canCloseThread} aria-label={`Close ${title} chat`}>
                    x
                  </button>
                </div>
              )}

              {isExpanded ? (
                <section className="mon-chat-widget" aria-label={`${title} chat`}>
                  <header className="mon-chat-widget-header">
                    <button className="mon-chat-header-main" type="button" onClick={() => props.onMinimize(thread)} aria-label={`Minimize ${title} chat`}>
                      <MonIcon mon={threadMon} label={title} compact />
                      <span className="mon-chat-header-copy">
                        <strong className="mon-chat-title">{title}</strong>
                        <span className="mon-chat-meta" aria-label={`${harness.label}, ${status.label}, ${mode.label}`}>
                          <MetaChip meta={harness} />
                          <MetaChip meta={status} />
                          <MetaChip meta={mode} />
                        </span>
                        <span className="mon-chat-path" title={threadMon?.work_root ?? undefined}>working in {workRootTail}</span>
                      </span>
                    </button>
                    <div className="mon-chat-widget-actions">
                      <button type="button" onClick={() => props.onCloseThread(thread)} disabled={!canCloseThread} aria-label="Close thread">
                        x
                      </button>
                    </div>
                  </header>

                  <div className="mon-chat-messages" ref={(element) => { messageRefs.current[thread.id] = element; }}>
                    {messages.map((event) => (
                      <div className="mon-chat-message" data-author={chatEventAuthor(event)} data-state={event.event_type === "error" ? "failed" : undefined} key={event.id}>
                        <span className="mon-chat-message-body">{chatEventContent(event)}</span>
                        <time className="mon-chat-message-time" dateTime={event.created_at} title={formatChatTimestampTitle(event.created_at)}>
                          {formatChatTimestamp(event.created_at)}
                        </time>
                      </div>
                    ))}
                    {isResponding ? (
                      <div className="mon-chat-message mon-chat-typing" data-author="mon" aria-label="Mon is responding">
                        <span />
                        <span />
                        <span />
                      </div>
                    ) : null}
                    {messages.length === 0 ? (
                      <div className="mon-chat-empty">
                        Ask {threadMon ? monDisplayName(threadMon) : monIdDisplayName(thread.mon_id)} something from this Monde.
                      </div>
                    ) : null}
                  </div>

                  <form className="mon-chat-composer" onSubmit={(event) => props.onSend(thread, event)}>
                    <textarea
                      className="mon-chat-input"
                      value={props.drafts[thread.id] ?? ""}
                      onChange={(event) => props.onChangeDraft(thread.id, event.target.value)}
                      placeholder={`Message ${threadMon ? monDisplayName(threadMon) : monIdDisplayName(thread.mon_id)}...`}
                      disabled={!isOpenThreadRuntimeState(thread.runtime_state)}
                    />
                    <button className="mon-chat-send" type="submit" disabled={!canSend}>
                      {isSending ? "..." : "Send"}
                    </button>
                  </form>
                </section>
              ) : null}
            </div>
            );
          })}
          {props.error ? <span className="mon-chat-rail-error">{props.error}</span> : null}
        </div>
      </div>
    </div>
  );
}

function MetaChip({ meta }: { meta: ChipMeta }) {
  return <span className="thread-chip" data-tone={meta.tone}>{meta.label}</span>;
}

function MonIcon({
  mon,
  label,
  tone = "mint",
  compact = false
}: {
  mon?: Mon;
  label?: string;
  tone?: "mint" | "cyan";
  compact?: boolean;
}) {
  const title = mon ? monDisplayName(mon) : label ?? "Mon";
  return (
    <span
      className={compact ? `mon-placeholder mon-placeholder-${tone} mon-placeholder-compact` : `mon-placeholder mon-placeholder-${tone}`}
      role="img"
      aria-label={`${title} mon icon`}
    >
      <span className="mon-placeholder-face" />
    </span>
  );
}

function UiIcon({ name }: { name: IconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2.35 } as const;
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      {name === "runs" ? (
        <>
          <circle {...common} cx="12" cy="12" r="9" />
          <path {...common} d="M10 8l6 4-6 4V8z" />
        </>
      ) : null}
      {name === "plans" ? (
        <>
          <path {...common} d="M8 4h8" />
          <path {...common} d="M7 6h10a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V8a2 2 0 012-2z" />
          <path {...common} d="M8 11h8M8 15h5" />
        </>
      ) : null}
      {name === "artifacts" ? (
        <>
          <path {...common} d="M4 8l8-4 8 4-8 4-8-4z" />
          <path {...common} d="M4 8v8l8 4 8-4V8" />
          <path {...common} d="M12 12v8" />
        </>
      ) : null}
      {name === "status" ? (
        <>
          <path {...common} d="M4 13h4l2-6 4 10 2-4h4" />
          <path {...common} d="M4 19h16" />
        </>
      ) : null}
      {name === "review" ? (
        <>
          <path {...common} d="M5 12l4 4L19 6" />
          <path {...common} d="M5 20h14" />
        </>
      ) : null}
      {name === "mons" ? (
        <>
          <path {...common} d="M12 20c0-6 3-11 8-14" />
          <path {...common} d="M12 20c0-6-3-11-8-14" />
          <path {...common} d="M12 20V9" />
          <path {...common} d="M8 8c2 0 4 1 4 3-3 0-5-1-4-3z" />
          <path {...common} d="M16 8c-2 0-4 1-4 3 3 0 5-1 4-3z" />
        </>
      ) : null}
      {name === "machine" ? (
        <>
          <rect {...common} x="4" y="5" width="16" height="11" rx="2" />
          <path {...common} d="M8 20h8M12 16v4" />
        </>
      ) : null}
      {name === "monde" ? (
        <>
          <circle {...common} cx="12" cy="12" r="9" />
          <path {...common} d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
        </>
      ) : null}
    </svg>
  );
}

function AttentionSection(props: {
  items: AttentionItem<Run>[];
  selectedRunId?: string;
  onView(run: Run): void;
  onStart(run: Run): void;
  onStop(run: Run): void;
}) {
  return (
    <section className="attention-section" aria-label="Runs needing attention">
      <div className="attention-head">
        <div>
          <p className="eyebrow">Attention</p>
          <h4>Runs needing operator focus</h4>
        </div>
        <span>{props.items.length ? `${props.items.length} highlighted` : "clear"}</span>
      </div>
      {props.items.length ? (
        <div className="attention-list">
          {props.items.map(({ run, reason }) => (
            <article className={run.id === props.selectedRunId ? "attention-item attention-item-selected" : "attention-item"} key={run.id}>
              <div className="attention-main">
                <div className="attention-kicker">
                  <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                  <Badge>{run.process_status}</Badge>
                  <Badge tone={outcomeTone(run.outcome)}>{run.outcome}</Badge>
                  <span>{reason}</span>
                </div>
                <strong>{run.intent.title}</strong>
                <small>{run.id} · {monIdDisplayName(run.mon_id)} · {String(run.origin.type)} · {ageLabel(run.started_at ?? run.created_at)}</small>
                <span className="why-label">Why shown: {reason}</span>
                {run.warnings?.length ? <em>{run.warnings.join(", ")}</em> : null}
              </div>
              <div className="attention-actions">
                {(run.status === "active" || run.status === "starting") ? (
                  <>
                    <button type="button" onClick={() => props.onView(run)}>
                      Attach
                    </button>
                    <button type="button" onClick={() => props.onStop(run)}>
                      Stop
                    </button>
                  </>
                ) : run.status === "queued" || run.status === "blocked" ? (
                  <>
                    <button type="button" onClick={() => props.onStart(run)}>
                      Start
                    </button>
                    <button type="button" onClick={() => props.onView(run)}>
                      View
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => props.onView(run)}>
                    View
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="attention-empty">No active, warning-bearing, blocked, or queued plan/cron-origin runs.</div>
      )}
    </section>
  );
}

function RunCard({ run, selected, onSelect, onReview }: { run: Run; selected: boolean; onSelect(): void; onReview(): void }) {
  return (
    <article className={selected ? "run-card run-card-selected" : "run-card"} onClick={onSelect}>
      <div className="run-card-top">
        <Badge tone={run.interaction_mode === "hitl_thread" ? "blue" : statusTone(run.status)}>
          {run.interaction_mode === "hitl_thread" ? "HITL Thread" : "One-shot"}
        </Badge>
        <span>{String(run.origin.type)}</span>
      </div>
      <h4>{run.intent.title}</h4>
      <p>{run.id}</p>
      <div className="run-card-meta">
        <span>{monIdDisplayName(run.mon_id)}</span>
        <span>{run.runtime_state}</span>
        <span>{run.outcome_state}</span>
      </div>
      {run.warnings?.length ? <div className="warning-chip">{run.warnings.join(", ")}</div> : null}
      <div className="run-card-footer">
        <time>{formatDate(run.created_at)}</time>
        <button type="button" onClick={(event) => {
          event.stopPropagation();
          onReview();
        }}>
          Review
        </button>
      </div>
    </article>
  );
}

function RunDetail(props: {
  run: Run;
  events: RunEvent[];
  logs: LogEvent[];
  artifacts: Artifact[];
  artifactDetails: Record<string, ArtifactDetail>;
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
}) {
  const { run } = props;
  const acceptsInput = runAcceptsInput(run);
  const reviewed = typeof run.result?.reviewed_at === "string";
  const processUnknown = run.status === "finished" && run.outcome === "unknown";
  return (
    <div className={props.compact ? "run-review run-review-compact" : "run-review"}>
      <header className="review-head">
        <div>
          <p className="eyebrow">Run Review</p>
          <h3>{run.intent.title}</h3>
          <span>{run.id}</span>
        </div>
        <div className="review-actions">
          {run.status === "queued" ? <button onClick={props.onStart}>Start</button> : null}
          {run.status === "active" || run.status === "starting" ? (
            <>
              <button onClick={props.onInterrupt}>Interrupt</button>
              <button onClick={props.onStop}>Stop</button>
            </>
          ) : null}
          {run.status === "finished" ? (
            <>
              <button onClick={() => props.onReview("completed")}>Completed</button>
              <button onClick={() => props.onReview("failed")}>Failed</button>
            </>
          ) : null}
          <button onClick={props.onRefresh}>Reconnect</button>
        </div>
      </header>

      <div className="review-state">
        <MetadataGroup title="Run Kind">
          <Badge tone={run.interaction_mode === "hitl_thread" ? "blue" : "default"}>
            {run.interaction_mode === "hitl_thread" ? "HITL Thread" : "One-shot"}
          </Badge>
          <Badge>{threadRuntimeLabel(run.runtime_state)}</Badge>
          <Badge tone={run.outcome_state === "succeeded" ? "green" : run.outcome_state === "failed" ? "red" : "default"}>
            {run.outcome_state}
          </Badge>
          {run.close_reason ? <Badge>{run.close_reason}</Badge> : null}
        </MetadataGroup>
        <MetadataGroup title="Lifecycle">
          <Badge tone={statusTone(run.status)}>{run.status}</Badge>
          <Badge>{run.process_status}</Badge>
          <Badge tone={outcomeTone(run.outcome)}>{run.outcome}</Badge>
        </MetadataGroup>
        <MetadataGroup title="Harness">
          <Badge>{String(run.execution?.runner_type ?? run.execution?.runner ?? "runner unknown")}</Badge>
          <Badge>{String(run.execution?.interaction_mode ?? (acceptsInput ? "interactive" : "single-shot"))}</Badge>
          <Badge tone={acceptsInput ? "green" : "default"}>input {String(run.execution?.input_mode ?? (acceptsInput ? "open" : "closed"))}</Badge>
          <Badge>{String(run.execution?.output_mode ?? "output unknown")}</Badge>
        </MetadataGroup>
        <MetadataGroup title="Write">
          <Badge tone={run.execution?.can_write === true ? "amber" : "default"}>
            {run.execution?.can_write === true ? "write enabled" : "no write"}
          </Badge>
          <Badge>{String(run.execution?.write_scope ?? "none")}</Badge>
          <Badge>sandbox {String(run.execution?.sandbox_mode ?? "unknown")}</Badge>
          <Badge>approval {String(run.execution?.approval_mode ?? "unknown")}</Badge>
        </MetadataGroup>
        <MetadataGroup title="Warnings">
          <span>{run.warnings?.join(", ") || "none"}</span>
        </MetadataGroup>
      </div>

      <details className="intent-panel">
        <summary>Intent and origin</summary>
        <div className="origin-grid">
          <span>mon</span>
          <strong>{monIdDisplayName(run.mon_id)}</strong>
          {Object.entries(run.origin).map(([key, value]) => (
            <>
              <span key={`${key}-label`}>origin.{key}</span>
              <strong key={key}>{String(value)}</strong>
            </>
          ))}
        </div>
        <pre>{run.intent.prompt}</pre>
      </details>

      {processUnknown ? (
        <div className="review-notice">
          Process exited cleanly, but the semantic outcome is still unknown until operator review.
        </div>
      ) : null}
      {reviewed ? (
        <div className="review-notice review-notice-reviewed">
          Reviewed by {String(run.result?.reviewed_by ?? "operator")} at {String(run.result?.reviewed_at)}.
        </div>
      ) : null}
      {run.result && Object.keys(run.result).length ? (
        <div className="result-summary">
          <strong>{String(run.result.summary ?? "No summary recorded.")}</strong>
          {run.result.notes ? <p>{String(run.result.notes)}</p> : null}
          {run.result.reviewed_by || run.result.reviewed_at ? (
            <small>{String(run.result.reviewed_by ?? "operator")} · {String(run.result.reviewed_at ?? "unreviewed")}</small>
          ) : null}
        </div>
      ) : null}

      <div className="terminal-shell">
        <div className="terminal-title">Run terminal/output</div>
        <TerminalPane events={props.events} />
      </div>

      <form className="input-row" onSubmit={props.onSubmitInput}>
        <input
          disabled={run.status !== "active" || !acceptsInput}
          value={props.input}
          onChange={(event) => props.setInput(event.target.value)}
          placeholder={run.status === "active" ? (acceptsInput ? "Send input to active run" : "Harness does not accept stdin turns") : "Run is not active"}
        />
        <button disabled={run.status !== "active" || !acceptsInput || !props.input} type="submit">
          Send
        </button>
      </form>
      {run.status === "active" && !acceptsInput ? (
        <div className="input-disabled-note">
          Input is disabled because this run is {String(run.execution?.interaction_mode ?? "single-shot")} with input_mode={String(run.execution?.input_mode ?? "closed")}.
        </div>
      ) : null}

      {run.status === "finished" ? (
        <section className="review-form">
          <input
            value={props.reviewSummary}
            onChange={(event) => props.setReviewSummary(event.target.value)}
            placeholder="Outcome summary"
          />
          <textarea
            value={props.reviewNotes}
            onChange={(event) => props.setReviewNotes(event.target.value)}
            placeholder="Optional review notes"
          />
          <div className="review-form-actions">
            <button type="button" onClick={() => props.onReview("completed")}>Mark completed</button>
            <button type="button" onClick={() => props.onReview("failed")}>Mark failed</button>
            <button type="button" onClick={() => props.onReview("stopped")}>Mark stopped</button>
          </div>
        </section>
      ) : null}

      <form className="artifact-create" onSubmit={props.onRegisterArtifact}>
        <select value={props.artifactType} onChange={(event) => props.setArtifactType(event.target.value)}>
          {["file", "note", "diff", "report", "schema", "test_suite", "screenshot", "generated_asset", "prompt_pack", "other"].map(
            (type) => (
              <option value={type} key={type}>
                {type}
              </option>
            )
          )}
        </select>
        <input value={props.artifactPath} onChange={(event) => props.setArtifactPath(event.target.value)} placeholder="Artifact path" />
        <input value={props.artifactTitle} onChange={(event) => props.setArtifactTitle(event.target.value)} placeholder="Artifact title" />
        <button type="submit">Register artifact</button>
      </form>

      <DiffReviewSurface run={run} artifacts={props.artifacts} artifactDetails={props.artifactDetails} />

      <section className="evidence-grid">
        <EvidencePanel title="Logs" content={props.logs.length ? props.logs.map((log) => `${log.created_at} ${log.event_type} ${JSON.stringify(log.payload)}`).join("\n") : "No logs."} />
        <EvidencePanel
          title="Artifacts"
          content={
            props.artifacts.length
              ? props.artifacts
                  .map((artifact) => `${artifact.id} ${artifact.type} ${artifact.path_status} ${artifact.title} ${artifact.path ?? ""}`)
                  .join("\n")
              : "No artifacts."
          }
        />
        <EvidencePanel title="Warnings" content={run.warnings?.length ? run.warnings.join("\n") : "No warnings."} />
        <EvidencePanel title="Result" content={JSON.stringify(run.result ?? {}, null, 2)} />
        <EvidencePanel title="Scope" content={JSON.stringify(props.scope ?? run.scope_snapshot ?? {}, null, 2)} collapsible />
      </section>
    </div>
  );
}

function MetadataGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="metadata-group">
      <span>{title}</span>
      <div>{children}</div>
    </div>
  );
}

function DiffReviewSurface({
  run,
  artifacts,
  artifactDetails
}: {
  run: Run;
  artifacts: Artifact[];
  artifactDetails: Record<string, ArtifactDetail>;
}) {
  const diffCapture = isRecord(run.execution?.diff_capture) ? run.execution.diff_capture : {};
  const changedFiles = Array.isArray(diffCapture.changed_files) ? diffCapture.changed_files.map(String) : [];
  const diffStat = typeof diffCapture.diff_stat === "string" ? diffCapture.diff_stat.trim() : "";
  const diffArtifacts = artifacts.filter((artifact) => artifact.type === "diff");
  const changedFileArtifacts = artifacts.filter((artifact) => artifact.type === "file" && changedFiles.includes(artifact.title));
  const primaryDiff = diffArtifacts
    .map((artifact) => artifactDetails[artifact.id])
    .find((artifact) => artifact?.content_excerpt?.trim());

  if (!diffArtifacts.length && !changedFiles.length && !diffStat) {
    return null;
  }

  return (
    <section className="diff-review">
      <div className="section-head compact-head">
        <div>
          <p className="eyebrow">Write Evidence</p>
          <h4>Run diff summary</h4>
        </div>
        <Badge tone={diffCapture.diff_truncated === true ? "amber" : "green"}>
          {diffCapture.diff_truncated === true ? "bounded excerpt" : "captured"}
        </Badge>
      </div>
      {diffStat ? <pre className="diff-stat">{diffStat}</pre> : null}
      {changedFiles.length ? (
        <div className="changed-files">
          {changedFiles.map((file) => {
            const artifact = changedFileArtifacts.find((candidate) => candidate.title === file);
            return (
              <div className="changed-file" key={file}>
                <span>{file}</span>
                <Badge tone={artifact?.path_status === "exists" ? "green" : artifact?.path_status === "missing" ? "amber" : "default"}>
                  {artifact?.path_status ?? "not registered"}
                </Badge>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="diff-artifacts">
        {diffArtifacts.map((artifact) => (
          <div className="diff-artifact" key={artifact.id}>
            <strong>{artifact.title}</strong>
            <span>{artifact.id} · {artifact.path_status}</span>
            <small>{artifact.path ?? "no path"}</small>
          </div>
        ))}
      </div>
      {primaryDiff?.content_excerpt ? (
        <details className="evidence-panel diff-excerpt" open>
          <summary>{primaryDiff.title}{primaryDiff.content_truncated ? " (truncated)" : ""}</summary>
          <pre>{primaryDiff.content_excerpt}</pre>
        </details>
      ) : null}
    </section>
  );
}

function PlanEvidenceSummary({ evidence, onOpenRun }: { evidence?: PlanEvidence; onOpenRun(runId: string): void }) {
  if (!evidence) {
    return <div className="plan-evidence-empty">Evidence has not loaded yet.</div>;
  }

  return (
    <div className="plan-evidence">
      <div className="plan-evidence-metrics">
        <Badge>{evidence.summary.linked_runs} runs</Badge>
        <Badge>{evidence.summary.artifacts} artifacts</Badge>
        <Badge>{evidence.summary.logs} logs</Badge>
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
      {evidence.result_summaries.length ? (
        <div className="plan-evidence-notes">
          {evidence.result_summaries.map((summary) => (
            <small key={summary.run_id}>{summary.run_id}: {summary.summary}</small>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TerminalPane({ events }: { events: RunEvent[] }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const transcript = useMemo(() => renderTranscript(events), [events]);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#16191f",
        foreground: "#d8dee9"
      }
    });
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    return () => {
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    terminal.write(transcript || "No output yet.");
  }, [transcript]);

  return (
    <>
      <div className="xterm-host" ref={hostRef} />
      <pre className="terminal-fallback">{transcript || "No output yet."}</pre>
    </>
  );
}

function EvidencePanel({ title, content, collapsible = false }: { title: string; content: string; collapsible?: boolean }) {
  if (collapsible) {
    return (
      <details className="evidence-panel" open>
        <summary>{title}</summary>
        <pre>{content}</pre>
      </details>
    );
  }

  return (
    <div className="evidence-panel">
      <h4>{title}</h4>
      <pre>{content}</pre>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: number;
  tone?: "default" | "blue" | "green" | "amber" | "purple" | "red";
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "blue" | "green" | "amber" | "red" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function runAcceptsInput(run: Run): boolean {
  if (run.execution?.input_mode === "open") {
    return true;
  }

  if (run.execution?.input_mode === "closed") {
    return false;
  }

  const terminal = run.execution?.terminal;
  return isRecord(terminal) && terminal.stdin === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upsertString(items: string[], item: string): string[] {
  return items.includes(item) ? items : [...items, item];
}

function compactPathTail(value: string | null | undefined, depth = 3): string {
  const path = value?.trim();
  if (!path) return "unknown work root";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= depth) return path;
  return `.../${parts.slice(-depth).join("/")}`;
}

function renderTranscript(events: RunEvent[]): string {
  if (events.length === 0) return "No output yet.";
  return events
    .map((event) => {
      if (event.event_type === "run_output" || event.event_type === "run_error_output") return String(event.payload.chunk ?? "");
      if (event.event_type === "run_input") return String(event.payload.chunk ?? "");
      if (event.event_type === "user_message") return `user: ${chatEventContent(event)}\n`;
      if (event.event_type === "mon_message") return `mon: ${chatEventContent(event)}\n`;
      if (event.event_type === "system_message") return `system: ${chatEventContent(event)}\n`;
      if (event.event_type === "error") return `error: ${chatEventContent(event)}\n`;
      if (event.event_type === "warning_added") return `\n[${event.run_id}] warning ${event.payload.warning}\n`;
      if (event.event_type === "run_started") return `[${event.run_id}] started\n`;
      if (event.event_type === "run_finished") {
        return `\n[${event.run_id}] finished ${event.payload.status}/${event.payload.process_status}/${event.payload.outcome}\n`;
      }
      return "";
    })
    .join("");
}

function ageLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s old`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h old`;
  const days = Math.floor(hours / 24);
  return `${days}d old`;
}

function mondeDisplayName(monde: Monde): string {
  return monde.name || monde.id;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [item, ...items];
  return items.map((candidate) => (candidate.id === item.id ? item : candidate));
}

function appendById<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((candidate) => candidate.id === item.id) ? items : [...items, item];
}

function replaceById<T extends { id: string }>(items: T[], replacedId: string, item: T): T[] {
  let replaced = false;
  const next: T[] = [];
  for (const candidate of items) {
    if (candidate.id === item.id && candidate.id !== replacedId) {
      continue;
    }
    if (candidate.id === replacedId) {
      next.push(item);
      replaced = true;
    } else {
      next.push(candidate);
    }
  }
  return replaced ? next : appendById(next, item);
}

function mergeServerAndDraftThreads(serverThreads: Run[], currentThreads: Run[]): Run[] {
  const serverById = new Map(serverThreads.map((thread) => [thread.id, thread]));
  const next: Run[] = [];
  const seen = new Set<string>();

  for (const current of currentThreads) {
    if (isDraftThreadRun(current)) {
      next.push(current);
      seen.add(current.id);
      continue;
    }

    const serverThread = serverById.get(current.id);
    if (serverThread) {
      next.push(serverThread);
      seen.add(serverThread.id);
    }
  }

  for (const serverThread of serverThreads) {
    if (!seen.has(serverThread.id)) {
      next.push(serverThread);
    }
  }

  return next;
}

function createDraftThreadRun(mondeId: string, mon: Mon): Run {
  const now = new Date().toISOString();
  return {
    id: `draft_${mondeId}_${mon.id}_${Date.now()}`,
    monde_id: mondeId,
    mon_id: mon.id,
    status: "active",
    process_status: "running",
    outcome: "unknown",
    interaction_mode: "hitl_thread",
    runtime_state: "idle_open",
    outcome_state: "unknown",
    close_reason: null,
    warnings: [],
    origin: { type: "operator", label: "Draft bottom mon chat" },
    intent: {
      title: `${monDisplayName(mon)} chat`,
      prompt: `Draft human-in-the-loop chat thread with ${mon.id}.`
    },
    execution: {
      local_draft: true,
      input_mode: "open",
      output_mode: "plain",
      thread_surface: "bottom_rail"
    },
    result: {},
    created_at: now,
    updated_at: now,
    opened_at: now
  };
}

function isDraftThreadRun(thread: Run): boolean {
  return isDraftThreadId(thread.id) || thread.execution?.local_draft === true;
}

function isDraftThreadId(threadId: string): boolean {
  return threadId.startsWith("draft_");
}

function isOpenThreadRuntimeState(runtimeState: string): boolean {
  return runtimeState === "queued" || runtimeState === "running" || runtimeState === "waiting_for_user" || runtimeState === "idle_open";
}

function threadRuntimeLabel(runtimeState: string): string {
  if (runtimeState === "waiting_for_user") return "waiting for you";
  if (runtimeState === "idle_open") return "idle";
  if (runtimeState === "running") return "responding";
  if (runtimeState === "closed") return "closed";
  if (runtimeState === "cancelled") return "cancelled";
  return runtimeState.replaceAll("_", " ");
}

function monHarnessMeta(mon: Mon): ChipMeta {
  const label = (mon.default_harness ?? "").trim() || "harness";
  return { label: label.replaceAll("_", " "), tone: label === "harness" ? "neutral" : "blue" };
}

function monStatusMeta(monRuns: Run[], monThreads: Run[]): ChipMeta {
  if (monRuns.some((run) => run.status === "active" || run.status === "starting") || monThreads.some((thread) => thread.runtime_state === "running")) {
    return { label: "working", tone: "blue" };
  }
  if (monThreads.some((thread) => thread.runtime_state === "waiting_for_user")) {
    return { label: "waiting", tone: "amber" };
  }
  if (monRuns.some((run) => run.status === "queued") || monThreads.some((thread) => thread.runtime_state === "queued")) {
    return { label: "queued", tone: "amber" };
  }
  if (monThreads.some((thread) => thread.runtime_state === "failed" || thread.runtime_state === "cancelled")) {
    return { label: "needs review", tone: "red" };
  }
  return { label: "idle", tone: "green" };
}

function monModeMeta(mon: Mon): ChipMeta {
  const sandboxMode = monSandboxMode(mon);
  if (sandboxMode.includes("write")) return { label: "write", tone: "amber" };
  if (sandboxMode.includes("read")) return { label: "read only", tone: "green" };
  if (sandboxMode) return { label: sandboxMode.replaceAll("_", " "), tone: "neutral" };
  return { label: "mode default", tone: "neutral" };
}

function monSandboxMode(mon: Mon): string {
  const defaults = mon.harness_defaults ?? {};
  const preferredHarness = mon.default_harness ?? "";
  const preferred = preferredHarness ? defaults[preferredHarness]?.sandbox_mode : undefined;
  if (preferred) return preferred;
  if (defaults.codex?.sandbox_mode) return defaults.codex.sandbox_mode;

  const firstDefault = Object.values(defaults).find((entry) => entry?.sandbox_mode);
  return firstDefault?.sandbox_mode ?? "";
}

function threadHarnessMeta(thread: Run, mon: Mon | undefined): ChipMeta {
  const raw =
    typeof thread.execution?.runner === "string"
      ? thread.execution.runner
      : typeof thread.execution?.runner_type === "string"
        ? thread.execution.runner_type
        : mon?.default_harness ?? "";
  const label = raw.trim() || "harness";
  return { label: label.replaceAll("_", " "), tone: label === "harness" ? "neutral" : "blue" };
}

function threadStatusMeta(thread: Run): ChipMeta {
  if (thread.runtime_state === "running") return { label: "working", tone: "blue" };
  if (thread.runtime_state === "waiting_for_user") return { label: "waiting", tone: "amber" };
  if (thread.runtime_state === "idle_open") return { label: "idle", tone: "green" };
  if (thread.runtime_state === "queued") return { label: "queued", tone: "amber" };
  if (thread.runtime_state === "closed") return { label: "closed", tone: "neutral" };
  if (thread.runtime_state === "failed") return { label: "failed", tone: "red" };
  if (thread.runtime_state === "cancelled") return { label: "cancelled", tone: "red" };
  return { label: threadRuntimeLabel(thread.runtime_state), tone: "neutral" };
}

function threadModeMeta(thread: Run): ChipMeta {
  if (isDraftThreadRun(thread)) return { label: "draft", tone: "neutral" };
  if (thread.execution?.can_write === true) return { label: "write", tone: "amber" };
  if (thread.execution?.can_write === false) return { label: "read only", tone: "green" };
  const sandbox = typeof thread.execution?.sandbox_mode === "string" ? thread.execution.sandbox_mode : "";
  if (sandbox.includes("write")) return { label: "write", tone: "amber" };
  if (sandbox.includes("read")) return { label: "read only", tone: "green" };
  return { label: "mode unknown", tone: "neutral" };
}

function threadTitle(thread: Run, mons: Mon[]): string {
  const mon = mons.find((candidate) => candidate.id === thread.mon_id);
  return mon ? monDisplayName(mon) : monIdDisplayName(thread.mon_id);
}

function createLocalRunEvent(runId: string, eventType: string, payload: Record<string, unknown>): RunEvent {
  return {
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    run_id: runId,
    event_type: eventType,
    payload,
    created_at: new Date().toISOString()
  };
}

function appendLocalEvent(events: RunEvent[], event: RunEvent): RunEvent[] {
  return events.some((existing) => existing.id === event.id) ? events : [...events, event];
}

function chatEventAuthor(event: RunEvent): "user" | "mon" | "system" | "error" {
  if (event.event_type === "user_message") return "user";
  if (event.event_type === "mon_message") return "mon";
  if (event.event_type === "error") return "mon";
  return "system";
}

function chatEventContent(event: RunEvent): string {
  if (event.event_type === "error") {
    const content = typeof event.payload.content === "string" ? event.payload.content : "Response failed.";
    const timeoutReason = typeof event.payload.timeout_reason === "string" ? event.payload.timeout_reason : "";
    const lastActivityAt = typeof event.payload.last_activity_at === "string" ? event.payload.last_activity_at : "";
    const lastActivityText = lastActivityAt ? ` Last activity: ${formatChatTimestampTitle(lastActivityAt)}.` : "";
    if (timeoutReason === "idle_timeout") {
      const timeoutMs = typeof event.payload.idle_timeout_ms === "number" ? event.payload.idle_timeout_ms : undefined;
      const windowText = timeoutMs ? ` for ${formatDuration(timeoutMs)}` : "";
      return `${content} No harness activity${windowText}.${lastActivityText}`;
    }
    if (timeoutReason === "hard_timeout") {
      const timeoutMs = typeof event.payload.hard_timeout_ms === "number" ? event.payload.hard_timeout_ms : undefined;
      const windowText = timeoutMs ? ` of ${formatDuration(timeoutMs)}` : "";
      return `${content} Turn exceeded the maximum duration${windowText}.${lastActivityText}`;
    }

    const detail = typeof event.payload.detail === "string" ? event.payload.detail : "";
    return detail && detail !== content ? `${content} ${detail}` : content;
  }

  if (typeof event.payload.content === "string") return event.payload.content;
  if (typeof event.payload.message === "string") return event.payload.message;
  if (typeof event.payload.chunk === "string") return event.payload.chunk;
  return JSON.stringify(event.payload);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds >= 60000 && milliseconds % 60000 === 0) {
    const minutes = milliseconds / 60000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  if (milliseconds >= 1000 && milliseconds % 1000 === 0) {
    const seconds = milliseconds / 1000;
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }

  return `${milliseconds}ms`;
}

function chatTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
  } catch {
    return "America/Los_Angeles";
  }
}

function formatChatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const timeZone = chatTimeZone();
  const date = new Date(timestamp);
  const currentDate = new Date();
  const dateParts = chatCalendarParts(date, timeZone);
  const currentDateParts = chatCalendarParts(currentDate, timeZone);
  const isCurrentDay = dateParts.year === currentDateParts.year && dateParts.month === currentDateParts.month && dateParts.day === currentDateParts.day;
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    ...(isCurrentDay ? {} : {
      month: "short",
      day: "numeric",
      ...(dateParts.year === currentDateParts.year ? {} : { year: "numeric" })
    }),
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function chatCalendarParts(date: Date, timeZone: string): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(date);
  return {
    year: parts.find((part) => part.type === "year")?.value ?? "",
    month: parts.find((part) => part.type === "month")?.value ?? "",
    day: parts.find((part) => part.type === "day")?.value ?? ""
  };
}

function formatChatTimestampTitle(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: chatTimeZone(),
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(timestamp));
}

function sidebarMachineIdForMonde(monde: Monde): string {
  const key = `${monde.id} ${monde.name} ${monde.root}`.toLowerCase();
  if (key.includes("ui-demo") || key.includes("demo") || key.includes("backup")) return "ui-demo-machine";
  if (key.includes("cli") || key.includes("frontend") || key.includes("service") || key.includes("temporary") || key.includes("temp")) {
    return "cli-machine";
  }
  return "nightstand-machine";
}

function monDisplayName(mon: Mon): string {
  return monIdDisplayName(mon.id);
}

function monIdDisplayName(monId: string): string {
  return monId.endsWith(".mon") ? monId : `${monId}.mon`;
}

function tabLabel(tab: ActiveTab): string {
  return tab[0].toUpperCase() + tab.slice(1);
}

function statusTone(status: string): "default" | "blue" | "green" | "amber" | "red" {
  if (status === "active" || status === "starting") return "green";
  if (status === "queued") return "amber";
  if (status === "blocked") return "red";
  if (status === "finished") return "blue";
  return "default";
}

function outcomeTone(outcome: string): "default" | "blue" | "green" | "amber" | "red" {
  if (outcome === "completed") return "green";
  if (outcome === "failed" || outcome === "interrupted") return "red";
  if (outcome === "stopped" || outcome === "canceled") return "amber";
  return "default";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
