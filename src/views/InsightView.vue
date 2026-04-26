<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { useEnergyConsole } from "../composables/useEnergyConsole";

const store = useEnergyConsole();

const trendChartRef = ref<HTMLElement | null>(null);
const donutChartRef = ref<HTMLElement | null>(null);
const interfaceSavingChartRef = ref<HTMLElement | null>(null);
let trendChart: echarts.ECharts | null = null;
let donutChart: echarts.ECharts | null = null;
let interfaceSavingChart: echarts.ECharts | null = null;

const trendSignature = computed(() => {
  const labels = store.trendSvg.labels.join("|");
  const series = store.trendSeries.map((item) => `${item.label}:${item.values.join(",")}`).join("|");
  return `${labels}::${series}`;
});

const donutSignature = computed(() => store.donutGroups.map((item) => `${item.label}:${item.value}`).join("|"));
const interfaceSavingSignature = computed(() =>
  store.interfaceSavingCurve
    .map((item) => `${item.interfaceCount}:${item.cumulativeSavingKwh}:${item.marginalSavingKwh}:${item.averageRiskScore}`)
    .join("|"),
);

const interfaceSavingCards = computed(() => [
  {
    label: "轮次",
    value: `${store.interfaceSavingSummary.interfaceCount}`,
    hint: "按治理接口数量递增",
  },
  {
    label: "累计节电",
    value: `${store.interfaceSavingSummary.projectedSavingKwh.toFixed(1)} kWh`,
    hint: "当前接口池模拟上限",
  },
  {
    label: "单口均值",
    value: `${store.interfaceSavingSummary.averageMarginalSavingKwh.toFixed(1)} kWh`,
    hint: "每新增一个治理接口的平均增量",
  },
  {
    label: "自动放行",
    value: `${store.interfaceSavingSummary.autoEligibleCount}`,
    hint: "满足低风险自治门槛的接口",
  },
]);

const recentTrendContext = computed(() => {
  const labels = store.trendSvg.labels;
  const savingSeries = store.trendSeries.find((item) => item.label === "节电量") || store.trendSeries[0];
  const carbonSeries =
    store.trendSeries.find((item) => item.label === "减碳量") ||
    store.trendSeries[Math.min(1, Math.max(store.trendSeries.length - 1, 0))];

  const recentLabels = labels.slice(-6);
  const recentSaving = (savingSeries?.values || []).slice(-6);
  const recentCarbon = (carbonSeries?.values || []).slice(-6);

  return {
    labels: recentLabels,
    saving: recentSaving,
    carbon: recentCarbon,
  };
});

const topTrendCards = computed(() => {
  const saving = recentTrendContext.value.saving;
  const carbon = recentTrendContext.value.carbon;
  const totalSaving = saving.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const totalCarbon = carbon.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const avgSaving = saving.length ? totalSaving / saving.length : 0;
  const first = Number(saving[0] || 0);
  const last = Number(saving[saving.length - 1] || 0);
  const growth = first > 0 ? ((last - first) / first) * 100 : last > 0 ? 100 : 0;

  return [
    {
      icon: "⚡",
      label: "近6月节电",
      value: `${totalSaving.toFixed(1)} kWh`,
      hint: "按趋势累计",
      tone: "kpi-lime",
    },
    {
      icon: "🌿",
      label: "近6月减碳",
      value: `${totalCarbon.toFixed(1)} kg`,
      hint: "按趋势换算",
      tone: "kpi-cyan",
    },
    {
      icon: "📊",
      label: "月均节电",
      value: `${avgSaving.toFixed(1)} kWh`,
      hint: "近6月平均",
      tone: "kpi-amber",
    },
    {
      icon: growth >= 0 ? "📈" : "📉",
      label: "近6月趋势",
      value: `${growth >= 0 ? "+" : ""}${growth.toFixed(1)}%`,
      hint: `${recentTrendContext.value.labels[0] || "起始"} -> ${recentTrendContext.value.labels[recentTrendContext.value.labels.length - 1] || "最新"}`,
      tone: growth >= 0 ? "kpi-cyan" : "kpi-rose",
    },
  ];
});

