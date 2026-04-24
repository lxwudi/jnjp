import type { AdviceRecord, AgentRunRecord, OverviewSnapshot, SnmpConfig } from "../types/domain.js";
import { parseHistory } from "../utils/csv.js";
import {
  clamp,
  createAdvice,
  createId,
  executeGuardrailStrategy,
  getInterfaceStatus,
  getSecurityGrade,
  getSecurityHint,
  summarize,
  validateExecutionSchedule,
  validateIp,
} from "../utils/energy.js";
import { addExecutionRecord, state } from "./store.js";

export function getMetrics() {
  return summarize(
    state.interfaces,
    state.advice,
    state.executionRecords,
    state.agentRuns,
    state.manualThreshold,
    state.idleDuration,
    state.snmpConfig,
  );
}

export function summarizeNow(): OverviewSnapshot {
  const securityGrade = getSecurityGrade(state.snmpConfig);
  return {
    manualThreshold: state.manualThreshold,
    idleDuration: state.idleDuration,
    guardrailsEnabled: state.guardrailsEnabled,
    snmpConfig: state.snmpConfig,
    securityGrade,
    securityHint: getSecurityHint(securityGrade),
    metrics: getMetrics(),
  };
}

export function validateInterfacePayload(payload: unknown):
  | { ok: true; record: { id: string; name: string; ip: string; mask: string; usage: number; history: number[]; connections: number; applied: boolean } }
  | { ok: false; message: string } {
  const candidate = (payload ?? {}) as {
    name?: unknown;
    ip?: unknown;
    mask?: unknown;
    usage?: unknown;
    connections?: unknown;
    history?: unknown;
  };

  const name = String(candidate.name || "").trim();
  const ip = String(candidate.ip || "").trim();
  const mask = String(candidate.mask || "").trim();
  const usage = Number(candidate.usage);
  const connections = Number(candidate.connections);
  const history = Array.isArray(candidate.history)
    ? candidate.history.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : parseHistory(String(candidate.history || ""));

  if (!name) {
    return { ok: false, message: "接口名称不能为空" };
  }

  if (!validateIp(ip)) {
    return { ok: false, message: "IP 地址格式无效" };
  }

  if (!validateIp(mask)) {
    return { ok: false, message: "子网掩码格式无效" };
  }

  if (!Number.isFinite(usage) || usage < 0 || usage > 100) {
    return { ok: false, message: "利用率需为 0-100 的数字" };
  }

  if (!Number.isFinite(connections) || connections < 0) {
    return { ok: false, message: "连接数需为大于等于 0 的数字" };
  }

  return {
    ok: true,
    record: {
      id: createId(),
      name,
      ip,
      mask,
      usage,
      history,
      connections,
      applied: false,
    },
  };
}

export function applyAdviceRecord(advice: AdviceRecord): { changed: boolean; impact: number } {
  if (advice.applied) return { changed: false, impact: 0 };

  advice.applied = true;
  const port = state.interfaces.find((item) => item.id === advice.portId);
  if (port) {
    port.applied = true;
    port.usage = Math.max(0, Math.round(port.usage * 0.48));
    port.history = port.history.map((value) => Math.max(0, Math.round(value * 0.62)));
  }

  const impact = Number(advice.impact.toFixed(1));
  addExecutionRecord("规则引擎", advice.action, advice.portName, impact);
  return { changed: true, impact };
}

