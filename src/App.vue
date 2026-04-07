<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { Component } from "vue";
import BrandLogo from "./components/BrandLogo.vue";
import { useEnergyConsole } from "./composables/useEnergyConsole";
import AuditView from "./views/AuditView.vue";
import AgentOpsView from "./views/AgentOpsView.vue";
import InsightView from "./views/InsightView.vue";
import OverviewView from "./views/OverviewView.vue";

type ConsolePageKey = "overview" | "insight" | "agent" | "audit";

interface ConsolePageMeta {
  key: ConsolePageKey;
  nav: string;
  note: string;
  title: string;
  tag: string;
  summary: string;
  metric: string;
  component: Component;
}

const store = useEnergyConsole();
const currentPage = ref<ConsolePageKey>("overview");

const pageList = computed<ConsolePageMeta[]>(() => [
  {
    key: "overview",
    nav: "总览驾驶舱",
    note: "先看自治运行态势、待优化端口和整体收益。",
    title: "总览驾驶舱",
    tag: "总体态势",
    summary: "查看当前自治状态、重点端口、核心收益和最近处理结果。",
    metric: `${store.heroMetrics.idlePorts.length} 个待优化`,
    component: OverviewView,
  },
  {
    key: "insight",
    nav: "可视化统计",
    note: "查看节能趋势、策略分布和绿色收益。",
    title: "可视化统计页",
    tag: "图形分析",
    summary: "查看节能趋势、策略分布和绿色收益变化。",
    metric: `${store.donutTotal} 条策略`,
    component: InsightView,
  },
  {
    key: "agent",
    nav: "自治智能体",
    note: "护栏、自治巡检、风险筛选与自动执行一体化闭环。",
    title: "自治智能体主控台",
    tag: "自治智能体",
    summary: "配置执行边界，查看自治巡检、风险评估和自动执行结果。",
    metric: `${store.agentSummary.planned} 个待执行`,
    component: AgentOpsView,
  },
  {
    key: "audit",
    nav: "审计日志",
    note: "查看最近操作、巡检结果和执行记录。",
    title: "审计与追踪页",
    tag: "追溯记录",
    summary: "查看最近操作、巡检结果和执行记录。",
    metric: `${store.auditLogs.length} 条记录`,
    component: AuditView,
  },
]);

const currentPageMeta = computed(
  () => pageList.value.find((item) => item.key === currentPage.value) ?? pageList.value[0],
);
const overviewPage = computed(() => pageList.value[0]);
const subPages = computed(() => pageList.value.filter((item) => item.key !== "overview"));

const headerSignals = computed(() => [
  { label: "夜间时窗", value: store.snmpForm.schedule || "--" },
  { label: "安全等级", value: `${store.securityGrade} 级` },
  { label: "当前时间", value: store.controlClock },
]);

function normalizeHash(hash: string): ConsolePageKey {
  const cleaned = hash.replace(/^#\/?/, "");
  if (cleaned === "auto" || cleaned === "manual") {
    return "agent";
  }
  const matched = pageList.value.find((item) => item.key === cleaned);
  return matched?.key ?? "overview";
}

function syncPageFromHash() {
  currentPage.value = normalizeHash(typeof window === "undefined" ? "" : window.location.hash);
}

function setPage(page: ConsolePageKey) {
  if (typeof window === "undefined") {
    currentPage.value = page;
    return;
  }

  if (normalizeHash(window.location.hash) === page) {
    currentPage.value = page;
    return;
  }

  window.location.hash = page;
}

onMounted(() => {
  syncPageFromHash();
  if (typeof window !== "undefined") {
    window.addEventListener("hashchange", syncPageFromHash);
    if (!window.location.hash) {
      window.location.hash = "overview";
    }
  }
});

onBeforeUnmount(() => {
  if (typeof window !== "undefined") {
    window.removeEventListener("hashchange", syncPageFromHash);
  }
});
</script>

<template>
  <div class="page-shell">
    <div class="page-grid"></div>
    <div class="page-orbit orbit-a"></div>
    <div class="page-orbit orbit-b"></div>

    <div class="app-shell">
      <header class="app-header panel">
        <div class="app-header-main">
          <div class="brand-lockup app-header-brand">
            <BrandLogo class="brand-badge" />
            <div>
              <p class="capsule-label">校园交换机智能体平台</p>
              <h1>交换机智能体节能控制台</h1>
              <p>集中查看自治状态、节能收益、重点端口和最近执行结果。</p>
            </div>
          </div>

          <div class="app-header-status">
            <article v-for="item in headerSignals" :key="item.label" class="header-signal-card">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
            </article>
          </div>
        </div>

        <div class="app-nav-row">
          <section class="nav-cluster">
            <div class="nav-cluster-head">
              <p class="capsule-label">首页</p>
            </div>
            <nav class="top-nav-links">
              <a
                class="top-nav-link home-link"
                :class="{ active: currentPage === overviewPage.key }"
                :href="`#${overviewPage.key}`"
                @click.prevent="setPage(overviewPage.key)"
              >
                <strong>{{ overviewPage.nav }}</strong>
                <small>{{ overviewPage.note }}</small>
                <span>{{ overviewPage.metric }}</span>
              </a>
            </nav>
          </section>

          <section class="nav-cluster">
            <div class="nav-cluster-head">
              <p class="capsule-label">功能页</p>
            </div>
            <nav class="top-nav-links">
              <a
                v-for="item in subPages"
                :key="item.key"
                class="top-nav-link"
                :class="{ active: currentPage === item.key }"
                :href="`#${item.key}`"
                @click.prevent="setPage(item.key)"
              >
                <strong>{{ item.nav }}</strong>
                <small>{{ item.note }}</small>
                <span>{{ item.metric }}</span>
              </a>
            </nav>
          </section>
        </div>
      </header>

      <section class="app-main">
        <component :is="currentPageMeta.component" />
      </section>
    </div>
  </div>
</template>
