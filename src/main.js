import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

const app = createApp(App)

/** v-rise：元素进入视口时淡入上浮（transform/opacity only） */
const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('in')
      io.unobserve(e.target)
    }
  }
}, { threshold: 0.08 })

app.directive('rise', {
  mounted(el) {
    el.classList.add('rise')
    io.observe(el)
  }
})

app.mount('#app')

/** 兜底：观察所有带 .rise 类的元素（含 v-for 动态渲染的卡片），进入视口时触发入场动画 */
function watchRise(root) {
  if (!(root instanceof HTMLElement)) return
  if (root.classList.contains('rise')) io.observe(root)
  root.querySelectorAll('.rise').forEach(el => io.observe(el))
}
watchRise(document.body)
new MutationObserver(muts => {
  for (const mu of muts) for (const n of mu.addedNodes) watchRise(n)
}).observe(document.body, { childList: true, subtree: true })