export function sanitizeSnmpConfigInput(input: unknown):
  | { ok: true; patch: Partial<SnmpConfig> }
  | { ok: false; message: string } {
  const source = (input ?? {}) as Record<string, unknown>;
  const patch: Partial<SnmpConfig> = {};

  if (source.model !== undefined) {
    patch.model = String(source.model || "").trim();
  }
  if (source.host !== undefined) {
    patch.host = String(source.host || "").trim();
  }
  if (source.version !== undefined) {
    const version = String(source.version);
    if (!["v1", "v2c", "v3"].includes(version)) {
      return { ok: false, message: "SNMP 版本仅支持 v1 / v2c / v3" };
    }
    patch.version = version as SnmpConfig["version"];
  }
  if (source.port !== undefined) {
    const port = Number(source.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return { ok: false, message: "SNMP 端口范围需在 1-65535" };
    }
    patch.port = port;
  }
  if (source.credential !== undefined) {
    patch.credential = String(source.credential || "").trim();
  }
  if (source.security !== undefined) {
    const security = String(source.security);
    if (!["authPriv", "authNoPriv", "noAuthNoPriv"].includes(security)) {
      return { ok: false, message: "SNMP 安全模式不合法" };
    }
    patch.security = security as SnmpConfig["security"];
  }
  if (source.usageThreshold !== undefined) {
    const threshold = Number(source.usageThreshold);
    if (!Number.isFinite(threshold) || threshold < 5 || threshold > 60) {
      return { ok: false, message: "利用率阈值需在 5-60" };
    }
    patch.usageThreshold = threshold;
  }
  if (source.connectionThreshold !== undefined) {
    const threshold = Number(source.connectionThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      return { ok: false, message: "连接数阈值需在 0-100" };
    }
    patch.connectionThreshold = threshold;
  }
  if (source.schedule !== undefined) {
    const checkedSchedule = validateExecutionSchedule(String(source.schedule || "").trim());
    if (!checkedSchedule.ok) {
      return { ok: false, message: checkedSchedule.message || "执行时窗格式不合法" };
    }
    patch.schedule = checkedSchedule.normalized;
  }
  if (source.strategy !== undefined) {
    const strategy = String(source.strategy);
    if (!["close", "reduce", "hybrid"].includes(strategy)) {
      return { ok: false, message: "策略仅支持 close / reduce / hybrid" };
    }
    patch.strategy = strategy as SnmpConfig["strategy"];
  }

  if (!Object.keys(patch).length) {
    return { ok: false, message: "没有可更新字段" };
  }

  if (patch.host !== undefined && patch.host && !validateIp(patch.host) && !/^[a-zA-Z0-9.-]+$/.test(patch.host)) {
    return { ok: false, message: "管理地址格式无效" };
  }

  return { ok: true, patch };
}

export function listAuditLogs(input: { limit?: unknown; module?: unknown; action?: unknown }) {
  const rawLimit = Array.isArray(input.limit) ? input.limit[0] : input.limit;
  const rawModule = Array.isArray(input.module) ? input.module[0] : input.module;
  const rawAction = Array.isArray(input.action) ? input.action[0] : input.action;

  const limit = clamp(Number(rawLimit) || 120, 1, 500);
  const moduleFilter = String(rawModule || "").trim();
  const actionFilter = String(rawAction || "").trim();

  let items = state.auditLogs;
  if (moduleFilter) {
    items = items.filter((item) => item.module.includes(moduleFilter));
  }
  if (actionFilter) {
    items = items.filter((item) => item.action.includes(actionFilter));
  }

  return items.slice(0, limit);
}

export function compareWindows(leftDays: number, rightDays: number) {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  const leftStart = now - leftDays * oneDay;
  const leftEnd = now;
  const rightStart = leftStart - rightDays * oneDay;
  const rightEnd = leftStart;

  const sumByWindow = (start: number, end: number) =>
    state.executionRecords.reduce((sum, record) => {
      const time = new Date(record.timeISO).valueOf();
      if (Number.isNaN(time)) return sum;
      if (time >= start && time < end) return sum + record.impact;
      return sum;
    }, 0);

  const left = Number(sumByWindow(leftStart, leftEnd).toFixed(1));
  const right = Number(sumByWindow(rightStart, rightEnd).toFixed(1));
  const delta = Number((left - right).toFixed(1));
  const ratio = right > 0 ? Number((((left - right) / right) * 100).toFixed(1)) : null;

  return { left, right, delta, ratio };
}

export function findAgentRunById(runId: string): AgentRunRecord | null {
  return state.agentRuns.find((run) => run.id === runId) ?? null;
}

export function markAdviceAppliedByPortId(portId: string): void {
  state.advice.forEach((entry) => {
    if (entry.portId === portId) {
      entry.applied = true;
    }
  });
}

export function analyzeCurrentInterfaces(): void {
  state.advice = state.interfaces
    .filter((port) => !port.applied)
    .filter((port) => getInterfaceStatus(port, state.manualThreshold).className !== "active")
    .map((port) => createAdvice(port, state.manualThreshold, state.idleDuration))
    .sort((left, right) => right.confidence - left.confidence);
}

export { createAdvice, executeGuardrailStrategy, getInterfaceStatus };
