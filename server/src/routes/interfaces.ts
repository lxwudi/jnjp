import { Router } from "express";
import { requireAuth } from "../services/auth.js";
import { addAuditLog, persistState, state } from "../services/store.js";
import {
  analyzeCurrentInterfaces,
  applyAdviceRecord,
  summarizeNow,
  validateInterfacePayload,
} from "../services/console.js";
import { parseCsvRows } from "../utils/csv.js";
import { sendError, sendOk, asyncHandler } from "../utils/http.js";

export const interfacesRouter = Router();
export const manualRouter = Router();
export const adviceRouter = Router();

interfacesRouter.use(requireAuth());
manualRouter.use(requireAuth());
adviceRouter.use(requireAuth());

interfacesRouter.get("/", (_req, res) => {
  sendOk(res, state.interfaces);
});

interfacesRouter.post(
  "/",
  requireAuth(["admin", "operator"]),
  asyncHandler((req, res) => {
    const checked = validateInterfacePayload(req.body);

    if (!checked.ok) {
      sendError(res, 400, checked.message);
      return;
    }

    state.interfaces.unshift(checked.record);
    addAuditLog("接口库", "新增接口", checked.record.name, "接口已加入待分析池");
    persistState();
    sendOk(res, checked.record, 201);
  }),
);

interfacesRouter.post(
  "/import-csv",
  requireAuth(["admin", "operator"]),
  asyncHandler((req, res) => {
    const csvText = String(req.body?.csvText || "");

    if (!csvText.trim()) {
      sendError(res, 400, "CSV 内容不能为空");
      return;
    }

    const rows = parseCsvRows(csvText);
    const inserted: typeof state.interfaces = [];
    const errors: Array<{ line: number; message: string }> = [];

    rows.forEach((row) => {
      const [name, ip, mask, usage, history, connections] = row.values;
      const checked = validateInterfacePayload({
        name,
        ip,
        mask,
        usage: Number(usage?.trim()),
        history: history || "",
        connections: Number(connections?.trim()),
      });

      if (!checked.ok) {
        errors.push({ line: row.line, message: checked.message });
        return;
      }

      inserted.push(checked.record);
    });

    state.interfaces.unshift(...inserted);
    addAuditLog("接口库", "CSV 导入", "接口池", `成功 ${inserted.length} 条，失败 ${errors.length} 条`);
    persistState();
    sendOk(res, {
      insertedCount: inserted.length,
      errorCount: errors.length,
      errors,
      inserted,
    });
  }),
);

interfacesRouter.delete(
  "/",
  requireAuth(["admin", "operator"]),
  (_req, res) => {
    state.interfaces = [];
    state.advice = [];
    addAuditLog("接口库", "清空接口", "接口池", "所有接口与建议已清空");
    persistState();
    sendOk(res);
  },
);

manualRouter.post(
  "/analyze",
  requireAuth(["admin", "operator"]),
  asyncHandler((req, res) => {
    if (req.body?.manualThreshold !== undefined) {
      const threshold = Number(req.body.manualThreshold);
      if (!Number.isFinite(threshold) || threshold < 5 || threshold > 50) {
        sendError(res, 400, "manualThreshold 需在 5-50");
        return;
      }
      state.manualThreshold = threshold;
    }

    if (req.body?.idleDuration !== undefined) {
      const idleDuration = Number(req.body.idleDuration);
      if (!Number.isFinite(idleDuration) || ![15, 30, 60, 120].includes(idleDuration)) {
        sendError(res, 400, "idleDuration 仅支持 15 / 30 / 60 / 120");
        return;
      }
      state.idleDuration = idleDuration;
    }

    if (!state.interfaces.length) {
      sendError(res, 400, "请先录入接口或导入 CSV");
      return;
    }

    analyzeCurrentInterfaces();
    addAuditLog("规则引擎", "分析接口", "接口池", `生成 ${state.advice.length} 条节能建议`);
    persistState();
    sendOk(res, { advice: state.advice, ...summarizeNow() });
  }),
);

adviceRouter.get("/", (_req, res) => {
  sendOk(res, state.advice);
});

adviceRouter.post(
  "/apply-all",
  requireAuth(["admin", "operator"]),
  (_req, res) => {
    let appliedCount = 0;
    let totalImpact = 0;

    state.advice.forEach((item) => {
      if (item.applied) return;
      const result = applyAdviceRecord(item);
      if (result.changed) {
        appliedCount += 1;
        totalImpact += result.impact;
      }
    });

    addAuditLog("节能方案", "批量执行", "建议队列", `执行 ${appliedCount} 条建议`);
    persistState();
    sendOk(res, {
      appliedCount,
      totalImpact: Number(totalImpact.toFixed(1)),
      ...summarizeNow(),
    });
  },
);

adviceRouter.post(
  "/:id/apply",
  requireAuth(["admin", "operator"]),
  asyncHandler((req, res) => {
    const rawAdviceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const adviceId = decodeURIComponent(rawAdviceId);
    const advice = state.advice.find((item) => item.id === adviceId);

    if (!advice) {
      sendError(res, 404, "建议不存在");
      return;
    }

    const result = applyAdviceRecord(advice);
    if (result.changed) {
      addAuditLog("节能方案", "执行建议", advice.portName, `${advice.action}，预计节省 ${advice.impact.toFixed(1)} kWh/年`);
      persistState();
    }

    sendOk(res, { advice, ...summarizeNow() });
  }),
);
