import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AdapterInfoDto,
  ArtifactDetailDto,
  ArtifactDto,
  BackupInfoDto,
  CronScheduleDto,
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
import { UiIcon } from "./components/UiIcon";
import { ConfirmationOverlay, type ConfirmationRequest } from "./components/ConfirmationOverlay";
import { RunsWorkspace } from "./features/runs/RunsWorkspace";
import { ReviewWorkspace } from "./features/runs/ReviewWorkspace";
import { WorldOverview, type SectorCardModel, type SectorTab } from "./features/overview/WorldOverview";
import { PlansView } from "./features/plans/PlansView";
import { CronView } from "./features/cron/CronView";
import { ArtifactsView } from "./features/artifacts/ArtifactsView";
import { StatusView } from "./features/status/StatusView";
import { BottomMonChatRail } from "./features/chat/BottomMonChatRail";
import {
  appendLocalEvent,
  createDraftThreadRun,
  createLocalRunEvent,
  isDraftThreadId,
  isDraftThreadRun,
  isOpenThreadRuntimeState,
  mergeServerAndDraftThreads,
  threadTitle
} from "./features/chat/chatViewModel";
import { MonsView } from "./features/mons/MonsView";
import { appendById, replaceById, upsertById, upsertString } from "./lib/collections";
import { monDisplayName } from "./lib/mon";
import { AppShell, type ActiveTab } from "./layout/AppShell";
import { buildSidebarMachines } from "./layout/sidebarMachines";

type Health = HealthDto;
type Monde = MondeDto;
type Mon = MonDto;
type Run = RunDto;
type Plan = PlanDto;
type CronSchedule = CronScheduleDto;
type RunEvent = RunEventDto;
type LogEvent = LogEventDto;
type Artifact = ArtifactDto;
type ArtifactDetail = ArtifactDetailDto;
type PlanEvidence = PlanEvidenceDto;
type AdapterInfo = AdapterInfoDto;

