#!/usr/bin/env node
/**
 * dev.mjs — 同时启动 API 服务（8601）与 Vite 开发服务器（5173）
 * 由 `npm run dev` 调用，Ctrl+C 一起退出。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

const children = []

function start(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  })
  p.on('exit', (code) => {
    if (stopping) return
    console.log(`[${name}] exited (code ${code})`)
    shutdown(code ?? 0)
  })
  children.push(p)
  return p
}

let stopping = false
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  for (const p of children) {
    try { p.kill('SIGTERM') } catch {}
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('─'.repeat(52))
console.log('  GPU Ops Center · 开发模式')
console.log('  API   → http://127.0.0.1:8601')
console.log('  前端  → http://localhost:5173')
console.log('─'.repeat(52))

start('api', process.execPath, [join(root, 'server', 'api.mjs')], { API_PORT: '8601' })
start('vite', process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js')])
