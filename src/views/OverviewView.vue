<script setup lang="ts">
import { computed } from "vue";
import { average, getInterfaceStatus } from "../lib/energy";
import { useEnergyConsole } from "../composables/useEnergyConsole";

const store = useEnergyConsole();

const pendingAgentRun = computed(() => {
  const run = store.latestCompletedAgentRun;
  if (!run || run.status === "executed" || run.plan.selectedCount <= 0) return null;
  return run;
});

const overviewStatusLabel = computed(() => {
  if (pendingAgentRun.value) {
    return store.latestCompletedAgentNeedsApproval ? "计划待确认" : "计划待执行";
  }
  return store.agentAutonomyStatusLabel;
});

const overviewOutcomeLabel = computed(() => {
  if (pendingAgentRun.value) {
    return store.latestCompletedAgentNeedsApproval ? "计划待人工确认" : "计划待执行";
  }
  if (store.latestCompletedAgentRun?.status === "executed") {
    return "最近一轮已执行";
  }
  return store.agentAutonomyOutcomeLabel;
});

const summaryCards = computed(() => [
  {
    label: pendingAgentRun.value ? "待处理端口" : "待优化端口",
    value: `${pendingAgentRun.value?.plan.selectedCount ?? store.heroMetrics.idlePorts.length}`,
    hint: pendingAgentRun.value ? "最近计划中等待确认或执行的接口数量" : "当前满足闲置判定、值得优先处理的接口数量",
  },
  {
    label: "自治候选动作",
    value: `${pendingAgentRun.value?.plan.selectedCount ?? store.heroMetrics.guardrailCandidates.length}`,
    hint: pendingAgentRun.value ? "最近一轮智能体生成、等待处理的动作数量" : "在当前护栏边界内，允许纳入自治规划的接口数量",
  },
  {
    label: "累计节电",
    value: `${store.heroMetrics.totalSaving.toFixed(1)} kWh`,
    hint: "按已执行动作累计估算的节电收益",
  },
  {
    label: "最近结论",
    value: overviewOutcomeLabel.value,
    hint: pendingAgentRun.value
      ? `风险等级：${pendingAgentRun.value.simulation.risk.level}，评分 ${pendingAgentRun.value.simulation.risk.score}`
      : `最近作业状态：${store.latestCompletedAgentRun ? store.latestCompletedAgentJobStatusLabel : store.agentLatestJobStatusLabel}`,
  },
]);

const statusCards = computed(() => [
  {
    label: "自治状态",
    value: overviewStatusLabel.value,
    hint: store.agentAutonomyRuntime.lastMessage || "自治智能体正在等待下一轮巡检。",
  },
  {
    label: "运行模式",
    value: store.agentRuntimeMode === "llm_agent" ? "模型智能体" : "预设策略",
    hint: store.agentRuntimeLabel,
  },
  {
    label: "执行边界",
    value: store.guardrailsEnabled ? "已启用" : "待启用",
    hint: `${store.strategyLabel(store.snmpForm.strategy)} · ${store.snmpForm.schedule || "--"}`,
  },
  {
    label: "安全等级",
    value: `${store.securityGrade} 级`,
    hint: store.securityHint,
  },
]);

const focusPorts = computed(() => {
  const merged = [
    ...store.heroMetrics.guardrailCandidates,
    ...store.heroMetrics.idlePorts,
    ...[...store.interfaces].sort((left, right) => left.usage - right.usage || left.connections - right.connections),
  ];
  const uniquePorts = new Map<string, (typeof merged)[number]>();

  for (const port of merged) {
    if (!uniquePorts.has(port.id)) uniquePorts.set(port.id, port);
  }

  return Array.from(uniquePorts.values())
    .slice(0, 6)
    .map((port) => {
      const status = getInterfaceStatus(port, Number(store.manualThreshold));
      const avgHistory = average(port.history) || port.usage;
      return {
        id: port.id,
        name: port.name,
        ip: port.ip,
        usage: port.usage,
        avgHistory: avgHistory.toFixed(1),
        connections: port.connections,
        status: port.applied ? "已执行" : status.label,
        tone: port.applied ? "active" : status.className,
        note: port.applied ? "已完成节能处理" : port.connections === 0 ? "零连接，可优先处理" : `${port.connections} 个活动连接`,
      };
    });
});

const latestRunMetrics = computed(() => [
  {
    label: "候选动作",
    value: String(store.latestCompletedAgentRun?.plan.candidateCount ?? 0).padStart(2, "0"),
  },
  {
    label: "纳入执行",
    value: String(store.latestCompletedAgentRun?.plan.selectedCount ?? 0).padStart(2, "0"),
  },
  {
    label: "风险等级",
    value: store.latestCompletedAgentRun?.simulation.risk.level || "--",
  },
  {
    label: "执行方式",
    value: store.latestCompletedAgentRun ? (store.latestCompletedAgentRun.gate.mode === "manual" ? "风险过滤" : "自治自动") : "--",
  },
]);
</script>

