import "dotenv/config";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import type { Tool } from "openai/resources/responses/responses";
import type { ReasoningEffort } from "openai/resources/shared";
import type {
  AgentActionRecord,
  AgentProviderConfig,
  AgentProviderConfigSnapshot,
  AgentReasoningEffort,
  AgentReviewRecord,
  AgentStage,
  AgentStatus,
  InterfaceRecord,
  SessionUser,
  StrategyKey,
  SubmittedAgentPlan,
  SubmittedAgentPlanAction,
} from "../types/domain.js";
import { average, clamp, getInterfaceStatus, isWithinSchedule } from "../utils/energy.js";
import { getMetrics } from "./console.js";
import { createAgentRunFromPlannedActions, evaluatePortAction } from "./agents.js";
import { state } from "./store.js";

type ToolCallLike = {
  type?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
};

type ReasoningEffortValue = Exclude<ReasoningEffort, null>;

type ToolHandler = (args: Record<string, unknown>) => unknown;

type ReviewOutcome = AgentReviewRecord & {
  gateMode: "auto" | "manual";
  gateReason: string;
};

type ChatToolCallLike = {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type ChatAssistantMessageLike = {
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
};

export interface AgentProgressEvent {
  eventType: "status" | "tool" | "review" | "result" | "error";
  stage: AgentStage;
  agentName?: string | null;
  message: string;
  payload?: Record<string, unknown> | null;
}

export type AgentProgressReporter = (event: AgentProgressEvent) => void | Promise<void>;

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.1";
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(process.env.OPENAI_REASONING_EFFORT);
const MAX_TOOL_ROUNDS = clamp(Number(process.env.OPENAI_AGENT_MAX_TOOL_ROUNDS) || 8, 2, 16);
const FINAL_PLAN_TOOL_NAME = "submit_strategy_plan";
const REVIEW_TOOL_NAME = "submit_review_assessment";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

let clientSingleton: OpenAI | null = null;

type ApiCompatibilityMode = "responses" | "chat_completions";

function normalizeReasoningEffort(input: string | undefined): ReasoningEffortValue {
  if (input === "none" || input === "minimal" || input === "low" || input === "high" || input === "xhigh") {
    return input;
  }
  return "medium";
}

function normalizeReasoningEffortValue(input: unknown, fallback: AgentReasoningEffort): AgentReasoningEffort {
  if (
    input === "none" ||
    input === "minimal" ||
    input === "low" ||
    input === "medium" ||
    input === "high" ||
    input === "xhigh"
  ) {
    return input;
  }
  return fallback;
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasStoredProviderConfig(config: AgentProviderConfig): boolean {
  return Boolean(config.baseUrl.trim() || config.apiKey.trim() || config.model.trim() || config.reasoningEffort !== "medium");
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isDeepSeekCompatible(model: string, baseUrl: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  return normalizedModel.startsWith("deepseek") || normalizedBaseUrl.includes("deepseek.com");
}

function inferCompatibleBaseUrl(model: string, baseUrl: string): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (normalizedBaseUrl) return normalizedBaseUrl;
  if (isDeepSeekCompatible(model, normalizedBaseUrl)) return DEEPSEEK_BASE_URL;
  return "";
}

function getApiCompatibilityMode(model: string, baseUrl: string): ApiCompatibilityMode {
  return isDeepSeekCompatible(model, baseUrl) ? "chat_completions" : "responses";
}

function resolveProviderConfig(): {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: AgentReasoningEffort;
  source: "console" | "env" | "default";
  mode: ApiCompatibilityMode;
} {
  const stored = state.agentProviderConfig;
  const envBaseUrl = normalizeBaseUrl(trimString(process.env.OPENAI_BASE_URL));
  const envApiKey = trimString(process.env.OPENAI_API_KEY);
  const envModel = trimString(process.env.OPENAI_MODEL);
  const envReasoningEffort = normalizeReasoningEffortValue(process.env.OPENAI_REASONING_EFFORT, DEFAULT_REASONING_EFFORT);
  const hasStored = hasStoredProviderConfig(stored);
  const source = hasStored ? "console" : envApiKey || envBaseUrl || envModel ? "env" : "default";
  const storedBaseUrl = normalizeBaseUrl(trimString(stored.baseUrl));
  const storedApiKey = trimString(stored.apiKey);
  const storedModel = trimString(stored.model);
  const storedReasoningEffort = normalizeReasoningEffortValue(stored.reasoningEffort, DEFAULT_REASONING_EFFORT);
  const model = storedModel || envModel || DEFAULT_MODEL;
  const baseUrl = inferCompatibleBaseUrl(model, storedBaseUrl || envBaseUrl);

  return {
    baseUrl,
    apiKey: storedApiKey || envApiKey,
    model,
    reasoningEffort: storedReasoningEffort !== DEFAULT_REASONING_EFFORT ? storedReasoningEffort : envReasoningEffort,
    source,
    mode: getApiCompatibilityMode(model, baseUrl),
  };
}

function maskApiKey(apiKey: string): string | null {
  const trimmed = apiKey.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}****`;
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

export function resetOpenAIClient(): void {
  clientSingleton = null;
}

export function getAgentProviderConfigSnapshot(): AgentProviderConfigSnapshot {
  const resolved = resolveProviderConfig();
  return {
    provider: "openai",
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort,
    apiKeyConfigured: Boolean(resolved.apiKey),
    apiKeyPreview: maskApiKey(resolved.apiKey),
    source: resolved.source,
  };
}

export function updateAgentProviderConfig(input: {
  baseUrl?: unknown;
  apiKey?: unknown;
  clearApiKey?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
}): AgentProviderConfigSnapshot {
  if (input.baseUrl !== undefined) {
    state.agentProviderConfig.baseUrl = trimString(input.baseUrl);
  }
  if (input.model !== undefined) {
    state.agentProviderConfig.model = trimString(input.model) || DEFAULT_MODEL;
  }
  if (input.reasoningEffort !== undefined) {
    state.agentProviderConfig.reasoningEffort = normalizeReasoningEffortValue(input.reasoningEffort, DEFAULT_REASONING_EFFORT);
  }
  if (Boolean(input.clearApiKey)) {
    state.agentProviderConfig.apiKey = "";
  } else if (input.apiKey !== undefined) {
    const nextKey = trimString(input.apiKey);
    if (nextKey) {
      state.agentProviderConfig.apiKey = nextKey;
    }
  }

  state.agentProviderConfig.provider = "openai";
  resetOpenAIClient();
  return getAgentProviderConfigSnapshot();
}

function getClient(): OpenAI {
  const { apiKey, baseUrl } = resolveProviderConfig();
  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY 未配置，无法启用真实智能体。");
    (error as Error & { status?: number }).status = 503;
    throw error;
  }

  if (!clientSingleton) {
    clientSingleton = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  return clientSingleton;
}

export function getOpenAIAgentStatus(): AgentStatus {
  const resolved = resolveProviderConfig();
  const configured = Boolean(resolved.apiKey);
  const serviceLabel = resolved.mode === "chat_completions" ? "兼容模型服务" : "OpenAI";

  return {
    kind: "llm_agent",
    provider: "openai",
    configured,
    model: resolved.model,
    baseUrl: resolved.baseUrl || null,
    reasoningEffort: resolved.reasoningEffort,
    message: configured
      ? resolved.baseUrl
        ? `智能体已就绪，当前通过 ${resolved.baseUrl} 接入${serviceLabel}。`
        : "智能体已就绪，可调用工具读取接口池并生成执行计划。"
      : "未检测到 OPENAI_API_KEY，当前无法调用真实智能体。",
  };
}

async function emitProgress(report: AgentProgressReporter | undefined, event: AgentProgressEvent): Promise<void> {
  if (!report) return;
  await report(event);
}

function parseJsonObject(input: string | undefined): Record<string, unknown> {
  if (!input) return {};

  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function simplifyPort(port: InterfaceRecord) {
  const status = getInterfaceStatus(port, state.manualThreshold);
  return {
    id: port.id,
    name: port.name,
    ip: port.ip,
    usage: port.usage,
    averageHistory: Number((average(port.history) || port.usage).toFixed(1)),
    connections: port.connections,
    applied: port.applied,
    status: status.className,
    statusLabel: status.label,
  };
}

function listInterfacesTool(args: Record<string, unknown>) {
  const statusFilter = asString(args.statusFilter, "all");
  const includeApplied = asBoolean(args.includeApplied, false);
  const limit = clamp(asInteger(args.limit, 12), 1, 60);

  return state.interfaces
    .map((port) => simplifyPort(port))
    .filter((port) => {
      if (!includeApplied && port.applied) return false;
      if (statusFilter === "all") return true;
      return port.status === statusFilter;
    })
    .slice(0, limit);
}

function getConsoleSnapshotTool() {
  const metrics = getMetrics();
  return {
    manualThreshold: state.manualThreshold,
    idleDuration: state.idleDuration,
    guardrailsEnabled: state.guardrailsEnabled,
    snmpConfig: state.snmpConfig,
    metrics: {
      interfaceCount: state.interfaces.length,
      idlePortCount: metrics.idlePorts.length,
      pendingAdviceCount: metrics.pendingAdvice.length,
      appliedAdviceCount: metrics.appliedAdvice.length,
      projectedSaving: Number(metrics.projectedSaving.toFixed(1)),
      meanConfidence: Number.isFinite(metrics.meanConfidence) ? metrics.meanConfidence : 0,
      guardrailCandidateCount: metrics.guardrailCandidates.length,
      riskLevel: metrics.riskLevel,
    },
  };
}

function listExistingAdviceTool(args: Record<string, unknown>) {
  const limit = clamp(asInteger(args.limit, 8), 1, 30);
  return state.advice.slice(0, limit).map((item) => ({
    id: item.id,
    portId: item.portId,
    portName: item.portName,
    action: item.action,
    confidence: item.confidence,
    impact: item.impact,
    applied: item.applied,
  }));
}

function estimatePortActionTool(args: Record<string, unknown>) {
  const portId = asString(args.portId);
  const actionKey = asString(args.actionKey) as StrategyKey;
  const port = state.interfaces.find((item) => item.id === portId);

  if (!port) {
    return { ok: false, message: "接口不存在" };
  }

  if (!["close", "reduce", "hybrid"].includes(actionKey)) {
    return { ok: false, message: "actionKey 非法" };
  }

  const action = evaluatePortAction({
    port,
    actionKey,
    manualThreshold: state.manualThreshold,
    inSchedule: isWithinSchedule(state.snmpConfig.schedule),
  });

  return {
    ok: true,
    action,
  };
}

function parseSubmittedAction(input: unknown): SubmittedAgentPlanAction | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const actionKey = asString(value.actionKey) as StrategyKey;

  if (!["close", "reduce", "hybrid"].includes(actionKey)) {
    return null;
  }

  return {
    portId: asString(value.portId),
    actionKey,
    rationale: asString(value.rationale),
    expectedBenefit: asString(value.expectedBenefit),
    expectedRisk: asString(value.expectedRisk),
    priority: asInteger(value.priority, 999),
  };
}

function parseSubmittedPlan(argumentsJson: string | undefined): SubmittedAgentPlan | null {
  const parsed = parseJsonObject(argumentsJson);
  const hasPlanShape =
    Object.prototype.hasOwnProperty.call(parsed, "selectedActions")
    || Object.prototype.hasOwnProperty.call(parsed, "summary")
    || Object.prototype.hasOwnProperty.call(parsed, "explanation")
    || Object.prototype.hasOwnProperty.call(parsed, "gateMode");
  if (!hasPlanShape) return null;

  const selectedActionsRaw = Array.isArray(parsed.selectedActions) ? parsed.selectedActions : [];
  const selectedActions = selectedActionsRaw.map((item) => parseSubmittedAction(item)).filter(Boolean) as SubmittedAgentPlanAction[];

  return {
    summary: asString(parsed.summary),
    explanation: asString(parsed.explanation),
    gateMode: parsed.gateMode === "auto" ? "auto" : "manual",
    gateReason: asString(parsed.gateReason),
    selectedActions,
  };
}

function normalizeTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (record.type === "text" && typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractJsonObjectText(content: unknown): string | null {
  const text = normalizeTextContent(content);
  if (!text) return null;

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fencedMatch?.[1]?.trim() || text;

  if (raw.startsWith("{") && raw.endsWith("}")) return raw;

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return raw.slice(start, end + 1).trim();
  }

  return null;
}

function parseSubmittedPlanFromContent(content: unknown): SubmittedAgentPlan | null {
  const jsonText = extractJsonObjectText(content);
  return parseSubmittedPlan(jsonText ?? undefined);
}

function parseReviewOutcomeFromContent(content: unknown): ReviewOutcome | null {
  const jsonText = extractJsonObjectText(content);
  return parseReviewOutcome(jsonText ?? undefined);
}

function buildPlannerInstructions(goal: string, actionLimit: number): string {
  return [
    "你是校园交换机智能体节能控制台中的规划智能体。",
    "你的工作不是凭空想象，而是必须通过工具读取当前接口池、现有建议和动作估算结果，再提交一份可执行的节能计划。",
    "优先目标：在尽量不影响业务连续性的前提下，提出收益明确、风险可解释的节能动作。",
    "不要重复选择已执行过的接口，除非工具结果明确要求 includeApplied=true 并且你有充分理由。",
    "必须先调用 get_console_snapshot 和 list_interfaces，再对拟纳入计划的接口调用 estimate_port_action。",
    `最多只能提交 ${actionLimit} 个动作。不要虚构接口 ID，不要提交未估算过的动作。`,
    "如果本轮没有合适动作，也必须调用 submit_strategy_plan，并将 selectedActions 传为空数组，同时说明原因。",
    "如果计划中包含高风险或不确定动作，应使用 manual 门控；只有在整体风险低且理由充分时才可使用 auto 门控。",
    "完成分析后，必须调用 submit_strategy_plan 工具提交结构化结果，不要输出普通文本作为最终答案。",
    `本轮用户目标：${goal}`,
  ].join("\n");
}

function buildPlannerJsonFinalizerInstructions(actionLimit: number): string {
  return [
    "你正在为校园交换机节能智能体整理最终执行计划。",
    "你已经拿到了控制台快照、接口列表、现有建议和部分动作估算结果。",
    "请只输出一个 JSON 对象，不要输出任何额外说明、Markdown 或代码块。",
    "JSON 必须包含字段：summary、explanation、gateMode、gateReason、selectedActions。",
    `selectedActions 最多 ${actionLimit} 个动作；如果没有合适动作，请返回空数组。`,
    "selectedActions 中每一项必须包含：portId、actionKey、rationale、expectedBenefit、expectedRisk、priority。",
    "gateMode 只能是 auto 或 manual。",
  ].join("\n");
}

function buildReviewerJsonInstructions(goal: string): string {
  return [
    "你是校园交换机节能智能体的风险评审智能体。",
    "请根据给定计划和动作风险，输出一个 JSON 对象，不要输出任何额外说明、Markdown 或代码块。",
    "JSON 必须包含字段：verdict、summary、gateMode、gateReason、notes。",
    "verdict 只能是 approved 或 caution；gateMode 只能是 auto 或 manual；notes 必须是 1 到 4 条字符串。",
    "如果任一动作风险偏高、理由不足或门控不稳妥，请使用 caution 和 manual。",
    `本轮用户目标：${goal}`,
  ].join("\n");
}

type PlannerObservation = {
  toolName: string;
  args: Record<string, unknown>;
  output: unknown;
};

function getPlannerToolDefinitions(actionLimit: number): Tool[] {
  return [
    {
      type: "function",
      name: "get_console_snapshot",
      description: "读取当前控制台关键运行态势、阈值设置、护栏状态和总体指标。",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
    },
    {
      type: "function",
      name: "list_interfaces",
      description: "列出当前接口池，可按状态筛选，并控制是否包含已执行接口。",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          statusFilter: {
            type: "string",
            enum: ["all", "danger", "warning", "active"],
          },
          includeApplied: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 60 },
        },
        required: ["statusFilter", "includeApplied", "limit"],
      },
    },
    {
      type: "function",
      name: "list_existing_advice",
      description: "读取当前已有节能建议，用于避免重复和判断历史方向。",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 30 },
        },
        required: ["limit"],
      },
    },
    {
      type: "function",
      name: "estimate_port_action",
      description: "对单个接口的指定动作进行收益、风险和置信度估算。",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          portId: { type: "string" },
          actionKey: { type: "string", enum: ["close", "reduce", "hybrid"] },
        },
        required: ["portId", "actionKey"],
      },
    },
    {
      type: "function",
      name: FINAL_PLAN_TOOL_NAME,
      description: "提交最终节能计划。只有在完成必要工具调用后才能调用该函数。",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          explanation: { type: "string" },
          gateMode: { type: "string", enum: ["auto", "manual"] },
          gateReason: { type: "string" },
          selectedActions: {
            type: "array",
            minItems: 0,
            maxItems: actionLimit,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                portId: { type: "string" },
                actionKey: { type: "string", enum: ["close", "reduce", "hybrid"] },
                rationale: { type: "string" },
                expectedBenefit: { type: "string" },
                expectedRisk: { type: "string" },
                priority: { type: "integer", minimum: 1, maximum: 999 },
              },
              required: ["portId", "actionKey", "rationale", "expectedBenefit", "expectedRisk", "priority"],
            },
          },
        },
        required: ["summary", "explanation", "gateMode", "gateReason", "selectedActions"],
      },
    },
  ];
}

function getPlannerToolHandlers(): Record<string, ToolHandler> {
  return {
    get_console_snapshot: () => getConsoleSnapshotTool(),
    list_interfaces: (args) => listInterfacesTool(args),
    list_existing_advice: (args) => listExistingAdviceTool(args),
    estimate_port_action: (args) => estimatePortActionTool(args),
  };
}

function toPlannerObservation(toolName: string, args: Record<string, unknown>, output: unknown): PlannerObservation {
  return {
    toolName,
    args,
    output,
  };
}

function buildSubmittedPlanFromEstimatedActions(
  actions: AgentActionRecord[],
  actionLimit: number,
  reason = "根据已完成的动作估算结果生成保守计划。",
): SubmittedAgentPlan | null {
  const deduped = actions.filter((action, index, list) => {
    return list.findIndex((item) => item.portId === action.portId && item.actionKey === action.actionKey) === index;
  });

  const ranked = deduped
    .slice()
    .sort((left, right) => {
      const leftScore = left.impact * (left.confidence / 100) - left.riskScore * 0.08;
      const rightScore = right.impact * (right.confidence / 100) - right.riskScore * 0.08;
      return rightScore - leftScore;
    })
    .slice(0, actionLimit);

  const selectedActions = ranked.map((action, index) => ({
    portId: action.portId,
    actionKey: action.actionKey,
    rationale: `${action.portName} 当前利用率 ${action.beforeUsage}% ，连接数较低，适合优先处理。`,
    expectedBenefit: `预计节能影响 ${action.impact}，置信度 ${action.confidence}%。`,
    expectedRisk: `风险评分 ${action.riskScore}，风险等级 ${action.riskLevel}。`,
    priority: index + 1,
  }));

  if (!selectedActions.length) {
    return {
      summary: "本轮未发现适合执行的动作。",
      explanation: `${reason} 当前候选动作不足或风险收益比不理想，因此保持空计划。`,
      gateMode: "auto",
      gateReason: "当前无可执行动作。",
      selectedActions: [],
    };
  }

  const maxRisk = Math.max(...ranked.map((item) => item.riskScore));
  const gateMode = maxRisk >= 55 ? "manual" : "auto";

  return {
    summary: `已从估算结果中收敛出 ${selectedActions.length} 个候选动作。`,
    explanation: `${reason} 优先保留收益明确且风险较低的动作。`,
    gateMode,
    gateReason: gateMode === "manual" ? "部分动作风险偏高，建议人工复核。" : "当前候选动作风险较低，可自动放行。",
    selectedActions,
  };
}

async function finalizePlannerPlanWithJsonResponse(input: {
  client: OpenAI;
  goal: string;
  actionLimit: number;
  agentStatus: AgentStatus;
  observations: PlannerObservation[];
}): Promise<SubmittedAgentPlan | null> {
  const { client, goal, actionLimit, agentStatus, observations } = input;
  const completion = await client.chat.completions.create({
    model: agentStatus.model,
    messages: [
      { role: "system", content: buildPlannerJsonFinalizerInstructions(actionLimit) },
      {
        role: "user",
        content: JSON.stringify(
          {
            goal,
            consoleSnapshot: getConsoleSnapshotTool(),
            observations,
          },
          null,
          2,
        ),
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 1800,
  });

  return parseSubmittedPlanFromContent(completion.choices[0]?.message?.content);
}

function buildHeuristicReviewOutcome(selectedActions: AgentActionRecord[]): ReviewOutcome {
  const highRiskCount = selectedActions.filter((item) => item.riskScore >= 70).length;
  const avgRisk = selectedActions.length
    ? selectedActions.reduce((sum, item) => sum + item.riskScore, 0) / selectedActions.length
    : 0;
  const gateMode = highRiskCount > 0 || avgRisk >= 50 ? "manual" : "auto";

  return {
    reviewer: "风险评审智能体",
    verdict: gateMode === "manual" ? "caution" : "approved",
    summary:
      gateMode === "manual"
        ? "评审认为计划中存在需要人工确认的风险因素。"
        : "评审认为当前计划总体风险可控。",
    gateMode,
    gateReason: gateMode === "manual" ? "动作中存在中高风险项，建议人工审批。" : "动作风险较低，可自动执行。",
    notes: [
      `候选动作 ${selectedActions.length} 个`,
      `平均风险评分 ${avgRisk.toFixed(1)}`,
      highRiskCount > 0 ? `检测到 ${highRiskCount} 个高风险动作` : "未检测到高风险动作",
    ],
  };
}

function getResponseToolCalls(output: unknown): ToolCallLike[] {
  if (!Array.isArray(output)) return [];
  return output
    .filter((item) => item && typeof item === "object" && (item as ToolCallLike).type === "function_call")
    .map((item) => item as ToolCallLike);
}

function toChatCompletionTools(tools: Tool[]): ChatCompletionTool[] {
  return tools
    .filter((tool): tool is Tool & { type: "function"; name: string; description?: string; parameters?: object } => tool.type === "function")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
}

function getChatToolCalls(toolCalls: unknown): ChatToolCallLike[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((item) => item && typeof item === "object" && (item as ChatToolCallLike).function?.name)
    .map((item) => item as ChatToolCallLike);
}

function toChatAssistantContinuationMessage(message: ChatAssistantMessageLike | null | undefined): ChatCompletionMessageParam {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const content =
    typeof message?.content === "string" ? message.content : message?.content == null ? "" : JSON.stringify(message.content);
  const reasoningContent =
    typeof message?.reasoning_content === "string" && message.reasoning_content.trim()
      ? message.reasoning_content
      : null;

  return {
    role: "assistant",
    content,
    tool_calls: toolCalls as NonNullable<ChatCompletionMessageParam & { tool_calls?: unknown }>["tool_calls"],
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  } as ChatCompletionMessageParam;
}

function buildGoal(goal: string | undefined): string {
  const trimmed = String(goal || "").trim();
  if (trimmed) return trimmed;
  return "请为当前校园交换机接口池制定一份低风险、可解释、收益清晰的节能执行计划，优先保障业务连续性。";
}

function dedupeActions(actions: SubmittedAgentPlanAction[], actionLimit: number): SubmittedAgentPlanAction[] {
  const seen = new Set<string>();
  const result: SubmittedAgentPlanAction[] = [];

  actions
    .slice()
    .sort((left, right) => left.priority - right.priority)
    .forEach((item) => {
      const key = `${item.portId}:${item.actionKey}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(item);
    });

  return result.slice(0, actionLimit);
}

