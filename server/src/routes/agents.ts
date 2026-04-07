import { Router, type Request, type Response } from "express";
import { requireAuth } from "../services/auth.js";
import { getAgentAutonomySnapshot, runAutonomyCycle, updateAgentAutonomyConfig } from "../services/agent-autonomy.js";
import {
  appendAgentJobEvent,
  createAgentJob,
  failAgentJob,
  getAgentJobById,
  listAgentJobs,
  markAgentJobPlanned,
} from "../services/agent-runtime.js";
import { summarizeAgentRuns } from "../services/agents.js";
import { executeAndPersistAgentRun } from "../services/agent-execution.js";
import {
  createOpenAIAgentRun,
  getAgentProviderConfigSnapshot,
  getOpenAIAgentStatus,
  resetOpenAIClient,
  type AgentProgressEvent,
  type AgentProgressReporter,
  updateAgentProviderConfig,
} from "../services/openai-agent.js";
import { findAgentRunById, summarizeNow } from "../services/console.js";
import { DEFAULT_AGENT_GOAL, addAgentRun, addAuditLog, persistState, state } from "../services/store.js";
import { clamp } from "../utils/energy.js";
import { asyncHandler, sendError, sendOk } from "../utils/http.js";

export const agentRouter = Router();

agentRouter.use(requireAuth());

function writeStreamChunk(res: Response, payload: unknown): void {
  if (res.writableEnded) return;
  res.write(`${JSON.stringify(payload)}\n`);
}

function normalizeGoal(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_AGENT_GOAL;
  const trimmed = value.trim();
  return trimmed || DEFAULT_AGENT_GOAL;
}

function toMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "智能体执行失败，请稍后重试。";
}

function createJobReporter(jobId: string, res?: Response): AgentProgressReporter {
  return async (event: AgentProgressEvent) => {
    const storedEvent = appendAgentJobEvent({
      jobId,
      eventType: event.eventType,
      stage: event.stage,
      agentName: event.agentName ?? null,
      message: event.message,
      payload: event.payload ?? null,
    });

    if (res) {
      writeStreamChunk(res, {
        type: "event",
        event: storedEvent,
      });
    }
  };
}

async function executePlanningJob(req: Request, res?: Response) {
  const actionLimit = clamp(Number(req.body?.actionLimit) || 8, 1, 20);
  const goal = normalizeGoal(req.body?.goal);
  const agentStatus = getOpenAIAgentStatus();
  const engine = {
    kind: "llm_agent" as const,
    provider: "openai" as const,
    model: agentStatus.model,
    reasoningEffort: agentStatus.reasoningEffort,
    workflow: ["planner", "reviewer"],
  };

  const job = createAgentJob({
    operator: req.authUser?.username || "system",
    goal,
    workflow: engine.workflow,
    engine,
  });

  if (res) {
    writeStreamChunk(res, {
      type: "job",
      job,
    });
  }

  const report = createJobReporter(job.id, res);

  try {
    const run = await createOpenAIAgentRun({
      operator: req.authUser,
      goal,
      actionLimit,
      report,
      jobId: job.id,
    });

    addAgentRun(run);
    addAuditLog(
      "智能体",
      "生成策略",
      `Run ${run.id.slice(0, 8)}`,
      `候选 ${run.plan.candidateCount}，入选 ${run.plan.selectedCount}，风险 ${run.simulation.risk.level}`,
    );
    persistState();

    const summary = summarizeAgentRuns(state.agentRuns);
    const plannedJob = markAgentJobPlanned(job.id, run);

    if (res && plannedJob) {
      writeStreamChunk(res, {
        type: "job",
        job: plannedJob,
      });
    }

    return {
      run,
      summary,
      job: plannedJob,
    };
  } catch (error) {
    const message = toMessage(error);
    await report({
      eventType: "error",
      stage: "failed",
      message,
    });
    const failedJob = failAgentJob(job.id, message);

    if (res && failedJob) {
      writeStreamChunk(res, {
        type: "job",
        job: failedJob,
      });
    }

    throw error;
  }
}

agentRouter.get("/status", (_req, res) => {
  sendOk(res, getOpenAIAgentStatus());
});

agentRouter.get("/provider", (_req, res) => {
  sendOk(res, getAgentProviderConfigSnapshot());
});

