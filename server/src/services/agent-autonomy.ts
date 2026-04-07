import type {
  AgentActionRecord,
  AgentAutonomySnapshot,
  AgentRunRecord,
  AutonomyConfig,
  AutonomyRuntimeSnapshot,
  SessionUser,
} from "../types/domain.js";
import { clamp, formatDate, isWithinSchedule } from "../utils/energy.js";
import { executeAndPersistAgentRun } from "./agent-execution.js";
import {
  appendAgentJobEvent,
  createAgentJob,
  failAgentJob,
  markAgentJobPlanned,
  markAgentJobSkipped,
} from "./agent-runtime.js";
import { createAgentRun, createAgentRunFromPlannedActions } from "./agents.js";
import { releaseAppSettingLease, tryAcquireAppSettingLease } from "./interface-db.js";
import {
  createOpenAIAgentRun,
  getOpenAIAgentStatus,
  type AgentProgressEvent,
  type AgentProgressReporter,
} from "./openai-agent.js";
import { DEFAULT_AGENT_GOAL, addAgentRun, addAuditLog, defaultAutonomyConfig, persistState, state } from "./store.js";

const AUTONOMY_OPERATOR: SessionUser = {
  username: "agent-autonomy",
  role: "admin",
  name: "自治智能体",
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const AUTONOMY_MAX_RISK_SCORE = 44;
const AUTONOMY_MIN_CONFIDENCE = 60;
const AUTONOMY_LEASE_KEY = "autonomyRuntimeLease";
const AUTONOMY_INSTANCE_ID = `${AUTONOMY_OPERATOR.username}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

const runtime: AutonomyRuntimeSnapshot = {
  status: "idle",
  currentJobId: null,
  currentRunId: null,
  lastRunId: null,
  lastCycleAt: null,
  lastCycleAtISO: null,
  lastMessage: "自治智能体待命中，将按计划自动巡检接口池。",
  lastOutcome: "idle",
};

let cycleTimer: ReturnType<typeof setTimeout> | null = null;
let cyclePromise: Promise<void> | null = null;
let started = false;

function normalizeConfig(config: AutonomyConfig): AutonomyConfig {
  const fallback = defaultAutonomyConfig();
  return {
    enabled: Boolean(config.enabled),
    intervalSeconds: clamp(Number(config.intervalSeconds) || fallback.intervalSeconds, 15, 3600),
    actionLimit: clamp(Number(config.actionLimit) || fallback.actionLimit, 1, 20),
    goal: String(config.goal || "").trim() || DEFAULT_AGENT_GOAL,
    allowHeuristicFallback:
      typeof config.allowHeuristicFallback === "boolean"
        ? config.allowHeuristicFallback
        : fallback.allowHeuristicFallback,
  };
}

function syncConfigToState(next?: Partial<AutonomyConfig>): AutonomyConfig {
  const merged = normalizeConfig({
    ...defaultAutonomyConfig(),
    ...state.autonomyConfig,
    ...next,
  });
  state.autonomyConfig = merged;
  return merged;
}

function setRuntimeMessage(message: string, outcome?: AutonomyRuntimeSnapshot["lastOutcome"]): void {
  runtime.lastMessage = message;
  if (outcome) {
    runtime.lastOutcome = outcome;
  }
}

function stampCycleTime(): void {
  const now = new Date();
  runtime.lastCycleAtISO = now.toISOString();
  runtime.lastCycleAt = formatDate(now);
}

function toMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim();
    const normalized = message.toLowerCase();
    if (normalized.includes("402") && normalized.includes("insufficient balance")) {
      return "模型服务余额不足，当前无法调用智能体模型。";
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
    return message;
  }
  return "自治智能体运行失败，请稍后重试。";
}

function shouldFallbackToHeuristic(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.trim().toLowerCase();
  return (
    (message.includes("402") && message.includes("insufficient balance"))
    || message.includes("401")
    || message.includes("429")
    || message.includes("connection error")
    || message.includes("timeout")
  );
}

function getAutonomyLeaseTtlMs(config: AutonomyConfig): number {
  return Math.max(120_000, config.intervalSeconds * 3_000);
}

function createRuntimeReporter(jobId: string): AgentProgressReporter {
  return async (event: AgentProgressEvent) => {
    appendAgentJobEvent({
      jobId,
      eventType: event.eventType,
      stage: event.stage,
      agentName: event.agentName ?? null,
      message: event.message,
      payload: event.payload ?? null,
    });
    setRuntimeMessage(event.message);
  };
}

function buildAutonomousActions(run: AgentRunRecord): AgentActionRecord[] {
  return run.plan.actions.filter((action) => {
    const target = state.interfaces.find((port) => port.id === action.portId);
    if (!target || target.applied) return false;
    return action.riskScore <= AUTONOMY_MAX_RISK_SCORE && action.confidence >= AUTONOMY_MIN_CONFIDENCE;
  });
}

function createExecutableRun(run: AgentRunRecord): AgentRunRecord | null {
  const safeActions = buildAutonomousActions(run);
  if (!safeActions.length) return null;

  const allSafe =
    safeActions.length === run.plan.actions.length &&
    run.simulation.risk.highRiskCount === 0 &&
    run.simulation.risk.score < 50;

  if (allSafe) {
    run.gate.mode = "auto";
    run.gate.reason = "自治模式已判定本轮计划为低风险，可直接执行。";
    return run;
  }

  return createAgentRunFromPlannedActions({
    interfaces: state.interfaces,
    manualThreshold: state.manualThreshold,
    idleDuration: state.idleDuration,
    snmpConfig: state.snmpConfig,
    operator: AUTONOMY_OPERATOR.username,
    actionLimit: Math.min(run.settings.actionLimit, safeActions.length),
    actions: safeActions,
    explanation: `${run.explanation} 自治模式已自动剔除高风险、低置信度或已执行动作，仅保留可自动放行的低风险动作。`.trim(),
    gateMode: "auto",
    gateReason: "自治模式仅自动执行低风险动作。",
    engine: run.engine ?? {
      kind: "heuristic",
      provider: "local",
      model: "rule-engine",
      workflow: ["planner", "autonomy-filter"],
    },
    review: run.review,
    jobId: run.jobId,
    goal: run.settings.goal,
  });
}

async function createFallbackRun(
  jobId: string,
  config: AutonomyConfig,
  report: AgentProgressReporter,
  fallbackMessage = "未检测到 OpenAI，自治智能体已切换到规则引擎兜底。",
) {
  await report({
    eventType: "status",
    stage: "planner",
    agentName: "规则规划器",
    message: fallbackMessage,
  });

  const run = createAgentRun({
    interfaces: state.interfaces,
    manualThreshold: state.manualThreshold,
    idleDuration: state.idleDuration,
    snmpConfig: state.snmpConfig,
    operator: AUTONOMY_OPERATOR.username,
    actionLimit: config.actionLimit,
  });

  run.jobId = jobId;
  run.settings.goal = config.goal;
  run.engine = {
    kind: "heuristic",
    provider: "local",
    model: "rule-engine",
    workflow: ["planner", "fallback"],
  };

  await report({
    eventType: "result",
    stage: "completed",
    agentName: "规则规划器",
    message: `规则引擎已生成候选计划，共 ${run.plan.selectedCount} 个动作。`,
    payload: {
      selectedCount: run.plan.selectedCount,
      riskLevel: run.simulation.risk.level,
    },
  });

  return run;
}

async function createPlannedRun(jobId: string, config: AutonomyConfig, report: AgentProgressReporter) {
  if (getOpenAIAgentStatus().configured) {
    try {
      return await createOpenAIAgentRun({
        operator: AUTONOMY_OPERATOR,
        goal: config.goal,
        actionLimit: config.actionLimit,
        report,
        jobId,
      });
    } catch (error) {
      if (config.allowHeuristicFallback && shouldFallbackToHeuristic(error)) {
        return createFallbackRun(
          jobId,
          config,
          report,
          `${toMessage(error)} 已自动切换到预设策略继续巡检。`,
        );
      }
      throw error;
    }
  }

  if (!config.allowHeuristicFallback) {
    const error = new Error("未配置 OPENAI_API_KEY，且当前已禁用规则引擎兜底。");
    (error as Error & { status?: number }).status = 503;
    throw error;
  }

  return createFallbackRun(jobId, config, report);
}

function scheduleNextCycle(immediate = false): void {
  if (cycleTimer) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }

  const config = syncConfigToState();
  if (!config.enabled) {
    runtime.status = "paused";
    runtime.currentJobId = null;
    runtime.currentRunId = null;
    setRuntimeMessage("自治智能体已暂停。", "skipped");
    persistState();
    return;
  }

  const delay = immediate ? 1_000 : config.intervalSeconds * 1_000;
  runtime.status = cyclePromise ? "running" : "idle";
  cycleTimer = setTimeout(() => {
    void runAutonomyCycle(immediate ? "startup" : "scheduled");
  }, delay);
}

async function performAutonomyCycle(trigger: "startup" | "scheduled" | "config"): Promise<void> {
  const config = syncConfigToState();
  stampCycleTime();
  let leaseHeld = false;
  let job: ReturnType<typeof createAgentJob> | null = null;

  const lease = tryAcquireAppSettingLease({
    key: AUTONOMY_LEASE_KEY,
    owner: AUTONOMY_INSTANCE_ID,
    ttlMs: getAutonomyLeaseTtlMs(config),
  });

  if (!lease.acquired) {
    runtime.status = "idle";
    setRuntimeMessage("检测到另一服务实例正在执行自治巡检，本实例本轮不再重复执行。", "skipped");
    persistState();
    return;
  }

  leaseHeld = true;

  try {
    if (!config.enabled) {
      runtime.status = "paused";
      setRuntimeMessage("自治智能体已暂停。", "skipped");
      persistState();
      return;
    }

    if (!state.guardrailsEnabled) {
      runtime.status = "paused";
      setRuntimeMessage("智能体护栏未启用，自治巡检暂停。", "skipped");
      persistState();
      return;
    }

    if (!state.interfaces.length) {
      runtime.status = "paused";
      setRuntimeMessage("接口池为空，自治智能体等待新数据接入。", "skipped");
      persistState();
      return;
    }

    if (!isWithinSchedule(state.snmpConfig.schedule)) {
      runtime.status = "idle";
      setRuntimeMessage("当前不在设定作业时窗内，本轮自治巡检已自动跳过。", "skipped");
      persistState();
      return;
    }

    const engineStatus = getOpenAIAgentStatus();
    const workflow = engineStatus.configured ? ["planner", "reviewer", "execution"] : ["planner", "fallback", "execution"];
    const engine = engineStatus.configured
      ? {
          kind: "llm_agent" as const,
          provider: "openai" as const,
          model: engineStatus.model,
          reasoningEffort: engineStatus.reasoningEffort,
          workflow,
        }
      : {
          kind: "heuristic" as const,
          provider: "local" as const,
          model: "rule-engine",
          workflow,
        };

    job = createAgentJob({
      operator: AUTONOMY_OPERATOR.username,
      goal: config.goal,
      workflow,
      engine,
    });

    runtime.status = "running";
    runtime.currentJobId = job.id;
    runtime.currentRunId = null;
    setRuntimeMessage(trigger === "startup" ? "自治智能体已启动首轮巡检。" : "自治智能体开始新一轮巡检。");

    const report = createRuntimeReporter(job.id);

    const plannedRun = await createPlannedRun(job.id, config, report);
    const executableRun = createExecutableRun(plannedRun);

    if (!executableRun || executableRun.plan.selectedCount === 0) {
      const message =
        plannedRun.plan.selectedCount > 0
          ? `本轮已生成 ${plannedRun.plan.selectedCount} 个候选动作，预计节电 ${plannedRun.simulation.totals.savingKwh.toFixed(
              1,
            )} kWh；因未满足自动执行条件，本轮未执行调整。`
          : "本轮没有符合自动执行条件的动作，系统未执行调整。";
      addAgentRun(plannedRun);
      runtime.lastRunId = plannedRun.id;
      appendAgentJobEvent({
        jobId: job.id,
        eventType: "status",
        stage: "completed",
        agentName: "自治智能体",
        message,
        payload: {
          runId: plannedRun.id,
          originalSelectedCount: plannedRun.plan.selectedCount,
          savingKwh: plannedRun.simulation.totals.savingKwh,
        },
      });
      markAgentJobSkipped(job.id, message, {
        runId: plannedRun.id,
        selectedCount: plannedRun.plan.selectedCount,
        savingKwh: plannedRun.simulation.totals.savingKwh,
        trigger,
      });
      addAuditLog("自治智能体", "自动跳过", `Job ${job.id.slice(0, 8)}`, message);
      setRuntimeMessage(message, "skipped");
      persistState();
      return;
    }

    addAgentRun(executableRun);
    persistState();
    markAgentJobPlanned(job.id, executableRun);
    runtime.currentRunId = executableRun.id;
    runtime.lastRunId = executableRun.id;

    const executed = executeAndPersistAgentRun({
      run: executableRun,
      approvedBy: AUTONOMY_OPERATOR.name,
      moduleName: "自治智能体",
      actionName: "自动执行策略",
      executionMessage: `自治执行完成，共 ${executableRun.plan.selectedCount} 个动作已落地。`,
    });

    setRuntimeMessage(
      `自治巡检已自动执行 ${executed.run.execution?.applied.length ?? 0} 项动作，累计节能影响 ${(
        executed.run.execution?.totalImpact ?? 0
      ).toFixed(1)}。`,
      "executed",
    );
  } catch (error) {
    const message = toMessage(error);
    if (job) {
      failAgentJob(job.id, message);
      addAuditLog("自治智能体", "巡检失败", `Job ${job.id.slice(0, 8)}`, message);
    }
    setRuntimeMessage(message, "failed");
  } finally {
    runtime.status = config.enabled ? "idle" : "paused";
    runtime.currentJobId = null;
    runtime.currentRunId = null;
    if (leaseHeld) {
      releaseAppSettingLease(AUTONOMY_LEASE_KEY, AUTONOMY_INSTANCE_ID);
    }
    persistState();
  }
}

export function startAgentAutonomyLoop(): void {
  if (started) return;
  started = true;
  syncConfigToState();
  persistState();
  scheduleNextCycle(true);
}

export function runAutonomyCycle(trigger: "startup" | "scheduled" | "config" = "scheduled"): Promise<void> {
  if (cyclePromise) return cyclePromise;

  cyclePromise = performAutonomyCycle(trigger).finally(() => {
    cyclePromise = null;
    scheduleNextCycle(false);
  });

  return cyclePromise;
}

export function updateAgentAutonomyConfig(patch: Partial<AutonomyConfig>): AgentAutonomySnapshot {
  syncConfigToState(patch);
  persistState();
  scheduleNextCycle(true);
  return getAgentAutonomySnapshot();
}

export function getAgentAutonomySnapshot(): AgentAutonomySnapshot {
  const config = syncConfigToState();
  return {
    config: { ...config },
    runtime: { ...runtime },
  };
}
