import type {
  AdviceRecord,
  AuditRecord,
  InterfaceRecord,
  SnmpConfig,
  StrategyKey,
} from "../types";

export const TREE_FACTOR = 0.018;
export const CARBON_FACTOR = 0.785;
const ENERGY_FACTOR = 0.42;

export const createId = (): string =>
  globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const sampleInterfaces = (): InterfaceRecord[] => [
  {
    id: createId(),
    name: "GE1/0/03",
    ip: "10.10.1.13",
    mask: "255.255.255.0",
    usage: 8,
    history: [12, 10, 9, 7, 8],
    connections: 1,
    applied: false,
  },
  {
    id: createId(),
    name: "GE1/0/07",
    ip: "10.10.1.17",
    mask: "255.255.255.0",
    usage: 14,
    history: [15, 13, 16, 12, 14],
    connections: 2,
    applied: false,
  },
  {
    id: createId(),
    name: "GE1/0/12",
    ip: "10.10.1.22",
    mask: "255.255.255.0",
    usage: 5,
    history: [6, 4, 5, 8, 5],
    connections: 0,
    applied: false,
  },
  {
    id: createId(),
    name: "GE1/0/18",
    ip: "10.10.1.28",
    mask: "255.255.255.0",
    usage: 28,
    history: [24, 22, 27, 31, 29],
    connections: 6,
    applied: false,
  },
];

export const sampleLogs = (): AuditRecord[] => [
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
    result: "已切换为低功耗模式",
  },
];

export const trendSeries = [
  { label: "节电量", color: "#c5ff48", values: [8, 12, 16, 18, 22, 26, 28, 31, 37, 35, 42, 48] },
  { label: "减碳量", color: "#00c2ff", values: [5, 7, 8, 10, 13, 14, 16, 18, 21, 24, 27, 30] },
];

export const exampleCsv = `name,ip,mask,usage,history,connections
GE1/0/21,10.10.2.21,255.255.255.0,7,"6,5,7,8,5",1
GE1/0/25,10.10.2.25,255.255.255.0,4,"5,4,4,3,5",0
GE1/0/29,10.10.2.29,255.255.255.0,17,"15,16,18,17,16",2`;

export function formatDate(value = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

export function variance(values: number[]): number {
  if (!values.length) return 0;
  const mean = average(values);
  return average(values.map((value) => (value - mean) ** 2));
}

export function validateIp(ip: string): boolean {
  const pattern =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

  return pattern.test(ip);
}

export function validateExecutionSchedule(schedule: string): {
  ok: boolean;
  normalized: string;
  crossesMidnight: boolean;
  message?: string;
} {
  const matched = String(schedule || "")
    .trim()
    .match(/^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)$/);

  if (!matched) {
    return {
      ok: false,
      normalized: "",
      crossesMidnight: false,
      message: "执行时窗格式需为 HH:MM - HH:MM，例如 22:00 - 07:30。",
    };
  }

  const startHour = Number(matched[1]);
  const startMinute = Number(matched[2]);
  const endHour = Number(matched[3]);
  const endMinute = Number(matched[4]);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;

  if (start === end) {
    return {
      ok: false,
      normalized: "",
      crossesMidnight: false,
      message: "执行时窗的开始和结束时间不能相同。",
    };
  }

  return {
    ok: true,
    normalized: `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")} - ${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`,
    crossesMidnight: start > end,
  };
}

export function strategyLabel(value: StrategyKey): string {
  if (value === "reduce") return "低功耗";
  if (value === "close") return "关闭接口";
  return "混合策略";
}

export function getInterfaceStatus(
  port: InterfaceRecord,
  manualThreshold: number,
): { label: string; className: "danger" | "warning" | "active" } {
  const avg = average(port.history) || port.usage;

  if (port.usage <= manualThreshold && port.connections <= 2 && avg <= manualThreshold + 3) {
    return { label: "闲置可优化", className: "danger" };
  }

  if (port.usage <= manualThreshold + 10) {
    return { label: "观察中", className: "warning" };
  }

  return { label: "活跃", className: "active" };
}