agentRouter.put(
  "/provider",
  requireAuth(["admin", "operator"]),
  asyncHandler((req, res) => {
    const payload = updateAgentProviderConfig({
      baseUrl: req.body?.baseUrl,
      apiKey: req.body?.apiKey,
      clearApiKey: req.body?.clearApiKey,
      model: req.body?.model,
      reasoningEffort: req.body?.reasoningEffort,
    });

    addAuditLog(
      "智能体配置",
      req.body?.clearApiKey ? "清除模型密钥" : "更新模型接入",
      payload.model,
      `${payload.baseUrl || "官方 OpenAI"} / ${payload.reasoningEffort}`,
    );
    persistState();
    resetOpenAIClient();
    sendOk(res, payload);
  }),
);

agentRouter.get("/autonomy", (_req, res) => {
  sendOk(res, getAgentAutonomySnapshot());
});

agentRouter.put(
  "/autonomy",
  requireAuth(["admin", "operator"]),
  asyncHandler((req, res) => {
    const payload = updateAgentAutonomyConfig({
      enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined,
      intervalSeconds:
        req.body?.intervalSeconds !== undefined ? clamp(Number(req.body.intervalSeconds) || 0, 15, 3600) : undefined,
      actionLimit: req.body?.actionLimit !== undefined ? clamp(Number(req.body.actionLimit) || 0, 1, 20) : undefined,
      goal: typeof req.body?.goal === "string" ? req.body.goal : undefined,
      allowHeuristicFallback:
        typeof req.body?.allowHeuristicFallback === "boolean" ? req.body.allowHeuristicFallback : undefined,
    });

    addAuditLog(
      "自治智能体",
      payload.config.enabled ? "更新自治策略" : "暂停自治策略",
      "自治主控",
      `周期 ${payload.config.intervalSeconds}s，动作上限 ${payload.config.actionLimit}`,
    );
    persistState();
    sendOk(res, payload);
  }),
);

agentRouter.post(
  "/autonomy/run-now",
  requireAuth(["admin", "operator"]),
  asyncHandler(async (_req, res) => {
    await runAutonomyCycle("config");
    sendOk(res, getAgentAutonomySnapshot());
  }),
);

agentRouter.get("/jobs", (req, res) => {
  const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const limit = clamp(Number(limitRaw) || 12, 1, 60);
  sendOk(res, {
    items: listAgentJobs(limit),
  });
});

agentRouter.get("/runs", (req, res) => {
  const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const limit = clamp(Number(limitRaw) || 20, 1, 120);
  sendOk(res, {
    items: state.agentRuns.slice(0, limit),
    summary: summarizeAgentRuns(state.agentRuns),
  });
});

agentRouter.post(
  "/plan",
  requireAuth(["admin", "operator"]),
  asyncHandler(async (req, res) => {
    const payload = await executePlanningJob(req);
    sendOk(res, payload);
  }),
);

agentRouter.post("/plan/stream", requireAuth(["admin", "operator"]), async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    const payload = await executePlanningJob(req, res);
    writeStreamChunk(res, {
      type: "result",
      ...payload,
    });
  } catch (error) {
    if (!res.writableEnded) {
      writeStreamChunk(res, {
        type: "error",
        message: toMessage(error),
      });
    }
  } finally {
    res.end();
  }
});

agentRouter.post(
  "/:id/execute",
  requireAuth(["admin", "operator"]),
  asyncHandler((req, res) => {
    const rawRunId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const runId = decodeURIComponent(rawRunId);
    const run = findAgentRunById(runId);

    if (!run) {
      sendError(res, 404, "智能体运行记录不存在");
      return;
    }

    if (run.status === "executed") {
      sendOk(res, {
        run,
        metrics: summarizeNow(),
        job: run.jobId ? getAgentJobById(run.jobId) : null,
      });
      return;
    }

    const approved = Boolean(req.body?.approved) || Boolean(req.body?.force);
    const approvedBy = String(req.body?.approvedBy || req.authUser?.username || "operator");

    if (run.gate.mode === "manual" && !approved) {
      sendError(res, 409, "当前策略风险较高，需人工确认后执行", {
        gateMode: run.gate.mode,
        riskLevel: run.simulation.risk.level,
        riskScore: run.simulation.risk.score,
      });
      return;
    }

    const payload = executeAndPersistAgentRun({
      run,
      approvedBy,
      moduleName: "智能体",
      actionName: "执行策略",
      executionMessage: `已由 ${approvedBy} 执行 ${run.execution?.applied.length ?? run.plan.selectedCount} 个动作。`,
    });

    sendOk(res, {
      run: payload.run,
      summary: payload.summary,
      metrics: summarizeNow(),
      job: payload.job,
    });
  }),
);
