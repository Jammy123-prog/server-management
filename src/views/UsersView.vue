<script setup>
/** 用户管理：新建账号 + 机器×用户矩阵 + 改密/删除 */
import { computed, onMounted, reactive, ref } from 'vue'
import { api, genPassword } from '../api.js'

const props = defineProps({
  machines: { type: Array, required: true },
  toast: { type: Function, required: true }
})

// ---- 新建表单 ----
const username = ref('')
const password = ref('')
const grantSudo = ref(false)
const selected = reactive(new Set())
const creating = ref(false)

const hosts = computed(() => props.machines.filter(m => m.os !== 'windows').map(m => m.host))
const targetHosts = computed(() =>
  selected.has('__all') ? hosts.value : hosts.value.filter(h => selected.has(h))
)
const formValid = computed(() =>
  /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(username.value) &&
  password.value.length >= 6 && targetHosts.value.length > 0
)

function toggleMachine(h) {
  if (h === '__all') {
    selected.clear()
    if (!selected.has('__all')) selected.add('__all')
  } else {
    selected.delete('__all')
    selected.has(h) ? selected.delete(h) : selected.add(h)
  }
}

async function createUser() {
  creating.value = true
  try {
    const r = await api('/api/users/add', {
      username: username.value, password: password.value,
      hosts: targetHosts.value, sudo: grantSudo.value
    })
    const entries = Object.entries(r.results || {})
    const ok = entries.filter(([, v]) => v[0]).length
    if (ok === entries.length) {
      props.toast(`已在 ${ok} 台机器创建账号「${username.value}」`)
    } else {
      const fails = entries.filter(([, v]) => !v[0]).map(([k, v]) => `${k}: ${v[1]}`)
      props.toast(`部分失败（${ok}/${entries.length}）：${fails.join('；')}`, false)
    }
    username.value = ''; password.value = ''; grantSudo.value = false
    loadUsers(true)
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    creating.value = false
  }
}

// ---- 矩阵 ----
const usersMap = ref(null)
const loadingUsers = ref(false)

async function loadUsers(force) {
  loadingUsers.value = true
  try {
    const r = await api('/api/users')
    usersMap.value = r.users
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    loadingUsers.value = false
  }
}
onMounted(() => loadUsers())

// ---- 删除确认 ----
const delModal = reactive({ show: false, user: '', hosts: [], busy: false })
function confirmDelete(user, host) {
  delModal.user = user
  delModal.hosts = [host]
  delModal.show = true
}
async function doDelete() {
  delModal.busy = true
  try {
    const r = await api('/api/users/delete', { username: delModal.user, hosts: delModal.hosts })
    const entries = Object.entries(r.results || {})
    const ok = entries.filter(([, v]) => v[0]).length
    props.toast(ok === delModal.hosts.length ? `已从 ${ok} 台机器删除「${delModal.user}」` : '部分机器删除失败', ok === delModal.hosts.length)
    delModal.show = false
    loadUsers(true)
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    delModal.busy = false
  }
}

