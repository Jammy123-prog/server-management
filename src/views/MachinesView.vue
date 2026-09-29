<script setup>
/** 机器管理：网页增删受管机器（自动写入 config.json，立即生效，无需重启） */
import { computed, reactive, ref } from 'vue'
import { api, ago } from '../api.js'
import BootstrapModal from '../components/BootstrapModal.vue'

const props = defineProps({
  machines: { type: Array, required: true },
  toast: { type: Function, required: true },
  onRefresh: { type: Function, required: true }
})

const HOSTNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/
const ADDR_RE = /^[a-zA-Z0-9.:_-]{1,253}$/

// ---- 新增表单 ----
const host = ref('')
const ip = ref('')
const adding = ref(false)
const testing = ref(false)
const test = reactive({ done: false, ok: false, msg: '' })

const formValid = computed(() =>
  HOSTNAME_RE.test(host.value) && ADDR_RE.test(ip.value) &&
  !props.machines.some(m => m.host === host.value || m.ip === ip.value)
)

async function testConn() {
  if (!ADDR_RE.test(ip.value)) { props.toast('请先填写合法的 IP / 主机名', false); return }
  testing.value = true
  test.done = false
  try {
    const r = await api('/api/machines/test', { ip: ip.value })
    test.done = true
    test.ok = !!r.ok
    test.msg = r.ok ? 'SSH 免密连接成功' : (r.error || '连接失败')
  } catch (e) {
    test.done = true
    test.ok = false
    test.msg = e.message
  } finally {
    testing.value = false
  }
}

async function addMachine() {
  adding.value = true
  try {
    await api('/api/machines/add', { host: host.value, ip: ip.value })
    props.toast(`已添加机器「${host.value}」，开始采集`)
    host.value = ''
    ip.value = ''
    test.done = false
    props.onRefresh()
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    adding.value = false
  }
}

// ---- 移除 ----
// ---- 密码引导 ----
const bootTarget = ref(null)

// ---- 移除 ----
const delModal = reactive({ show: false, host: '', ip: '', busy: false })
function confirmRemove(m) {
  delModal.host = m.host
  delModal.ip = m.ip
  delModal.show = true
}
async function doRemove() {
  delModal.busy = true
  try {
    await api('/api/machines/remove', { host: delModal.host })
    props.toast(`已移除机器「${delModal.host}」`)
    delModal.show = false
    props.onRefresh()
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    delModal.busy = false
  }
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <span class="eyebrow"><i></i>MACHINES</span>
        <h1>机器管理</h1>
        <div class="sub">在网页上增删受管机器 · 自动保存到 config.json 并立即开始采集，无需重启服务</div>
      </div>
      <span class="chip">当前 <b>{{ machines.length }}</b> 台</span>
    </div>

    <!-- 新增机器 -->
    <div class="bezel rise in" style="margin-bottom:18px">
      <div class="core">
        <div style="font-size:16px;font-weight:600;margin-bottom:24px">接入新机器</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0 28px">
          <div>
            <div class="field">
              <label>机器名称</label>
              <input v-model="host" class="inp" placeholder="如 gpu-06（显示名，字母/数字开头）" autocomplete="off">
            </div>
            <div class="field">
              <label>IP 地址 / 主机名</label>
              <div class="pw-wrap">
                <input v-model="ip" class="inp mono" placeholder="如 192.168.1.16" autocomplete="off">
                <button class="gen-btn" type="button" :disabled="testing" @click="testConn">{{ testing ? '测试中…' : '测试连接' }}</button>
              </div>
            </div>
          </div>
          <div>
            <div class="field">
              <label>接入前提（每台新机器做一次）</label>
              <div class="fnote" style="border:0;padding:0;margin:0">
                中心节点（本服务所在机器）需能 SSH 免密登录目标机器。<br>
                若新机器仅有密码登录，在中心节点执行一次：<br>
                <code class="mono" style="color:var(--muted)">ssh-copy-id gpuops@新机器IP</code><br>
                （或参照 README「密码引导」章节创建 gpuops 账号）
              </div>
            </div>
            <div v-if="test.done" style="font-size:12.5px" :style="{ color: test.ok ? 'var(--accent-2)' : 'var(--danger)' }">
              {{ test.ok ? '● ' : '● ' }}{{ test.msg }}
            </div>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button class="btn" :disabled="!formValid || adding" @click="addMachine">
            <span>{{ adding ? '添加中…' : '添加机器' }}</span>
            <span class="ic"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
          </button>
        </div>
      </div>
    </div>

    <!-- 机器列表 -->
    <div style="font-size:16px;font-weight:600;margin:6px 2px 16px">受管机器</div>
    <div class="umatrix">
      <div v-for="m in machines" :key="m.host" class="bezel ucard rise">
        <div class="core">
          <div class="mtitle">
            <span class="dot" :class="m.online ? 'on' : 'off'" style="width:7px;height:7px"></span>
            <span style="font-weight:600;font-size:15px">{{ m.host }}</span>
            <span class="mono" style="font-size:12px;color:var(--faint)">{{ m.ip }}</span>
            <span class="count">{{ (m.gpus || []).length }} 卡</span>
          </div>
          <div style="font-size:12px;color:var(--muted)">
            <template v-if="m.online">
              在线 · 最近采集 {{ ago(m.last_seen) }} · CPU {{ m.cpu?.used_pct ?? '—' }}% · 显存 {{ m.mem?.pct ?? '—' }}%
            </template>
            <template v-else>
              <span style="color:var(--danger)">{{ m.error || '尚未采集' }}</span>
            </template>
          </div>
          <div style="margin-top:auto;display:flex;justify-content:flex-end;gap:6px">
            <button v-if="!m.online" class="iact" @click="bootTarget = { host: m.host, ip: m.ip }">密码引导</button>
            <button class="iact del" @click="confirmRemove(m)">移除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 移除确认 -->
    <div class="modal-mask" :class="{ show: delModal.show }">
      <div class="modal bezel"><div class="core">
        <h3>移除机器</h3>
        <div class="msub">仅从管理台移除，机器本身与其上的账号、任务完全不受影响</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:22px">
          将移除 <b style="color:var(--text)">{{ delModal.host }}</b>（{{ delModal.ip }}）的监控与管理
        </div>
        <div class="actions">
          <button class="btn ghost sm" @click="delModal.show = false"><span>取消</span></button>
          <button class="btn danger sm" :disabled="delModal.busy" @click="doRemove"><span>{{ delModal.busy ? '移除中…' : '确认移除' }}</span></button>
        </div>
      </div></div>
    </div>
    <!-- SSH 密码引导 -->
    <BootstrapModal :target="bootTarget" :toast="toast" @close="bootTarget = null" @done="onRefresh()" />
  </section>
</template>
