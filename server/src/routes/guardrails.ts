import { Router } from "express";
import { requireAuth } from "../services/auth.js";
import { runAutonomyCycle } from "../services/agent-autonomy.js";
import { addAuditLog, addExecutionRecord, persistState, state } from "../services/store.js";
import {
  getMetrics,
  markAdviceAppliedByPortId,
  sanitizeSnmpConfigInput,
  summarizeNow,
  executeGuardrailStrategy,
} from "../services/console.js";
import { computeRecommendedThreshold, getSecurityGrade, getSecurityHint, isWithinSchedule, strategyLabel } from "../utils/energy.js";
import { asyncHandler, sendError, sendOk } from "../utils/http.js";

export const guardrailsRouter = Router();

guardrailsRouter.use(requireAuth());

guardrailsRouter.get("/config", (_req, res) => {
  const recommendedThreshold = computeRecommendedThreshold(state.interfaces);
  const securityGrade = getSecurityGrade(state.snmpConfig);
  sendOk(res, {
    snmpConfig: state.snmpConfig,
    guardrailsEnabled: state.guardrailsEnabled,
    recommendedThreshold,
    securityGrade,
    securityHint: getSecurityHint(securityGrade),
  });
});

guardrailsRouter.put(
  "/config",
  requireAuth(["admin", "operator"]),
  asyncHandler((req, res) => {
    const checked = sanitizeSnmpConfigInput(req.body);
    if (!checked.ok) {
      sendError(res, 400, checked.message);
      return;
    }

    state.snmpConfig = { ...state.snmpConfig, ...checked.patch };
    addAuditLog("智能体护栏", "更新配置", state.snmpConfig.model, "已更新智能体护栏参数");
    persistState();
    sendOk(res, state.snmpConfig);
  }),
);

guardrailsRouter.post(
  "/recommend-threshold",
  requireAuth(["admin", "operator"]),
  (_req, res) => {
    const threshold = computeRecommendedThreshold(state.interfaces);
    state.snmpConfig.usageThreshold = threshold;
    addAuditLog("智能体护栏", "阈值推荐", "护栏策略", `系统建议阈值 ${threshold}%`);
    persistState();
    sendOk(res, { usageThreshold: threshold });
  },
);

guardrailsRouter.post(
  "/toggle",
  requireAuth(["admin", "operator"]),
  asyncHandler(async (req, res) => {
    if (typeof req.body?.active === "boolean") {
      state.guardrailsEnabled = req.body.active;
    } else {
      state.guardrailsEnabled = !state.guardrailsEnabled;
    }

    addAuditLog(
      "智能体护栏",
      state.guardrailsEnabled ? "启用护栏" : "停用护栏",
      `${state.snmpConfig.model} / ${state.snmpConfig.version}`,
      `${strategyLabel(state.snmpConfig.strategy)}，阈值 ${state.snmpConfig.usageThreshold}%`,
    );
    persistState();
    if (state.guardrailsEnabled && state.autonomyConfig.enabled) {
      await runAutonomyCycle("config");
    }
    sendOk(res, { guardrailsEnabled: state.guardrailsEnabled });
  }),
);

guardrailsRouter.post(
  "/run",
  requireAuth(["admin", "operator"]),
  asyncHandler((req, res) => {
    const dryRun = Boolean(req.body?.dryRun);
    const withinSchedule = isWithinSchedule(state.snmpConfig.schedule);
    const metrics = getMetrics();
    const candidates = metrics.guardrailCandidates;

    const actionList: Array<{
      portId: string;
      portName: string;
      action: string;
      before: number;
      after: number;
      impact: number;
      mode: "preview" | "executed";
    }> = [];
    let executedCount = 0;
    let totalImpact = 0;

    candidates.forEach((port) => {
      if (dryRun || !withinSchedule) {
        const estimatedImpact = Number(Math.max(state.snmpConfig.usageThreshold + 12 - port.usage, 0).toFixed(1));
        actionList.push({
          portId: port.id,
          portName: port.name,
          action: strategyLabel(state.snmpConfig.strategy),
          before: port.usage,
          after: port.usage,
          impact: estimatedImpact,
          mode: "preview",
        });
        totalImpact += estimatedImpact;
        return;
      }

      const executed = executeGuardrailStrategy(port, state.snmpConfig.strategy);
      executedCount += 1;
      totalImpact += executed.impact;
      addExecutionRecord("智能体护栏", executed.action, port.name, executed.impact);
      markAdviceAppliedByPortId(port.id);

      actionList.push({
        portId: port.id,
        portName: port.name,
        action: executed.action,
        before: executed.before,
        after: executed.after,
        impact: executed.impact,
        mode: "executed",
      });
    });

    addAuditLog(
      "智能体护栏",
      dryRun ? "护栏预演" : "护栏执行",
      state.snmpConfig.model,
      `候选 ${candidates.length}，执行 ${executedCount}，预估影响 ${totalImpact.toFixed(1)} 单位`,
    );
    persistState();
    sendOk(res, {
      withinSchedule,
      dryRun,
      candidateCount: candidates.length,
      executedCount,
      totalImpact: Number(totalImpact.toFixed(1)),
      actions: actionList,
      ...summarizeNow(),
    });
  }),
);