// ---- 改密 ----
const pwModal = reactive({ show: false, user: '', hosts: [], pw: '', busy: false })
function openPasswd(user, host) {
  pwModal.user = user; pwModal.hosts = [host]; pwModal.pw = ''
  pwModal.show = true
}
async function doPasswd() {
  if (pwModal.pw.length < 6) { props.toast('密码至少 6 位', false); return }
  pwModal.busy = true
  try {
    const r = await api('/api/users/passwd', { username: pwModal.user, password: pwModal.pw, hosts: pwModal.hosts })
    const entries = Object.entries(r.results || {})
    const ok = entries.filter(([, v]) => v[0]).length
    props.toast(ok === pwModal.hosts.length ? '密码已重置' : '部分机器重置失败：' + entries.filter(([, v]) => !v[0]).map(([k]) => k).join('、'), ok === pwModal.hosts.length)
    pwModal.show = false
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    pwModal.busy = false
  }
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <span class="eyebrow"><i></i>ACCOUNTS</span>
        <h1>用户管理</h1>
        <div class="sub">在各机器上创建 / 删除本地账号 · 账号直接落在目标机器，中心宕机不影响登录</div>
      </div>
    </div>

    <!-- 新建账号 -->
    <div class="bezel rise in" style="margin-bottom:18px">
      <div class="core">
        <div style="font-size:16px;font-weight:600;margin-bottom:24px">新建账号</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0 28px">
          <div>
            <div class="field">
              <label>用户名</label>
              <input v-model="username" class="inp" placeholder="如 zhangsan（字母开头）" autocomplete="off">
            </div>
            <div class="field">
              <label>初始密码</label>
              <div class="pw-wrap">
                <input v-model="password" class="inp mono" placeholder="至少 6 位" autocomplete="off">
                <button class="gen-btn" type="button" @click="password = genPassword()">生成</button>
              </div>
            </div>
            <label class="toggle">
              <input v-model="grantSudo" type="checkbox">
              <span class="track"></span>
              <span>授予 sudo 权限（加入 sudo 组）</span>
            </label>
          </div>
          <div>
            <div class="field">
              <label>部署到指定机器</label>
              <div class="mselect">
                <button type="button" class="mpill all" :class="{ on: selected.has('__all') }" @click="toggleMachine('__all')">全部</button>
                <button v-for="h in hosts" :key="h" type="button" class="mpill" :class="{ on: selected.has(h) }" @click="toggleMachine(h)">{{ h }}</button>
              </div>
            </div>
            <div class="fnote">账号创建在各机器本地（/etc/passwd），SSH 登录不依赖本管理台。已选 {{ targetHosts.length }} 台。</div>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button class="btn" :disabled="!formValid || creating" @click="createUser">
            <span>{{ creating ? '创建中…' : '创建账号' }}</span>
            <span class="ic"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
          </button>
        </div>
      </div>
    </div>

    <!-- 机器×用户矩阵 -->
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin:6px 2px 16px;gap:12px;flex-wrap:wrap">
      <div style="font-size:16px;font-weight:600">机器 × 用户矩阵</div>
      <button class="btn ghost sm" :disabled="loadingUsers" @click="loadUsers(true)">
        <span>{{ loadingUsers ? '采集中…' : '刷新用户列表' }}</span>
        <span class="ic"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.7h-2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </button>
    </div>

    <div v-if="!usersMap" class="loading">正在采集各机器用户…</div>

    <div v-else class="umatrix">
      <div v-for="m in machines" :key="m.host" class="bezel ucard rise">
        <div class="core">
          <div class="mtitle">
            <span class="dot" :class="m.online ? 'on' : 'off'" style="width:7px;height:7px"></span>
            <span style="font-weight:600;font-size:15px">{{ m.host }}</span>
            <span v-if="m.os === 'windows'" class="count" style="color:var(--warn);border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.1)">Windows</span>
            <span class="count">{{ (usersMap[m.host]?.users || []).length }} 个账号</span>
          </div>
          <div v-if="usersMap[m.host]?.error" class="uerr">{{ usersMap[m.host].error }}</div>
          <div v-else class="ulist">
            <div v-for="u in usersMap[m.host]?.users || []" :key="u.name" class="urow">
              <span class="uname">{{ u.name }}</span>
              <span v-if="u.sudo" class="badge sudo">sudo</span>
              <span class="ops">
                <button class="iact" @click="openPasswd(u.name, m.host)">改密</button>
                <button class="iact del" @click="confirmDelete(u.name, m.host)">删除</button>
              </span>
            </div>
            <div v-if="!(usersMap[m.host]?.users || []).length" class="uempty">暂无普通用户账号</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div class="modal-mask" :class="{ show: delModal.show }">
      <div class="modal bezel"><div class="core">
        <h3>删除账号</h3>
        <div class="msub">此操作将从目标机器移除该本地账号及其家目录</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:22px">
          将删除用户 <b style="color:var(--text)">{{ delModal.user }}</b>（{{ delModal.hosts.join('、') }}）
        </div>
        <div class="actions">
          <button class="btn ghost sm" @click="delModal.show = false"><span>取消</span></button>
          <button class="btn danger sm" :disabled="delModal.busy" @click="doDelete"><span>{{ delModal.busy ? '删除中…' : '删除' }}</span></button>
        </div>
      </div></div>
    </div>

    <!-- 改密 -->
    <div class="modal-mask" :class="{ show: pwModal.show }">
      <div class="modal bezel"><div class="core">
        <h3>重置密码</h3>
        <div class="msub">用户 {{ pwModal.user }} · 机器 {{ pwModal.hosts.join('、') }}</div>
        <div class="field">
          <label>新密码</label>
          <div class="pw-wrap">
            <input v-model="pwModal.pw" class="inp mono" placeholder="至少 6 位" autocomplete="off">
            <button class="gen-btn" type="button" @click="pwModal.pw = genPassword()">生成</button>
          </div>
        </div>
        <div class="actions">
          <button class="btn ghost sm" @click="pwModal.show = false"><span>取消</span></button>
          <button class="btn sm" :disabled="pwModal.busy" @click="doPasswd"><span>{{ pwModal.busy ? '重置中…' : '确认重置' }}</span></button>
        </div>
      </div></div>
    </div>
  </section>
</template>
