<script setup lang="ts">
import { useEnergyConsole } from "../composables/useEnergyConsole";

const store = useEnergyConsole();
</script>

<template>
  <div class="workspace-view audit-view">
    <section class="section-block">
      <div class="section-heading">
        <p class="capsule-label">操作记录</p>
        <h3>日志记录与审计追踪</h3>
        <p>覆盖数据同步、阈值调整、自治巡检、自动执行和智能体护栏记录，便于追溯与排障。</p>
      </div>

      <article class="panel module-panel">
        <div class="panel-heading">
          <div>
            <p class="capsule-label">最近操作</p>
            <h4>最近操作</h4>
          </div>
          <button class="micro-btn" type="button" @click="store.seedAuditLogs">生成示例日志</button>
        </div>

        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>模块</th>
                <th>动作</th>
                <th>对象</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="log in store.auditLogs" :key="log.id">
                <td>{{ log.time }}</td>
                <td>{{ log.module }}</td>
                <td>{{ log.action }}</td>
                <td>{{ log.target }}</td>
                <td>{{ log.result }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
    </section>
  </div>
</template>
