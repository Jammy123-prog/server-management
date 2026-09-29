#!/usr/bin/env node
/**
 * GPU Ops Center — API 服务（零 npm 依赖，Node >= 18）
 *
 * 职责：
 *  - SSH 免密轮询采集 GPU/系统指标与占卡进程（GPU 机器零安装）
 *  - 网页化管理各机器本地账号（useradd/userdel/chpasswd，旁路设计）
 *  - 会话认证、审计日志、demo 模式
 *  - 生产模式（存在 ../dist 时）同时托管前端静态文件
 *
 * 端口：
 *  - npm start      → config.json 的 listen_port（默认 8600），托管 dist
 *  - dev.mjs 启动时 → env API_PORT=8601（Vite 代理 /api 到这里）
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(__dirname)
const CONFIG_PATH = path.join(ROOT, 'config.json')
const AUDIT_PATH = path.join(ROOT, 'audit.json')
const DIST_DIR = path.join(ROOT, 'dist')

// ---------------------------------------------------------------- config

const DEFAULT_CONFIG = {
  listen_host: '0.0.0.0',
  listen_port: 8600,
  admin_password: 'changeme',
  poll_interval: 10,
  ssh_user: 'root',
  ssh_port: 22,
  demo_mode: false,
  machines: [
    { host: 'gpu-01', ip: '192.168.1.11' },
    { host: 'gpu-02', ip: '192.168.1.12' },
    { host: 'gpu-03', ip: '192.168.1.13' },
    { host: 'gpu-04', ip: '192.168.1.14' },
    { host: 'gpu-05', ip: '192.168.1.15' }
  ]
}

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    cfg = { ...cfg, ...raw }
  } catch {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  }
  return cfg
}

const CFG = loadConfig()
const HISTORY_LEN = 240

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2))
    return true
  } catch (e) {
    console.error('[config] 写入失败:', e.message)
    return false
  }
}

// 机器名 / 地址校验（地址允许 IPv4 / IPv6 / 主机名）
const HOSTNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/
const ADDR_RE = /^[a-zA-Z0-9.:_-]{1,253}$/

// ---------------------------------------------------------------- ssh

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function sshExec(machine, script, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=6',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(CFG.ssh_port || 22),
      `${CFG.ssh_user || 'root'}@${machine.ip}`,
      script
    ]
    const p = spawn('ssh', args)
    let out = '', err = ''
    const timer = setTimeout(() => {
      try { p.kill() } catch {}
      reject(new Error('SSH 执行超时'))
    }, timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error((err || out || `ssh exit ${code}`).slice(0, 300)))
    })
  })
}

const POLL_SCRIPT = `
echo '@@GPU';
nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null;
echo '@@PROC';
nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null;
echo '@@PS';
PIDS=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | tr '\\n' ',' | sed 's/,*$//');
if [ -n "$PIDS" ]; then ps -o pid:12=,user:28=,comm:40=,etime:20= -p "$PIDS" 2>/dev/null; fi;
echo '@@SYS';
cat /proc/loadavg;
free -b 2>/dev/null | awk 'NR==2{print $2,$3}';
df -B1 / 2>/dev/null | awk 'NR==2{print $2,$3,$5}';
nproc;
echo '@@WHO';
who -s 2>/dev/null;
echo '@@END';
`

const LIST_USERS_SCRIPT = `
awk -F: '$3>=1000 && $3<65534 {print $1}' /etc/passwd;
echo '@@SUDO';
getent group sudo 2>/dev/null | cut -d: -f4;
echo '@@END';
`

// ---------------------------------------------------------------- parsing

const parseIntSafe = s => { const m = /-?\d+/.exec(s ?? ''); return m ? parseInt(m[0]) : 0 }
const parseFloatSafe = s => { const m = /-?[\d.]+/.exec(s ?? ''); return m ? parseFloat(m[0]) : 0 }

function parsePoll(out) {
  const sections = {}
  let cur = null
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) { cur = line.slice(2); sections[cur] = [] }
    else if (cur) sections[cur].push(line)
  }

  const gpus = []
  for (const line of sections.GPU || []) {
    const p = line.split(',').map(x => x.trim())
    if (p.length < 7) continue
    const memTotal = parseIntSafe(p[4]), memUsed = parseIntSafe(p[3])
    gpus.push({
      index: parseIntSafe(p[0]), name: p[1],
      util: parseIntSafe(p[2]),
      mem_used: memUsed, mem_total: memTotal,
      mem_pct: memTotal ? Math.round(memUsed * 100 / memTotal) : 0,
      temp: parseIntSafe(p[5]), power: parseFloatSafe(p[6])
    })
  }

  const psMap = {}
  for (const line of sections.PS || []) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 4) {
      psMap[parts[0]] = { user: parts[1], comm: parts.slice(2, -1).join(' '), etime: parts[parts.length - 1] }
    }
  }
  const procs = []
  for (const line of sections.PROC || []) {
    const p = line.split(',').map(x => x.trim())
    if (p.length < 2) continue
    const info = psMap[p[0]] || { user: '?', comm: '?', etime: '?' }
    procs.push({ pid: p[0], mem_mb: parseIntSafe(p[1]), ...info })
  }
  procs.sort((a, b) => b.mem_mb - a.mem_mb)

  const sysl = sections.SYS || []
  const load1 = sysl[0] ? parseFloatSafe(sysl[0].split(/\s+/)[0]) : 0
  const cores = sysl[3] ? parseIntSafe(sysl[3]) : 1
  let memTotal = 0, memUsed = 0
  if (sysl[1]) {
    const v = sysl[1].trim().split(/\s+/)
    memTotal = parseIntSafe(v[0]); memUsed = parseIntSafe(v[1])
  }
  let diskTotal = 0, diskUsed = 0, diskPct = 0
  if (sysl[2]) {
    const v = sysl[2].trim().split(/\s+/)
    diskTotal = parseIntSafe(v[0]); diskUsed = parseIntSafe(v[1])
    const m = /\d+/.exec(v[2] ?? ''); diskPct = m ? parseInt(m[0]) : 0
  }

  const who = []
  for (const line of sections.WHO || []) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 3) {
      who.push({
        user: parts[0], tty: parts[1],
        when: parts.slice(2, 5).join(' '),
        from: parts.length === 6 ? parts[5].replace(/[()]/g, '') : '-'
      })
    }
  }

  return {
    gpus, procs, who,
    cpu: { load1: Math.round(load1 * 100) / 100, cores, used_pct: cores ? Math.min(100, Math.round(load1 * 100 / cores)) : 0 },
    mem: { total_b: memTotal, used_b: memUsed, pct: memTotal ? Math.round(memUsed * 100 / memTotal) : 0 },
    disk: { total_b: diskTotal, used_b: diskUsed, pct: diskPct }
  }
}

// ---------------------------------------------------------------- state

const state = {
  machines: new Map(),
  usersCache: new Map(),
  audit: []
}

for (const m of CFG.machines) {
  state.machines.set(m.host, {
    host: m.host, ip: m.ip,
    online: false, last_seen: 0, error: '尚未采集',
    gpus: [], procs: [], who: [],
    cpu: {}, mem: {}, disk: {},
    history: []
  })
}

try { state.audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf-8')) } catch {}

function auditAdd(action, user, machines, ok, detail = '') {
  state.audit.unshift({
    ts: Math.floor(Date.now() / 1000), action, user,
    machines, ok, detail: detail.slice(0, 300)
  })
  state.audit = state.audit.slice(0, 500)
  try { fs.writeFileSync(AUDIT_PATH, JSON.stringify(state.audit, null, 1)) } catch {}
}

async function pollMachine(host) {
  const m = state.machines.get(host)
  if (!m) return
  try {
    const out = await sshExec(m, POLL_SCRIPT)
    const data = parsePoll(out)
    Object.assign(m, data)
    m.online = true
    m.last_seen = Math.floor(Date.now() / 1000)
    m.error = ''
    const utils = m.gpus.length ? m.gpus.map(g => g.util) : [0]
    const mems = m.gpus.length ? m.gpus.map(g => g.mem_pct) : [0]
    const avg = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length)
    m.history.push({
      t: Math.floor(Date.now() / 1000),
      u: avg(utils), m: avg(mems), c: m.cpu?.used_pct || 0
    })
    if (m.history.length > HISTORY_LEN) m.history.splice(0, m.history.length - HISTORY_LEN)
  } catch (e) {
    m.online = false
    m.error = String(e.message || e)
  }
}

async function collectUsers(host) {
  const m = state.machines.get(host)
  if (!m) return { error: 'unknown host' }
  const cached = state.usersCache.get(host)
  const now = Date.now() / 1000
  if (cached && now - cached.ts < 60) return cached
  let res
  try {
    const out = await sshExec(m, LIST_USERS_SCRIPT, 15000)
    const lines = out.split('\n')
    const idx = lines.indexOf('@@SUDO')
    const names = lines.slice(0, idx === -1 ? lines.length : idx).map(s => s.trim()).filter(Boolean)
    let sudoers = []
    if (idx !== -1) {
      sudoers = lines.slice(idx + 1).join(',').replace(/@@END/g, '').split(',').map(s => s.trim()).filter(Boolean)
    }
    res = {
      ts: now, error: '',
      users: names.sort().map(n => ({ name: n, sudo: sudoers.includes(n) }))
    }
  } catch (e) {
    res = { ts: now, users: [], error: String(e.message || e).slice(0, 200) }
  }
  state.usersCache.set(host, res)
  return res
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const p = spawn('openssl', ['passwd', '-6', '-stdin'])
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('error', reject)
    p.on('close', () => {
      out = out.trim()
      out.startsWith('$6$') ? resolve(out) : reject(new Error('openssl passwd 失败'))
    })
    p.stdin.write(password)
    p.stdin.end()
  })
}

async function addUser(username, password, hosts, grantSudo) {
  const results = {}
  for (const host of hosts) {
    const m = state.machines.get(host)
    if (!m) { results[host] = [false, '未知机器']; continue }
    try {
      const h = await hashPassword(password)
      let script =
        `sudo useradd -m -s /bin/bash ${shq(username)} 2>/dev/null || ` +
        `sudo usermod -s /bin/bash ${shq(username)}; ` +
        `printf '%s:%s\\n' ${shq(username)} ${shq(h)} | sudo chpasswd -e`
      if (grantSudo) script += `; sudo usermod -aG sudo ${shq(username)}`
      await sshExec(m, script, 25000)
      results[host] = [true, '']
    } catch (e) {
      results[host] = [false, String(e.message || e).slice(0, 200)]
    }
    state.usersCache.delete(host)
  }
  return results
}

async function changePasswd(username, password, hosts) {
  const results = {}
  for (const host of hosts) {
    const m = state.machines.get(host)
    if (!m) { results[host] = [false, '未知机器']; continue }
    try {
      const h = await hashPassword(password)
      const script = `printf '%s:%s\\n' ${shq(username)} ${shq(h)} | sudo chpasswd -e`
      await sshExec(m, script, 25000)
      results[host] = [true, '']
    } catch (e) {
      results[host] = [false, String(e.message || e).slice(0, 200)]
    }
    state.usersCache.delete(host)
  }
  return results
}

async function deleteUser(username, hosts) {
  const results = {}
  for (const host of hosts) {
    const m = state.machines.get(host)
    if (!m) { results[host] = [false, '未知机器']; continue }
    try {
      const script =
        `sudo userdel -r ${shq(username)} 2>/dev/null; ` +
        `sudo userdel ${shq(username)} 2>/dev/null; ` +
        `id ${shq(username)} >/dev/null 2>&1 && echo STILL_EXISTS || echo OK`
      const out = await sshExec(m, script, 25000)
      if (out.includes('STILL_EXISTS')) throw new Error('删除失败（可能仍有该用户的进程在运行）')
      results[host] = [true, '']
    } catch (e) {
      results[host] = [false, String(e.message || e).slice(0, 200)]
    }
    state.usersCache.delete(host)
  }
  return results
}

// ---------------------------------------------------------------- demo mode

const DEMO_USERS = ['alice', 'bob', 'chen', 'liu']
const DEMO_PROCS = [
  ['python', 'train_llm.py --epochs 50'], ['python', 'preprocess.py'],
  ['python', 'sd-webui'], ['python', 'eval.py']
]

const demo = {
  util: new Map(), mem: new Map(), procs: new Map(),
  seed() {
    let i = 0
    const rnd = mulberry(42)
    for (const host of state.machines.keys()) {
      this.util.set(host, 20 + (i * 13) % 60)
      this.mem.set(host, 15 + (i * 21) % 55)
      const n = Math.floor(rnd() * 4)
      const procs = []
      for (let k = 0; k < n; k++) {
        const user = DEMO_USERS[Math.floor(rnd() * DEMO_USERS.length)]
        const [comm, args] = DEMO_PROCS[Math.floor(rnd() * DEMO_PROCS.length)]
        procs.push({
          pid: String(10000 + Math.floor(rnd() * 50000)),
          user, comm, args,
          etime: `${Math.floor(rnd() * 20)}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`,
          mem_mb: 2000 + Math.floor(rnd() * 13000)
        })
      }
      procs.sort((a, b) => b.mem_mb - a.mem_mb)
      this.procs.set(host, procs)
      i++
    }
  },
  // 演示模式下动态接入新机器
  addHost(host) {
    const rnd = mulberry([...host].reduce((a, c) => a + c.charCodeAt(0), 0))
    this.util.set(host, 20 + Math.floor(rnd() * 60))
    this.mem.set(host, 15 + Math.floor(rnd() * 55))
    const n = Math.floor(rnd() * 4)
    const procs = []
    for (let k = 0; k < n; k++) {
      const user = DEMO_USERS[Math.floor(rnd() * DEMO_USERS.length)]
      const [comm, args] = DEMO_PROCS[Math.floor(rnd() * DEMO_PROCS.length)]
      procs.push({
        pid: String(10000 + Math.floor(rnd() * 50000)),
        user, comm, args,
        etime: `${Math.floor(rnd() * 20)}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`,
        mem_mb: 2000 + Math.floor(rnd() * 13000)
      })
    }
    procs.sort((a, b) => b.mem_mb - a.mem_mb)
    this.procs.set(host, procs)
  },
  tick() {
    const rnd = mulberry(Date.now() % 100000)
    for (const [host, m] of state.machines) {
      const u = clamp(this.util.get(host) + Math.floor(rnd() * 25) - 12, 3, 99)
      const memP = clamp(this.mem.get(host) + Math.floor(rnd() * 11) - 5, 5, 97)
      this.util.set(host, u); this.mem.set(host, memP)
      const memUsed = Math.round(16384 * memP / 100)
      const procs = this.procs.get(host) || []
      m.gpus = [{
        index: 0, name: 'NVIDIA GeForce RTX 4080',
        util: u, mem_used: memUsed, mem_total: 16384, mem_pct: memP,
        temp: 45 + Math.round(u * 0.35), power: Math.round((20 + u * 2.8) * 10) / 10
      }]
      m.procs = procs
      m.who = procs.map((p, i) => ({
        user: p.user, tty: `pts/${i}`, when: '2026-09-28 14:00', from: '192.168.1.100'
      }))
      m.cpu = { load1: Math.round(rnd() * 770) / 100, cores: 32, used_pct: 5 + Math.floor(rnd() * 75) }
      m.mem = { total_b: 64 * 1024 ** 3, used_b: Math.round(64 * 1024 ** 3 * (0.2 + rnd() * 0.5)), pct: 20 + Math.floor(rnd() * 50) }
      m.disk = { total_b: 2 * 1024 ** 4, used_b: Math.round(2 * 1024 ** 4 * 0.43), pct: 43 }
      m.online = true
      m.last_seen = Math.floor(Date.now() / 1000)
      m.error = ''
      m.history.push({ t: Math.floor(Date.now() / 1000), u, m: memP, c: m.cpu.used_pct })
      if (m.history.length > HISTORY_LEN) m.history.splice(0, m.history.length - HISTORY_LEN)
    }
  },
  users(host) {
    const rnd = mulberry([...host].reduce((a, c) => a + c.charCodeAt(0), 0))
    const n = 1 + Math.floor(rnd() * 4)
    const pool = [...DEMO_USERS]
    const picked = []
    for (let i = 0; i < n; i++) picked.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
    return { ts: Date.now() / 1000, error: '', users: picked.sort().map(u => ({ name: u, sudo: u === 'alice' })) }
  }
}

function mulberry(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// ---------------------------------------------------------------- auth

const sessions = new Map()   // token -> expiry(ms)
let failCount = 0, failUntil = 0

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex') }

function checkPassword(given) {
  const stored = CFG.admin_password || ''
  if (stored.startsWith('sha256$')) return sha256(given) === stored.slice(7)
  return given === stored
}

function sessionOk(req) {
  const cookie = req.headers.cookie || ''
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(cookie)
  if (!m) return false
  const exp = sessions.get(m[1]) || 0
  return exp > Date.now()
}

// ---------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

function sendJson(res, obj, code = 200, headers = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    ...headers
  })
  res.end(body)
}

function readBody(req) {
  return new Promise(resolve => {
    let n = 0
    const chunks = []
    req.on('data', d => {
      n += d.length
      if (n > 65536) { req.destroy(); return resolve({}) }
      chunks.push(d)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')) }
      catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function serveStatic(res, urlPath) {
  let fp = path.normalize(path.join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath))
  if (!fp.startsWith(DIST_DIR)) { res.writeHead(403); return res.end() }
  fs.readFile(fp, (err, data) => {
    if (err) {
      // SPA fallback → index.html
      fs.readFile(path.join(DIST_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('not found') }
        res.writeHead(200, { 'Content-Type': MIME['.html'] })
        res.end(idx)
      })
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' })
    res.end(data)
  })
}

const USERNAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/

async function handleApi(req, res, url, body) {
  const { pathname } = url

  if (req.method === 'POST' && pathname === '/api/login') {
    const now = Date.now()
    if (now < failUntil) return sendJson(res, { error: '尝试过多，请稍后再试' }, 429)
    if (checkPassword(String(body.password || ''))) {
      failCount = 0
      const token = crypto.randomBytes(24).toString('hex')
      sessions.clear()
      sessions.set(token, now + 12 * 3600 * 1000)
      return sendJson(res, {}, 200, {
        'Set-Cookie': `sid=${token}; HttpOnly; Path=/; SameSite=Strict`
      })
    }
    failCount++
    if (failCount >= 5) { failUntil = now + 300 * 1000; failCount = 0 }
    return sendJson(res, { error: '密码错误' }, 401)
  }

  if (!sessionOk(req)) return sendJson(res, { error: 'unauthorized' }, 401)

  if (req.method === 'POST' && pathname === '/api/logout') {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '')
    if (m) sessions.delete(m[1])
    return sendJson(res, { ok: true })
  }

  // ---- 机器管理（网页增删，自动持久化到 config.json，立即生效） ----

  if (req.method === 'POST' && pathname === '/api/machines/add') {
    const host = String(body.host || '').trim()
    const ip = String(body.ip || '').trim()
    if (!HOSTNAME_RE.test(host)) return sendJson(res, { error: '机器名不合法（字母/数字开头，可含 . _ -，最长 63 字符）' }, 400)
    if (!ADDR_RE.test(ip)) return sendJson(res, { error: 'IP / 主机名不合法' }, 400)
    if (state.machines.has(host)) return sendJson(res, { error: `机器「${host}」已存在` }, 400)
    if ([...state.machines.values()].some(m => m.ip === ip)) return sendJson(res, { error: `地址 ${ip} 已被机器「${[...state.machines.values()].find(m => m.ip === ip).host}」使用` }, 400)

    state.machines.set(host, {
      host, ip,
      online: false, last_seen: 0, error: '尚未采集',
      gpus: [], procs: [], who: [],
      cpu: {}, mem: {}, disk: {},
      history: []
    })
    CFG.machines.push({ host, ip })
    const saved = saveConfig()

    if (CFG.demo_mode) {
      demo.addHost(host)
      demo.tick()
    } else {
      pollMachine(host).catch(() => {})   // 立即采集一次，不等下一轮
    }
    auditAdd('machine_add', host, [], saved, saved ? '' : 'config.json 写入失败（重启后丢失）')
    return sendJson(res, { ok: saved, machines: CFG.machines })
  }

  if (req.method === 'POST' && pathname === '/api/machines/remove') {
    const host = String(body.host || '').trim()
    if (!state.machines.has(host)) return sendJson(res, { error: '机器不存在' }, 400)
    state.machines.delete(host)
    state.usersCache.delete(host)
    CFG.machines = CFG.machines.filter(m => m.host !== host)
    const saved = saveConfig()
    auditAdd('machine_remove', host, [], saved, saved ? '' : 'config.json 写入失败（重启后仍存在）')
    return sendJson(res, { ok: saved, machines: CFG.machines })
  }

  if (req.method === 'POST' && pathname === '/api/machines/test') {
    const ip = String(body.ip || '').trim()
    if (!ADDR_RE.test(ip)) return sendJson(res, { error: 'IP / 主机名不合法' }, 400)
    try {
      await sshExec({ ip }, 'echo @@SSH_OK', 10000)
      return sendJson(res, { ok: true })
    } catch (e) {
      return sendJson(res, { ok: false, error: String(e.message || e).slice(0, 200) })
    }
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    const machines = [...state.machines.values()]
      .map(m => ({ ...m, history: m.history.slice(-90) }))
      .sort((a, b) => a.host.localeCompare(b.host))
    return sendJson(res, {
      now: Math.floor(Date.now() / 1000),
      poll_interval: CFG.poll_interval,
      demo: !!CFG.demo_mode,
      machines,
      audit: state.audit.slice(0, 60)
    })
  }

  if (req.method === 'GET' && pathname === '/api/users') {
    const out = {}
    for (const host of state.machines.keys()) {
      out[host] = CFG.demo_mode ? demo.users(host) : await collectUsers(host)
    }
    return sendJson(res, { users: out })
  }

  const hostList = arr => (Array.isArray(arr) ? arr : []).filter(h => state.machines.has(h))

  if (req.method === 'POST' && pathname === '/api/users/add') {
    const username = String(body.username || '').trim()
    const password = String(body.password || '')
    const hosts = hostList(body.hosts)
    if (!USERNAME_RE.test(username)) return sendJson(res, { error: '用户名不合法（字母开头，可含数字和 _ -）' }, 400)
    if (password.length < 6) return sendJson(res, { error: '密码至少 6 位' }, 400)
    if (!hosts.length) return sendJson(res, { error: '请至少选择一台机器' }, 400)
    let results
    if (CFG.demo_mode) {
      results = Object.fromEntries(hosts.map(h => [h, [true, '']]))
      auditAdd('add', username, hosts, true, 'demo 模式')
    } else {
      results = await addUser(username, password, hosts, !!body.sudo)
      const okAll = Object.values(results).every(v => v[0])
      auditAdd('add', username, hosts, okAll,
        Object.entries(results).filter(([, v]) => !v[0]).map(([k, v]) => `${k}:${v[1]}`).join('; '))
    }
    return sendJson(res, { results })
  }

  if (req.method === 'POST' && pathname === '/api/users/passwd') {
    const username = String(body.username || '').trim()
    const password = String(body.password || '')
    const hosts = hostList(body.hosts)
    if (!USERNAME_RE.test(username)) return sendJson(res, { error: '用户名不合法' }, 400)
    if (password.length < 6) return sendJson(res, { error: '密码至少 6 位' }, 400)
    if (!hosts.length) return sendJson(res, { error: '请至少选择一台机器' }, 400)
    let results
    if (CFG.demo_mode) {
      results = Object.fromEntries(hosts.map(h => [h, [true, '']]))
      auditAdd('passwd', username, hosts, true, 'demo 模式')
    } else {
      results = await changePasswd(username, password, hosts)
      const okAll = Object.values(results).every(v => v[0])
      auditAdd('passwd', username, hosts, okAll,
        Object.entries(results).filter(([, v]) => !v[0]).map(([k, v]) => `${k}:${v[1]}`).join('; '))
    }
    return sendJson(res, { results })
  }

  if (req.method === 'POST' && pathname === '/api/users/delete') {
    const username = String(body.username || '').trim()
    const hosts = hostList(body.hosts)
    if (!username || !hosts.length) return sendJson(res, { error: '参数缺失' }, 400)
    let results
    if (CFG.demo_mode) {
      results = Object.fromEntries(hosts.map(h => [h, [true, '']]))
      auditAdd('delete', username, hosts, true, 'demo 模式')
    } else {
      results = await deleteUser(username, hosts)
      const okAll = Object.values(results).every(v => v[0])
      auditAdd('delete', username, hosts, okAll,
        Object.entries(results).filter(([, v]) => !v[0]).map(([k, v]) => `${k}:${v[1]}`).join('; '))
    }
    return sendJson(res, { results })
  }

  return sendJson(res, { error: 'not found' }, 404)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (url.pathname.startsWith('/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : {}
      return await handleApi(req, res, url, body)
    }
    if (CFG.demo_mode ? false : !fs.existsSync(DIST_DIR)) {
      // 无 dist（开发中）直接访问 API 端口时给出提示
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end('<meta charset="utf-8"><body style="font-family:sans-serif;background:#050507;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><div><h2>GPU Ops Center API</h2><p>开发模式请访问 Vite 端口：http://localhost:5173</p><p>或先 <code>npm run build</code> 再 <code>npm start</code>。</p></div></body>')
      }
      res.writeHead(404); return res.end()
    }
    serveStatic(res, url.pathname)
  } catch (e) {
    sendJson(res, { error: String(e.message || e).slice(0, 300) }, 500)
  }
})

// ---------------------------------------------------------------- main

async function main() {
  const port = parseInt(process.env.API_PORT || CFG.listen_port || 8600, 10)
  const host = CFG.listen_host || '0.0.0.0'

  if (CFG.demo_mode) {
    demo.seed()
    setInterval(() => demo.tick(), Math.max(2, CFG.poll_interval) * 1000)
    demo.tick()
    console.log('[demo] 演示模式：使用模拟数据，不连接真实机器')
  } else {
    const pollOnce = async () => {
      await Promise.allSettled([...state.machines.keys()].map(h => pollMachine(h)))
    }
    pollOnce()
    setInterval(pollOnce, Math.max(5, CFG.poll_interval) * 1000)
  }

  server.listen(port, host, () => {
    const pw = CFG.admin_password || ''
    const shown = pw.startsWith('sha256$') ? 'sha256$****（已存哈希）' : pw
    console.log('─'.repeat(56))
    console.log('  GPU Ops Center API 已启动')
    console.log(`  监听     http://${host === '0.0.0.0' ? '0.0.0.0' : host}:${port}/`)
    console.log(`  管理密码 ${shown}  （config.json 可修改）`)
    console.log(`  采集     ${CFG.demo_mode ? '演示模式' : `SSH 轮询，间隔 ${CFG.poll_interval}s`}`)
    console.log('─'.repeat(56))
  })
}

main()
