import type {
  AgentActionRecord,
  AgentEngineInfo,
  AgentReviewRecord,
  AgentRunRecord,
  AgentRunSummary,
  ExecutionRecord,
  InterfaceRecord,
  SnmpConfig,
} from "../types/domain.js";
import {
  CARBON_FACTOR,
  TREE_FACTOR,
  clamp,
  createId,
  formatDate,
  getInterfaceStatus,
  isWithinSchedule,
  variance,
} from "../utils/energy.js";
import { applyKnowledgeGrounding } from "./knowledge-base.js";

function actionLabel(actionKey: AgentActionRecord["actionKey"]): string {
  if (actionKey === "close") return "关闭闲置接口";
  if (actionKey === "reduce") return "切换低功耗模式";
  return "调整工作模式";
}

function predictUsageAfter(port: InterfaceRecord, actionKey: AgentActionRecord["actionKey"]): number {
  if (actionKey === "close") return 0;
  if (actionKey === "reduce") return Math.max(0, Math.round(port.usage * 0.45));
  if (port.connections === 0 && port.usage <= 12) return 0;
  return Math.max(0, Math.round(port.usage * 0.55));
}

function predictHistoryAfter(history: number[], actionKey: AgentActionRecord["actionKey"], afterUsage: number): number[] {
  const factor = actionKey === "close" || afterUsage === 0 ? 0.35 : actionKey === "reduce" ? 0.58 : 0.67;
  return history.map((value) => Math.max(0, Math.round(value * factor)));
}

function estimateSavingImpact(before: number, after: number): number {
  const usageDelta = Math.max(before - after, 0);
  return Number((usageDelta * 1.8).toFixed(1));
}

function calcPowerIndex(ports: InterfaceRecord[]): number {
  return ports.reduce((sum, port) => sum + port.usage * 1.3 + port.connections * 0.9, 0);
}

function deriveRiskLevel(score: number): "低" | "中" | "高" {
  if (score >= 70) return "高";
  if (score >= 45) return "中";
  return "低";
}

function calcRiskScore(port: InterfaceRecord, manualThreshold: number, inSchedule: boolean): number {
  const fluctuation = variance(port.history);
  const status = getInterfaceStatus(port, manualThreshold).className;
  const statusPenalty = status === "danger" ? 6 : status === "warning" ? 12 : 20;
  const connectionPenalty = port.connections * 11;
  const fluctuationPenalty = fluctuation * 1.6;
  const schedulePenalty = inSchedule ? 0 : 9;
  return clamp(Math.round(statusPenalty + connectionPenalty + fluctuationPenalty + schedulePenalty), 5, 98);
}

function chooseAction(port: InterfaceRecord, manualThreshold: number, snmpThreshold: number) {
  if (port.usage <= manualThreshold - 5 && port.connections === 0) return "close" as const;
  if (port.usage <= snmpThreshold + 1) return "reduce" as const;
  if (port.usage <= manualThreshold + 6 && port.connections <= 2) return "hybrid" as const;
  return null;
}

export function evaluatePortAction(input: {
  port: InterfaceRecord;
  actionKey: AgentActionRecord["actionKey"];
  manualThreshold: number;
  inSchedule: boolean;
  extraReasons?: string[];
  goal?: string;
}): AgentActionRecord {
  const { port, actionKey, manualThreshold, inSchedule, extraReasons = [], goal } = input;
  const riskScore = calcRiskScore(port, manualThreshold, inSchedule);
  const afterUsage = predictUsageAfter(port, actionKey);
  const impact = estimateSavingImpact(port.usage, afterUsage);
  const confidence = clamp(Math.round(94 - riskScore * 0.58 + impact * 0.9), 38, 96);

  return applyKnowledgeGrounding({
    port,
    actionKey,
    goal,
    action: {
      id: createId(),
      portId: port.id,
      portName: port.name,
      actionKey,
      actionLabel: actionLabel(actionKey),
      beforeUsage: port.usage,
      afterUsage,
      impact,
      confidence,
      riskScore,
      riskLevel: deriveRiskLevel(riskScore),
      reasons: [`当前利用率 ${port.usage}%`, `连接数 ${port.connections}`, `历史波动 ${variance(port.history).toFixed(1)}`, ...extraReasons],
      knowledgeRefs: [],
    },
  });
}