const trendAnalysisRows = computed(() => {
  const labels = recentTrendContext.value.labels;
  const values = recentTrendContext.value.saving;

  const segmentSum = (start: number, end: number) =>
    values.slice(start, Math.min(end, values.length)).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const growthRate = (prev: number, next: number) => {
    if (prev <= 0) return next > 0 ? 100 : 0;
    return ((next - prev) / prev) * 100;
  };

  const rows = [
    {
      label: `${labels[0] || "前期"}~${labels[1] || ""}`,
      compare: `${labels[2] || "中期"}~${labels[3] || ""}`,
      prev: segmentSum(0, 2),
      next: segmentSum(2, 4),
    },
    {
      label: `${labels[2] || "中期"}~${labels[3] || ""}`,
      compare: `${labels[4] || "近期"}~${labels[5] || ""}`,
      prev: segmentSum(2, 4),
      next: segmentSum(4, 6),
    },
    {
      label: labels[0] || "起始月",
      compare: labels[labels.length - 1] || "最新月",
      prev: Number(values[0] || 0),
      next: Number(values[values.length - 1] || 0),
    },
  ];

  return rows.map((item) => {
    const delta = growthRate(item.prev, item.next);
    return {
      label: `${item.label} -> ${item.compare}`,
      delta,
      positive: delta >= 0,
      width: `${Math.max(8, Math.min(Math.abs(delta), 100))}%`,
      detail: `${item.prev.toFixed(1)} -> ${item.next.toFixed(1)} kWh`,
    };
  });
});

const donutProgressRows = computed(() => {
  const total = Math.max(store.donutTotal, 0);
  return store.donutGroups.map((item) => {
    const percent = total > 0 ? (item.value / total) * 100 : 0;
    return {
      ...item,
      percent,
      width: `${Math.max(percent, percent > 0 ? 8 : 0)}%`,
    };
  });
});

function renderTrendChart() {
  if (!trendChartRef.value) return;
  if (!trendChart) {
    trendChart = echarts.init(trendChartRef.value);
  }

  const labels = store.trendSvg.labels;
  const series = store.trendSeries;
  const recentLabels = labels.slice(-6);

  trendChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(19, 46, 55, 0.9)",
      borderColor: "rgba(157, 202, 79, 0.35)",
      textStyle: { color: "#eaf5f3" },
    },
    grid: { left: 54, right: 54, top: 72, bottom: 34 },
    legend: {
      show: true,
      right: 16,
      top: 18,
      selectedMode: true,
      textStyle: { color: "#4f6973", fontSize: 12 },
      itemWidth: 14,
      itemHeight: 10,
    },
    xAxis: {
      type: "category",
      data: recentLabels,
      axisLine: { lineStyle: { color: "rgba(23, 49, 58, 0.18)" } },
      axisLabel: {
        color: "#576c75",
        interval: 0,
      },
      axisTick: { show: false },
    },
    yAxis: [
      {
        type: "value",
        name: "节电量 (kWh)",
        nameTextStyle: { color: "#576c75", fontSize: 12, padding: [0, 0, 6, 0] },
        splitLine: { lineStyle: { color: "rgba(23, 49, 58, 0.1)" } },
        axisLabel: { color: "#576c75", formatter: "{value} kWh" },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      {
        type: "value",
        name: "减碳量 (kg)",
        nameTextStyle: { color: "#576c75", fontSize: 12, padding: [0, 0, 6, 0] },
        splitLine: { show: false },
        axisLabel: { color: "#576c75", formatter: "{value} kg" },
        axisLine: { show: false },
        axisTick: { show: false },
      },
    ],
    series: series.map((item) => ({
      name: item.label,
      type: "line",
      data: item.values.slice(-6),
      yAxisIndex: item.label.includes("减碳") ? 1 : 0,
      smooth: true,
      showSymbol: true,
      symbolSize: 7,
      lineStyle: { width: 3, color: item.color },
      itemStyle: { color: item.color, borderColor: "#f7fbf8", borderWidth: 1.5 },
      areaStyle: {
        opacity: 0.2,
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: item.color },
          { offset: 1, color: "rgba(255,255,255,0)" },
        ]),
      },
      emphasis: { focus: "series" },
    })),
  });
}

