<script setup>
/** 根组件：认证门 + 导航 + 视图切换 + Toast */
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { api } from './api.js'
import LoginView from './views/LoginView.vue'
import DashboardView from './views/DashboardView.vue'
import MachinesView from './views/MachinesView.vue'
import UsersView from './views/UsersView.vue'
import AdminsView from './views/AdminsView.vue'
import AuditView from './views/AuditView.vue'

const authed = ref(null)          // null=检查中, false, true
const currentView = ref('dash')
const state = ref(null)
const toast = reactive({ show: false, ok: true, msg: '' })
let toastTimer = null

const NAV = [
  { id: 'dash', label: '总览' },
  { id: 'machines', label: '机器管理' },
  { id: 'users', label: '用户管理' },
  { id: 'admins', label: '管理员' },
  { id: 'audit', label: '操作审计' }
]

function showToast(msg, ok = true) {
  toast.show = true
  toast.ok = ok
  toast.msg = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 3400)
}

async function poll() {
  try {
    state.value = await api('/api/state')
  } catch { /* 401 → 事件处理 */ }
}

async function enterMain() {
  authed.value = true
  await poll()
}

function switchView(id) {
  currentView.value = id
}

async function logout() {
  try { await api('/api/logout', {}) } catch {}
  authed.value = false
}

function onUnauthorized() {
  authed.value = false
}

onMounted(async () => {
  window.addEventListener('gpuc:unauthorized', onUnauthorized)
  try {
    await api('/api/state')
    await enterMain()
  } catch {
    authed.value = false
  }
  pollTimer = setInterval(poll, 5000)
})
let pollTimer
onUnmounted(() => {
  clearInterval(pollTimer)
  window.removeEventListener('gpuc:unauthorized', onUnauthorized)
})
</script>

<template>
  <div class="orbs"></div>

  <!-- 认证检查中 -->
  <div v-if="authed === null" class="login-wrap">
    <div class="loading" style="padding:0">…</div>
  </div>

  <!-- 登录 -->
  <LoginView v-else-if="!authed" @success="enterMain" />

  <!-- 主界面 -->
  <div v-else class="shell">
    <nav class="nav">
      <div class="brand">
        <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
          <rect x="1.5" y="1.5" width="15" height="15" rx="4.5" stroke="#8f86e8" stroke-width="1.1"/>
          <path d="M5.5 6.5h7M5.5 9h4.5M5.5 11.5h6" stroke="rgba(244,244,246,.7)" stroke-width="1.1" stroke-linecap="round"/>
        </svg>
        <span>GPU Ops Center</span>
      </div>
      <div class="seg">
        <button
          v-for="n in NAV" :key="n.id"
          :class="{ on: currentView === n.id }"
          @click="switchView(n.id)"
        >{{ n.label }}</button>
      </div>
      <button class="logout" :title="'当前登录：' + (state?.me || '')" @click="logout"><span v-if="state?.me" style="margin-right:6px">{{ state.me }}</span>退出</button>
    </nav>

    <KeepAlive>
      <DashboardView v-if="currentView === 'dash'" :state="state" :on-refresh="poll" :toast="showToast" />
      <MachinesView v-else-if="currentView === 'machines' && state" :machines="state.machines" :toast="showToast" :on-refresh="poll" />
      <UsersView v-else-if="currentView === 'users' && state" :machines="state.machines" :toast="showToast" />
      <AdminsView v-else-if="currentView === 'admins' && state" :me="state.me" :toast="showToast" />
      <AuditView v-else-if="currentView === 'audit' && state" :audit="state.audit" />
    </KeepAlive>
  </div>

  <!-- Toast -->
  <div class="toast" :class="{ show: toast.show, ok: toast.ok, err: !toast.ok }">
    <i>●</i><span>{{ toast.msg }}</span>
  </div>
</template>
