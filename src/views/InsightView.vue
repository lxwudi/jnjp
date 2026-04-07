<script setup lang="ts">
import { useEnergyConsole } from "../composables/useEnergyConsole";

const store = useEnergyConsole();
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
            <div class="legend-row">
              <span
                v-for="series in store.trendSeries"
                :key="series.label"
                class="legend-chip"
                :style="{ '--chip-color': series.color }"
              >
                {{ series.label }}
              </span>
            </div>
          </div>

          <div class="chart-shell">
            <svg :viewBox="`0 0 ${store.trendSvg.width} ${store.trendSvg.height}`" role="img" aria-label="年度节能趋势图">
              <defs>
                <linearGradient id="limeLine" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#c5ff48" />
                  <stop offset="100%" stop-color="#f4ffca" />
                </linearGradient>
                <linearGradient id="blueLine" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#00c2ff" />
                  <stop offset="100%" stop-color="#8be8ff" />
                </linearGradient>
              </defs>

              <line
                v-for="grid in store.trendSvg.gridLines"
                :key="grid.value"
                :x1="store.trendSvg.padding.left"
                :y1="grid.y"
                :x2="store.trendSvg.width - store.trendSvg.padding.right"
                :y2="grid.y"
                class="grid-line"
              />

              <text
                v-for="(label, index) in store.trendSvg.labels"
                :key="label"
                :x="
                  store.trendSvg.padding.left +
                  index * ((store.trendSvg.width - store.trendSvg.padding.left - store.trendSvg.padding.right) / 11)
                "
                :y="store.trendSvg.height - 12"
                class="axis-text"
                text-anchor="middle"
              >
                {{ label }}
              </text>

              <g v-for="series in store.trendSvg.series" :key="series.label">
                <polygon
                  :points="series.area"
                  :fill="series.index === 0 ? 'rgba(197,255,72,0.12)' : 'rgba(0,194,255,0.1)'"
                />
                <polyline
                  :points="series.polyline"
                  fill="none"
                  :stroke="series.index === 0 ? 'url(#limeLine)' : 'url(#blueLine)'"
                  stroke-width="4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <circle
                  v-for="point in series.points"
                  :key="`${series.label}-${point.x}`"
                  :cx="point.x"
                  :cy="point.y"
                  r="4.5"
                  :fill="series.color"
                />
              </g>
            </svg>
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
            <svg viewBox="0 0 260 260" role="img" aria-label="建议类型占比图">
              <circle cx="130" cy="130" r="90" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="28" />
              <path
                v-for="arc in store.donutArcs"
                :key="arc.label"
                :d="arc.path"
                fill="none"
                :stroke="arc.color"
                stroke-width="28"
                stroke-linecap="round"
              />
            </svg>
            <div class="donut-core">
              <span>策略总数</span>
              <strong>{{ store.donutTotal }}</strong>
            </div>
          </div>

          <div class="legend-column">
            <div v-for="group in store.donutGroups" :key="group.label" class="legend-line">
              <i :style="{ background: group.color }"></i>
              <span>{{ group.label }}</span>
              <strong>{{ group.value }}</strong>
            </div>
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
