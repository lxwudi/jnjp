import { computed, proxyRefs, reactive, ref } from "vue";
import { parseHistory } from "../lib/csv";
import {
  CARBON_FACTOR,
  TREE_FACTOR,
  computeRecommendedThreshold,
  exampleCsv,
  formatDate,
  getInterfaceStatus,
  sampleInterfaces,
  sampleLogs,
  strategyLabel,
  summarize,
  trendSeries as defaultTrendSeries,
  validateExecutionSchedule,
  validateIp,
} from "../lib/energy";
import type {
  AgentAutonomySnapshot,
  AgentJobEventRecord,
  AgentJobRecord,
  AgentProviderConfigSnapshot,
  AgentReasoningEffort,
  AgentRunRecord,
  AgentRunSummary,
  AgentStatus,
  AutonomyRuntimeSnapshot,
  AdviceRecord,
  AuditRecord,
  InterfaceFormState,
  InterfaceRecord,
  SnmpConfig,
  StrategyKey,
} from "../types";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "http://localhost:8787";
const DEFAULT_USERNAME = (import.meta.env.VITE_API_USERNAME as string | undefined) || "admin";
const DEFAULT_PASSWORD = (import.meta.env.VITE_API_PASSWORD as string | undefined) || "admin123";

interface GuardrailConfigPayload {
  snmpConfig: SnmpConfig;
  guardrailsEnabled: boolean;
  recommendedThreshold: number;
}

interface OverviewPayload {
  manualThreshold: number;
  idleDuration: number;
  guardrailsEnabled: boolean;
  snmpConfig: SnmpConfig;
  metrics?: OverviewMetricsPayload;
}

interface OverviewMetricsPayload {
  pendingAdvice: AdviceRecord[];
  appliedAdvice: AdviceRecord[];
  executedActionCount: number;
  idlePorts: InterfaceRecord[];
  totalSaving: number;
  projectedSaving: number;
  totalHours: number;
  carbon: number;
  trees: number;
  guardrailCandidates: InterfaceRecord[];
  monthlyGuardrailSaving: number;
  riskLevel: "低" | "中";
  highConfidenceCount: number;
  meanConfidence: number;
}

interface ManualAnalyzePayload extends OverviewPayload {
  advice: AdviceRecord[];
}

interface TrendPayload {
  trend: {
    labels: string[];
    saving: number[];
    carbon: number[];
  };
  donut?: Array<{
    label: string;
    value: number;
    color: string;
  }>;
}

interface ImportCsvPayload {
  insertedCount: number;
  errorCount: number;
}

interface LoginPayload {
  token: string;
}

interface TrendSeriesItem {
  label: string;
  color: string;
  values: number[];
}

interface AgentRunsPayload {
  items: AgentRunRecord[];
  summary: AgentRunSummary;
}

interface AgentJobsPayload {
  items: AgentJobRecord[];
}

interface AgentStatusPayload extends AgentStatus {}
interface AgentAutonomyPayload extends AgentAutonomySnapshot {}
interface AgentProviderPayload extends AgentProviderConfigSnapshot {}

interface AgentPlanPayload {
  run: AgentRunRecord;
  summary: AgentRunSummary;
  job?: AgentJobRecord | null;
}

interface AgentStreamEnvelope {
  type: "job" | "event" | "result" | "error";
  job?: AgentJobRecord | null;
  event?: AgentJobEventRecord;
  run?: AgentRunRecord;
  summary?: AgentRunSummary;
  message?: string;
}

const defaultTrendLabels = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

function humanizeAgentMessage(message: string | null | undefined) {
  const text = String(message || "").trim();
  const normalized = text.toLowerCase();
  if (!text) return "尚无最近一轮输出。";
  if (normalized.includes("402") && normalized.includes("insufficient balance")) {
    return "模型服务余额不足，当前无法调用智能体模型。";
  }
  if (normalized.includes("insufficient_quota")) {
    return "模型服务额度不足，当前无法继续调用智能体模型。";
  }
  if (normalized.includes("401")) {
    return "模型服务鉴权失败，请检查 API Key 或接入地址。";
  }
  if (normalized.includes("429")) {
    return "模型服务请求过于频繁，当前已被限流。";
  }
  if (normalized.includes("connection error")) {
    return "模型服务连接失败，请检查网络或服务地址。";
  }
  return text;
}

function toMessage(error: unknown) {
  if (error instanceof Error && error.message) return humanizeAgentMessage(error.message);
  return "请求失败，请稍后重试";
}

function normalizeProviderBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isDeepSeekCompatibleModel(model: string, baseUrl = ""): boolean {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  return normalizedModel.startsWith("deepseek") || normalizedBaseUrl.includes("deepseek.com");
}

function normalizeAgentStatusPayload(payload: AgentStatusPayload): AgentStatusPayload {
  return {
    ...payload,
    message: humanizeAgentMessage(payload.message),
  };
}

function normalizeAgentEventPayload(event: AgentJobEventRecord): AgentJobEventRecord {
  return {
    ...event,
    message: humanizeAgentMessage(event.message),
  };
}

function normalizeAgentJobPayload(job: AgentJobRecord): AgentJobRecord {
  return {
    ...job,
    latestMessage: humanizeAgentMessage(job.latestMessage),
    errorMessage: job.errorMessage ? humanizeAgentMessage(job.errorMessage) : job.errorMessage,
    events: Array.isArray(job.events) ? job.events.map(normalizeAgentEventPayload) : job.events,
  };
}

function normalizeAgentRuntimePayload(runtime: AutonomyRuntimeSnapshot): AutonomyRuntimeSnapshot {
  return {
    ...runtime,
    lastMessage: humanizeAgentMessage(runtime.lastMessage),
  };
}

function inferCompatibleProviderBaseUrl(model: string, baseUrl: string): string {
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
  if (normalizedBaseUrl) return normalizedBaseUrl;
  if (isDeepSeekCompatibleModel(model, normalizedBaseUrl)) return DEEPSEEK_BASE_URL;
  return "";
}

function buildSampleCsv() {
  const rows = sampleInterfaces().map((item) =>
    [
      item.name,
      item.ip,
      item.mask,
      String(item.usage),
      `"${item.history.join(",")}"`,
      String(item.connections),
    ].join(","),
  );

  return ["name,ip,mask,usage,history,connections", ...rows].join("\n");
}

