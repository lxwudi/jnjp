<script setup lang="ts">
import { computed, ref } from "vue";
import { useEnergyConsole } from "../composables/useEnergyConsole";
import { CARBON_FACTOR, TREE_FACTOR } from "../lib/energy";

const store = useEnergyConsole();

type AgentSubview = "overview" | "guardrails";
type AgentConfigTab = "autonomy" | "agent";
type GuardrailConfigTab = "device" | "boundary";

const activeSubview = ref<AgentSubview>("overview");
const activeAgentConfigTab = ref<AgentConfigTab>("autonomy");
const activeGuardrailConfigTab = ref<GuardrailConfigTab>("device");
const agentFeedbackDetail = computed(() => {
  const detail = store.agentAutonomyRuntime.lastMessage || store.latestAgentJob?.latestMessage || store.agentStatus.message || "";
  return detail && detail !== store.agentFeedback ? detail : "";
});
const cumulativeAgentTotals = computed(() => {
  const savingKwh = Number(store.agentSummary.totalSaving || 0);
  return {
    savingKwh,
    carbonKg: Number((savingKwh * CARBON_FACTOR).toFixed(1)),
    trees: Number((savingKwh * TREE_FACTOR).toFixed(1)),
  };
});

const subviewMeta = computed(() =>
  activeSubview.value === "overview"
    ? {
        label: "主控总览",
        title: "自治闭环总览",
        summary: "查看模型设置、自治状态、最近结果和自动执行动作。",
      }
    : {
        label: "执行边界",
        title: "执行边界设置",
        summary: "设置执行条件，查看当前边界状态和影响范围。",
      },
);
</script>