function buildReviewerInstructions(goal: string): string {
  return [
    "你是校园交换机智能体节能控制台中的风险评审智能体。",
    "你的职责是复核规划智能体提交的候选动作，判断这份计划是否保守、可解释，并决定是否必须人工审批。",
    "请重点查看每个动作的风险分、节能影响、置信度和业务连接数，避免冒进。",
    "如果任一动作风险偏高、理由不充分，或者整体计划说明不够稳妥，应要求 manual 门控。",
    "完成后必须调用 submit_review_assessment 工具提交结构化结论。",
    `本轮用户目标：${goal}`,
  ].join("\n");
}

function getReviewerToolDefinitions(): Tool[] {
  return [
    {
      type: "function",
      name: REVIEW_TOOL_NAME,
      description: "提交风险评审结论和门控建议。",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          verdict: { type: "string", enum: ["approved", "caution"] },
          summary: { type: "string" },
          gateMode: { type: "string", enum: ["auto", "manual"] },
          gateReason: { type: "string" },
          notes: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: { type: "string" },
          },
        },
        required: ["verdict", "summary", "gateMode", "gateReason", "notes"],
      },
    },
  ];
}

function parseReviewOutcome(argumentsJson: string | undefined): ReviewOutcome | null {
  const parsed = parseJsonObject(argumentsJson);
  const notesRaw = Array.isArray(parsed.notes) ? parsed.notes : [];
  const notes = notesRaw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);

  if (!notes.length) {
    return null;
  }

  return {
    reviewer: "风险评审智能体",
    verdict: parsed.verdict === "approved" ? "approved" : "caution",
    summary: asString(parsed.summary),
    notes,
    gateMode: parsed.gateMode === "auto" ? "auto" : "manual",
    gateReason: asString(parsed.gateReason),
  };
}