export function simulatePlannedActions(
  interfaces: InterfaceRecord[],
  actions: AgentActionRecord[],
): AgentRunRecord["simulation"] {
  const clone = interfaces.map((port) => ({ ...port, history: [...port.history] }));

  actions.forEach((action) => {
    const target = clone.find((port) => port.id === action.portId);
    if (!target) return;

    target.usage = action.afterUsage;
    target.history = predictHistoryAfter(target.history, action.actionKey, action.afterUsage);
  });

  const beforePower = calcPowerIndex(interfaces);
  const afterPower = calcPowerIndex(clone);
  const savingKwh = Number(Math.max(beforePower - afterPower, 0).toFixed(1));
  const carbonKg = Number((savingKwh * CARBON_FACTOR).toFixed(1));
  const trees = Number((savingKwh * TREE_FACTOR).toFixed(1));
  const avgRisk =
    actions.length > 0
      ? Number((actions.reduce((sum, item) => sum + item.riskScore, 0) / actions.length).toFixed(1))
      : 0;
  const highRiskCount = actions.filter((item) => item.riskScore >= 70).length;

  return {
    actionRecords: actions,
    totals: {
      beforePower: Number(beforePower.toFixed(1)),
      afterPower: Number(afterPower.toFixed(1)),
      savingKwh,
      carbonKg,
      trees,
    },
    risk: {
      score: avgRisk,
      highRiskCount,
      level: deriveRiskLevel(avgRisk),
      gate: avgRisk >= 50 || highRiskCount > 0 ? "manual" : "auto",
    },
  };
}

function buildCandidates(
  interfaces: InterfaceRecord[],
  manualThreshold: number,
  snmpThreshold: number,
  inSchedule: boolean,
  goal?: string,
) {
  const candidates = interfaces
    .map((port) => {
      if (port.applied) return null;
      const actionKey = chooseAction(port, manualThreshold, snmpThreshold);
      if (!actionKey) return null;

      const action = evaluatePortAction({
        port,
        actionKey,
        manualThreshold,
        inSchedule,
        goal,
      });
      const priority = Number((action.impact * (action.confidence / 100) - action.riskScore * 0.08).toFixed(2));

      return {
        ...action,
        priority,
      };
    })
    .filter(Boolean) as Array<AgentActionRecord & { priority: number }>;

  return candidates.sort((left, right) => right.priority - left.priority);
}

function explainRun(simulation: AgentRunRecord["simulation"], inSchedule: boolean): string {
  const gateText = simulation.risk.gate === "manual" ? "建议人工确认后执行" : "可直接执行";
  const scheduleText = inSchedule ? "当前处于作业时窗内" : "当前不在作业时窗，建议仅仿真";
  return `预计节电 ${simulation.totals.savingKwh} kWh，风险等级 ${simulation.risk.level}（评分 ${simulation.risk.score}），${gateText}。${scheduleText}。`;
}

