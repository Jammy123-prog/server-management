<script setup>
/** Sparkline：迷你趋势曲线（纯 SVG，随数据平滑更新） */
const props = defineProps({
  hist: { type: Array, default: () => [] },
  keyName: { type: String, default: 'u' },
  green: { type: Boolean, default: false }
})

function build() {
  const pts = (props.hist || []).map(h => h[props.keyName]).filter(v => typeof v === 'number')
  if (pts.length < 2) return { path: '', area: '' }
  const W = 200, H = 36, P = 3
  const min = Math.min(...pts, 0), max = Math.max(...pts, 1)
  const X = i => P + (W - 2 * P) * i / (pts.length - 1)
  const Y = v => H - P - (H - 2 * P) * ((v - min) / ((max - min) || 1))
  const path = pts.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ')
  const area = `M${X(0).toFixed(1)} ${H} ` + path.replace('M', 'L') + ` L${X(pts.length - 1).toFixed(1)} ${H} Z`
  return { path, area }
}
</script>

<template>
  <svg class="spark" viewBox="0 0 200 36" preserveAspectRatio="none">
    <path v-if="build().area" class="ar" :d="build().area" />
    <path v-if="build().path" class="ln" :class="{ g: green }" :d="build().path" />
  </svg>
</template>