async function runPlanningAgent(input: {
  client: OpenAI;
  goal: string;
  actionLimit: number;
  agentStatus: AgentStatus;
  report?: AgentProgressReporter;
  mode: ApiCompatibilityMode;
}): Promise<{
  submittedPlan: SubmittedAgentPlan;
  responseId: string | null;
  toolCallsUsed: number;
}> {
  const { client, goal, actionLimit, agentStatus, report, mode } = input;
  const instructions = buildPlannerInstructions(goal, actionLimit);
  const tools = getPlannerToolDefinitions(actionLimit);
  const handlers = getPlannerToolHandlers();

  await emitProgress(report, {
    eventType: "status",
    stage: "planner",
    agentName: "规划智能体",
    message: "规划智能体已启动，正在读取控制台状态与接口池。",
  });

  if (mode === "chat_completions") {
    const chatTools = toChatCompletionTools(tools);
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: instructions },
      { role: "user", content: goal },
    ];
    const observations: PlannerObservation[] = [];
    const estimatedActions: AgentActionRecord[] = [];

    let completion = await client.chat.completions.create({
      model: agentStatus.model,
      messages,
      tools: chatTools,
      max_tokens: 2400,
    });

    let toolCallsUsed = 0;
    let submittedPlan: SubmittedAgentPlan | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const message = completion.choices[0]?.message;
      const toolCalls = getChatToolCalls(message?.tool_calls);
      if (!toolCalls.length) {
        submittedPlan = parseSubmittedPlanFromContent(message?.content);
        if (submittedPlan) {
          await emitProgress(report, {
            eventType: "status",
            stage: "planner",
            agentName: "规划智能体",
            message: `规划智能体已提交候选计划，共 ${submittedPlan.selectedActions.length} 个动作。`,
          });
        }
        break;
      }

      messages.push(toChatAssistantContinuationMessage(message));

      const toolOutputs: ChatCompletionMessageParam[] = [];

      for (const toolCall of toolCalls) {
        if (!toolCall.id || !toolCall.function?.name) continue;
        toolCallsUsed += 1;

        if (toolCall.function.name === FINAL_PLAN_TOOL_NAME) {
          submittedPlan = parseSubmittedPlan(toolCall.function.arguments);
          if (submittedPlan) {
            await emitProgress(report, {
              eventType: "status",
              stage: "planner",
              agentName: "规划智能体",
              message: `规划智能体已提交候选计划，共 ${submittedPlan.selectedActions.length} 个动作。`,
            });
          }
          continue;
        }

        await emitProgress(report, {
          eventType: "tool",
          stage: "planner",
          agentName: "规划智能体",
          message: `规划智能体调用工具 ${toolCall.function.name}。`,
          payload: {
            toolName: toolCall.function.name,
          },
        });

        const handler = handlers[toolCall.function.name];
        const args = parseJsonObject(toolCall.function.arguments);
        const result = handler ? handler(args) : { ok: false, message: `未知工具 ${toolCall.function.name}` };
        observations.push(toPlannerObservation(toolCall.function.name, args, result));

        if (
          toolCall.function.name === "estimate_port_action"
          && result
          && typeof result === "object"
          && (result as { ok?: unknown }).ok
          && (result as { action?: unknown }).action
        ) {
          estimatedActions.push((result as { action: AgentActionRecord }).action);
        }

        const output = JSON.stringify(result);

        toolOutputs.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: output,
        });
      }

      if (submittedPlan) break;
      if (!toolOutputs.length) break;

      messages.push(...toolOutputs);
      completion = await client.chat.completions.create({
        model: agentStatus.model,
        messages,
        tools: chatTools,
        max_tokens: 2400,
      });
    }

    if (!submittedPlan) {
      await emitProgress(report, {
        eventType: "status",
        stage: "finalize",
        agentName: "规划智能体",
        message: "规划智能体未直接提交终稿，正在根据已完成估算整理最终计划。",
      });

      submittedPlan = await finalizePlannerPlanWithJsonResponse({
        client,
        goal,
        actionLimit,
        agentStatus,
        observations,
      });
    }

    if (!submittedPlan) {
      submittedPlan = buildSubmittedPlanFromEstimatedActions(estimatedActions, actionLimit);
      if (submittedPlan) {
        await emitProgress(report, {
          eventType: "status",
          stage: "finalize",
          agentName: "规划智能体",
          message: `规划智能体已根据 ${estimatedActions.length} 条动作估算结果生成保守计划。`,
        });
      }
    }

    if (!submittedPlan) {
      const error = new Error("智能体未能生成有效计划，请稍后重试。");
      (error as Error & { status?: number }).status = 502;
      throw error;
    }

    return {
      submittedPlan,
      responseId: completion.id,
      toolCallsUsed,
    };
  }

  let response = await client.responses.create({
    model: agentStatus.model,
    instructions,
    input: goal,
    tools,
    tool_choice: "required",
    parallel_tool_calls: true,
    max_output_tokens: 2400,
    reasoning: {
      effort: agentStatus.reasoningEffort,
    },
  });

  let toolCallsUsed = 0;
  let submittedPlan: SubmittedAgentPlan | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const toolCalls = getResponseToolCalls(response.output);
    if (!toolCalls.length) break;

    const outputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];

    for (const toolCall of toolCalls) {
      if (!toolCall.call_id || !toolCall.name) continue;
      toolCallsUsed += 1;

      if (toolCall.name === FINAL_PLAN_TOOL_NAME) {
        submittedPlan = parseSubmittedPlan(toolCall.arguments);
        if (submittedPlan) {
          await emitProgress(report, {
            eventType: "status",
            stage: "planner",
            agentName: "规划智能体",
            message: `规划智能体已提交候选计划，共 ${submittedPlan.selectedActions.length} 个动作。`,
          });
        }
        continue;
      }

      await emitProgress(report, {
        eventType: "tool",
        stage: "planner",
        agentName: "规划智能体",
        message: `规划智能体调用工具 ${toolCall.name}。`,
        payload: {
          toolName: toolCall.name,
        },
      });

      const handler = handlers[toolCall.name];
      if (!handler) {
        outputs.push({
          type: "function_call_output",
          call_id: toolCall.call_id,
          output: JSON.stringify({ ok: false, message: `未知工具 ${toolCall.name}` }),
        });
        continue;
      }

      const args = parseJsonObject(toolCall.arguments);
      const result = handler(args);
      outputs.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(result),
      });
    }

    if (submittedPlan) break;
    if (!outputs.length) break;

    response = await client.responses.create({
      model: agentStatus.model,
      instructions,
      previous_response_id: response.id,
      input: outputs,
      tools,
      tool_choice: "required",
      parallel_tool_calls: true,
      max_output_tokens: 2400,
      reasoning: {
        effort: agentStatus.reasoningEffort,
      },
    });
  }

  if (!submittedPlan) {
    const error = new Error("智能体未能生成有效计划，请稍后重试。");
    (error as Error & { status?: number }).status = 502;
    throw error;
  }

  return {
    submittedPlan,
    responseId: response.id,
    toolCallsUsed,
  };
}

