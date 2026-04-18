import type {
  AdviceRecord,
  ExecutionRecord,
  InterfaceRecord,
  MetricsSummary,
  SnmpConfig,
  StrategyKey,
} from "../types/domain.js";

export const TREE_FACTOR = 0.018;
export const CARBON_FACTOR = 0.785;
const ENERGY_FACTOR = 0.42;

export function createId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function formatDate(value = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
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
      message: "执行时窗格式需为 HH:MM - HH:MM，例如 22:00 - 07:30",
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
      message: "执行时窗的开始和结束时间不能相同",
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

export function createAdvice(port: InterfaceRecord, manualThreshold: number, idleDuration: number): AdviceRecord {
  const avg = average(port.history) || port.usage;
  const confidence = clamp(getConfidence(port), 52, 96);
  const impact = Number(((idleDuration / 30) * (26 - Math.min(avg, 20)) * ENERGY_FACTOR * 4.6).toFixed(1));

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
    description: `${port.name} 当前利用率 ${port.usage}% ，历史均值 ${avg.toFixed(1)}% ，连续闲置 ${idleDuration} 分钟后建议${action}。`,
    applied: false,
  };
}

export function computeRecommendedThreshold(interfaces: InterfaceRecord[]): number {
  if (!interfaces.length) return 15;

  const historyAverage = average(interfaces.map((port) => average(port.history) || port.usage));
  const fluctuation = average(interfaces.map((port) => variance(port.history)));
  return clamp(Math.round(historyAverage * 0.72 - fluctuation * 0.35), 10, 24);
}

export function getSecurityGrade(snmpConfig: SnmpConfig): "A" | "B" | "C" {
  if (snmpConfig.version === "v3" && snmpConfig.security === "authPriv") return "A";
  if (snmpConfig.version === "v3") return "B";
  return "C";
}

export function getSecurityHint(grade: "A" | "B" | "C"): string {
  if (grade === "A") return "当前安全配置较完整，适合正式环境使用。";
  if (grade === "B") return "建议补充加密配置，进一步提升访问安全性。";
  return "当前配置以兼容性为主，建议根据设备情况提升安全等级。";
}

export function summarize(
  interfaces: InterfaceRecord[],
  advice: AdviceRecord[],
  manualThreshold: number,
  idleDuration: number,
  snmpConfig: SnmpConfig,
): MetricsSummary {
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

export function isWithinSchedule(schedule: string, currentTime = new Date()): boolean {
  const checked = validateExecutionSchedule(schedule);
  if (!checked.ok) return false;

  const matched = checked.normalized.match(/^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/);
  if (!matched) return false;

  const startHour = Number(matched[1]);
  const startMinute = Number(matched[2]);
  const endHour = Number(matched[3]);
  const endMinute = Number(matched[4]);

  const nowMinute = currentTime.getHours() * 60 + currentTime.getMinutes();
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;

  if (start <= end) {
    return nowMinute >= start && nowMinute <= end;
  }

  return nowMinute >= start || nowMinute <= end;
}

export function executeGuardrailStrategy(
  port: InterfaceRecord,
  strategy: StrategyKey,
): { action: string; before: number; after: number; impact: number } {
  const before = port.usage;
  let action = "切换至低功耗模式";
  let after = port.usage;

  if (strategy === "close") {
    action = "关闭接口";
    after = 0;
  } else if (strategy === "hybrid") {
    if (port.connections === 0) {
      action = "关闭接口";
      after = 0;
    } else {
      action = "调整工作模式";
      after = Math.max(0, Math.round(port.usage * 0.52));
    }
  } else {
    after = Math.max(0, Math.round(port.usage * 0.45));
  }

  port.usage = after;
  port.history = port.history.map((value) => Math.max(0, Math.round(value * (after === 0 ? 0.35 : 0.62))));
  port.applied = true;

  const impact = Number(Math.max(before - after, 0).toFixed(1));
  return { action, before, after, impact };
}

export function buildTrendSeries(executionRecords: ExecutionRecord[], fallbackProjectedSaving: number): {
  labels: string[];
  saving: number[];
  carbon: number[];
} {
  const now = new Date();
  const labels: string[] = [];
  const saving: number[] = [];
  const carbon: number[] = [];

  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const label = `${date.getMonth() + 1}月`;
    labels.push(label);

    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const records = executionRecords.filter((record) => {
      const parsed = new Date(record.timeISO);
      if (Number.isNaN(parsed.valueOf())) return false;
      const recordKey = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
      return recordKey === key;
    });

    if (records.length) {
      const monthSaving = Number(records.reduce((sum, item) => sum + item.impact, 0).toFixed(1));
      saving.push(monthSaving);
      carbon.push(Number((monthSaving * CARBON_FACTOR).toFixed(1)));
      continue;
    }

    const baseline = fallbackProjectedSaving > 0 ? fallbackProjectedSaving / 12 : 6;
    const factor = 0.65 + ((11 - offset) % 5) * 0.08;
    const monthSaving = Number((baseline * factor).toFixed(1));
    saving.push(monthSaving);
    carbon.push(Number((monthSaving * CARBON_FACTOR).toFixed(1)));
  }

  return { labels, saving, carbon };
}
