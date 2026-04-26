import { Router } from "express";
import { requireAuth } from "../services/auth.js";
import { compareWindows, getMetrics, summarizeNow } from "../services/console.js";
import { state } from "../services/store.js";
import { buildTrendSeries, clamp } from "../utils/energy.js";
import { sendOk } from "../utils/http.js";

export const statsRouter = Router();
export const reportRouter = Router();

type ActionBucketKey = "close" | "reduce" | "hybrid";

const donutMeta: Record<ActionBucketKey, { label: string; color: string }> = {
  close: { label: "关闭接口", color: "#c5ff48" },
  reduce: { label: "低功耗", color: "#00c2ff" },
  hybrid: { label: "模式调整", color: "#ff7c45" },
};

function classifyActionKey(input: string): ActionBucketKey | null {
  const text = String(input || "").trim();
  if (!text) return null;
  if (text.includes("关闭")) return "close";
  if (text.includes("低功耗")) return "reduce";
  if (text.includes("模式") || text.includes("调整")) return "hybrid";
  return null;
}

function buildDonutData() {
  const counters: Record<ActionBucketKey, number> = {
    close: 0,
    reduce: 0,
    hybrid: 0,
  };

  const addCounter = (key: ActionBucketKey | null) => {
    if (!key) return;
    counters[key] += 1;
  };

  if (state.executionRecords.length > 0) {
    state.executionRecords.forEach((item) => addCounter(classifyActionKey(item.action)));
  } else if (state.agentRuns.length > 0) {
    state.agentRuns.forEach((run) => {
      run.plan.actions.forEach((action) => {
        if (action.actionKey === "close") addCounter("close");
        else if (action.actionKey === "reduce") addCounter("reduce");
        else addCounter("hybrid");
      });
    });
  } else {
    state.advice.forEach((item) => addCounter(classifyActionKey(item.action)));
  }

  return (Object.keys(donutMeta) as ActionBucketKey[]).map((key) => ({
    label: donutMeta[key].label,
    value: counters[key],
    color: donutMeta[key].color,
  }));
}

statsRouter.use(requireAuth());
reportRouter.use(requireAuth());

statsRouter.get("/overview", (_req, res) => {
  sendOk(res, summarizeNow());
});

statsRouter.get("/trend", (_req, res) => {
  const metrics = getMetrics();
  const trend = buildTrendSeries(state.executionRecords, metrics.projectedSaving);
  const donut = buildDonutData();
  sendOk(res, { trend, donut });
});

statsRouter.get("/compare", (req, res) => {
  const leftRaw = Array.isArray(req.query.leftDays) ? req.query.leftDays[0] : req.query.leftDays;
  const rightRaw = Array.isArray(req.query.rightDays) ? req.query.rightDays[0] : req.query.rightDays;
  const leftDays = clamp(Number(leftRaw) || 30, 1, 365);
  const rightDays = clamp(Number(rightRaw) || 30, 1, 365);
  const result = compareWindows(leftDays, rightDays);
  sendOk(res, { leftDays, rightDays, ...result });
});

statsRouter.get("/eco", (_req, res) => {
  const metrics = getMetrics();
  sendOk(res, {
    yearCarbonKg: Number(metrics.carbon.toFixed(1)),
    equivalentTrees: Number(metrics.trees.toFixed(1)),
    savingExecutions: metrics.executedActionCount,
    highConfidenceAdvice: metrics.highConfidenceCount,
    projectedSavingKwh: Number(metrics.projectedSaving.toFixed(1)),
  });
});

reportRouter.get("/summary", (_req, res) => {
  const metrics = getMetrics();
  const report = [
    `当前接口总数：${state.interfaces.length}`,
    `闲置可优化端口：${metrics.idlePorts.length}`,
    `待执行建议：${metrics.pendingAdvice.length}`,
    `已执行动作：${metrics.executedActionCount}`,
    `年预计节电：${metrics.projectedSaving.toFixed(1)} kWh`,
    `年减碳量：${metrics.carbon.toFixed(1)} kg`,
    `护栏候选端口：${metrics.guardrailCandidates.length}`,
    `当前风险等级：${metrics.riskLevel}`,
  ].join("；");

  sendOk(res, { report });
});
