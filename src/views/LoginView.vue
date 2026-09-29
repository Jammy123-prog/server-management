<script setup>
import { ref } from 'vue'
import { api } from '../api.js'

const emit = defineEmits(['success'])

const password = ref('')
const err = ref('')
const loading = ref(false)

async function doLogin() {
  err.value = ''
  loading.value = true
  try {
    await api('/api/login', { password: password.value })
    emit('success')
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card bezel rise in">
      <div class="core">
        <span class="eyebrow"><i></i>GPU OPS CENTER</span>
        <h1>集群管理台</h1>
        <div class="sub">5 台 RTX 4080 · 统一账户 / 资源 / 占卡总览</div>
        <div class="field" style="margin-bottom:14px">
          <label>管理密码</label>
          <input
            id="login-pw"
            v-model="password"
            class="inp" type="password" placeholder="••••••••"
            autocomplete="current-password"
            @keydown.enter="doLogin"
          >
        </div>
        <div class="login-err">{{ err }}</div>
        <button id="login-btn" class="btn" style="width:100%;justify-content:space-between" :disabled="loading" @click="doLogin">
          <span>{{ loading ? '验证中…' : '进入控制台' }}</span>
          <span class="ic">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 8h11M9 3.5 13.5 8 9 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