<template>
  <div class="workspace-view overview-view overview-dashboard">
    <section class="split-layout overview-command-grid">
      <article class="panel module-panel overview-hero-panel">
        <div class="panel-heading">
          <div>
            <p class="capsule-label">总览驾驶舱</p>
            <h4>自治节能运行态势</h4>
          </div>
          <span class="monitor-pill" :class="{ active: store.agentAutonomyEnabled && store.guardrailsEnabled }">
            {{ overviewStatusLabel }}
          </span>
        </div>

        <p class="overview-summary">
          先看当前自治状态、重点端口和最近结果，再进入对应页面继续处理。
        </p>

        <div class="metric-grid overview-stat-grid">
          <article v-for="item in summaryCards" :key="item.label" class="overview-stat-card">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
            <p>{{ item.hint }}</p>
          </article>
        </div>

        <div class="action-cluster wide">
          <a class="primary-btn" href="#agent">进入自治主控</a>
          <a class="ghost-btn" href="#insight">查看统计分析</a>
          <a class="ghost-btn" href="#audit">查看审计追踪</a>
        </div>
      </article>

      <article class="panel module-panel panel-monitor">
        <div class="panel-heading">
          <div>
            <p class="capsule-label">状态快照</p>
            <h4>当前系统判断</h4>
          </div>
          <span class="tag-pill">{{ store.agentWorkflowLabel }}</span>
        </div>

        <div class="overview-status-list">
          <article v-for="item in statusCards" :key="item.label" class="overview-status-item">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
            <p>{{ item.hint }}</p>
          </article>
        </div>

        <div class="impact-footer">
          <span>当前说明</span>
          <strong>{{ store.agentFeedback }}</strong>
          <p>{{ store.latestCompletedAgentExplanation || store.agentStatus.message }}</p>
        </div>
      </article>
    </section>

    <section class="split-layout overview-main-grid">
      <article class="panel module-panel">
        <div class="panel-heading">
          <div>
            <p class="capsule-label">重点端口</p>
            <h4>当前最值得关注的接口</h4>
          </div>
          <span class="tag-pill">{{ focusPorts.length }} 个焦点端口</span>
        </div>

        <div v-if="focusPorts.length" class="overview-focus-list scroll-region scroll-region--lg">
          <article v-for="port in focusPorts" :key="port.id" class="overview-focus-item">
            <div class="overview-focus-main">
              <div>
                <strong>{{ port.name }}</strong>
                <small>{{ port.ip }}</small>
              </div>
              <span class="status-pill" :class="port.tone">{{ port.status }}</span>
            </div>
            <div class="overview-focus-meta">
              <span>当前利用率 {{ port.usage }}%</span>
              <span>历史均值 {{ port.avgHistory }}%</span>
              <span>{{ port.note }}</span>
            </div>
          </article>
        </div>
        <div v-else class="empty-block">当前没有需要特别关注的接口。</div>
      </article>

      <article class="panel module-panel panel-monitor">
        <div class="panel-heading">
          <div>
            <p class="capsule-label">最近执行</p>
            <h4>最近一轮自治结果</h4>
          </div>
          <span class="monitor-pill" :class="{ active: !!store.latestCompletedAgentRun }">
            {{ store.latestCompletedAgentRun ? store.latestCompletedAgentJobStatusLabel : "待巡检" }}
          </span>
        </div>

        <div class="metric-grid overview-run-metrics">
          <article v-for="item in latestRunMetrics" :key="item.label">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </article>
        </div>

        <div v-if="store.latestCompletedAgentTopActions.length" class="overview-action-list scroll-region scroll-region--sm">
          <article
            v-for="item in store.latestCompletedAgentTopActions.slice(0, 4)"
            :key="`${item.portId}-${item.actionKey}`"
            class="overview-action-item"
          >
            <div>
              <strong>{{ item.portName }}</strong>
              <p>{{ item.actionLabel }} · 置信度 {{ item.confidence }}%</p>
            </div>
            <span>{{ item.impact.toFixed(1) }}</span>
          </article>
        </div>
        <div v-else class="empty-block">
          {{ store.latestCompletedAgentRun ? store.latestCompletedAgentExplanation : "等待下一轮自治巡检后，这里会显示最近的自动执行动作。" }}
        </div>
      </article>
    </section>

  </div>
</template>