const storedTokenKey = "monde.serviceToken";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [token, setToken] = useState(() => new URLSearchParams(window.location.search).get("token") ?? localStorage.getItem(storedTokenKey) ?? "");
  const [mondes, setMondes] = useState<Monde[]>([]);
  const [selectedMondeId, setSelectedMondeId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");
  const [mons, setMons] = useState<Mon[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [cronSchedules, setCronSchedules] = useState<CronSchedule[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [threads, setThreads] = useState<Run[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadEvents, setThreadEvents] = useState<Record<string, RunEvent[]>>({});
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [monRailExpanded, setMonRailExpanded] = useState(false);
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
  const [planTitle, setPlanTitle] = useState("Improve Monde operator console");
  const [planPrompt, setPlanPrompt] = useState("Review the operator console and record one useful improvement.");
  const [planMon, setPlanMon] = useState("");
  const [cronName, setCronName] = useState("Daily Mon activation");
  const [cronExpression, setCronExpression] = useState("0 9 * * *");
  const [cronTimezone, setCronTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [cronMon, setCronMon] = useState("");
  const [cronPrompt, setCronPrompt] = useState("Review current Monde work and record the next actionable step.");
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
  const activeRuns = runs.filter((run) => run.status === "active" || run.status === "starting");
  const queuedRuns = runs.filter((run) => run.status === "queued");
  const finishedRuns = runs.filter((run) => run.status === "finished");
  const warningRuns = runs.filter((run) => run.warnings?.length);
  const pendingReviews = runs.filter((run) => run.status === "finished" && run.outcome === "unknown").length;
  const healthLabel = health?.ok ? "Healthy" : health ? "Needs attention" : "Checking";
  // TODO: replace deterministic grouping when the service exposes machine inventory.
  const machineGroups = useMemo(() => buildSidebarMachines(mondes, health), [health, mondes]);
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
      const [monResponse, runResponse, planResponse, cronResponse, artifactResponse, threadResponse, adapterResponse, backupResponse, doctorResponse] = await Promise.all([
        authFetch<{ mons: Mon[] }>(monde ? `/api/mons?monde_id=${encodeURIComponent(monde.id)}` : "/api/mons"),
        authFetch<{ runs: Run[] }>(monde ? `/api/runs?monde_id=${encodeURIComponent(monde.id)}` : "/api/runs"),
        authFetch<{ plans: Plan[] }>(monde ? `/api/plans?monde_id=${encodeURIComponent(monde.id)}` : "/api/plans"),
        authFetch<{ schedules: CronSchedule[] }>(
          monde
            ? `/api/cron-schedules?monde_id=${encodeURIComponent(monde.id)}`
            : "/api/cron-schedules"
        ).catch(() => ({ schedules: [] })),
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
      setCronSchedules(cronResponse.schedules);
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
      if (!cronMon && monResponse.mons[0]) setCronMon(monResponse.mons[0].id);
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

  async function createCronSchedule(event: FormEvent) {
    event.preventDefault();
    if (
      !currentMonde ||
      !cronName ||
      !cronExpression ||
      !cronTimezone ||
      !cronMon ||
      !cronPrompt
    ) {
      return;
    }
    await authFetch("/api/cron-schedules", {
      method: "POST",
      body: JSON.stringify({
        monde_id: currentMonde.id,
        mon_id: cronMon,
        name: cronName,
        expression: cronExpression,
        timezone: cronTimezone,
        title: cronName,
        prompt: cronPrompt,
        enabled: true
      })
    });
    await refreshAll();
  }

  async function toggleCronSchedule(schedule: CronSchedule) {
    await authFetch(`/api/cron-schedules/${encodeURIComponent(schedule.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !schedule.enabled })
    });
    await refreshAll();
  }

  async function archiveCronSchedule(schedule: CronSchedule) {
    await authFetch(`/api/cron-schedules/${encodeURIComponent(schedule.id)}`, {
      method: "DELETE"
    });
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
          : activeTab === "cron" && cronSchedules[0]
            ? {
                selected_entity_type: "cron_schedule",
                visible_entity_ids: cronSchedules
                  .map((schedule) => schedule.id)
                  .slice(0, 25)
              }
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

  const chatRail = (
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
  );

  return (
    <>
      <AppShell
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        machines={machineGroups}
        collapsedMachines={collapsedMachines}
        onToggleMachine={toggleMachine}
        currentMonde={currentMonde}
        onSelectMonde={selectMonde}
        health={health}
        token={token}
        onTokenChange={setToken}
        onRefresh={() => void refreshAll()}
        error={error}
        metrics={{ mons: mons.length, active: activeRuns.length, queued: queuedRuns.length, finished: finishedRuns.length, warnings: warningRuns.length }}
        floatingLayer={chatRail}
      >
          {activeTab === "overview" ? (
            <WorldOverview
              sectors={sectorCards}
              runs={runs}
              mons={mons}
              health={health}
              warningCount={warningRuns.length}
              onSelectTab={setActiveTab}
            />
          ) : null}

          {activeTab === "runs" ? (
            <RunsWorkspace
              runs={runs}
              mons={mons}
              selectedRun={selectedRun}
              onSelectRun={(run) => setSelectedRunId(run.id)}
              detailProps={{
                events, logs, artifacts, artifactDetails, scope, input, setInput,
                onSubmitInput: sendInput,
                onStart: () => { if (selectedRun) void startRun(selectedRun); },
                onStop: () => { if (selectedRun) void stopRun(selectedRun); },
                onInterrupt: () => { if (selectedRun) void interruptRun(selectedRun); },
                onClose: (outcome) => { if (selectedRun) void closeRun(selectedRun, outcome); },
                onReview: (outcome) => { if (selectedRun) void reviewRun(selectedRun, outcome); },
                onRefresh: () => { if (selectedRun) void refreshRunSurfaces(selectedRun.id); },
                reviewSummary, setReviewSummary, reviewNotes, setReviewNotes,
                artifactPath, setArtifactPath, artifactTitle, setArtifactTitle, artifactType, setArtifactType,
                onRegisterArtifact: registerArtifact
              }}
            />
          ) : null}

          {activeTab === "mons" ? (
            <MonsView
              mons={mons} runs={runs} threads={threads}
              prompt={monPrompt} setPrompt={setMonPrompt}
              onChat={(mon) => void openMonThread(mon)}
              onWake={(mon) => void wakeMon(mon)}
              onRunPrompt={(mon) => void messageMon(mon)}
              onEditPermissions={(mon) => void editMonPermissions(mon)}
              onChangeHarness={(mon) => void changeMonHarness(mon)}
              onMoveWorkRoot={(mon) => void moveMonWorkRoot(mon)}
              onUnregister={requestDeleteMon}
            />
          ) : null}

          {activeTab === "plans" ? (
            <PlansView
              plans={plans} mons={mons} runs={runs} evidence={planEvidence}
              canCreate={Boolean(currentMonde)}
              title={planTitle} setTitle={setPlanTitle}
              monId={planMon} setMonId={setPlanMon}
              prompt={planPrompt} setPrompt={setPlanPrompt}
              onCreate={(event) => void createPlan(event)}
              onOpenRun={(runId) => { setSelectedRunId(runId); setActiveTab("review"); }}
              onStartRun={(run) => void startRun(run)}
              onActivate={(plan) => void activatePlan(plan)}
            />
          ) : null}

          {activeTab === "cron" ? (
            <CronView
              schedules={cronSchedules}
              mons={mons}
              canCreate={Boolean(currentMonde)}
              name={cronName}
              setName={setCronName}
              expression={cronExpression}
              setExpression={setCronExpression}
              timezone={cronTimezone}
              setTimezone={setCronTimezone}
              monId={cronMon}
              setMonId={setCronMon}
              prompt={cronPrompt}
              setPrompt={setCronPrompt}
              onCreate={(event) => void createCronSchedule(event)}
              onToggle={(schedule) => void toggleCronSchedule(schedule)}
              onArchive={(schedule) => void archiveCronSchedule(schedule)}
            />
          ) : null}

          {activeTab === "artifacts" ? (
            <ArtifactsView artifacts={allArtifacts} onOpenRun={(runId) => { setSelectedRunId(runId); setActiveTab("review"); }} />
          ) : null}

          {activeTab === "status" ? (
            <StatusView
              health={health}
              adapters={adapters}
              warningRuns={warningRuns}
              backupInfo={backupInfo}
              doctorStatus={doctorStatus}
              canRefresh={Boolean(token)}
              onRefresh={() => void refreshAll()}
            />
          ) : null}

          {activeTab === "review" ? (
            <ReviewWorkspace
              run={selectedRun}
              detailProps={{
                events, logs, artifacts, artifactDetails, scope, input, setInput,
                onSubmitInput: sendInput,
                onStart: () => { if (selectedRun) void startRun(selectedRun); },
                onStop: () => { if (selectedRun) void stopRun(selectedRun); },
                onInterrupt: () => { if (selectedRun) void interruptRun(selectedRun); },
                onClose: (outcome) => { if (selectedRun) void closeRun(selectedRun, outcome); },
                onReview: (outcome) => { if (selectedRun) void reviewRun(selectedRun, outcome); },
                onRefresh: () => { if (selectedRun) void refreshRunSurfaces(selectedRun.id); },
                reviewSummary, setReviewSummary, reviewNotes, setReviewNotes,
                artifactPath, setArtifactPath, artifactTitle, setArtifactTitle, artifactType, setArtifactType,
                onRegisterArtifact: registerArtifact
              }}
            />
          ) : null}
        
      </AppShell>
      <ConfirmationOverlay
        request={confirmation}
        busy={confirmationBusy}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void confirmRequestedAction()}
      />
    </>
  );
}
