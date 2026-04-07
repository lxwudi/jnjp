export type StrategyKey = "close" | "reduce" | "hybrid";
export type SnmpVersion = "v1" | "v2c" | "v3";
export type AgentReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface InterfaceRecord {
  id: string;
  name: string;
  ip: string;
  mask: string;
  usage: number;
  history: number[];
  connections: number;
  applied: boolean;
}

export interface AdviceRecord {
  id: string;
  portId: string;
  portName: string;
  action: string;
  level: string;
  confidence: number;
  impact: number;
  description: string;
  applied: boolean;
}

export interface AuditRecord {
  id: string;
  time: string;
  module: string;
  action: string;
  target: string;
  result: string;
}

export interface SnmpConfig {
  model: string;
  host: string;
  version: SnmpVersion;
  port: number;
  credential: string;
  security: "authPriv" | "authNoPriv" | "noAuthNoPriv";
  usageThreshold: number;
  connectionThreshold: number;
  schedule: string;
  strategy: StrategyKey;
}

export interface InterfaceFormState {
  name: string;
  ip: string;
  mask: string;
  usage: number | null;
  history: string;
  connections: number | null;
}

export interface AgentActionRecord {
  id?: string;
  portId: string;
  portName: string;
  actionKey: StrategyKey;
  actionLabel: string;
  beforeUsage: number;
  afterUsage: number;
  impact: number;
  confidence: number;
  riskScore: number;
  riskLevel: "低" | "中" | "高";
  reasons: string[];
}

export interface AgentEngineInfo {
  kind: "llm_agent" | "heuristic";
  provider: "openai" | "local";
  model: string;
  reasoningEffort?: string;
  toolCalls?: number;
  responseId?: string | null;
  workflow?: string[];
}

export interface AgentProviderConfigSnapshot {
  provider: "openai";
  baseUrl: string;
  model: string;
  reasoningEffort: AgentReasoningEffort;
  apiKeyConfigured: boolean;
  apiKeyPreview: string | null;
  source: "console" | "env" | "default";
}

export interface AgentStatus {
  kind: "llm_agent";
  provider: "openai";
  configured: boolean;
  model: string;
  baseUrl: string | null;
  reasoningEffort: AgentReasoningEffort;
  message: string;
}

export type AgentStage = "boot" | "planner" | "reviewer" | "finalize" | "execution" | "completed" | "failed";
export type AgentJobStatus = "running" | "planned" | "executed" | "skipped" | "failed";
export type AgentJobEventType = "status" | "tool" | "review" | "result" | "error" | "execution";

export interface AutonomyConfig {
  enabled: boolean;
  intervalSeconds: number;
  actionLimit: number;
  goal: string;
  allowHeuristicFallback: boolean;
}

export interface AutonomyRuntimeSnapshot {
  status: "idle" | "running" | "paused";
  currentJobId: string | null;
  currentRunId: string | null;
  lastRunId: string | null;
  lastCycleAt: string | null;
  lastCycleAtISO: string | null;
  lastMessage: string;
  lastOutcome: "idle" | "executed" | "skipped" | "failed";
}

export interface AgentAutonomySnapshot {
  config: AutonomyConfig;
  runtime: AutonomyRuntimeSnapshot;
}

export interface AgentReviewRecord {
  reviewer: string;
  verdict: "approved" | "caution";
  summary: string;
  notes: string[];
}

export interface AgentRunRecord {
  id: string;
  jobId?: string;
  startedAt: string;
  startedAtISO: string;
  operator: string;
  engine?: AgentEngineInfo;
  review?: AgentReviewRecord;
  settings: {
    manualThreshold: number;
    idleDuration: number;
    usageThreshold: number;
    connectionThreshold: number;
    schedule: string;
    actionLimit: number;
    goal?: string;
  };
  monitor: {
    interfaceCount: number;
    inSchedule: boolean;
    idlePortCount: number;
  };
  plan: {
    candidateCount: number;
    selectedCount: number;
    actions: AgentActionRecord[];
  };
  simulation: {
    actionRecords: AgentActionRecord[];
    totals: {
      beforePower: number;
      afterPower: number;
      savingKwh: number;
      carbonKg: number;
      trees: number;
    };
    risk: {
      score: number;
      highRiskCount: number;
      level: "低" | "中" | "高";
      gate: "auto" | "manual";
    };
  };
  gate: {
    mode: "auto" | "manual";
    reason: string;
    approved: boolean;
    approvedBy: string | null;
  };
  explanation: string;
  status: "planned" | "executed";
  execution?: {
    applied: AgentActionRecord[];
    totalImpact: number;
    finishedAt: string;
    finishedAtISO: string;
    approvedBy: string;
  };
}

export interface AgentRunSummary {
  planned: number;
  executed: number;
  totalSaving: number;
}

export interface AgentJobEventRecord {
  id: string;
  jobId: string;
  eventType: AgentJobEventType;
  stage: AgentStage;
  agentName: string | null;
  message: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
  createdAtISO: string;
}

export interface AgentJobRecord {
  id: string;
  runId: string | null;
  operator: string;
  goal: string;
  status: AgentJobStatus;
  workflow: string[];
  currentStage: AgentStage;
  latestMessage: string;
  engine?: AgentEngineInfo;
  startedAt: string;
  startedAtISO: string;
  finishedAt: string | null;
  finishedAtISO: string | null;
  errorMessage: string | null;
  events?: AgentJobEventRecord[];
}
