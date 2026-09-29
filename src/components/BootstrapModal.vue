<script setup>
/** SSH 密码引导弹窗：为采集失败的机器，用一次密码自动装好免密通道 */
import { ref, watch } from 'vue'
import { api } from '../api.js'

const props = defineProps({
  target: { type: Object, default: null },   // { host, ip }，为 null 时隐藏
  toast: { type: Function, required: true }
})
const emit = defineEmits(['close', 'done'])

const username = ref('root')
const password = ref('')
const busy = ref(false)

watch(() => props.target, t => {
  if (t) { username.value = 'root'; password.value = ''; busy.value = false }
})

async function run() {
  if (!password.value) { props.toast('请输入登录密码', false); return }
  busy.value = true
  try {
    await api('/api/machines/bootstrap', {
      host: props.target.host,
      username: username.value,
      password: password.value
    })
    props.toast(`「${props.target.host}」引导成功，正在重新采集`)
    password.value = ''
    emit('done')
    emit('close')
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="modal-mask" :class="{ show: !!target }" @click.self="!busy && emit('close')">
    <div class="modal bezel"><div class="core">
      <template v-if="target">
        <h3>密码引导接入</h3>
        <div class="msub">
          用一次密码登录 <b style="color:var(--text)">{{ target.host }}</b>（{{ target.ip }}），
          自动完成：创建 gpuops 账号 → 安装公钥 → 配置受限 sudo，之后走免密采集。<br>
          该账号需为 root 或有 sudo 权限；机器上现有用户与密码不受影响。密码仅本次使用，不保存。
        </div>
        <div class="field">
          <label>登录用户名</label>
          <input v-model="username" class="inp" placeholder="通常为 root" autocomplete="off">
        </div>
        <div class="field">
          <label>登录密码</label>
          <input v-model="password" type="password" class="inp mono" placeholder="该账号的 SSH 登录密码" autocomplete="off">
        </div>
        <div class="actions">
          <button class="btn ghost sm" :disabled="busy" @click="emit('close')"><span>取消</span></button>
          <button class="btn sm" :disabled="busy || !password" @click="run">
            <span>{{ busy ? '引导中…' : '开始引导' }}</span>
          </button>
        </div>
      </template>
    </div></div>
  </div>
</template>