function createEnergyConsoleStore() {
  const manualForm = reactive<InterfaceFormState>({
    name: "",
    ip: "",
    mask: "255.255.255.0",
    usage: null,
    history: "",
    connections: null,
  });

  const snmpForm = reactive<SnmpConfig>({
    model: "S5720-28X-SI-AC",
    host: "10.10.0.8",
    version: "v3",
    port: 161,
    credential: "campus-energy",
    security: "authPriv",
    usageThreshold: 15,
    connectionThreshold: 4,
    schedule: "00:00 - 23:59",
    strategy: "hybrid",
  });

  const interfaces = ref<InterfaceRecord[]>([]);
  const advice = ref<AdviceRecord[]>([]);
  const auditLogs = ref<AuditRecord[]>([]);
  const manualThreshold = ref(18);
  const idleDuration = ref(30);
  const guardrailsEnabled = ref(false);
  const formFeedback = ref("正在连接服务...");
  const formError = ref(false);
  const guardrailFeedback = ref("正在更新执行边界...");
  const controlClock = ref(formatDate());
  const authToken = ref("");
  const recommendedThresholdServer = ref(15);
  const trendLabels = ref<string[]>([...defaultTrendLabels]);
  const overviewMetrics = ref<OverviewMetricsPayload | null>(null);
  const trendSeriesData = ref<TrendSeriesItem[]>(
    defaultTrendSeries.map((item) => ({ label: item.label, color: item.color, values: [...item.values] })),
  );
  const trendDonutData = ref<Array<{ label: string; value: number; color: string }>>([]);
  const agentRuns = ref<AgentRunRecord[]>([]);
  const agentSummary = ref<AgentRunSummary>({ planned: 0, executed: 0, totalSaving: 0 });
  const agentActionLimit = ref(8);
  const agentAutonomyEnabled = ref(true);
  const agentIntervalSeconds = ref(60);
  const agentAllowHeuristicFallback = ref(true);
  const agentBusy = ref(false);
  const agentGoal = ref(
    "请为当前校园交换机接口池持续执行低风险、可解释、收益清晰的节能治理，默认自动完成巡检、规划、执行与留痕，并优先保障业务连续性。",
  );
  const agentFeedback = ref("自治智能体待命中，将自动巡检接口池并处理低风险动作。");
  const agentStatus = ref<AgentStatus>({
    kind: "llm_agent",
    provider: "openai",
    configured: false,
    model: "gpt-5.1",
    baseUrl: null,
    reasoningEffort: "medium",
    message: "正在检测智能体可用状态...",
  });
  const agentProviderBaseUrl = ref("");
  const agentProviderModel = ref("gpt-5.1");
  const agentProviderReasoningEffort = ref<AgentReasoningEffort>("medium");
  const agentProviderApiKeyInput = ref("");
  const agentProviderApiKeyConfigured = ref(false);
  const agentProviderApiKeyPreview = ref<string | null>(null);
  const agentProviderSource = ref<"console" | "env" | "default">("default");
  const agentJobs = ref<AgentJobRecord[]>([]);
  const agentProgressFeed = ref<AgentJobEventRecord[]>([]);
  const agentActiveJobId = ref<string | null>(null);
  const agentAutonomyRuntime = ref<AutonomyRuntimeSnapshot>({
    status: "idle",
    currentJobId: null,
    currentRunId: null,
    lastRunId: null,
    lastCycleAt: null,
    lastCycleAtISO: null,
    lastMessage: "自治智能体待命中，将按计划自动巡检接口池。",
    lastOutcome: "idle",
  });
  let refreshInFlight = false;

  async function requestApi<T>(
    path: string,
    options: RequestInit = {},
    authRequired = true,
  ): Promise<T> {
    if (authRequired && !authToken.value) {
      await loginAsDefault();
    }

    const headers = new Headers(options.headers);
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (authRequired && authToken.value) {
      headers.set("Authorization", `Bearer ${authToken.value}`);
    }

    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      data?: T;
      message?: string;
    };

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || `请求失败 (${response.status})`);
    }

    if (payload.data !== undefined) {
      return payload.data;
    }

    return payload as T;
  }

  async function loginAsDefault() {
    const payload = await requestApi<LoginPayload>(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          username: DEFAULT_USERNAME,
          password: DEFAULT_PASSWORD,
        }),
      },
      false,
    );

    if (!payload.token) {
      throw new Error("登录失败，未返回 token");
    }

    authToken.value = payload.token;
  }

  function upsertAgentJob(job: AgentJobRecord | null | undefined) {
    if (!job) return;

    const nextJob = normalizeAgentJobPayload(job);
    agentJobs.value = [nextJob, ...agentJobs.value.filter((item) => item.id !== nextJob.id)];
    agentActiveJobId.value = nextJob.id;

    if (Array.isArray(nextJob.events) && nextJob.events.length) {
      agentProgressFeed.value = [...nextJob.events].slice(-18);
    }
  }

  function appendAgentProgressEvent(event: AgentJobEventRecord | undefined) {
    if (!event) return;

    const nextEvent = normalizeAgentEventPayload(event);

    if (!agentActiveJobId.value) {
      agentActiveJobId.value = nextEvent.jobId;
    }

    if (nextEvent.jobId !== agentActiveJobId.value) {
      return;
    }

    const next = [...agentProgressFeed.value, nextEvent];
    agentProgressFeed.value = next.slice(-18);
  }

  function syncPlannedAgentPayload(payload: AgentPlanPayload) {
    if (payload.run) {
      agentRuns.value = [payload.run, ...agentRuns.value.filter((item) => item.id !== payload.run.id)];
    }
    if (payload.summary) {
      agentSummary.value = payload.summary;
    }
    upsertAgentJob(payload.job);
  }

  function applyPlannedAgentFeedback(run: AgentRunRecord | undefined) {
    const gateMode = run?.gate?.mode === "manual" ? "需人工确认" : "可直接执行";
    const riskLevel = run?.simulation?.risk?.level || "--";
    const saving = run?.simulation?.totals?.savingKwh ?? 0;
    const engineModel = run?.engine?.model || agentStatus.value.model;
    agentFeedback.value = `智能体已生成策略：预计节电 ${saving.toFixed(1)} kWh，风险 ${riskLevel}，${gateMode}，模型 ${engineModel}。`;
  }

  async function openAgentPlanStream(actionLimit: number, goal: string) {
    if (!authToken.value) {
      await loginAsDefault();
    }

    const response = await fetch(`${API_BASE}/api/agents/plan/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken.value}`,
      },
      body: JSON.stringify({
        actionLimit,
        goal,
      }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(payload.message || `请求失败 (${response.status})`);
    }

    return response;
  }

  function syncSnmpForm(next: Partial<SnmpConfig>) {
    if (next.model !== undefined) snmpForm.model = next.model;
    if (next.host !== undefined) snmpForm.host = next.host;
    if (next.version !== undefined) snmpForm.version = next.version;
    if (next.port !== undefined) snmpForm.port = next.port;
    if (next.credential !== undefined) snmpForm.credential = next.credential;
    if (next.security !== undefined) snmpForm.security = next.security;
    if (next.usageThreshold !== undefined) snmpForm.usageThreshold = next.usageThreshold;
    if (next.connectionThreshold !== undefined) snmpForm.connectionThreshold = next.connectionThreshold;
    if (next.schedule !== undefined) snmpForm.schedule = next.schedule;
    if (next.strategy !== undefined) snmpForm.strategy = next.strategy;
  }

  async function loadInterfaces() {
    interfaces.value = await requestApi<InterfaceRecord[]>("/api/interfaces");
  }

  async function loadAdvice() {
    advice.value = await requestApi<AdviceRecord[]>("/api/advice");
  }

  async function loadAuditLogs(limit = 120) {
    auditLogs.value = await requestApi<AuditRecord[]>(`/api/audit/logs?limit=${limit}`);
  }

  async function loadGuardrailConfig() {
    const payload = await requestApi<GuardrailConfigPayload>("/api/guardrails/config");
    syncSnmpForm(payload.snmpConfig);
    guardrailsEnabled.value = Boolean(payload.guardrailsEnabled);
    if (Number.isFinite(payload.recommendedThreshold)) {
      recommendedThresholdServer.value = payload.recommendedThreshold;
    }
  }

  async function loadOverviewStats() {
    const payload = await requestApi<OverviewPayload>("/api/stats/overview");

    if (Number.isFinite(payload.manualThreshold)) {
      manualThreshold.value = payload.manualThreshold;
    }
    if (Number.isFinite(payload.idleDuration)) {
      idleDuration.value = payload.idleDuration;
    }

    guardrailsEnabled.value = Boolean(payload.guardrailsEnabled);
    syncSnmpForm(payload.snmpConfig);
    overviewMetrics.value = payload.metrics ?? null;
  }

  async function loadTrendStats() {
    const payload = await requestApi<TrendPayload>("/api/stats/trend");
    if (!payload.trend) return;

    const labels = Array.isArray(payload.trend.labels) && payload.trend.labels.length ? payload.trend.labels : defaultTrendLabels;
    const saving = Array.isArray(payload.trend.saving) ? payload.trend.saving : [];
    const carbon = Array.isArray(payload.trend.carbon) ? payload.trend.carbon : [];

    trendLabels.value = [...labels];
    trendSeriesData.value = [
      { label: "节电量", color: "#c5ff48", values: [...saving] },
      { label: "减碳量", color: "#00c2ff", values: [...carbon] },
    ];

    trendDonutData.value = Array.isArray(payload.donut)
      ? payload.donut
          .map((item) => ({
            label: String(item.label || ""),
            value: Number(item.value) || 0,
            color: String(item.color || "#8aa7b1"),
          }))
          .filter((item) => item.label)
      : [];
  }

  async function loadAgentRuns(limit = 20) {
    const payload = await requestApi<AgentRunsPayload>(`/api/agents/runs?limit=${limit}`);
    agentRuns.value = Array.isArray(payload.items) ? payload.items : [];
    if (payload.summary) {
      agentSummary.value = payload.summary;
    }
  }

  async function loadAgentJobs(limit = 12) {
    const payload = await requestApi<AgentJobsPayload>(`/api/agents/jobs?limit=${limit}`);
    agentJobs.value = Array.isArray(payload.items) ? payload.items.map(normalizeAgentJobPayload) : [];

    const latestJob = agentJobs.value[0];
    if (latestJob) {
      agentActiveJobId.value = latestJob.id;
      agentProgressFeed.value = Array.isArray(latestJob.events) ? latestJob.events.slice(-18) : [];
    }
  }

  async function loadAgentStatus() {
    const payload = normalizeAgentStatusPayload(await requestApi<AgentStatusPayload>("/api/agents/status"));
    agentStatus.value = payload;
  }

  async function loadAgentProviderConfig() {
    const payload = await requestApi<AgentProviderPayload>("/api/agents/provider");
    agentProviderModel.value = payload.model || "gpt-5.1";
    agentProviderBaseUrl.value = inferCompatibleProviderBaseUrl(agentProviderModel.value, payload.baseUrl || "");
    agentProviderReasoningEffort.value = payload.reasoningEffort || "medium";
    agentProviderApiKeyConfigured.value = Boolean(payload.apiKeyConfigured);
    agentProviderApiKeyPreview.value = payload.apiKeyPreview || null;
    agentProviderSource.value = payload.source || "default";
  }

  async function loadAgentAutonomy() {
    const payload = await requestApi<AgentAutonomyPayload>("/api/agents/autonomy");
    if (payload?.config) {
      agentAutonomyEnabled.value = Boolean(payload.config.enabled);
      agentIntervalSeconds.value = Number(payload.config.intervalSeconds) || 60;
      agentActionLimit.value = Number(payload.config.actionLimit) || 6;
      agentGoal.value = payload.config.goal || agentGoal.value;
      agentAllowHeuristicFallback.value = Boolean(payload.config.allowHeuristicFallback);
    }
    if (payload?.runtime) {
      agentAutonomyRuntime.value = normalizeAgentRuntimePayload(payload.runtime);
      if (agentAutonomyRuntime.value.lastMessage) {
        agentFeedback.value = agentAutonomyRuntime.value.lastMessage;
      }
    }
  }

  async function refreshConsole() {
    await loadInterfaces();
    await Promise.all([
      loadAdvice(),
      loadAuditLogs(),
      loadOverviewStats(),
      loadGuardrailConfig(),
      loadTrendStats(),
      loadAgentStatus(),
      loadAgentProviderConfig(),
      loadAgentAutonomy(),
      loadAgentJobs(),
      loadAgentRuns(),
    ]);
  }

  async function refreshLiveState() {
    if (refreshInFlight) return;
    refreshInFlight = true;

    try {
      await Promise.all([
        loadInterfaces(),
        loadAdvice(),
        loadAuditLogs(60),
        loadOverviewStats(),
        loadGuardrailConfig(),
        loadTrendStats(),
        loadAgentStatus(),
        loadAgentProviderConfig(),
        loadAgentAutonomy(),
        loadAgentJobs(8),
        loadAgentRuns(12),
      ]);
    } catch {
      // Keep the last successful UI snapshot when transient polling fails.
    } finally {
      refreshInFlight = false;
    }
  }

  async function saveAgentAutonomy() {
    agentBusy.value = true;
    try {
      const payload = await requestApi<AgentAutonomyPayload>("/api/agents/autonomy", {
        method: "PUT",
        body: JSON.stringify({
          enabled: agentAutonomyEnabled.value,
          intervalSeconds: Number(agentIntervalSeconds.value),
          actionLimit: Number(agentActionLimit.value),
          goal: agentGoal.value.trim(),
          allowHeuristicFallback: agentAllowHeuristicFallback.value,
        }),
      });

      if (payload.config) {
        agentAutonomyEnabled.value = Boolean(payload.config.enabled);
        agentIntervalSeconds.value = Number(payload.config.intervalSeconds) || agentIntervalSeconds.value;
        agentActionLimit.value = Number(payload.config.actionLimit) || agentActionLimit.value;
        agentGoal.value = payload.config.goal || agentGoal.value;
        agentAllowHeuristicFallback.value = Boolean(payload.config.allowHeuristicFallback);
      }
      if (payload.runtime) {
        agentAutonomyRuntime.value = payload.runtime;
      }

      await refreshLiveState();
      agentFeedback.value = agentAutonomyEnabled.value
        ? `自治智能体已更新，将按 ${agentIntervalSeconds.value} 秒周期自动巡检。`
        : "自治智能体已暂停，当前仅保留监测与配置同步。";
      guardrailFeedback.value = "自治配置已更新，后续巡检会采用最新设置。";
    } catch (error) {
      agentFeedback.value = toMessage(error);
    } finally {
      agentBusy.value = false;
    }
  }

  async function saveAgentProviderConfig() {
    agentBusy.value = true;
    try {
      const requestedModel = agentProviderModel.value.trim() || "gpt-5.1";
      const requestedBaseUrl = inferCompatibleProviderBaseUrl(requestedModel, agentProviderBaseUrl.value.trim());
      const body: Record<string, unknown> = {
        baseUrl: requestedBaseUrl,
        model: requestedModel,
        reasoningEffort: agentProviderReasoningEffort.value,
      };

      if (agentProviderApiKeyInput.value.trim()) {
        body.apiKey = agentProviderApiKeyInput.value.trim();
      }

      const payload = await requestApi<AgentProviderPayload>("/api/agents/provider", {
        method: "PUT",
        body: JSON.stringify(body),
      });

      agentProviderModel.value = payload.model || requestedModel;
      agentProviderBaseUrl.value = inferCompatibleProviderBaseUrl(
        agentProviderModel.value,
        payload.baseUrl || requestedBaseUrl,
      );
      agentProviderReasoningEffort.value = payload.reasoningEffort || agentProviderReasoningEffort.value;
      agentProviderApiKeyConfigured.value = Boolean(payload.apiKeyConfigured);
      agentProviderApiKeyPreview.value = payload.apiKeyPreview || null;
      agentProviderSource.value = payload.source || "default";
      agentProviderApiKeyInput.value = "";

      await Promise.all([loadAgentStatus(), loadAgentProviderConfig()]);
      agentFeedback.value = payload.apiKeyConfigured
        ? "模型接入配置已保存，智能体会按新的设置运行。"
        : "模型接入配置已保存，但当前还没有可用的 API Key。";
    } catch (error) {
      agentFeedback.value = toMessage(error);
    } finally {
      agentBusy.value = false;
    }
  }

  async function clearAgentProviderApiKey() {
    agentBusy.value = true;
    try {
      const requestedModel = agentProviderModel.value.trim() || "gpt-5.1";
      const requestedBaseUrl = inferCompatibleProviderBaseUrl(requestedModel, agentProviderBaseUrl.value.trim());
      const payload = await requestApi<AgentProviderPayload>("/api/agents/provider", {
        method: "PUT",
        body: JSON.stringify({
          clearApiKey: true,
          baseUrl: requestedBaseUrl,
          model: requestedModel,
          reasoningEffort: agentProviderReasoningEffort.value,
        }),
      });

      agentProviderModel.value = payload.model || requestedModel;
      agentProviderBaseUrl.value = inferCompatibleProviderBaseUrl(
        agentProviderModel.value,
        payload.baseUrl || requestedBaseUrl,
      );
      agentProviderApiKeyConfigured.value = Boolean(payload.apiKeyConfigured);
      agentProviderApiKeyPreview.value = payload.apiKeyPreview || null;
      agentProviderApiKeyInput.value = "";
      await Promise.all([loadAgentStatus(), loadAgentProviderConfig()]);
      agentFeedback.value = "已清除已保存的模型 API Key。";
    } catch (error) {
      agentFeedback.value = toMessage(error);
    } finally {
      agentBusy.value = false;
    }
  }

  function resetManualForm() {
    manualForm.name = "";
    manualForm.ip = "";
    manualForm.mask = "255.255.255.0";
    manualForm.usage = null;
    manualForm.history = "";
    manualForm.connections = null;
  }

  async function importCsvText(csvText: string, source: string) {
    const payload = await requestApi<ImportCsvPayload>("/api/interfaces/import-csv", {
      method: "POST",
      body: JSON.stringify({ csvText }),
    });

    await Promise.all([loadInterfaces(), loadAuditLogs(), loadOverviewStats()]);

    formError.value = payload.errorCount > 0 && payload.insertedCount === 0;
    formFeedback.value =
      payload.errorCount > 0
        ? `${source} 导入完成：成功 ${payload.insertedCount} 条，失败 ${payload.errorCount} 条。`
        : `${source} 已导入 ${payload.insertedCount} 个接口。`;
  }

  async function submitInterface() {
    const usage = manualForm.usage;
    const connections = manualForm.connections;

    if (
      !manualForm.name.trim() ||
      !validateIp(manualForm.ip.trim()) ||
      !validateIp(manualForm.mask.trim()) ||
      usage === null ||
      !Number.isFinite(usage) ||
      usage < 0 ||
      usage > 100
    ) {
      formError.value = true;
      formFeedback.value = "请检查接口名称、IP、掩码与带宽利用率格式。";
      return;
    }

    try {
      await requestApi("/api/interfaces", {
        method: "POST",
        body: JSON.stringify({
          name: manualForm.name.trim(),
          ip: manualForm.ip.trim(),
          mask: manualForm.mask.trim(),
          usage,
          history: parseHistory(manualForm.history),
          connections: connections ?? 0,
        }),
      });

      await Promise.all([loadInterfaces(), loadAuditLogs(), loadOverviewStats()]);
      formError.value = false;
      formFeedback.value = `${manualForm.name.trim()} 已录入，可继续添加或直接生成规则建议。`;
      resetManualForm();
    } catch (error) {
      formError.value = true;
      formFeedback.value = toMessage(error);
    }
  }

  async function analyzeInterfaces() {
    if (!interfaces.value.length) {
      formError.value = true;
      formFeedback.value = "请先录入接口或导入 CSV 数据。";
      return;
    }

    try {
      const payload = await requestApi<ManualAnalyzePayload>("/api/manual/analyze", {
        method: "POST",
        body: JSON.stringify({
          manualThreshold: Number(manualThreshold.value),
          idleDuration: Number(idleDuration.value),
        }),
      });

      advice.value = Array.isArray(payload.advice) ? payload.advice : [];
      if (Number.isFinite(payload.manualThreshold)) manualThreshold.value = payload.manualThreshold;
      if (Number.isFinite(payload.idleDuration)) idleDuration.value = payload.idleDuration;
      guardrailsEnabled.value = Boolean(payload.guardrailsEnabled);
      syncSnmpForm(payload.snmpConfig);

      await Promise.all([loadAuditLogs(), loadTrendStats()]);
      formError.value = false;
      formFeedback.value = `已生成 ${advice.value.length} 条规则建议，可逐条确认或批量应用。`;
    } catch (error) {
      formError.value = true;
      formFeedback.value = toMessage(error);
    }
  }

  async function importSampleSet() {
    try {
      await requestApi("/api/interfaces", { method: "DELETE" });
      await importCsvText(buildSampleCsv(), "推荐样例");
      await analyzeInterfaces();
    } catch (error) {
      formError.value = true;
      formFeedback.value = toMessage(error);
    }
  }

  async function importExampleCsv() {
    try {
      await importCsvText(exampleCsv, "示例 CSV");
    } catch (error) {
      formError.value = true;
      formFeedback.value = toMessage(error);
    }
  }

  async function handleCsvUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      await importCsvText(text, file.name);
    } catch (error) {
      formError.value = true;
      formFeedback.value = toMessage(error);
    } finally {
      input.value = "";
    }
  }

  async function applyAdvice(id: string) {
    try {
      await requestApi(`/api/advice/${encodeURIComponent(id)}/apply`, { method: "POST" });
      await Promise.all([loadInterfaces(), loadAdvice(), loadAuditLogs(), loadOverviewStats(), loadTrendStats()]);
      formError.value = false;
      formFeedback.value = "建议已执行，结果已更新。";
    } catch (error) {
      formError.value = true;
      formFeedback.value = toMessage(error);
    }
  }

  async function applyAllAdvice() {
    try {
      await requestApi("/api/advice/apply-all", { method: "POST" });
      await Promise.all([loadInterfaces(), loadAdvice(), loadAuditLogs(), loadOverviewStats(), loadTrendStats()]);
      formError.value = false;
      formFeedback.value = "已执行全部建议，结果已更新。";
    } catch (error) {
      formError.value = true;
      formFeedback.value = toMessage(error);
    }
  }

  async function recommendThreshold() {
    try {
      const payload = await requestApi<{ usageThreshold: number }>("/api/guardrails/recommend-threshold", {
        method: "POST",
      });
      if (Number.isFinite(payload.usageThreshold)) {
        snmpForm.usageThreshold = payload.usageThreshold;
        recommendedThresholdServer.value = payload.usageThreshold;
      }
      await Promise.all([loadGuardrailConfig(), loadOverviewStats(), loadAuditLogs()]);
      guardrailFeedback.value = `系统已根据历史数据推荐智能体护栏阈值 ${recommendedThreshold.value}%。`;
    } catch (error) {
      guardrailFeedback.value = toMessage(error);
    }
  }

  async function toggleGuardrails() {
    const nextActive = !guardrailsEnabled.value;
    const checkedSchedule = validateExecutionSchedule(snmpForm.schedule);

    if (!checkedSchedule.ok) {
      guardrailFeedback.value = checkedSchedule.message || "执行时窗格式不合法。";
      return;
    }

    snmpForm.schedule = checkedSchedule.normalized;

    try {
      await requestApi("/api/guardrails/config", {
        method: "PUT",
        body: JSON.stringify({
          model: snmpForm.model,
          host: snmpForm.host,
          version: snmpForm.version,
          port: snmpForm.port,
          credential: snmpForm.credential,
          security: snmpForm.security,
          usageThreshold: Number(snmpForm.usageThreshold),
          connectionThreshold: Number(snmpForm.connectionThreshold),
          schedule: snmpForm.schedule,
          strategy: snmpForm.strategy,
        }),
      });

      await requestApi("/api/guardrails/toggle", {
        method: "POST",
        body: JSON.stringify({ active: nextActive }),
      });

      guardrailsEnabled.value = nextActive;

      if (nextActive) {
        const preview = await requestApi<{ candidateCount: number; withinSchedule: boolean }>("/api/guardrails/run", {
          method: "POST",
          body: JSON.stringify({ dryRun: true }),
        });

        if (agentAutonomyEnabled.value) {
          await requestApi("/api/agents/autonomy/run-now", { method: "POST" });
        }

        guardrailFeedback.value = preview.withinSchedule
          ? `智能体护栏已启用，当前有 ${preview.candidateCount} 个候选接口。`
          : "智能体护栏已启用，但当前不在设定作业时窗内。";
      } else {
        guardrailFeedback.value = "智能体护栏已停用，当前仅保留配置供智能体参考。";
      }

      await Promise.all([loadGuardrailConfig(), loadOverviewStats(), loadAuditLogs(), loadTrendStats(), loadAgentAutonomy()]);
    } catch (error) {
      guardrailFeedback.value = toMessage(error);
    }
  }

  async function clearInterfaces() {
    try {
      await requestApi("/api/interfaces", { method: "DELETE" });
      await Promise.all([loadInterfaces(), loadAdvice(), loadAuditLogs(), loadOverviewStats(), loadTrendStats()]);
      formError.value = false;
      formFeedback.value = "接口池已清空。";
    } catch (error) {
      formError.value = true;
      formFeedback.value = toMessage(error);
    }
  }

  async function seedAuditLogs() {
    try {
      await requestApi("/api/audit/logs/seed", { method: "POST" });
      await loadAuditLogs();
    } catch (error) {
      guardrailFeedback.value = toMessage(error);
    }
  }

  async function generateAgentPlan() {
    agentBusy.value = true;
    agentProgressFeed.value = [];
    agentActiveJobId.value = null;
    agentFeedback.value = "智能体已启动，正在读取接口列表和风险状态...";

    try {
      const response = await openAgentPlanStream(Number(agentActionLimit.value), agentGoal.value.trim());

      if (!response.body) {
        const payload = await requestApi<AgentPlanPayload>("/api/agents/plan", {
          method: "POST",
          body: JSON.stringify({
            actionLimit: Number(agentActionLimit.value),
            goal: agentGoal.value.trim(),
          }),
        });

        syncPlannedAgentPayload(payload);
        applyPlannedAgentFeedback(payload.run);
        await Promise.all([loadAuditLogs(), loadTrendStats(), loadAgentJobs()]);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          const envelope = JSON.parse(line) as AgentStreamEnvelope;

          if (envelope.type === "job") {
            upsertAgentJob(envelope.job);
            if (envelope.job?.latestMessage) {
              agentFeedback.value = humanizeAgentMessage(envelope.job.latestMessage);
            }
            continue;
          }

          if (envelope.type === "event") {
            appendAgentProgressEvent(envelope.event);
            if (envelope.event?.message) {
              agentFeedback.value = humanizeAgentMessage(envelope.event.message);
            }
            continue;
          }

          if (envelope.type === "result") {
            syncPlannedAgentPayload({
              run: envelope.run as AgentRunRecord,
              summary: envelope.summary as AgentRunSummary,
              job: envelope.job,
            });
            applyPlannedAgentFeedback(envelope.run);
            continue;
          }

          if (envelope.type === "error") {
            throw new Error(envelope.message || "智能体流式规划失败");
          }
        }

        if (done) {
          break;
        }
      }

      const trailing = buffer.trim();
      if (trailing) {
        const envelope = JSON.parse(trailing) as AgentStreamEnvelope;
        if (envelope.type === "result") {
          syncPlannedAgentPayload({
            run: envelope.run as AgentRunRecord,
            summary: envelope.summary as AgentRunSummary,
            job: envelope.job,
          });
          applyPlannedAgentFeedback(envelope.run);
        } else if (envelope.type === "error") {
          throw new Error(envelope.message || "智能体流式规划失败");
        }
      }

      await Promise.all([loadAuditLogs(), loadTrendStats(), loadAgentJobs()]);
    } catch (error) {
      agentFeedback.value = toMessage(error);
    } finally {
      agentBusy.value = false;
    }
  }

  async function executeAgentPlan(runId?: string, force = false) {
    const targetRunId = runId || agentRuns.value[0]?.id;
    if (!targetRunId) {
      agentFeedback.value = "没有可执行的智能体策略。";
      return;
    }

    agentBusy.value = true;
    try {
      const payload = await requestApi<{
        run: AgentRunRecord;
        summary: AgentRunSummary;
        job?: AgentJobRecord | null;
      }>(`/api/agents/${encodeURIComponent(targetRunId)}/execute`, {
        method: "POST",
        body: JSON.stringify({
          approved: true,
          approvedBy: DEFAULT_USERNAME,
          force,
        }),
      });

      if (payload.run) {
        agentRuns.value = [payload.run, ...agentRuns.value.filter((item) => item.id !== payload.run.id)];
      }
      if (payload.summary) {
        agentSummary.value = payload.summary;
      }
      upsertAgentJob(payload.job);

      await Promise.all([
        loadInterfaces(),
        loadAdvice(),
        loadAuditLogs(),
        loadOverviewStats(),
        loadTrendStats(),
        loadAgentStatus(),
        loadAgentJobs(),
      ]);

      const executedCount = payload.run?.execution?.applied?.length ?? 0;
      const totalImpact = payload.run?.execution?.totalImpact ?? 0;
      agentFeedback.value = `智能体策略已执行 ${executedCount} 项，累计节能影响 ${totalImpact.toFixed(1)}。`;
      formError.value = false;
      formFeedback.value = "智能体执行已完成，主看板数据已刷新。";
    } catch (error) {
      agentFeedback.value = toMessage(error);
    } finally {
      agentBusy.value = false;
    }
  }

  async function bootstrap() {
    try {
      await loginAsDefault();
      await refreshConsole();
      formError.value = false;
      formFeedback.value = "已连接服务，自治智能体会按计划自动巡检。";
      guardrailFeedback.value = "执行边界已更新，自治执行会按当前设置运行。";
    } catch (error) {
      interfaces.value = sampleInterfaces();
      auditLogs.value = sampleLogs();
      advice.value = [];
      agentJobs.value = [];
      agentProgressFeed.value = [];
      agentActiveJobId.value = null;
      agentAutonomyRuntime.value = {
        status: "paused",
        currentJobId: null,
        currentRunId: null,
        lastRunId: null,
        lastCycleAt: null,
        lastCycleAtISO: null,
        lastMessage: "未连接服务，自治智能体暂不可用。",
        lastOutcome: "failed",
      };
      recommendedThresholdServer.value = computeRecommendedThreshold(interfaces.value);
      overviewMetrics.value = null;
      formError.value = true;
      formFeedback.value = `服务连接失败，当前显示示例数据：${toMessage(error)}`;
      guardrailFeedback.value = "当前未连接服务，执行边界和保存操作暂不可用。";
      agentStatus.value = {
        kind: "llm_agent",
        provider: "openai",
        configured: false,
        model: "gpt-5.1",
        baseUrl: null,
        reasoningEffort: "medium",
        message: "未连接服务，暂时无法检测智能体状态。",
      };
      agentFeedback.value = "未连接服务，自治智能体当前不可用。";
    }
  }

  const heroMetrics = computed(() =>
    overviewMetrics.value ??
    summarize(interfaces.value, advice.value, Number(manualThreshold.value), Number(idleDuration.value), snmpForm),
  );
  const recommendedThreshold = computed(() =>
    Number.isFinite(recommendedThresholdServer.value)
      ? recommendedThresholdServer.value
      : computeRecommendedThreshold(interfaces.value),
  );
  const securityGrade = computed(() => {
    if (snmpForm.version === "v3" && snmpForm.security === "authPriv") return "A";
    if (snmpForm.version === "v3") return "B";
    return "C";
  });
  const securityHint = computed(() => {
    if (securityGrade.value === "A") return "当前安全配置较完整，适合正式环境使用。";
    if (securityGrade.value === "B") return "建议补充加密配置，进一步提升访问安全性。";
    return "当前配置以兼容性为主，建议根据设备情况提升安全等级。";
  });
  const agentAutonomyStatusLabel = computed(() => {
    if (!agentAutonomyEnabled.value) return "已暂停";
    if (!guardrailsEnabled.value) return "护栏待启用";
    if (agentAutonomyRuntime.value.status === "running") return "巡检中";
    if (agentAutonomyRuntime.value.status === "paused") return "等待条件满足";
    return "自治待命";
  });
  const agentAutonomyOutcomeLabel = computed(() => {
    const outcome = agentAutonomyRuntime.value.lastOutcome;
    if (outcome === "executed") return "最近一轮已自动执行";
    if (outcome === "skipped") return "最近一轮自动跳过";
    if (outcome === "failed") return "最近一轮失败";
    return "尚未完成巡检";
  });
  const agentAutonomyLastCycleLabel = computed(() => agentAutonomyRuntime.value.lastCycleAt || "尚无记录");

  const controlRibbon = computed(() => [
    { label: "执行时窗", value: snmpForm.schedule || "--", tone: "signal-lime" },
    {
      label: "自治状态",
      value: agentAutonomyStatusLabel.value,
      tone: "signal-cyan",
    },
    {
      label: "护栏状态",
      value: guardrailsEnabled.value ? "已启用" : "待启用",
      tone: guardrailsEnabled.value ? "signal-amber" : "signal-steel",
    },
    { label: "最近巡检", value: agentAutonomyLastCycleLabel.value, tone: "signal-steel" },
  ]);

  const tacticalNotes = computed(() => [
    { label: "当前执行时窗", value: snmpForm.schedule || "--" },
    { label: "预估碳回收", value: `${heroMetrics.value.carbon.toFixed(1)} kg CO2` },
    { label: "安全等级", value: `${securityGrade.value} 级` },
    { label: "自治结果", value: agentAutonomyOutcomeLabel.value },
  ]);

  const displayReadouts = computed(() => [
    { label: "年预计节电", value: `${heroMetrics.value.projectedSaving.toFixed(1)} kWh` },
    { label: "智能阈值", value: `${snmpForm.usageThreshold}%` },
    { label: "自治周期", value: `${agentIntervalSeconds.value}s` },
    { label: "减碳收益", value: `${heroMetrics.value.carbon.toFixed(1)} kg` },
  ]);

  const portBoard = computed(() => {
    const cells: Array<{
      id: string;
      slot: string;
      usage: number;
      status: "danger" | "warning" | "active" | "empty";
      mode: string;
      placeholder: boolean;
    }> = interfaces.value.slice(0, 12).map((port, index) => {
      const status = getInterfaceStatus(port, Number(manualThreshold.value)).className;
      const segments = port.name.split("/");

      return {
        id: port.id,
        slot: (segments[segments.length - 1] || String(index + 1)).padStart(2, "0"),
        usage: port.usage,
        status,
        mode: port.applied ? "已执行" : status === "danger" ? "待控" : status === "warning" ? "观察" : "联机",
        placeholder: false,
      };
    });

    while (cells.length < 12) {
      cells.push({
        id: `placeholder-${cells.length}`,
        slot: String(cells.length + 1).padStart(2, "0"),
        usage: 0,
        status: "empty",
        mode: "空位",
        placeholder: true,
      });
    }

    return cells;
  });

  const sectorStats = computed(() => [
    {
      label: "待优化",
      value: heroMetrics.value.idlePorts.length,
      tone: "sector-lime",
    },
    {
      label: "观察中",
      value: interfaces.value.filter(
        (port) => getInterfaceStatus(port, Number(manualThreshold.value)).className === "warning",
      ).length,
      tone: "sector-cyan",
    },
    {
      label: "运行中",
      value: interfaces.value.filter(
        (port) => getInterfaceStatus(port, Number(manualThreshold.value)).className === "active",
      ).length,
      tone: "sector-amber",
    },
  ]);

  const actionPipeline = computed(() => [
    { label: "接口采集", value: `${interfaces.value.length} 个接口`, state: "ready" },
    { label: "自治目标", value: `${agentActionLimit.value} 项 / ${agentIntervalSeconds.value}s`, state: "active" },
    {
      label: "智能体护栏",
      value: guardrailsEnabled.value ? strategyLabel(snmpForm.strategy) : "待启用",
      state: guardrailsEnabled.value ? "armed" : "standby",
    },
    { label: "自治执行", value: agentAutonomyOutcomeLabel.value, state: "ready" },
  ]);

  const donutGroups = computed(() => {
    if (trendDonutData.value.length) {
      return trendDonutData.value;
    }

    const sourceActions = advice.value.length
      ? advice.value.map((item) => item.action)
      : (latestCompletedAgentRun.value?.plan.actions ?? []).map((item) => item.actionLabel);

    return [
      { label: "关闭接口", value: sourceActions.filter((item) => item.includes("关闭")).length, color: "#c5ff48" },
      { label: "低功耗", value: sourceActions.filter((item) => item.includes("低功耗")).length, color: "#00c2ff" },
      { label: "模式调整", value: sourceActions.filter((item) => item.includes("调整") || item.includes("模式")).length, color: "#ff7c45" },
    ];
  });

  const donutTotal = computed(() => donutGroups.value.reduce((sum, item) => sum + item.value, 0));

  const trendSavingTotal = computed(() => {
    const savingSeries = trendSeriesData.value.find((item) => item.label === "节电量") || trendSeriesData.value[0];
    if (!savingSeries) return 0;
    return savingSeries.values.reduce((sum, value) => sum + (Number(value) || 0), 0);
  });

  const trendCarbonTotal = computed(() => trendSavingTotal.value * CARBON_FACTOR);
  const trendTreesTotal = computed(() => trendSavingTotal.value * TREE_FACTOR);

  const timelineRows = computed(() => [
    {
      label: "识别闲置端口",
      value: heroMetrics.value.idlePorts.length,
      width: `${Math.min(heroMetrics.value.idlePorts.length * 22, 100)}%`,
    },
    {
      label: "护栏候选资格",
      value: heroMetrics.value.guardrailCandidates.length,
      width: `${Math.min(heroMetrics.value.guardrailCandidates.length * 26, 100)}%`,
    },
    {
      label: "已执行策略",
      value: heroMetrics.value.executedActionCount,
      width: `${Math.min(heroMetrics.value.executedActionCount * 32, 100)}%`,
    },
  ]);

  const heroWave = computed(() => {
    const values = interfaces.value.map((port) => 20 + port.usage * 2.1);
    const padded = values.length ? values : [18, 26, 12, 30];
    const width = 720;
    const height = 220;
    const step = width / (padded.length - 1 || 1);
    const points = padded.map((value, index) => {
      const x = index * step;
      const y = height - value * 4;
      return [x, y] as const;
    });

    let d = `M ${points[0][0]} ${points[0][1]}`;
    for (let index = 1; index < points.length; index += 1) {
      const [x, y] = points[index];
      const [prevX, prevY] = points[index - 1];
      const cpX = (prevX + x) / 2;
      d += ` C ${cpX} ${prevY}, ${cpX} ${y}, ${x} ${y}`;
    }

    return d;
  });

  const trendSvg = computed(() => {
    const width = 760;
    const height = 320;
    const padding = { top: 18, right: 18, bottom: 38, left: 34 };
    const labels = trendLabels.value.length ? trendLabels.value : defaultTrendLabels;
    const seriesSource = trendSeriesData.value.length ? trendSeriesData.value : defaultTrendSeries;
    const maxValue = Math.max(10, ...seriesSource.flatMap((item) => item.values));
    const xStep = labels.length > 1 ? (width - padding.left - padding.right) / (labels.length - 1) : 0;
    const yScale = (height - padding.top - padding.bottom) / maxValue;

    const gridLines = Array.from({ length: 5 }, (_, index) => {
      const value = (maxValue / 4) * index;
      const y = height - padding.bottom - value * yScale;
      return { value: Math.round(value), y };
    });

    const series = seriesSource.map((item, index) => {
      const values = labels.map((_, valueIndex) => item.values[valueIndex] ?? 0);
      const points = values.map((value, valueIndex) => {
        const x = padding.left + valueIndex * xStep;
        const y = height - padding.bottom - value * yScale;
        return { x, y, value };
      });

      const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
      const area = `${padding.left},${height - padding.bottom} ${polyline} ${
        padding.left + (Math.max(values.length, 1) - 1) * xStep
      },${height - padding.bottom}`;

      return {
        index,
        color: item.color,
        label: item.label,
        points,
        polyline,
        area,
      };
    });

    return { width, height, padding, labels, gridLines, series };
  });

  function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
    const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;

    return {
      x: centerX + radius * Math.cos(angleInRadians),
      y: centerY + radius * Math.sin(angleInRadians),
    };
  }

  function describeArc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
    const start = polarToCartesian(x, y, radius, endAngle);
    const end = polarToCartesian(x, y, radius, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
  }

  const donutArcs = computed(() => {
    if (!donutTotal.value) return [];
    let cursor = 0;

    return donutGroups.value
      .filter((group) => group.value)
      .map((group) => {
        const angle = (group.value / donutTotal.value) * 360;
        const path = describeArc(130, 130, 90, cursor, cursor + angle);
        cursor += angle;
        return { ...group, path };
      });
  });

  const ecoMetrics = computed(() => [
    {
      label: "年减碳量",
      value: `${trendCarbonTotal.value.toFixed(1)} kg`,
      hint: `按近 12 个月治理趋势推算（已落地：${heroMetrics.value.carbon.toFixed(1)} kg）`,
    },
    {
      label: "等效种树量",
      value: `${trendTreesTotal.value.toFixed(1)} 棵`,
      hint: `按近 12 个月治理趋势推算（已落地：${heroMetrics.value.trees.toFixed(1)} 棵）`,
    },
    { label: "节能执行次数", value: `${heroMetrics.value.executedActionCount} 次`, hint: "按自治执行与护栏执行记录统计" },
    { label: "高置信建议", value: `${heroMetrics.value.highConfidenceCount} 条`, hint: "可优先作为节能调整参考" },
  ]);

  const heroCards = computed(() => [
    { label: "接口总量", value: `${interfaces.value.length}`, hint: "纳入联动治理的端口数量" },
    { label: "预计节电量", value: `${heroMetrics.value.projectedSaving.toFixed(1)} kWh`, hint: "基于当前接口状态综合估算" },
    { label: "护栏候选", value: `${heroMetrics.value.guardrailCandidates.length} 个`, hint: "满足当前护栏阈值的接口" },
    { label: "自治结果", value: agentAutonomyOutcomeLabel.value, hint: "最近一轮自治巡检的处理结论" },
  ]);

  const statusTone = (key: StrategyKey) => `tone-${key}`;
  const formatAgentJobStatusLabel = (job: AgentJobRecord | null) => {
    const status = job?.status;
    if (status === "running") return "运行中";
    if (status === "planned") return "已生成计划";
    if (status === "executed") return "已执行";
    if (status === "skipped") return "已跳过";
    if (status === "failed") return "失败";
    return "待命";
  };
  const latestAgentRun = computed<AgentRunRecord | null>(() => agentRuns.value[0] ?? null);
  const latestAgentJob = computed<AgentJobRecord | null>(() => agentJobs.value[0] ?? null);
  const latestCompletedAgentJob = computed<AgentJobRecord | null>(() => {
    const run = latestCompletedAgentRun.value;
    if (run?.jobId) {
      return agentJobs.value.find((job) => job.id === run.jobId) ?? null;
    }
    if (run) {
      return agentJobs.value.find((job) => job.runId === run.id) ?? null;
    }
    return agentJobs.value.find((job) => job.status !== "running") ?? agentJobs.value[0] ?? null;
  });
  const latestCompletedAgentRun = computed<AgentRunRecord | null>(() => {
    return (
      agentRuns.value.find((run) => {
        const selectedCount = Number(run.plan?.selectedCount || 0);
        const simulatedSaving = Number(run.simulation?.totals?.savingKwh || 0);
        const executedImpact = Number(run.execution?.totalImpact || 0);
        return selectedCount > 0 || simulatedSaving > 0 || executedImpact > 0;
      }) ??
      agentRuns.value[0] ??
      null
    );
  });
  const agentTopActions = computed(() => latestAgentRun.value?.plan?.actions?.slice(0, 6) ?? []);
  const agentNeedsApproval = computed(() => latestAgentRun.value?.gate.mode === "manual");
  const agentRuntimeLabel = computed(() => {
    const provider = latestAgentRun.value?.engine?.provider || agentStatus.value.provider;
    const model = latestAgentRun.value?.engine?.model || agentStatus.value.model;
    return `${provider} · ${model}`;
  });
  const agentRuntimeMode = computed(() => latestAgentRun.value?.engine?.kind || "llm_agent");
  const latestCompletedAgentTopActions = computed(() => latestCompletedAgentRun.value?.plan?.actions?.slice(0, 6) ?? []);
  const latestCompletedAgentNeedsApproval = computed(() => latestCompletedAgentRun.value?.gate.mode === "manual");
  const latestCompletedAgentRuntimeLabel = computed(() => {
    const provider =
      latestCompletedAgentRun.value?.engine?.provider || latestCompletedAgentJob.value?.engine?.provider || agentStatus.value.provider;
    const model =
      latestCompletedAgentRun.value?.engine?.model || latestCompletedAgentJob.value?.engine?.model || agentStatus.value.model;
    return `${provider} · ${model}`;
  });
  const latestCompletedAgentRuntimeMode = computed(() => {
    return latestCompletedAgentRun.value?.engine?.kind || latestCompletedAgentJob.value?.engine?.kind || "llm_agent";
  });
  const agentWorkflowLabel = computed(() => {
    const workflow = latestAgentRun.value?.engine?.workflow || latestAgentJob.value?.workflow || [];
    return workflow.length ? workflow.join(" -> ") : "planner -> reviewer -> execution";
  });
  const latestCompletedAgentWorkflowLabel = computed(() => {
    const workflow = latestCompletedAgentRun.value?.engine?.workflow || latestCompletedAgentJob.value?.workflow || [];
    return workflow.length ? workflow.join(" -> ") : "planner -> reviewer -> execution";
  });
  const agentLatestJobStatusLabel = computed(() => {
    return formatAgentJobStatusLabel(latestAgentJob.value);
  });
  const latestCompletedAgentJobStatusLabel = computed(() => {
    if (latestCompletedAgentJob.value) return formatAgentJobStatusLabel(latestCompletedAgentJob.value);
    if (latestCompletedAgentRun.value?.status === "executed") return "已执行";
    if (latestCompletedAgentRun.value?.status === "planned") return "已生成计划";
    return "待命";
  });
  const latestCompletedAgentExplanation = computed(() => {
    const latestFailedJob =
      latestAgentJob.value && latestAgentJob.value.status === "failed" ? latestAgentJob.value : null;
    const displayJobId = latestCompletedAgentJob.value?.id;

    if (latestFailedJob && latestFailedJob.id !== displayJobId && latestCompletedAgentRun.value) {
      return `${humanizeAgentMessage(latestFailedJob.latestMessage)} 当前展示上一轮已记录结果。`;
    }

    return latestCompletedAgentRun.value?.explanation || humanizeAgentMessage(latestCompletedAgentJob.value?.latestMessage);
  });
  const latestCompletedAgentReviewSummary = computed(() => latestCompletedAgentRun.value?.review?.summary || "");
  const latestCompletedAgentReviewNotes = computed(() => latestCompletedAgentRun.value?.review?.notes ?? []);

  void bootstrap();

  return {
    actionPipeline,
    agentActionLimit,
    agentAutonomyEnabled,
    agentAutonomyLastCycleLabel,
    agentAutonomyOutcomeLabel,
    agentAutonomyRuntime,
    agentAutonomyStatusLabel,
    agentAllowHeuristicFallback,
    agentBusy,
    agentFeedback,
    agentGoal,
    agentIntervalSeconds,
    agentJobs,
    agentLatestJobStatusLabel,
    agentNeedsApproval,
    agentProviderApiKeyConfigured,
    agentProviderApiKeyInput,
    agentProviderApiKeyPreview,
    agentProviderBaseUrl,
    agentProviderModel,
    agentProviderReasoningEffort,
    agentProviderSource,
    agentProgressFeed,
    agentRuns,
    agentSummary,
    agentStatus,
    agentTopActions,
    agentWorkflowLabel,
    agentRuntimeLabel,
    agentRuntimeMode,
    toggleGuardrails,
    advice,
    analyzeInterfaces,
    applyAdvice,
    applyAllAdvice,
    auditLogs,
    clearAgentProviderApiKey,
    guardrailFeedback,
    guardrailsEnabled,
    clearInterfaces,
    controlClock,
    controlRibbon,
    displayReadouts,
    donutArcs,
    donutGroups,
    donutTotal,
    ecoMetrics,
    executeAgentPlan,
    formError,
    formFeedback,
    generateAgentPlan,
    getInterfaceStatus,
    handleCsvUpload,
    heroCards,
    heroMetrics,
    heroWave,
    idleDuration,
    importExampleCsv,
    importSampleSet,
    interfaces,
    latestAgentJob,
    latestCompletedAgentExplanation,
    latestCompletedAgentJob,
    latestCompletedAgentJobStatusLabel,
    latestCompletedAgentNeedsApproval,
    latestCompletedAgentReviewNotes,
    latestCompletedAgentReviewSummary,
    latestCompletedAgentRun,
    latestCompletedAgentRuntimeLabel,
    latestCompletedAgentRuntimeMode,
    latestCompletedAgentTopActions,
    latestCompletedAgentWorkflowLabel,
    manualForm,
    latestAgentRun,
    manualThreshold,
    portBoard,
    recommendThreshold,
    recommendedThreshold,
    refreshLiveState,
    saveAgentAutonomy,
    saveAgentProviderConfig,
    sectorStats,
    securityGrade,
    securityHint,
    seedAuditLogs,
    snmpForm,
    statusTone,
    strategyLabel,
    submitInterface,
    tacticalNotes,
    timelineRows,
    trendSeries: trendSeriesData,
    trendSvg,
  };
}

const rawEnergyConsole = createEnergyConsoleStore();
const energyConsole = proxyRefs(rawEnergyConsole);
let clockTimer: number | undefined;
let livePollTimer: number | undefined;

function ensureClockRunning() {
  if (clockTimer || typeof window === "undefined") return;

  clockTimer = window.setInterval(() => {
    rawEnergyConsole.controlClock.value = formatDate();
  }, 30_000);
}

function ensureLivePolling() {
  if (livePollTimer || typeof window === "undefined") return;

  livePollTimer = window.setInterval(() => {
    void rawEnergyConsole.refreshLiveState();
  }, 12_000);
}

if (typeof window !== "undefined") {
  ensureClockRunning();
  ensureLivePolling();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (clockTimer && typeof window !== "undefined") {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
    if (livePollTimer && typeof window !== "undefined") {
      window.clearInterval(livePollTimer);
      livePollTimer = undefined;
    }
  });
}

export function useEnergyConsole() {
  ensureClockRunning();
  ensureLivePolling();
  return energyConsole;
}
