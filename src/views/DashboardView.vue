<script setup>
/** 总览：统计卡 + 机器卡片 + 占卡进程表 */
import { computed, reactive, ref } from 'vue'
import Sparkline from '../components/Sparkline.vue'
import StatBar from '../components/StatBar.vue'
import BootstrapModal from '../components/BootstrapModal.vue'
import { fmtB, fmtMB, ago } from '../api.js'

const props = defineProps({
  state: { type: Object, required: true },
  onRefresh: { type: Function, required: true },
  toast: { type: Function, required: true }
})

const expanded = reactive({})
const bootTarget = ref(null)   // { host, ip } → 打开密码引导弹窗
const search = ref('')

const machines = computed(() => props.state?.machines || [])

// 搜索过滤：按机器名或 IP（子串匹配，不区分大小写）
const machinesShown = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return machines.value
  return machines.value.filter(m =>
    m.host.toLowerCase().includes(q) || String(m.ip || '').toLowerCase().includes(q)
  )
})
const scrollable = computed(() => machinesShown.value.length > 8)

const online = computed(() => machines.value.filter(m => m.online))
const gpus = computed(() => online.value.flatMap(m => m.gpus || []))
const avgU = computed(() => gpus.value.length ? Math.round(gpus.value.reduce((a, g) => a + g.util, 0) / gpus.value.length) : 0)
const memUsed = computed(() => gpus.value.reduce((a, g) => a + (g.mem_used || 0), 0))
const memTot = computed(() => gpus.value.reduce((a, g) => a + (g.mem_total || 0), 0))
const memPct = computed(() => memTot.value ? Math.round(memUsed.value * 100 / memTot.value) : 0)
const procAll = computed(() => machines.value.flatMap(m => (m.procs || []).map(p => ({ ...p, host: m.host }))))
const whoAll = computed(() => online.value.flatMap(m => (m.who || []).map(w => ({ ...w, host: m.host }))))
const uniqUsers = computed(() => [...new Set(whoAll.value.map(w => w.user))])

const stats = computed(() => [
  { l: '在线机器', v: online.value.length, s: `/ ${machines.value.length} 台`, d: online.value.length === machines.value.length ? '<b>全部在线</b>' : '部分离线' },
  { l: 'GPU 平均利用率', v: avgU.value, s: '%', d: `${gpus.value.length} 张卡` },
  { l: '显存占用', v: memPct.value, s: '%', d: `${fmtMB(memUsed.value)} / ${fmtMB(memTot.value)}` },
  { l: '活跃用户 / 进程', v: uniqUsers.value.length, s: '', d: `${procAll.value.length} 个 GPU 进程` }
])

function subText(m) {
  return `${online.value.length}/${machines.value.length} 台在线 · 采集间隔 ${props.state?.poll_interval}s` + (props.state?.demo ? ' · 演示模式' : '')
}

