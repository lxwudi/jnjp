import type { AgentActionRecord, AgentEngineInfo, InterfaceRecord } from "../types/domain.js";
import { formatDate } from "../utils/energy.js";
import { addAuditLog, addAgentRun, defaultAgentProviderConfig, persistState, state } from "./store.js";
import { analyzeCurrentInterfaces } from "./console.js";
import { createAgentRunFromPlannedActions, evaluatePortAction } from "./agents.js";
import { executeAndPersistAgentRun } from "./agent-execution.js";
import { createAgentJob, appendAgentJobEvent, markAgentJobPlanned, resetAgentRuntimeHistory } from "./agent-runtime.js";
import { hydrateAgentAutonomyRuntime, suspendAgentAutonomySchedule } from "./agent-autonomy.js";

const DEMO_GOAL =
  "在不影响教学网络与办公接入连续性的前提下，优先自动处理宿舍汇聚、实验室接入口和办公区低负载端口，形成一套可解释、可复盘的校园节能演示链路。";

const DEMO_ENGINE: AgentEngineInfo = {
  kind: "heuristic",
  provider: "local",
  model: "rule-engine",
  workflow: ["planner", "fallback", "execution"],
};

function buildDemoInterfaces(): InterfaceRecord[] {
  return [
    {
      id: "demo-ge-03",
      name: "GE1/0/03",
      ip: "10.10.1.13",
      mask: "255.255.255.0",
      usage: 6,
      history: [7, 6, 6, 5, 6],
      connections: 0,
      applied: false,
    },
    {
      id: "demo-ge-07",
      name: "GE1/0/07",
      ip: "10.10.1.17",
      mask: "255.255.255.0",
      usage: 13,
      history: [14, 13, 12, 13, 12],
      connections: 1,
      applied: false,
    },
    {
      id: "demo-ge-12",
      name: "GE1/0/12",
      ip: "10.10.1.22",
      mask: "255.255.255.0",
      usage: 4,
      history: [5, 4, 4, 3, 4],
      connections: 0,
      applied: false,
    },
    {
      id: "demo-ge-14",
      name: "GE1/0/14",
      ip: "10.10.1.24",
      mask: "255.255.255.0",
      usage: 9,
      history: [9, 10, 9, 8, 9],
      connections: 1,
      applied: false,
    },
    {
      id: "demo-ge-18",
      name: "GE1/0/18",
      ip: "10.10.1.28",
      mask: "255.255.255.0",
      usage: 15,
      history: [16, 15, 14, 16, 15],
      connections: 4,
      applied: false,
    },
    {
      id: "demo-ge-21",
      name: "GE1/0/21",
      ip: "10.10.1.31",
      mask: "255.255.255.0",
      usage: 17,
      history: [18, 17, 16, 18, 17],
      connections: 2,
      applied: false,
    },
    {
      id: "demo-ge-24",
      name: "GE1/0/24",
      ip: "10.10.1.34",
      mask: "255.255.255.0",
      usage: 28,
      history: [30, 29, 28, 27, 28],
      connections: 5,
      applied: false,
    },
    {
      id: "demo-ge-27",
      name: "GE1/0/27",
      ip: "10.10.1.37",
      mask: "255.255.255.0",
      usage: 43,
      history: [42, 44, 43, 41, 43],
      connections: 10,
      applied: false,
    },
    {
      id: "demo-ge-30",
      name: "GE1/0/30",
      ip: "10.10.1.40",
      mask: "255.255.255.0",
      usage: 12,
      history: [11, 12, 13, 12, 12],
      connections: 0,
      applied: false,
    },
    {
      id: "demo-ge-32",
      name: "GE1/0/32",
      ip: "10.10.1.42",
      mask: "255.255.255.0",
      usage: 14,
      history: [14, 15, 14, 13, 14],
      connections: 2,
      applied: false,
    },
  ];
}

function findPort(portId: string): InterfaceRecord {
  const port = state.interfaces.find((item) => item.id === portId);
  if (!port) {
    throw new Error(`演示端口不存在: ${portId}`);
  }
  return port;
}

function buildAction(portId: string, actionKey: AgentActionRecord["actionKey"], extraReasons: string[]): AgentActionRecord {
  return evaluatePortAction({
    port: findPort(portId),
    actionKey,
    manualThreshold: state.manualThreshold,
    inSchedule: true,
    extraReasons,
  });
}