function renderDonutChart() {
  if (!donutChartRef.value) return;
  if (!donutChart) {
    donutChart = echarts.init(donutChartRef.value);
  }

  const total = store.donutTotal;
  const data = store.donutGroups.map((item) => ({ name: item.label, value: item.value, itemStyle: { color: item.color } }));

  donutChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(19, 46, 55, 0.9)",
      borderColor: "rgba(16, 164, 183, 0.32)",
      textStyle: { color: "#eaf5f3" },
      formatter: "{b}<br/>数量: {c} ({d}%)",
    },
    title: {
      text: `${total}`,
      subtext: "策略总数",
      left: "center",
      top: "43%",
      textStyle: {
        color: "#17313a",
        fontSize: 34,
        fontWeight: 700,
      },
      subtextStyle: {
        color: "#576c75",
        fontSize: 12,
      },
    },
    series: [
      {
        type: "pie",
        radius: ["58%", "78%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        minAngle: 4,
        padAngle: 2,
        label: {
          color: "#17313a",
          formatter: "{b}: {d}%",
          fontSize: 12,
        },
        labelLine: {
          lineStyle: { color: "rgba(23, 49, 58, 0.28)" },
        },
        data,
      },
    ],
  });
}

function renderInterfaceSavingChart() {
  if (!interfaceSavingChartRef.value) return;
  if (!interfaceSavingChart) {
    interfaceSavingChart = echarts.init(interfaceSavingChartRef.value);
  }

  const curve = store.interfaceSavingCurve.length
    ? store.interfaceSavingCurve
    : [{ interfaceCount: 0, label: "0", cumulativeSavingKwh: 0, marginalSavingKwh: 0, averageRiskScore: 0, autoEligibleCount: 0, selectedPorts: [] }];
  const labels = curve.map((item) => item.label);

  interfaceSavingChart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(19, 46, 55, 0.92)",
      borderColor: "rgba(16, 164, 183, 0.32)",
      textStyle: { color: "#eaf5f3" },
      formatter(params: unknown) {
        const items = Array.isArray(params) ? params : [];
        const index = Number((items[0] as { dataIndex?: number } | undefined)?.dataIndex ?? 0);
        const point = curve[index];
        const lines = items.map((item) => {
          const next = item as { marker?: string; seriesName?: string; value?: number };
          return `${next.marker || ""}${next.seriesName}: ${Number(next.value || 0).toFixed(1)} kWh`;
        });
        const ports = point?.selectedPorts?.length ? `纳入接口：${point.selectedPorts.slice(0, 4).join("、")}` : "纳入接口：--";
        return [`治理接口数：${point?.interfaceCount ?? 0}`, ...lines, ports].join("<br/>");
      },
    },
    grid: { left: 86, right: 42, top: 62, bottom: 76 },
    legend: {
      show: true,
      right: 14,
      top: 12,
      textStyle: { color: "#4f6973", fontSize: 12 },
      itemWidth: 14,
      itemHeight: 10,
    },
    xAxis: {
      type: "category",
      name: "治理接口数量（个）",
      nameLocation: "middle",
      nameGap: 42,
      nameTextStyle: { color: "#17313a", fontSize: 16, fontWeight: 700 },
      data: labels,
      axisLine: { lineStyle: { color: "rgba(23, 49, 58, 0.42)", width: 1.4 } },
      axisLabel: { color: "#17313a", fontSize: 15, fontWeight: 700, margin: 14 },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: "节电量（kWh）",
      nameLocation: "middle",
      nameGap: 56,
      nameRotate: 90,
      nameTextStyle: { color: "#17313a", fontSize: 16, fontWeight: 700 },
      splitLine: { lineStyle: { color: "rgba(23, 49, 58, 0.14)" } },
      axisLabel: { color: "#17313a", formatter: "{value}", fontSize: 15, fontWeight: 700, margin: 14 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "累计节电",
        type: "line",
        data: curve.map((item) => item.cumulativeSavingKwh),
        smooth: true,
        showSymbol: true,
        symbolSize: 7,
        lineStyle: { width: 3, color: "#129db0" },
        itemStyle: { color: "#129db0", borderColor: "#f7fbf8", borderWidth: 1.5 },
        areaStyle: {
          opacity: 0.18,
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "#129db0" },
            { offset: 1, color: "rgba(255,255,255,0)" },
          ]),
        },
      },
      {
        name: "新增节电",
        type: "line",
        data: curve.map((item) => item.marginalSavingKwh),
        smooth: true,
        showSymbol: true,
        symbolSize: 7,
        lineStyle: { width: 3, color: "#c5ff48" },
        itemStyle: { color: "#9fdc32", borderColor: "#f7fbf8", borderWidth: 1.5 },
      },
    ],
  });
}

function handleResize() {
  trendChart?.resize();
  donutChart?.resize();
  interfaceSavingChart?.resize();
}

onMounted(() => {
  window.addEventListener("resize", handleResize);
  renderTrendChart();
  renderDonutChart();
  renderInterfaceSavingChart();
});