export function createAgentRun(input: {
  interfaces: InterfaceRecord[];
  manualThreshold: number;
  idleDuration: number;
  snmpConfig: SnmpConfig;
  operator?: string;
  actionLimit?: number;
  goal?: string;
}): AgentRunRecord {
  const { interfaces, manualThreshold, idleDuration, snmpConfig, operator = "system", actionLimit = 8, goal } = input;
  const inSchedule = isWithinSchedule(snmpConfig.schedule);
  const startedAtISO = new Date().toISOString();
  const candidates = buildCandidates(
    interfaces,
    Number(manualThreshold),
    Number(snmpConfig.usageThreshold),
    inSchedule,
    goal,
  );
  const actions = candidates.slice(0, actionLimit);
  const simulation = simulatePlannedActions(interfaces, actions);
  const runId = createId();

  return {
    id: runId,
    startedAt: formatDate(),
    startedAtISO,
    operator,
    engine: {
      kind: "heuristic",
      provider: "local",
      model: "rule-engine",
      workflow: ["planner"],
    },
    settings: {
      manualThreshold: Number(manualThreshold),
      idleDuration: Number(idleDuration),
      usageThreshold: Number(snmpConfig.usageThreshold),
      connectionThreshold: Number(snmpConfig.connectionThreshold),
      schedule: snmpConfig.schedule,
      actionLimit,
      goal,
    },
    monitor: {
      interfaceCount: interfaces.length,
      inSchedule,
      idlePortCount: interfaces.filter((port) => getInterfaceStatus(port, Number(manualThreshold)).className === "danger").length,
    },
    plan: {
      candidateCount: candidates.length,
      selectedCount: actions.length,
      actions,
    },
    simulation,
    gate: {
      mode: simulation.risk.gate,
      reason: simulation.risk.gate === "manual" ? "检测到中高风险动作，需人工确认。" : "风险较低，可直接执行。",
      approved: false,
      approvedBy: null,
    },
    explanation: explainRun(simulation, inSchedule),
    status: "planned",
  };
}

export interface InterfaceSavingCurvePoint {
  interfaceCount: number;
  label: string;
  cumulativeSavingKwh: number;
  marginalSavingKwh: number;
  averageRiskScore: number;
  autoEligibleCount: number;
  selectedPorts: string[];
}

export function buildInterfaceSavingCurve(input: {
  interfaces: InterfaceRecord[];
  executionRecords?: ExecutionRecord[];
  manualThreshold: number;
  snmpConfig: SnmpConfig;
  goal?: string;
  maxPoints?: number;
}): InterfaceSavingCurvePoint[] {
  const { interfaces, executionRecords = [], manualThreshold, snmpConfig, goal, maxPoints = 10 } = input;
  const inSchedule = isWithinSchedule(snmpConfig.schedule);
  const candidates = buildCandidates(
    interfaces,
    Number(manualThreshold),
    Number(snmpConfig.usageThreshold),
    inSchedule,
    goal,
  ).slice(0, Math.max(1, maxPoints));

  const points: InterfaceSavingCurvePoint[] = [
    {
      interfaceCount: 0,
      label: "0",
      cumulativeSavingKwh: 0,
      marginalSavingKwh: 0,
      averageRiskScore: 0,
      autoEligibleCount: 0,
      selectedPorts: [],
    },
  ];

  let previousSaving = 0;
  let realizedCount = 0;
  const realizedRecords = [...executionRecords]
    .filter((record) => Number(record.impact) > 0)
    .sort((left, right) => new Date(left.timeISO).valueOf() - new Date(right.timeISO).valueOf())
    .slice(-maxPoints);

  for (const record of realizedRecords) {
    if (points.length > maxPoints) break;
    realizedCount += 1;
    const marginalSavingKwh = Number(record.impact.toFixed(1));
    const cumulativeSavingKwh = Number((previousSaving + marginalSavingKwh).toFixed(1));

    points.push({
      interfaceCount: realizedCount,
      label: String(realizedCount),
      cumulativeSavingKwh,
      marginalSavingKwh,
      averageRiskScore: 0,
      autoEligibleCount: realizedCount,
      selectedPorts: [record.target],
    });
    previousSaving = cumulativeSavingKwh;
  }

  const remainingSlots = Math.max(maxPoints - realizedCount, 0);
  const realizedSaving = previousSaving;
  let previousCurveSaving = previousSaving;
  for (let index = 1; index <= Math.min(candidates.length, remainingSlots); index += 1) {
    const selected = candidates.slice(0, index);
    const simulation = simulatePlannedActions(interfaces, selected);
    const cumulativeSavingKwh = Number((realizedSaving + simulation.totals.savingKwh).toFixed(1));
    const marginalSavingKwh = Number(Math.max(cumulativeSavingKwh - previousCurveSaving, 0).toFixed(1));
    const autoEligibleCount = selected.filter((action) => action.riskScore <= 44 && action.confidence >= 60).length;
    const interfaceCount = realizedCount + index;

    points.push({
      interfaceCount,
      label: String(interfaceCount),
      cumulativeSavingKwh,
      marginalSavingKwh,
      averageRiskScore: Number(simulation.risk.score.toFixed(1)),
      autoEligibleCount: realizedCount + autoEligibleCount,
      selectedPorts: selected.map((action) => action.portName),
    });
    previousCurveSaving = cumulativeSavingKwh;
  }

  return points;
}

