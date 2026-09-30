<script setup>
/** 操作审计：时间线视图 */
import { computed } from 'vue'
import { ago } from '../api.js'

const props = defineProps({
  audit: { type: Array, default: () => [] }
})

const OP_LABEL = { add: '创建', delete: '删除', passwd: '改密', machine_add: '接入机器', machine_remove: '移除机器', bootstrap: '密码引导', admin_add: '新增管理员', admin_delete: '删除管理员' }

function fmtTs(ts) {
  return new Date(ts * 1000).toLocaleString('zh-CN')
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <span class="eyebrow"><i></i>AUDIT</span>
        <h1>操作审计</h1>
        <div class="sub">账号操作的完整记录 · 持久化保存在中心节点 audit.json</div>
      </div>
    </div>
    <div class="bezel rise in">
      <div class="core">
        <div v-if="!audit.length" class="loading">暂无操作记录</div>
        <div v-else class="tl">
          <div v-for="(a, i) in audit" :key="i" class="tl-item" :class="{ bad: !a.ok }">
            <div class="when">{{ fmtTs(a.ts) }} · {{ ago(a.ts) }}</div>
            <div class="what">
              <span class="op">{{ OP_LABEL[a.action] || a.action }}</span>
              <b>{{ a.user }}</b>
              <span style="color:var(--muted)"> · {{ a.machines.join('、') || '无' }}</span>
              <span v-if="a.actor" class="chip" style="margin-left:6px;padding:2px 9px;font-size:10px">by {{ a.actor }}</span>
            </div>
            <div v-if="a.why" class="why">{{ a.why }}</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
