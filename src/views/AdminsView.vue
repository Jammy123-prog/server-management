<script setup>
/** 管理员管理：后台登录账号的增删（存于中心节点 admins.json） */
import { computed, onActivated, onMounted, reactive, ref } from 'vue'
import { api, genPassword, ago } from '../api.js'

const props = defineProps({
  me: { type: String, default: '' },
  toast: { type: Function, required: true }
})

// ---- 列表 ----
const admins = ref([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const r = await api('/api/admins')
    admins.value = r.admins || []
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    loading.value = false
  }
}
onMounted(load)
onActivated(load)

// ---- 新增 ----
const username = ref('')
const password = ref('')
const creating = ref(false)
const formValid = computed(() =>
  /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(username.value) &&
  password.value.length >= 6 &&
  !admins.value.some(a => a.name === username.value)
)

async function createAdmin() {
  creating.value = true
  try {
    await api('/api/admins/add', { username: username.value, password: password.value })
    props.toast(`已创建管理员「${username.value}」`)
    username.value = ''; password.value = ''
    load()
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    creating.value = false
  }
}

// ---- 删除 ----
const delModal = reactive({ show: false, name: '', busy: false })
function confirmDelete(a) {
  delModal.name = a.name
  delModal.show = true
}
async function doDelete() {
  delModal.busy = true
  try {
    await api('/api/admins/delete', { username: delModal.name })
    props.toast(`已删除管理员「${delModal.name}」`)
    delModal.show = false
    load()
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
        <span class="eyebrow"><i></i>ADMINS</span>
        <h1>管理员</h1>
        <div class="sub">管理后台登录账号 · 存于中心节点 admins.json · 当前登录：{{ me || '—' }}</div>
      </div>
      <button class="btn ghost sm" :disabled="loading" @click="load">
        <span>{{ loading ? '加载中…' : '刷新' }}</span>
        <span class="ic"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.7h-2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </button>
    </div>

    <!-- 新增管理员 -->
    <div class="bezel rise in" style="margin-bottom:18px">
      <div class="core">
        <div style="font-size:16px;font-weight:600;margin-bottom:24px">新增管理员</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0 28px">
          <div>
            <div class="field">
              <label>用户名</label>
              <input v-model="username" class="inp" placeholder="如 ops-admin（字母开头）" autocomplete="off">
            </div>
          </div>
          <div>
            <div class="field">
              <label>初始密码</label>
              <div class="pw-wrap">
                <input v-model="password" class="inp mono" placeholder="至少 6 位" autocomplete="off">
                <button class="gen-btn" type="button" @click="password = genPassword()">生成</button>
              </div>
            </div>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button class="btn" :disabled="!formValid || creating" @click="createAdmin">
            <span>{{ creating ? '创建中…' : '创建管理员' }}</span>
            <span class="ic"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
          </button>
        </div>
      </div>
    </div>

    <!-- 列表 -->
    <div style="font-size:16px;font-weight:600;margin:6px 2px 16px">账号列表（{{ admins.length }}）</div>
    <div class="umatrix">
      <div v-for="a in admins" :key="a.name" class="bezel ucard rise">
        <div class="core">
          <div class="mtitle">
            <span class="dot on" style="width:7px;height:7px"></span>
            <span style="font-weight:600;font-size:15px">{{ a.name }}</span>
            <span v-if="a.name === me" class="count">当前登录</span>
          </div>
          <div style="font-size:12px;color:var(--muted)">
            创建于 {{ new Date(a.created * 1000).toLocaleString('zh-CN') }}<br>
            {{ a.last_login ? '最近登录 ' + ago(a.last_login) : '尚未登录过' }}
          </div>
          <div style="margin-top:auto;display:flex;justify-content:flex-end">
            <button class="iact del" :disabled="admins.length <= 1" @click="confirmDelete(a)">删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div class="modal-mask" :class="{ show: delModal.show }">
      <div class="modal bezel"><div class="core">
        <h3>删除管理员</h3>
        <div class="msub">该账号将立即无法登录管理台</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:22px">
          将删除管理员 <b style="color:var(--text)">{{ delModal.name }}</b>
        </div>
        <div class="actions">
          <button class="btn ghost sm" @click="delModal.show = false"><span>取消</span></button>
          <button class="btn danger sm" :disabled="delModal.busy" @click="doDelete"><span>{{ delModal.busy ? '删除中…' : '删除' }}</span></button>
        </div>
      </div></div>
    </div>
  </section>
</template>