async function runReviewerAgent(input: {
  client: OpenAI;
  goal: string;
  agentStatus: AgentStatus;
  submittedPlan: SubmittedAgentPlan;
  selectedActions: AgentActionRecord[];
  report?: AgentProgressReporter;
  mode: ApiCompatibilityMode;
}): Promise<ReviewOutcome> {
  const { client, goal, agentStatus, submittedPlan, selectedActions, report, mode } = input;

  await emitProgress(report, {
    eventType: "status",
    stage: "reviewer",
    agentName: "风险评审智能体",
    message: "风险评审智能体开始复核计划和动作风险。",
  });

  if (mode === "chat_completions") {
    const completion = await client.chat.completions.create({
      model: agentStatus.model,
      messages: [
        { role: "system", content: buildReviewerJsonInstructions(goal) },
        {
          role: "user",
          content: JSON.stringify(
            {
              goal,
              submittedPlan,
              selectedActions,
              consoleSnapshot: getConsoleSnapshotTool(),
            },
            null,
            2,
          ),
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1600,
    });

    const review =
      parseReviewOutcomeFromContent(completion.choices[0]?.message?.content)
      || buildHeuristicReviewOutcome(selectedActions);

    if (!review) {
      const error = new Error("风险评审智能体未返回有效结论。");
      (error as Error & { status?: number }).status = 502;
      throw error;
    }

    await emitProgress(report, {
      eventType: "review",
      stage: "reviewer",
      agentName: "风险评审智能体",
      message: `风险评审完成，结论为 ${review.verdict === "approved" ? "可执行" : "需谨慎"}，建议 ${review.gateMode === "manual" ? "人工审批" : "自动放行"}。`,
      payload: {
        verdict: review.verdict,
        gateMode: review.gateMode,
      },
    });

    return review;
  }

  const response = await client.responses.create({
    model: agentStatus.model,
    instructions: buildReviewerInstructions(goal),
    input: JSON.stringify(
      {
        goal,
        submittedPlan,
        selectedActions,
        consoleSnapshot: getConsoleSnapshotTool(),
      },
      null,
      2,
    ),
    tools: getReviewerToolDefinitions(),
    tool_choice: "required",
    max_output_tokens: 1600,
    reasoning: {
      effort: agentStatus.reasoningEffort,
    },
  });

  const reviewToolCall = getResponseToolCalls(response.output).find((item) => item.name === REVIEW_TOOL_NAME);
  const review = parseReviewOutcome(reviewToolCall?.arguments);

  if (!review) {
    const error = new Error("风险评审智能体未返回有效结论。");
    (error as Error & { status?: number }).status = 502;
    throw error;
  }

  await emitProgress(report, {
    eventType: "review",
    stage: "reviewer",
    agentName: "风险评审智能体",
    message: `风险评审完成，结论为 ${review.verdict === "approved" ? "可执行" : "需谨慎"}，建议 ${review.gateMode === "manual" ? "人工审批" : "自动放行"}。`,
    payload: {
      verdict: review.verdict,
      gateMode: review.gateMode,
    },
  });

  return review;
}

export async function createOpenAIAgentRun(input: {
  operator?: SessionUser | null;
  goal?: string;
  actionLimit: number;
  report?: AgentProgressReporter;
  jobId?: string;
}) {
  const { operator, goal, actionLimit, report, jobId } = input;
  const agentStatus = getOpenAIAgentStatus();
  const providerConfig = resolveProviderConfig();
  const resolvedGoal = buildGoal(goal);
  const inSchedule = isWithinSchedule(state.snmpConfig.schedule);

  await emitProgress(report, {
    eventType: "status",
    stage: "boot",
    message: "真实智能体作业已启动，准备进入规划阶段。",
    payload: {
      model: agentStatus.model,
      reasoningEffort: agentStatus.reasoningEffort,
    },
  });

  const client = getClient();

  const planningResult = await runPlanningAgent({
    client,
    goal: resolvedGoal,
    actionLimit,
    agentStatus,
    report,
    mode: providerConfig.mode,
  });

  const selectedActions = dedupeActions(planningResult.submittedPlan.selectedActions, actionLimit)
    .map((item) => {
      const port = state.interfaces.find((entry) => entry.id === item.portId);
      if (!port || port.applied) return null;

      return evaluatePortAction({
        port,
        actionKey: item.actionKey,
        manualThreshold: state.manualThreshold,
        inSchedule,
        extraReasons: [
          `LLM 策略理由：${item.rationale}`,
          `收益判断：${item.expectedBenefit}`,
          `风险判断：${item.expectedRisk}`,
        ],
      });
    })
    .filter(Boolean) as AgentActionRecord[];

  if (!selectedActions.length) {
    const explanation =
      `${planningResult.submittedPlan.summary} ${planningResult.submittedPlan.explanation}`.trim()
      || "本轮未发现适合执行的节能动作。";
    const run = createAgentRunFromPlannedActions({
      interfaces: state.interfaces,
      manualThreshold: state.manualThreshold,
      idleDuration: state.idleDuration,
      snmpConfig: state.snmpConfig,
      operator: operator?.username || "system",
      actionLimit,
      actions: [],
      explanation,
      gateMode: "auto",
      gateReason: planningResult.submittedPlan.gateReason || "本轮未发现可执行动作。",
      goal: resolvedGoal,
      jobId,
      engine: {
        kind: "llm_agent",
        provider: "openai",
        model: agentStatus.model,
        reasoningEffort: agentStatus.reasoningEffort,
        toolCalls: planningResult.toolCallsUsed,
        responseId: planningResult.responseId,
        workflow: ["planner"],
      },
    });

    await emitProgress(report, {
      eventType: "result",
      stage: "completed",
      message: "本轮未发现合适动作，已记录为空计划。",
      payload: {
        runId: run.id,
        selectedCount: 0,
        gateMode: run.gate.mode,
        riskLevel: run.simulation.risk.level,
      },
    });

    return run;
  }

  const review = await runReviewerAgent({
    client,
    goal: resolvedGoal,
    agentStatus,
    submittedPlan: planningResult.submittedPlan,
    selectedActions,
    report,
    mode: providerConfig.mode,
  });

  await emitProgress(report, {
    eventType: "status",
    stage: "finalize",
    message: "正在汇总规划与评审结果，生成最终仿真记录。",
  });

  const run = createAgentRunFromPlannedActions({
    interfaces: state.interfaces,
    manualThreshold: state.manualThreshold,
    idleDuration: state.idleDuration,
    snmpConfig: state.snmpConfig,
    operator: operator?.username || "system",
    actionLimit,
    actions: selectedActions,
    explanation: `${planningResult.submittedPlan.summary} ${planningResult.submittedPlan.explanation} 评审结论：${review.summary}`.trim(),
    gateMode:
      planningResult.submittedPlan.gateMode === "manual" || review.gateMode === "manual"
        ? "manual"
        : "auto",
    gateReason:
      planningResult.submittedPlan.gateMode === "manual"
        ? planningResult.submittedPlan.gateReason
        : review.gateReason || planningResult.submittedPlan.gateReason,
    goal: resolvedGoal,
    jobId,
    review,
    engine: {
      kind: "llm_agent",
      provider: "openai",
      model: agentStatus.model,
      reasoningEffort: agentStatus.reasoningEffort,
      toolCalls: planningResult.toolCallsUsed,
      responseId: planningResult.responseId,
      workflow: ["planner", "reviewer"],
    },
  });

  if (run.simulation.risk.highRiskCount > 0 || run.simulation.risk.score >= 50) {
    run.gate.mode = "manual";
    run.gate.reason = "模型计划中包含中高风险动作，系统强制切换为人工审批。";
  }

  await emitProgress(report, {
    eventType: "result",
    stage: "completed",
    message: `智能体计划已生成，预计节电 ${run.simulation.totals.savingKwh} kWh。`,
    payload: {
      runId: run.id,
      selectedCount: run.plan.selectedCount,
      gateMode: run.gate.mode,
      riskLevel: run.simulation.risk.level,
    },
  });

  return run;
}