function seedExecutedRun(input: {
  summaryMessage: string;
  resultMessage: string;
  executionMessage: string;
  actions: AgentActionRecord[];
}) {
  const job = createAgentJob({
    operator: "agent-autonomy",
    goal: DEMO_GOAL,
    workflow: DEMO_ENGINE.workflow,
    engine: DEMO_ENGINE,
  });

  appendAgentJobEvent({
    jobId: job.id,
    eventType: "status",
    stage: "planner",
    agentName: "规则规划器",
    message: input.summaryMessage,
  });

  const run = createAgentRunFromPlannedActions({
    interfaces: state.interfaces,
    manualThreshold: state.manualThreshold,
    idleDuration: state.idleDuration,
    snmpConfig: state.snmpConfig,
    operator: "agent-autonomy",
    actionLimit: input.actions.length,
    actions: input.actions,
    explanation: input.resultMessage,
    gateMode: "auto",
    gateReason: "演示场景中本轮动作均为低风险，允许直接自动执行。",
    engine: DEMO_ENGINE,
    jobId: job.id,
    goal: DEMO_GOAL,
  });

  appendAgentJobEvent({
    jobId: job.id,
    eventType: "result",
    stage: "completed",
    agentName: "规则规划器",
    message: `已生成 ${input.actions.length} 个可自动放行的节能动作，进入执行阶段。`,
    payload: {
      selectedCount: input.actions.length,
      savingKwh: run.simulation.totals.savingKwh,
      riskLevel: run.simulation.risk.level,
    },
  });

  addAgentRun(run);
  markAgentJobPlanned(job.id, run);

  executeAndPersistAgentRun({
    run,
    approvedBy: "agent-autonomy",
    moduleName: "自治智能体",
    actionName: "自动执行策略",
    executionMessage: input.executionMessage,
  });

  return run;
}

export function seedDemoScenario() {
  suspendAgentAutonomySchedule();
  resetAgentRuntimeHistory();

  state.interfaces = buildDemoInterfaces();
  state.advice = [];
  state.auditLogs = [];
  state.executionRecords = [];
  state.agentRuns = [];
  state.manualThreshold = 18;
  state.idleDuration = 60;
  state.guardrailsEnabled = true;
  state.autonomyConfig = {
    enabled: true,
    intervalSeconds: 1800,
    actionLimit: 4,
    goal: DEMO_GOAL,
    allowHeuristicFallback: true,
  };
  state.agentProviderConfig = defaultAgentProviderConfig();
  state.snmpConfig = {
    model: "S12708E Campus Demo Core",
    host: "10.10.0.8",
    version: "v3",
    port: 161,
    credential: "campus-energy-demo",
    security: "authPriv",
    usageThreshold: 15,
    connectionThreshold: 4,
    schedule: "00:00 - 23:59",
    strategy: "hybrid",
  };

  addAuditLog("接口库", "载入演示数据", "接口池", "已装载 10 个演示接口，覆盖宿舍、实验室与办公区场景。");
  addAuditLog("智能体护栏", "更新执行边界", "自治主控", "演示环境已启用全天时窗、15% 利用率阈值和 4 个连接数阈值。");

  seedExecutedRun({
    summaryMessage: "夜间宿舍汇聚交换机巡检完成，识别出 3 个长期低负载端口。",
    resultMessage: "夜间批处理窗口内发现 3 个长期低负载端口，均满足自动执行条件，适合直接落地节能动作。",
    executionMessage: "演示数据：首轮夜间巡检已自动执行 3 项低风险动作。",
    actions: [
      buildAction("demo-ge-03", "close", ["宿舍楼层交换机在凌晨 00:00 后持续零连接"]),
      buildAction("demo-ge-07", "reduce", ["接入口仅承载低频打印与门禁回传业务"]),
      buildAction("demo-ge-30", "close", ["晚间巡检连续 3 小时未观察到新增流量"]),
    ],
  });

  const latestRun = seedExecutedRun({
    summaryMessage: "实验室与办公区午间巡检完成，仍有 3 个接口可以在不影响业务的前提下自动节能。",
    resultMessage: "本轮自治巡检完成后，系统对实验室接入口与办公区低负载端口执行了第二轮低风险节能动作。",
    executionMessage: "演示数据：第二轮自治巡检已自动执行 3 项低风险动作，并完成留痕。",
    actions: [
      buildAction("demo-ge-12", "close", ["实验室闲置工位交换口连续低负载且零连接"]),
      buildAction("demo-ge-14", "reduce", ["教师办公区接入口仅保留轻载终端在线"]),
      buildAction("demo-ge-21", "hybrid", ["实验室边缘交换口保留少量连接，但业务对时延不敏感"]),
    ],
  });

  analyzeCurrentInterfaces();
  addAuditLog("规则引擎", "补充建议", "接口池", `已基于剩余接口生成 ${state.advice.length} 条待人工关注建议。`);

  const now = new Date();
  hydrateAgentAutonomyRuntime({
    status: "idle",
    currentJobId: null,
    currentRunId: null,
    lastRunId: latestRun.id,
    lastCycleAt: formatDate(now),
    lastCycleAtISO: now.toISOString(),
    lastMessage: "演示数据已载入，最近一轮自治巡检已自动执行 3 项低风险动作；其余高连接端口保留为人工关注建议。",
    lastOutcome: "executed",
  });

  persistState();

  return {
    interfaceCount: state.interfaces.length,
    adviceCount: state.advice.length,
    runCount: state.agentRuns.length,
    latestRunId: latestRun.id,
  };
}
