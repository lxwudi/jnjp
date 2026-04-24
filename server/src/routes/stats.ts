import { Router } from "express";
import { requireAuth } from "../services/auth.js";
import { compareWindows, getMetrics, summarizeNow } from "../services/console.js";
import { state } from "../services/store.js";
import { buildTrendSeries, clamp } from "../utils/energy.js";
import { sendOk } from "../utils/http.js";

export const statsRouter = Router();
export const reportRouter = Router();

statsRouter.use(requireAuth());
reportRouter.use(requireAuth());

statsRouter.get("/overview", (_req, res) => {
  sendOk(res, summarizeNow());
});

statsRouter.get("/trend", (_req, res) => {
  const metrics = getMetrics();
  const trend = buildTrendSeries(state.executionRecords, metrics.projectedSaving);
  const donut = [
    { label: "关闭接口", value: state.advice.filter((item) => item.action.includes("关闭")).length, color: "#c5ff48" },
    { label: "低功耗", value: state.advice.filter((item) => item.action.includes("低功耗")).length, color: "#00c2ff" },
    { label: "模式调整", value: state.advice.filter((item) => item.action.includes("工作模式")).length, color: "#ff7c45" },
  ];
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
