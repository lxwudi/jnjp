import type {
  AutonomyConfig,
  AgentProviderConfig,
  AgentRunRecord,
  AuditRecord,
  SnmpConfig,
  StateShape,
} from "../types/domain.js";
import { createId, formatDate } from "../utils/energy.js";
import { initializeConsoleState, persistConsoleState } from "./interface-db.js";

function sampleLogs(): AuditRecord[] {
  return [
    {
      id: createId(),
      time: formatDate(),
      module: "智能体护栏",
      action: "阈值推荐",
      target: "GE1/0/03",
      result: "建议阈值调整为 13%",
    },
    {
      id: createId(),
      time: formatDate(),
      module: "接口库",
      action: "数据同步",
      target: "接口池",
      result: "同步 4 个接口样例",
    },
    {
      id: createId(),
      time: formatDate(),
      module: "自治智能体",
      action: "自动执行策略",
      target: "GE1/0/12",
      result: "切换为低功耗模式，已自动落库",
    },
  ];
}

function defaultSnmpConfig(): SnmpConfig {
  return {
    model: "S5720-28X-SI-AC",
    host: "10.10.0.8",
    version: "v3",
    port: 161,
    credential: "campus-energy",
    security: "authPriv",
    usageThreshold: 15,
    connectionThreshold: 4,
    schedule: "07:30 - 22:00",
    strategy: "hybrid",
  };
}

export const DEFAULT_AGENT_GOAL =
  "请为当前校园交换机接口池持续执行低风险、可解释、收益清晰的节能治理，默认自动完成巡检、规划、执行与留痕，并优先保障业务连续性。";

export function defaultAutonomyConfig(): AutonomyConfig {
  return {
    enabled: true,
    intervalSeconds: 60,
    actionLimit: 6,
    goal: DEFAULT_AGENT_GOAL,
    allowHeuristicFallback: true,
  };
}

export function defaultAgentProviderConfig(): AgentProviderConfig {
  return {
    provider: "openai",
    baseUrl: "",
    apiKey: "",
    model: "gpt-5.1",
    reasoningEffort: "medium",
  };
}

function createDefaultState(): StateShape {
  return {
    interfaces: [],
    advice: [],
    auditLogs: sampleLogs(),
    executionRecords: [],
    agentRuns: [],
    manualThreshold: 18,
    idleDuration: 30,
    guardrailsEnabled: true,
    autonomyConfig: defaultAutonomyConfig(),
    agentProviderConfig: defaultAgentProviderConfig(),
    snmpConfig: defaultSnmpConfig(),
  };
}

function loadState(): StateShape {
  return initializeConsoleState(createDefaultState());
}

export const state = loadState();

export function persistState(): void {
  persistConsoleState(state);
}

export function addAuditLog(module: string, action: string, target: string, result: string): void {
  state.auditLogs.unshift({
    id: createId(),
    time: formatDate(),
    module,
    action,
    target,
    result,
  });
  state.auditLogs = state.auditLogs.slice(0, 1200);
}

export function addExecutionRecord(module: string, action: string, target: string, impact: number): void {
  state.executionRecords.unshift({
    id: createId(),
    time: formatDate(),
    timeISO: new Date().toISOString(),
    module,
    action,
    target,
    impact: Number(impact.toFixed(1)),
  });
  state.executionRecords = state.executionRecords.slice(0, 2000);
}

export function addAgentRun(run: AgentRunRecord): void {
  state.agentRuns.unshift(run);
  state.agentRuns = state.agentRuns.slice(0, 400);
}
