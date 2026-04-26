<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { useEnergyConsole } from "../composables/useEnergyConsole";

const store = useEnergyConsole();

const trendChartRef = ref<HTMLElement | null>(null);
const donutChartRef = ref<HTMLElement | null>(null);
let trendChart: echarts.ECharts | null = null;
let donutChart: echarts.ECharts | null = null;

const trendSignature = computed(() => {
  const labels = store.trendSvg.labels.join("|");
  const series = store.trendSeries.map((item) => `${item.label}:${item.values.join(",")}`).join("|");
  return `${labels}::${series}`;
});

const donutSignature = computed(() => store.donutGroups.map((item) => `${item.label}:${item.value}`).join("|"));

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

function handleResize() {
  trendChart?.resize();
  donutChart?.resize();
}

onMounted(() => {
  window.addEventListener("resize", handleResize);
  renderTrendChart();
  renderDonutChart();
});

watch(trendSignature, () => {
  renderTrendChart();
}, { immediate: true });

watch(donutSignature, () => {
  renderDonutChart();
}, { immediate: true });

onBeforeUnmount(() => {
  window.removeEventListener("resize", handleResize);
  trendChart?.dispose();
  donutChart?.dispose();
  trendChart = null;
  donutChart = null;
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