export function createAgentRunFromPlannedActions(input: {
  interfaces: InterfaceRecord[];
  manualThreshold: number;
  idleDuration: number;
  snmpConfig: SnmpConfig;
  operator?: string;
  actionLimit?: number;
  actions: AgentActionRecord[];
  explanation: string;
  gateMode: "auto" | "manual";
  gateReason: string;
  engine: AgentEngineInfo;
  review?: AgentReviewRecord;
  jobId?: string;
  goal?: string;
}): AgentRunRecord {
  const {
    interfaces,
    manualThreshold,
    idleDuration,
    snmpConfig,
    operator = "system",
    actionLimit = 8,
    actions,
    explanation,
    gateMode,
    gateReason,
    engine,
    review,
    jobId,
    goal,
  } = input;
  const inSchedule = isWithinSchedule(snmpConfig.schedule);
  const startedAtISO = new Date().toISOString();
  const simulation = simulatePlannedActions(interfaces, actions);

  return {
    id: createId(),
    jobId,
    startedAt: formatDate(),
    startedAtISO,
    operator,
    engine,
    review,
    settings: {
      manualThreshold: Number(manualThreshold),
      idleDuration: Number(idleDuration),
      usageThreshold: Number(snmpConfig.usageThreshold),
      connectionThreshold: Number(snmpConfig.connectionThreshold),
      schedule: snmpConfig.schedule,
      actionLimit,
      goal,
    },
    monitor: {
      interfaceCount: interfaces.length,
      inSchedule,
      idlePortCount: interfaces.filter((port) => getInterfaceStatus(port, Number(manualThreshold)).className === "danger").length,
    },
    plan: {
      candidateCount: actions.length,
      selectedCount: actions.length,
      actions,
    },
    simulation: {
      ...simulation,
      risk: {
        ...simulation.risk,
        gate: gateMode,
      },
    },
    gate: {
      mode: gateMode,
      reason: gateReason,
      approved: false,
      approvedBy: null,
    },
    explanation,
    status: "planned",
  };
}

export function executeAgentRun(run: AgentRunRecord, interfaces: InterfaceRecord[], approvedBy = "operator") {
  const applied: AgentActionRecord[] = [];

  run.plan.actions.forEach((action) => {
    const target = interfaces.find((port) => port.id === action.portId);
    if (!target) return;

    const before = target.usage;
    const after = predictUsageAfter(target, action.actionKey);
    const impact = estimateSavingImpact(before, after);

    target.usage = after;
    target.history = predictHistoryAfter(target.history, action.actionKey, after);
    target.applied = true;

    applied.push({
      ...action,
      beforeUsage: before,
      afterUsage: after,
      impact,
    });
  });

  const totalImpact = Number(applied.reduce((sum, item) => sum + item.impact, 0).toFixed(1));

  return {
    applied,
    totalImpact,
    finishedAt: formatDate(),
    finishedAtISO: new Date().toISOString(),
    approvedBy,
  };
}

export function summarizeAgentRuns(runs: AgentRunRecord[]): AgentRunSummary {
  const planned = runs.filter((run) => run.status === "planned").length;
  const executed = runs.filter((run) => run.status === "executed").length;
  const totalSaving = Number(
    runs.reduce((sum, run) => sum + (run.execution?.totalImpact || run.simulation?.totals?.savingKwh || 0), 0).toFixed(1),
  );
  return { planned, executed, totalSaving };
}