watch(trendSignature, () => {
  renderTrendChart();
}, { immediate: true });

watch(donutSignature, () => {
  renderDonutChart();
}, { immediate: true });

watch(interfaceSavingSignature, () => {
  renderInterfaceSavingChart();
}, { immediate: true });

onBeforeUnmount(() => {
  window.removeEventListener("resize", handleResize);
  trendChart?.dispose();
  donutChart?.dispose();
  interfaceSavingChart?.dispose();
  trendChart = null;
  donutChart = null;
  interfaceSavingChart = null;
});
</script>

<template>
  <div class="workspace-view insight-view">
    <section class="section-block">
      <div class="section-heading">
        <p class="capsule-label">统计分析</p>
        <h3>可视化统计与环保反馈</h3>
        <p>查看自治巡检后的节能趋势、策略分布和年度绿色收益，便于持续优化接口管理策略。</p>
      </div>

      <div class="insight-layout">
        <article class="panel module-panel trend-panel">
          <div class="panel-heading">
            <div>
              <p class="capsule-label">趋势变化</p>
              <h4>年度节能趋势</h4>
            </div>
          </div>

          <div class="insight-kpi-strip insight-kpi-strip--inside">
            <article v-for="item in topTrendCards" :key="item.label" class="insight-kpi-card" :class="item.tone">
              <div class="insight-kpi-head">
                <span class="insight-kpi-icon" aria-hidden="true">{{ item.icon }}</span>
                <p>{{ item.label }}</p>
              </div>
              <strong>{{ item.value }}</strong>
              <small>{{ item.hint }}</small>
            </article>
          </div>

          <div class="trend-dual-layout">
            <div class="chart-shell">
              <div ref="trendChartRef" class="echart-canvas" role="img" aria-label="年度节能趋势图"></div>
            </div>

            <div class="trend-analysis-panel">
              <h5>数据趋势分析</h5>
              <div class="trend-analysis-list">
                <article v-for="item in trendAnalysisRows" :key="item.label" class="trend-analysis-item">
                  <div class="trend-analysis-head">
                    <span>{{ item.label }}</span>
                    <strong :class="item.positive ? 'trend-positive' : 'trend-negative'">
                      {{ item.positive ? "+" : "" }}{{ item.delta.toFixed(1) }}%
                    </strong>
                  </div>
                  <p>{{ item.detail }}</p>
                  <div class="trend-progress-track">
                    <i :class="item.positive ? 'trend-positive-bg' : 'trend-negative-bg'" :style="{ width: item.width }"></i>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </article>

        <article class="panel module-panel interface-saving-panel">
          <div class="panel-heading">
            <div>
              <p class="capsule-label">效果曲线</p>
              <h4>接口数量与节电效果</h4>
            </div>
          </div>

          <div class="interface-effect-grid">
            <div class="chart-shell">
              <div ref="interfaceSavingChartRef" class="echart-canvas" role="img" aria-label="接口数量与节电效果折线图"></div>
            </div>

            <div class="interface-effect-summary">
              <article v-for="item in interfaceSavingCards" :key="item.label" class="display-readout">
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
                <p>{{ item.hint }}</p>
              </article>
            </div>
          </div>
        </article>

        <article class="panel module-panel donut-panel">
          <div class="panel-heading">
            <div>
              <p class="capsule-label">策略分布</p>
              <h4>建议类型占比</h4>
            </div>
          </div>

          <div class="donut-shell">
            <div ref="donutChartRef" class="echart-canvas" role="img" aria-label="建议类型占比图"></div>
          </div>

          <div class="donut-breakdown scroll-region scroll-region--sm">
            <article v-for="group in donutProgressRows" :key="group.label" class="donut-breakdown-item">
              <div class="donut-breakdown-head">
                <span>{{ group.label }}</span>
                <strong>{{ group.value }} ({{ group.percent.toFixed(1) }}%)</strong>
              </div>
              <div class="donut-progress-track">
                <i :style="{ width: group.width, background: group.color }"></i>
              </div>
            </article>
          </div>
        </article>

        <article class="panel module-panel">
          <div class="panel-heading">
            <div>
              <p class="capsule-label">绿色收益</p>
              <h4>绿色收益</h4>
            </div>
          </div>

          <div class="metric-grid">
            <article v-for="item in store.ecoMetrics" :key="item.label">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
              <p>{{ item.hint }}</p>
            </article>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
