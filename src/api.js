/** API 客户端 + 共享工具 */

export async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  } : undefined)
  if (res.status === 401) {
    window.dispatchEvent(new Event('gpuc:unauthorized'))
    throw new Error('unauthorized')
  }
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  return j
}

export const esc = s => String(s ?? '')
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function fmtB(b) {
  b = +b || 0
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (b >= 1024 && i < 4) { b /= 1024; i++ }
  return b.toFixed(i ? 1 : 0) + ' ' + u[i]
}

export const fmtMB = m => (+m || 0) >= 1024 ? ((+m) / 1024).toFixed(1) + ' GB' : (+m || 0) + ' MB'

export function ago(ts) {
  const d = (Date.now() / 1000 - ts) | 0
  if (d < 60) return d + ' 秒前'
  if (d < 3600) return (d / 60 | 0) + ' 分钟前'
  if (d < 86400) return (d / 3600 | 0) + ' 小时前'
  return (d / 86400 | 0) + ' 天前'
}

export function genPassword() {
  const cs = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 12; i++) s += cs[Math.random() * cs.length | 0]
  return s
}
