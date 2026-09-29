<script setup>
/** 资源条：bar + 颜色分级 */
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: 0 },
  tone: { type: String, default: '' }  // '' | green | amber | red
})

const cls = computed(() => {
  const v = props.value
  if (props.tone) return props.tone
  if (v > 85) return 'red'
  if (v > 60) return 'amber'
  return ''
})
const scaleX = computed(() => `scaleX(${Math.min(100, Math.max(0, props.value)) / 100})`)
</script>

<template>
  <div class="bar" :class="cls"><i :style="{ transform: scaleX }"></i></div>
</template>