<template>
  <div class="workspace-view agent-view">
    <section class="section-block">
      <article class="panel module-panel agent-subnav-panel">
        <div class="agent-subnav">
          <div class="agent-subnav-copy">
            <p class="capsule-label">{{ subviewMeta.label }}</p>
            <h4>{{ subviewMeta.title }}</h4>
            <p>{{ subviewMeta.summary }}</p>
          </div>
          <div class="agent-subnav-controls">
            <span class="tag-pill">最近巡检 · {{ store.agentAutonomyLastCycleLabel }}</span>
            <div class="agent-subnav-actions">
              <button
                class="subview-switch"
                :class="{ active: activeSubview === 'overview' }"
                type="button"
                @click="activeSubview = 'overview'"
              >
                主控总览
              </button>
              <button
                class="subview-switch"
                :class="{ active: activeSubview === 'guardrails' }"
                type="button"
                @click="activeSubview = 'guardrails'"
              >
                执行边界
              </button>
            </div>
          </div>
        </div>
      </article>

      <template v-if="activeSubview === 'overview'">
        <div class="split-layout">
          <article class="panel module-panel">
            <div class="panel-heading">
              <div>
                <p class="capsule-label">自治编排</p>
                <h4>自治运行策略</h4>
              </div>
              <div class="small-actions panel-tab-actions">
                <button
                  class="panel-tab-switch"
                  :class="{ active: activeAgentConfigTab === 'autonomy' }"
                  type="button"
                  @click="activeAgentConfigTab = 'autonomy'"
                >
                  自治配置
                </button>
                <button
                  class="panel-tab-switch"
                  :class="{ active: activeAgentConfigTab === 'agent' }"
                  type="button"
                  @click="activeAgentConfigTab = 'agent'"
                >
                  智能体配置
                </button>
              </div>
            </div>

            <div v-if="activeAgentConfigTab === 'autonomy'" class="agent-section-card">
              <div class="agent-section-head">
                <div>
                  <span>调度节奏</span>
                  <strong>自治巡检与动作编排</strong>
                </div>
                <small>控制巡检频率、动作数量和当前运行状态。</small>
              </div>

              <div class="agent-control-grid">
                <label>
                  <span>策略动作上限</span>
                  <input v-model.number="store.agentActionLimit" type="number" min="1" max="20" />
                </label>
                <label>
                  <span>巡检周期（秒）</span>
                  <input v-model.number="store.agentIntervalSeconds" type="number" min="15" max="3600" />
                </label>
                <div class="agent-live-pill">
                  <span>运行状态</span>
                  <strong>{{ store.agentAutonomyStatusLabel }}</strong>
                  <small>{{ store.agentRuntimeLabel }}</small>
                  <small>{{ store.agentAutonomyOutcomeLabel }} · {{ store.agentLatestJobStatusLabel }}</small>
                </div>
              </div>

              <div class="action-cluster wide">
                <button class="primary-btn slim" type="button" :disabled="store.agentBusy" @click="store.saveAgentAutonomy">
                  {{ store.agentBusy ? "同步中" : "保存自治配置" }}
                </button>
              </div>
            </div>

            <div v-if="activeAgentConfigTab === 'agent'" class="agent-section-card">
              <div class="agent-section-head">
                <div>
                  <span>模型接入</span>
                  <strong>智能体服务配置</strong>
                </div>
                <small>支持官方接口和兼容 OpenAI 协议的模型服务。</small>
              </div>

              <div class="impact-footer">
                <span>模型接入</span>
                <strong>{{ store.agentProviderApiKeyConfigured ? "已配置密钥" : "未配置密钥" }}</strong>
                <p>
                  {{
                    store.agentProviderSource === "console"
                      ? "当前模型设置已生效，智能体会按这里的配置运行。"
                      : store.agentProviderSource === "env"
                        ? "当前正在使用系统中的模型配置。"
                        : "当前还没有可用的模型配置。"
                  }}
                </p>
              </div>

              <div class="form-grid">
                <label>
                  <span>模型 Base URL</span>
                  <input
                    v-model.trim="store.agentProviderBaseUrl"
                    placeholder="可留空；DeepSeek 等兼容服务会自动补全地址"
                  />
                </label>
                <label>
                  <span>模型名称</span>
                  <input
                    v-model.trim="store.agentProviderModel"
                    placeholder="如：gpt-5.1 或兼容模型名"
                  />
                </label>
                <label>
                  <span>推理强度</span>
                  <select v-model="store.agentProviderReasoningEffort">
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                  </select>
                </label>
                <label>
                  <span>模型 API Key</span>
                  <input
                    v-model.trim="store.agentProviderApiKeyInput"
                    type="password"
                    placeholder="留空则不改动，已保存会显示掩码"
                  />
                </label>
              </div>

              <div class="action-cluster wide">
                <button class="ghost-btn" type="button" :disabled="store.agentBusy" @click="store.saveAgentProviderConfig">
                  保存模型接入
                </button>
                <button class="ghost-btn" type="button" :disabled="store.agentBusy" @click="store.clearAgentProviderApiKey">
                  清除已保存 Key
                </button>
              </div>

              <p class="feedback-line">
                {{ store.agentProviderApiKeyConfigured ? `已保存 Key：${store.agentProviderApiKeyPreview || "已配置"}` : "当前尚未保存模型 API Key。" }}
              </p>
            </div>

            <div v-if="activeAgentConfigTab === 'agent'" class="agent-section-card">
              <div class="agent-section-head">
                <div>
                  <span>目标与兜底</span>
                  <strong>自治策略偏好</strong>
                </div>
                <small>设定总体目标，并决定模型不可用时是否自动切换到预设策略。</small>
              </div>

              <label class="agent-goal-field">
                <span>自治目标</span>
                <textarea
                  v-model.trim="store.agentGoal"
                  rows="4"
                  placeholder="例如：持续保守执行，只自动处理低风险、收益明确且不影响业务连续性的动作。"
                ></textarea>
              </label>

              <div class="form-grid">
                <label>
                  <span>自治巡检</span>
                  <select v-model="store.agentAutonomyEnabled">
                    <option :value="true">开启</option>
                    <option :value="false">暂停</option>
                  </select>
                </label>
                <label>
                  <span>模型不可用时</span>
                  <select v-model="store.agentAllowHeuristicFallback">
                    <option :value="true">使用预设策略</option>
                    <option :value="false">仅使用模型智能体</option>
                  </select>
                </label>
              </div>
            </div>

            <div v-if="activeAgentConfigTab === 'autonomy'" class="agent-section-card">
              <div class="agent-section-head">
                <div>
                  <span>运行反馈</span>
                  <strong>自治执行动态</strong>
                </div>
                <small>查看当前说明、最近巡检结论和执行过程。</small>
              </div>

              <div class="impact-footer">
                <span>自治反馈</span>
                <strong>{{ store.agentFeedback }}</strong>
                <p v-if="agentFeedbackDetail">{{ agentFeedbackDetail }}</p>
              </div>

              <div class="agent-progress-panel">
                <div class="agent-progress-head">
                  <span>自治进度</span>
                  <strong>{{ store.agentLatestJobStatusLabel }}</strong>
                </div>
                <div v-if="store.agentProgressFeed.length" class="agent-progress-list scroll-region scroll-region--md">
                  <article v-for="item in store.agentProgressFeed" :key="item.id" class="agent-progress-item">
                    <small>{{ item.createdAt }}</small>
                    <strong>{{ item.agentName || item.stage }}</strong>
                    <p>{{ item.message }}</p>
                  </article>
                </div>
                <div v-else class="empty-block">下一轮自治巡检开始后，这里会显示规划、评审和执行的实时进度。</div>
              </div>
            </div>
          </article>

          <article class="panel module-panel panel-monitor">
            <div class="panel-heading">
              <div>
                <p class="capsule-label">最近结果</p>
                <h4>最近一轮自治输出</h4>
              </div>
              <span class="monitor-pill" :class="{ active: !!store.latestCompletedAgentRun }">
                {{ store.latestCompletedAgentRun ? store.latestCompletedAgentJobStatusLabel : "待巡检" }}
              </span>
            </div>

            <div v-if="store.latestCompletedAgentRun" class="timeline-box">
              <div class="timeline-row">
                <span>候选动作</span>
                <div class="timeline-rail">
                  <i :style="{ width: `${Math.min(store.latestCompletedAgentRun.plan.candidateCount * 10, 100)}%` }"></i>
                </div>
                <strong>{{ store.latestCompletedAgentRun.plan.candidateCount }}</strong>
              </div>
              <div class="timeline-row">
                <span>纳入执行</span>
                <div class="timeline-rail">
                  <i :style="{ width: `${Math.min(store.latestCompletedAgentRun.plan.selectedCount * 12, 100)}%` }"></i>
                </div>
                <strong>{{ store.latestCompletedAgentRun.plan.selectedCount }}</strong>
              </div>
              <div class="timeline-row">
                <span>风险评分</span>
                <div class="timeline-rail">
                  <i :style="{ width: `${Math.min(store.latestCompletedAgentRun.simulation.risk.score, 100)}%` }"></i>
                </div>
                <strong>{{ store.latestCompletedAgentRun.simulation.risk.score }}</strong>
              </div>
            </div>
            <div v-else class="empty-block">
              {{ store.latestCompletedAgentRun ? store.latestCompletedAgentExplanation : "等待下一轮自治巡检后，这里会显示智能体策略估算结果。" }}
            </div>

            <div v-if="store.latestCompletedAgentRun" class="agent-sim-grid">
              <article class="display-readout">
                <span>策略估算节电</span>
                <strong>{{ store.latestCompletedAgentRun.simulation.totals.savingKwh }} kWh</strong>
              </article>
              <article class="display-readout">
                <span>策略估算减碳</span>
                <strong>{{ store.latestCompletedAgentRun.simulation.totals.carbonKg }} kg</strong>
              </article>
              <article class="display-readout">
                <span>等效种树</span>
                <strong>{{ store.latestCompletedAgentRun.simulation.totals.trees.toFixed(1) }} 棵</strong>
              </article>
              <article class="display-readout">
                <span>执行模式</span>
                <strong>{{ store.latestCompletedAgentRun.gate.mode === "manual" ? "风险过滤后执行" : "自治自动执行" }}</strong>
              </article>
              <article class="display-readout">
                <span>智能体类型</span>
                <strong>{{ store.latestCompletedAgentRuntimeMode === "llm_agent" ? "模型智能体" : "预设策略" }}</strong>
              </article>
              <article class="display-readout">
                <span>协作链路</span>
                <strong>{{ store.latestCompletedAgentWorkflowLabel }}</strong>
              </article>
              <article class="display-readout">
                <span>最近作业</span>
                <strong>{{ store.latestCompletedAgentJobStatusLabel }}</strong>
              </article>
            </div>

            <div class="agent-cumulative-block">
              <div class="panel-heading agent-cumulative-heading">
                <div>
                  <p class="capsule-label">累计收益</p>
                  <h5>自治累计成效</h5>
                </div>
              </div>
              <div class="agent-sim-grid">
                <article class="display-readout">
                  <span>累计执行次数</span>
                  <strong>{{ store.agentSummary.executed }}</strong>
                </article>
                <article class="display-readout">
                  <span>累计节电</span>
                  <strong>{{ cumulativeAgentTotals.savingKwh.toFixed(1) }} kWh</strong>
                </article>
                <article class="display-readout">
                  <span>累计减碳</span>
                  <strong>{{ cumulativeAgentTotals.carbonKg.toFixed(1) }} kg</strong>
                </article>
                <article class="display-readout">
                  <span>累计等效植树</span>
                  <strong>{{ cumulativeAgentTotals.trees.toFixed(1) }} 棵</strong>
                </article>
              </div>
            </div>

            <div class="security-strip">
              <div>
                <span>解释输出</span>
                <strong>{{ store.latestCompletedAgentRun ? "可解释" : "待生成" }}</strong>
              </div>
              <p>{{ store.latestCompletedAgentExplanation }}</p>
            </div>

            <div v-if="store.latestCompletedAgentReviewSummary" class="impact-footer agent-review-footer">
              <span>风险评审</span>
              <strong>{{ store.latestCompletedAgentReviewSummary }}</strong>
              <p>{{ store.latestCompletedAgentReviewNotes.join(" / ") }}</p>
            </div>
          </article>
        </div>

        <article class="panel module-panel">
          <div class="panel-heading">
            <div>
              <p class="capsule-label">执行队列</p>
              <h4>最近自动执行动作</h4>
            </div>
            <span class="tag-pill">自治筛选后自动执行</span>
          </div>

          <div class="table-shell scroll-region scroll-region--lg">
            <table>
              <thead>
                <tr>
                  <th>接口</th>
                  <th>建议动作</th>
                  <th>当前利用率</th>
                  <th>预测利用率</th>
                  <th>节能影响</th>
                  <th>风险</th>
                  <th>置信度</th>
                  <th>依据</th>
                </tr>
              </thead>
              <tbody v-if="store.latestCompletedAgentTopActions.length">
                <tr v-for="item in store.latestCompletedAgentTopActions" :key="`${item.portId}-${item.actionKey}`">
                  <td>{{ item.portName }}</td>
                  <td>{{ item.actionLabel }}</td>
                  <td>{{ item.beforeUsage }}%</td>
                  <td>{{ item.afterUsage }}%</td>
                  <td>{{ item.impact.toFixed(1) }}</td>
                  <td>{{ item.riskLevel }} ({{ item.riskScore }})</td>
                  <td>{{ item.confidence }}%</td>
                  <td>
                    <div class="reason-stack">
                      <p>{{ item.reasons.join(" / ") }}</p>
                      <div v-if="item.knowledgeRefs.length" class="knowledge-hit-list">
                        <article v-for="ref in item.knowledgeRefs.slice(0, 2)" :key="ref.docId" class="knowledge-hit-card">
                          <strong>{{ ref.title }}</strong>
                          <small>{{ ref.sourceName }} · {{ ref.category }} · {{ ref.publishedAt }}</small>
                          <p>{{ ref.snippet }}</p>
                        </article>
                      </div>
                    </div>
                  </td>
                </tr>
              </tbody>
              <tbody v-else>
                <tr>
                  <td colspan="8">
                    <div class="empty-block">
                      {{ store.latestCompletedAgentJob ? "最近一轮自治输出没有形成可展示的动作。" : "等待下一轮自治巡检后，这里会显示最近自动执行动作。" }}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </template>

      <template v-else>
        <div class="split-layout">
          <article class="panel module-panel">
            <div class="panel-heading">
              <div>
                <p class="capsule-label">执行约束</p>
                <h4>智能体护栏</h4>
              </div>
              <div class="small-actions panel-tab-actions">
                <button
                  class="panel-tab-switch"
                  :class="{ active: activeGuardrailConfigTab === 'device' }"
                  type="button"
                  @click="activeGuardrailConfigTab = 'device'"
                >
                  设备信息
                </button>
                <button
                  class="panel-tab-switch"
                  :class="{ active: activeGuardrailConfigTab === 'boundary' }"
                  type="button"
                  @click="activeGuardrailConfigTab = 'boundary'"
                >
                  执行边界
                </button>
              </div>
            </div>

            <div v-if="activeGuardrailConfigTab === 'device'" class="agent-section-card">
              <div class="agent-section-head">
                <div>
                  <span>设备信息</span>
                  <strong>交换机与 SNMP 接入</strong>
                </div>
                <small>用于描述被管设备、接入方式和认证模式。</small>
              </div>

              <div class="form-grid">
                <label>
                  <span>交换机型号</span>
                  <input v-model.trim="store.snmpForm.model" />
                </label>
                <label>
                  <span>管理地址</span>
                  <input v-model.trim="store.snmpForm.host" />
                </label>
                <label>
                  <span>SNMP 版本</span>
                  <select v-model="store.snmpForm.version">
                    <option value="v1">SNMP v1</option>
                    <option value="v2c">SNMP v2c</option>
                    <option value="v3">SNMP v3</option>
                  </select>
                </label>
                <label>
                  <span>端口</span>
                  <input v-model.number="store.snmpForm.port" type="number" min="1" max="65535" />
                </label>
                <label>
                  <span>用户名 / Community</span>
                  <input v-model.trim="store.snmpForm.credential" />
                </label>
                <label>
                  <span>认证模式</span>
                  <select v-model="store.snmpForm.security">
                    <option value="authPriv">authPriv</option>
                    <option value="authNoPriv">authNoPriv</option>
                    <option value="noAuthNoPriv">noAuthNoPriv</option>
                  </select>
                </label>
              </div>
            </div>

            <div v-if="activeGuardrailConfigTab === 'boundary'" class="agent-section-card">
              <div class="agent-section-head">
                <div>
                  <span>执行边界</span>
                  <strong>候选筛选条件</strong>
                </div>
                <small>这些条件会影响哪些接口能进入自治评估和自动执行。</small>
              </div>

              <div class="form-grid">
                <label>
                  <span>利用率阈值 %</span>
                  <input v-model.number="store.snmpForm.usageThreshold" type="number" min="5" max="60" />
                </label>
                <label>
                  <span>连接数阈值</span>
                  <input v-model.number="store.snmpForm.connectionThreshold" type="number" min="0" max="100" />
                </label>
                <label>
                  <span>执行时窗</span>
                  <input v-model.trim="store.snmpForm.schedule" placeholder="00:00 - 23:59" />
                </label>
                <label>
                  <span>护栏动作</span>
                  <select v-model="store.snmpForm.strategy">
                    <option value="reduce">低功耗模式</option>
                    <option value="close">关闭闲置接口</option>
                    <option value="hybrid">混合节能策略</option>
                  </select>
                </label>
              </div>

              <p class="field-note">当前默认设置为全天运行。若后续需要限制自动执行时段，可以在这里改成指定时间窗口。</p>

              <div class="action-cluster wide">
                <button class="ghost-btn" type="button" @click="store.recommendThreshold">智能推荐阈值</button>
                <button class="primary-btn" type="button" @click="store.toggleGuardrails">
                  {{ store.guardrailsEnabled ? "停用护栏" : "启用护栏" }}
                </button>
              </div>

              <p class="feedback-line">{{ store.guardrailFeedback }}</p>

              <div class="security-strip">
                <div>
                  <span>安全等级</span>
                  <strong>{{ store.securityGrade }} 级</strong>
                </div>
                <p>{{ store.securityHint }}</p>
              </div>
            </div>
          </article>

          <article class="panel module-panel panel-monitor">
            <div class="panel-heading">
              <div>
                <p class="capsule-label">护栏状态</p>
                <h4>执行边界概况</h4>
              </div>
              <span class="monitor-pill" :class="{ active: store.guardrailsEnabled }">
                {{ store.guardrailsEnabled ? "已启用" : "待启用" }}
              </span>
            </div>

            <div class="metric-grid">
              <article>
                <span>推荐利用率阈值</span>
                <strong>{{ store.recommendedThreshold }}%</strong>
              </article>
              <article>
                <span>护栏候选接口</span>
                <strong>{{ store.heroMetrics.guardrailCandidates.length }}</strong>
              </article>
              <article>
                <span>预计月节电量</span>
                <strong>{{ store.heroMetrics.monthlyGuardrailSaving.toFixed(1) }} kWh</strong>
              </article>
              <article>
                <span>护栏风险</span>
                <strong>{{ store.heroMetrics.riskLevel }}</strong>
              </article>
            </div>

            <div class="timeline-box">
              <div v-for="row in store.timelineRows" :key="row.label" class="timeline-row">
                <span>{{ row.label }}</span>
                <div class="timeline-rail">
                  <i :style="{ width: row.width }"></i>
                </div>
                <strong>{{ row.value }}</strong>
              </div>
            </div>

            <div class="strategy-chip-row">
              <span class="strategy-chip" :class="store.statusTone(store.snmpForm.strategy)">
                护栏动作：{{ store.strategyLabel(store.snmpForm.strategy) }}
              </span>
              <span class="strategy-chip dark">时窗：{{ store.snmpForm.schedule || "--" }}</span>
            </div>
          </article>
        </div>
      </template>
    </section>
  </div>
</template>