export function getConfidence(port: InterfaceRecord): number {
  const avg = average(port.history) || port.usage;
  const stableScore = 100 - clamp(variance(port.history) * 8, 0, 40);
  const idleScore = 100 - clamp((port.usage + avg) * 2.4, 0, 80);
  const linkScore = 100 - clamp(port.connections * 10, 0, 50);
  return Math.round(stableScore * 0.35 + idleScore * 0.45 + linkScore * 0.2);
}

export function createAdvice(
  port: InterfaceRecord,
  manualThreshold: number,
  idleDuration: number,
): AdviceRecord {
  const avg = average(port.history) || port.usage;
  const confidence = clamp(getConfidence(port), 52, 96);
  const impact = Number(
    ((idleDuration / 30) * (26 - Math.min(avg, 20)) * ENERGY_FACTOR * 4.6).toFixed(1),
  );

  let action = "切换至低功耗模式";
  let level = "中等优先级";

  if (port.usage <= manualThreshold - 6 && port.connections === 0) {
    action = "关闭闲置接口";
    level = "高优先级";
  } else if (avg <= manualThreshold) {
    action = "调整工作模式";
  }

  return {
    id: createId(),
    portId: port.id,
    portName: port.name,
    action,
    level,
    confidence,
    impact,
    description: `${port.name} 当前利用率 ${port.usage}% ，历史均值 ${avg.toFixed(
      1,
    )}% ，连续闲置 ${idleDuration} 分钟后建议${action}。`,
    applied: false,
  };
}

export function computeRecommendedThreshold(interfaces: InterfaceRecord[]): number {
  if (!interfaces.length) return 15;

  const historyAverage = average(interfaces.map((port) => average(port.history) || port.usage));
  const fluctuation = average(interfaces.map((port) => variance(port.history)));
  return clamp(Math.round(historyAverage * 0.72 - fluctuation * 0.35), 10, 24);
}

export function summarize(
  interfaces: InterfaceRecord[],
  advice: AdviceRecord[],
  manualThreshold: number,
  idleDuration: number,
  snmpConfig: SnmpConfig,
): {
  pendingAdvice: AdviceRecord[];
  appliedAdvice: AdviceRecord[];
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
} {
  const appliedAdvice = advice.filter((item) => item.applied);
  const pendingAdvice = advice.filter((item) => !item.applied);
  const idlePorts = interfaces.filter((port) => !port.applied && getInterfaceStatus(port, manualThreshold).className === "danger");
  const totalSaving = appliedAdvice.reduce((sum, item) => sum + item.impact, 0);
  const projectedSaving = advice.reduce((sum, item) => sum + item.impact, 0);
  const totalHours = appliedAdvice.length * idleDuration * 12;
  const carbon = totalSaving * CARBON_FACTOR;
  const trees = totalSaving * TREE_FACTOR;
  const guardrailCandidates = interfaces.filter((port) => {
    if (port.applied) return false;
    const avgHistory = average(port.history) || port.usage;
    return (
      port.usage <= snmpConfig.usageThreshold &&
      port.connections <= snmpConfig.connectionThreshold &&
      avgHistory <= snmpConfig.usageThreshold + 4
    );
  });
  const monthlyGuardrailSaving = guardrailCandidates.reduce((sum, port) => {
    const weight = port.connections === 0 ? 3.4 : 2.1;
    return sum + (snmpConfig.usageThreshold + 16 - port.usage) * weight;
  }, 0);
  const riskLevel: "低" | "中" =
    guardrailCandidates.some((port) => variance(port.history) > 28) || snmpConfig.connectionThreshold >= 8 ? "中" : "低";
  const highConfidenceCount = advice.filter((item) => item.confidence >= 80).length;
  const meanConfidence = Math.round(average(advice.map((item) => item.confidence)));

  return {
    pendingAdvice,
    appliedAdvice,
    idlePorts,
    totalSaving,
    projectedSaving,
    totalHours,
    carbon,
    trees,
    guardrailCandidates,
    monthlyGuardrailSaving,
    riskLevel,
    highConfidenceCount,
    meanConfidence,
  };
}