function gpuOf(m) { return (m.gpus || [])[0] || {} }
function memAvgPct(m) {
  const g = m.gpus || []
  if (!g.length) return 0
  const used = g.reduce((a, x) => a + x.mem_used, 0)
  const tot = g.reduce((a, x) => a + x.mem_total, 0)
  return tot ? Math.round(used * 100 / tot) : 0
}
function whoUnique(m) {
  const map = new Map()
  for (const w of m.who || []) map.set(w.user, w)
  return [...map.values()]
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <span class="eyebrow"><i></i>OVERVIEW</span>
        <h1>集群总览</h1>
        <div class="sub">{{ subText() }}</div>
      </div>
      <button class="btn ghost sm" @click="onRefresh()">
        <span>刷新</span>
        <span class="ic"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.7h-2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </button>
    </div>

    <div class="bento">
      <div v-for="(s, i) in stats" :key="s.l" class="bezel b-3 rise" :style="{ transitionDelay: i * 70 + 'ms' }">
        <div class="core stat">
          <div class="label">{{ s.l }}</div>
          <div class="value">{{ s.v }}<small>{{ s.s }}</small></div>
          <div class="delta" v-html="s.d"></div>
        </div>
      </div>
    </div>

    <div style="height:18px"></div>

    <!-- 机器搜索 -->
    <div class="msearch-row">
      <div class="msearch bezel"><div class="core">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="flex:none;color:var(--faint)"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        <input v-model="search" class="msearch-inp" placeholder="搜索机器：名称或 IP，如 gpu-03 / 192.168.1.13">
        <button v-if="search" class="iact" style="flex:none" @click="search = ''">清除</button>
      </div></div>
      <span class="chip">{{ machinesShown.length }} / {{ machines.length }} 台{{ scrollable ? ' · 下滑查看更多' : '' }}</span>
    </div>
    <div style="height:18px"></div>

    <div class="bento" :class="{ 'bento-scroll': scrollable }">
      <div v-for="m in machinesShown" :key="m.host" class="bezel b-6 rise">
        <div class="core mcard">
          <div class="mhead">
            <span class="dot" :class="m.online ? 'on' : 'off'"></span>
            <div>
              <div class="name">{{ m.host }}</div>
              <div class="ip">{{ m.ip }}{{ m.online ? '' : ' · 离线' }}</div>
            </div>
            <div class="spacer"></div>
            <span class="chip">用户 <b>{{ (m.who || []).length }}</b></span>
            <span class="chip" :class="(m.procs || []).length ? 'hot' : ''">占卡 <b>{{ (m.procs || []).length }}</b></span>
          </div>

          <template v-if="m.online">
            <div class="gpu-block">
              <div class="gpu-title">
                <span>{{ gpuOf(m).name || 'GPU' }}</span>
                <span class="u">{{ gpuOf(m).util || 0 }}<small>% util</small></span>
              </div>
              <StatBar :value="gpuOf(m).util || 0" />
              <div class="gmeta">
                <span>显存 <b>{{ fmtMB(gpuOf(m).mem_used) }} / {{ fmtMB(gpuOf(m).mem_total) }}</b></span>
                <span>温度 <b>{{ gpuOf(m).temp || '—' }}°C</b></span>
                <span>功耗 <b>{{ gpuOf(m).power || '—' }} W</b></span>
              </div>
              <StatBar :value="memAvgPct(m)" tone="green" />
            </div>

            <div class="sys3">
              <div class="mini-row"><span>CPU</span><StatBar :value="m.cpu?.used_pct || 0" /><b>{{ m.cpu?.used_pct || 0 }}%</b></div>
              <div class="mini-row"><span>内存</span><StatBar :value="m.mem?.pct || 0" tone="green" /><b>{{ m.mem?.pct || 0 }}%</b></div>
              <div class="mini-row"><span>磁盘</span><StatBar :value="m.disk?.pct || 0" :tone="(m.disk?.pct || 0) > 85 ? 'amber' : ''" /><b>{{ m.disk?.pct || 0 }}%</b></div>
            </div>

            <Sparkline :hist="m.history" key-name="u" />

            <button class="expand-btn" :class="{ open: !!expanded[m.host] }" @click="expanded[m.host] = !expanded[m.host]">
              <span>GPU 进程与登录用户</span>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>

            <div class="detail" :class="{ open: !!expanded[m.host] }">
              <table class="ptable">
                <thead><tr><th>用户</th><th>进程</th><th>PID</th><th>显存</th><th>时长</th></tr></thead>
                <tbody>
                  <tr v-for="p in m.procs" :key="p.pid">
                    <td class="user">{{ p.user }}</td>
                    <td class="cmd">{{ p.comm }}{{ p.args ? ' ' + p.args : '' }}</td>
                    <td>{{ p.pid }}</td>
                    <td>{{ fmtMB(p.mem_mb) }}</td>
                    <td>{{ p.etime }}</td>
                  </tr>
                  <tr v-if="!(m.procs || []).length"><td colspan="5" class="empty">当前无 GPU 进程</td></tr>
                </tbody>
              </table>
              <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px">
                <span v-for="w in whoUnique(m)" :key="w.user" class="user-tag"><i></i>{{ w.user }}</span>
                <span v-if="!whoUnique(m).length" style="color:var(--faint);font-size:12px">当前无登录用户</span>
              </div>
            </div>
          </template>

          <template v-else>
            <div style="color:var(--danger);font-size:12.5px;padding:10px 0">
              采集失败：{{ m.error || '未知错误' }}
              <div style="color:var(--faint);margin-top:4px">机器本身不受影响，仅中心节点无法读取指标</div>
            </div>
            <div v-if="/Permission denied/i.test(m.error || '')" style="margin-top:2px">
              <button class="iact" @click="bootTarget = { host: m.host, ip: m.ip }">密码引导接入</button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div style="height:18px"></div>

    <div class="bento">
      <div class="bezel b-12 rise">
        <div class="core">
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-size:16px;font-weight:600">占卡进程</div>
              <div style="font-size:12px;color:var(--faint)">全部机器的 GPU 计算进程，按显存排序 · 实时</div>
            </div>
            <div class="chip">共 <b>{{ procAll.length }}</b> 个进程 · <b>{{ uniqUsers.length }}</b> 位用户</div>
          </div>
          <div style="overflow-x:auto">
            <table class="ptable">
              <thead><tr><th>机器</th><th>GPU 进程</th><th>用户</th><th>PID</th><th>显存</th><th>运行时长</th></tr></thead>
              <tbody>
                <tr v-for="p in procAll" :key="p.host + p.pid">
                  <td>{{ p.host }}</td>
                  <td class="cmd">{{ p.comm }}{{ p.args ? ' ' + p.args : '' }}</td>
                  <td class="user">{{ p.user }}</td>
                  <td>{{ p.pid }}</td>
                  <td>{{ fmtMB(p.mem_mb) }}</td>
                  <td>{{ p.etime }}</td>
                </tr>
                <tr v-if="!procAll.length"><td colspan="6" class="empty">所有机器当前无占卡进程</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- SSH 密码引导 -->
    <BootstrapModal :target="bootTarget" :toast="toast" @close="bootTarget = null" @done="onRefresh()" />
  </section>
</template>
