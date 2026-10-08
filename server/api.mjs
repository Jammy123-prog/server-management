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
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(__dirname)
const CONFIG_PATH = path.join(ROOT, 'config.json')
const AUDIT_PATH = path.join(ROOT, 'audit.json')
const ADMINS_PATH = path.join(ROOT, 'admins.json')
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
      `${machine.ssh_user || CFG.ssh_user || 'root'}@${machine.ip}`,
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

/**
 * 用密码执行一次 SSH（一次性引导用，密码不落盘）。
 * 通过 SSH_ASKPASS_REQUIRE=force 让 ssh 无终端时也走 askpass 读密码（需 OpenSSH >= 8.4）。
 */
function sshExecWithPassword(machine, password, script, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const askpassPath = path.join(os.tmpdir(), `gpuc-askpass-${process.pid}-${Date.now()}`)
    fs.writeFileSync(askpassPath, `#!/bin/sh\ncat <<'__GPUC_PW_EOF__'\n${password}\n__GPUC_PW_EOF__\n`, { mode: 0o700 })
    const cleanup = () => { try { fs.unlinkSync(askpassPath) } catch {} }
    const args = [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=8',
      '-o', 'NumberOfPasswordPrompts=1',
      '-p', String(CFG.ssh_port || 22),
      `${machine.user}@${machine.ip}`,
      script
    ]
    const p = spawn('ssh', args, {
      env: { ...process.env, SSH_ASKPASS: askpassPath, SUDO_ASKPASS: askpassPath, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'gpuc-dummy' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = '', err = ''
    const timer = setTimeout(() => {
      try { p.kill() } catch {}
      cleanup()
      reject(new Error('SSH 执行超时'))
    }, timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { clearTimeout(timer); cleanup(); reject(e) })
    p.on('close', code => {
      clearTimeout(timer)
      cleanup()
      if (code === 0) resolve(out)
      else reject(new Error((err || out || `ssh exit ${code}`).replace(/\n/g, ' ').slice(0, 300)))
    })
  })
}

/** 中心节点公钥：不存在则自动生成 ed25519 密钥对 */
function ensurePubKey() {
  const sshDir = path.join(os.homedir(), '.ssh')
  const pubPath = path.join(sshDir, 'id_ed25519.pub')
  try { return fs.readFileSync(pubPath, 'utf-8').trim() } catch {}
  fs.mkdirSync(sshDir, { recursive: true })
  const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', path.join(sshDir, 'id_ed25519'), '-N', '', '-q'])
  if (r.status !== 0) throw new Error('ssh-keygen 生成失败: ' + String(r.stderr).slice(0, 200))
  return fs.readFileSync(pubPath, 'utf-8').trim()
}

/**
 * 远程引导脚本：在目标机器上创建 gpuops 账号 + 安装公钥 + 受限 sudo。
 * 以传入账号执行；非 root 时先用密码完成 sudo -v，再走 sudo。
 */
function buildBootstrapScript(pubKey, password) {
  return `
S=""
if [ "$(id -u)" != "0" ]; then
  printf '%s\\n' ${shq(password)} | sudo -S -v 2>/dev/null || { echo '@@ERR:no_sudo'; exit 0; }
  S="sudo "
fi
id gpuops >/dev/null 2>&1 || $S useradd -m -s /bin/bash gpuops || { echo '@@ERR:useradd'; exit 0; }
$S mkdir -p /home/gpuops/.ssh
$S chmod 700 /home/gpuops/.ssh
printf '%s\\n' ${shq(pubKey)} | $S tee /home/gpuops/.ssh/authorized_keys >/dev/null
$S chmod 600 /home/gpuops/.ssh/authorized_keys
$S chown -R gpuops:gpuops /home/gpuops/.ssh
printf '%s\\n' 'gpuops ALL=(root) NOPASSWD: /usr/sbin/useradd, /usr/sbin/userdel, /usr/sbin/usermod, /usr/sbin/chpasswd' | $S tee /etc/sudoers.d/gpuops >/dev/null
$S chmod 440 /etc/sudoers.d/gpuops
echo '@@OK'
`
}

/**
 * Windows 远程引导：用密码登录后把中心节点公钥写入正确的位置。
 * 管理员账号 → C:\ProgramData\ssh\administrators_authorized_keys（含 ACL 修复）；
 * 普通账号 → %USERPROFILE%\.ssh\authorized_keys。
 * 前提：目标机器已启用 OpenSSH 服务器（无法在无任何通道时远程安装）。
 */
function buildBootstrapWinScript(pubKey) {
  const ps = `
$ErrorActionPreference = 'Stop'
$pub = @'
${pubKey}
'@
$km = ($pub.Trim() -split '\\s+')[1]
if (-not $km) { echo '@@ERR:no_key'; exit }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  $f = 'C:\\ProgramData\\ssh\\administrators_authorized_keys'
  if (-not (Test-Path $f)) { New-Item -ItemType File -Path $f -Force | Out-Null }
  $exists = (Get-Content $f -Raw) -match [regex]::Escape($km)
  if (-not $exists) { Add-Content -Path $f -Value $pub.Trim() -Encoding ascii }
  icacls $f /inheritance:r /grant 'SYSTEM:F' /grant 'BUILTIN\\Administrators:F' | Out-Null
} else {
  $d = Join-Path $env:USERPROFILE '.ssh'
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  $f = Join-Path $d 'authorized_keys'
  $exists = (Test-Path $f) -and ((Get-Content $f -Raw) -match [regex]::Escape($km))
  if (-not $exists) { Add-Content -Path $f -Value $pub.Trim() -Encoding ascii }
}
echo '@@OK'
`
  return 'powershell -NoProfile -EncodedCommand ' + Buffer.from(ps, 'utf16le').toString('base64')
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
LC_ALL=C awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "%d %d\n", t*1024, (t-a)*1024}' /proc/meminfo 2>/dev/null;
LC_ALL=C df -B1 / 2>/dev/null | awk 'NR==2{print $2,$3,$5}';
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

// ---- Windows 采集：PowerShell 脚本经 -EncodedCommand 下发（base64/UTF-16LE，规避 cmd/PS 双层引号问题） ----

const POLL_PS_WIN = `
echo '@@GPU'
nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null
echo '@@PROC'
nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>$null
echo '@@PS'
$ids = @(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>$null)
foreach ($i in $ids) {
  $pr = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $i.Trim()) -ErrorAction SilentlyContinue
  if ($pr) {
    $o = $pr | Invoke-CimMethod -MethodName GetOwner
    '{0},{1},{2}' -f $i.Trim(), $o.User, $pr.Name
  }
}
echo '@@SYS'
$os = Get-CimInstance Win32_OperatingSystem
$cl = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$mt = [math]::Round($os.TotalVisibleMemorySize * 1024)
$mu = $mt - [math]::Round($os.FreePhysicalMemory * 1024)
$d = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq 'C:' }
$dt = [math]::Round($d.Size)
$du = $dt - [math]::Round($d.FreeSpace)
'{0};{1};{2};{3};{4};{5}' -f $cl, $env:NUMBER_OF_PROCESSORS, $mt, $mu, $dt, $du
echo '@@WHO'
query user 2>$null
echo '@@END'
`

const POLL_SCRIPT_WIN = 'powershell -NoProfile -EncodedCommand ' +
  Buffer.from(POLL_PS_WIN, 'utf16le').toString('base64')

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
  // 防御：Linux 上 used 不可能超过 total，超出说明该机器返回了异常格式（记录原始数据便于排查）
  let memPct = memTotal ? Math.round(memUsed * 100 / memTotal) : 0
  if (memPct > 100) {
    console.warn(`[poll] 内存解析异常 total=${memTotal} used=${memUsed} raw="${String(sysl[1]).trim()}"`)
    memPct = 100
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
    mem: { total_b: memTotal, used_b: memUsed, pct: memPct },
    disk: { total_b: diskTotal, used_b: diskUsed, pct: diskPct }
  }
}

/** Windows 版采集解析：GPU/PROC 格式与 nvidia-smi 一致；SYS 为单行 ; 分隔；WHO 来自 query user */
function parsePollWin(out) {
  const sections = {}
  let cur = null
  for (const line of out.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('@@')) { cur = line.slice(2).trim(); sections[cur] = [] }
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
    const p = line.split(',')
    if (p.length >= 3) {
      const pid = p[0].trim()
      psMap[pid] = { user: p[1].trim(), comm: p.slice(2).join(',').trim(), etime: '-' }
    }
  }
  const procs = []
  for (const line of sections.PROC || []) {
    const p = line.split(',').map(x => x.trim())
    if (p.length < 2) continue
    const info = psMap[p[0]] || { user: '?', comm: '?', etime: '-' }
    procs.push({ pid: p[0], mem_mb: parseIntSafe(p[1]), ...info })
  }
  procs.sort((a, b) => b.mem_mb - a.mem_mb)

  // SYS 单行：cpuLoad;cores;memTotalB;memUsedB;diskTotalB;diskUsedB
  const sys = (sections.SYS || []).join('').trim()
  const v = sys.split(';').map(x => parseFloatSafe(x))
  const cpuPct = Math.min(100, Math.round(v[0] || 0))
  const cores = Math.max(1, Math.round(v[1] || 1))
  const memTot = v[2] || 0, memUsed = v[3] || 0
  const diskTot = v[4] || 0, diskUsed = v[5] || 0

  // WHO 来自 query user：USERNAME SESSIONNAME ID STATE IDLE TIME LOGON TIME（行首可能带 >）
  const who = []
  for (const line of sections.WHO || []) {
    const parts = line.trim().split(/\s+/)
    if (!parts[0] || /^>?username$/i.test(parts[0])) continue
    const user = parts[0] === '>' ? parts[1] : parts[0]
    if (!user || /^username$/i.test(user)) continue
    who.push({ user, tty: parts[parts.length - 5] || '-', when: parts.slice(-2).join(' '), from: '-' })
  }

  return {
    gpus, procs, who,
    cpu: { load1: Math.round((v[0] || 0) * 100) / 100, cores, used_pct: cpuPct },
    mem: { total_b: memTot, used_b: memUsed, pct: memTot ? Math.round(memUsed * 100 / memTot) : 0 },
    disk: { total_b: diskTot, used_b: diskUsed, pct: diskTot ? Math.round(diskUsed * 100 / diskTot) : 0 }
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
    os: m.os === 'windows' ? 'windows' : 'linux',
    ssh_user: m.ssh_user || '',
    online: false, last_seen: 0, error: '尚未采集',
    gpus: [], procs: [], who: [],
    cpu: {}, mem: {}, disk: {},
    history: []
  })
}

try { state.audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf-8')) } catch {}

function auditAdd(action, user, machines, ok, detail = '') {
  state.audit.unshift({
    ts: Math.floor(Date.now() / 1000), action, user, actor: currentActor,
    machines, ok, detail: detail.slice(0, 300)
  })
  state.audit = state.audit.slice(0, 500)
  try { fs.writeFileSync(AUDIT_PATH, JSON.stringify(state.audit, null, 1)) } catch {}
}

async function pollMachine(host) {
  const m = state.machines.get(host)
  if (!m) return
  try {
    const isWin = m.os === 'windows'
    const out = await sshExec(m, isWin ? POLL_SCRIPT_WIN : POLL_SCRIPT, isWin ? 40000 : 20000)
    const data = isWin ? parsePollWin(out) : parsePoll(out)
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

const sessions = new Map()   // token -> { exp, name }
let failCount = 0, failUntil = 0
let currentActor = 'system'  // 当前请求的管理员（记入审计）

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex') }

// ---- 管理员账号存储（admins.json：[{name, salt, hash, created, last_login}]） ----

let admins = []
try { admins = JSON.parse(fs.readFileSync(ADMINS_PATH, 'utf-8')) } catch {}
if (!Array.isArray(admins)) admins = []

function saveAdmins() {
  try { fs.writeFileSync(ADMINS_PATH, JSON.stringify(admins, null, 1)) } catch (e) {
    console.error('[admins] 写入失败:', e.message)
  }
}

// 首次启动：用 config.admin_password 生成默认管理员 admin（保留旧单密码的兼容）
if (!admins.length) {
  admins.push({
    name: 'admin',
    salt: crypto.randomBytes(8).toString('hex'),
    hash: '', created: Math.floor(Date.now() / 1000), last_login: 0
  })
  admins[0].hash = sha256(admins[0].salt + (CFG.admin_password || 'changeme'))
  saveAdmins()
  console.log('[admins] 已根据 config.json 的 admin_password 创建默认管理员「admin」，登录后可在"管理员"页修改账号')
}

function hashAdminPw(salt, password) { return sha256(salt + password) }

function verifyAdmin(name, given) {
  const a = admins.find(x => x.name === name)
  if (!a) return null
  return hashAdminPw(a.salt, given) === a.hash ? a : null
}

function sessionOk(req) {
  const cookie = req.headers.cookie || ''
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(cookie)
  if (!m) return false
  const s = sessions.get(m[1])
  if (!s || s.exp <= Date.now()) return false
  currentActor = s.name
  return true
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
    const username = String(body.username || '').trim()
    const account = verifyAdmin(username, String(body.password || ''))
    if (account) {
      failCount = 0
      const token = crypto.randomBytes(24).toString('hex')
      sessions.clear()
      sessions.set(token, { exp: now + 12 * 3600 * 1000, name: account.name })
      account.last_login = Math.floor(now / 1000)
      saveAdmins()
      return sendJson(res, { ok: true, name: account.name }, 200, {
        'Set-Cookie': `sid=${token}; HttpOnly; Path=/; SameSite=Strict`
      })
    }
    failCount++
    if (failCount >= 5) { failUntil = now + 300 * 1000; failCount = 0 }
    return sendJson(res, { error: '用户名或密码错误' }, 401)
  }

  if (!sessionOk(req)) return sendJson(res, { error: 'unauthorized' }, 401)

  if (req.method === 'POST' && pathname === '/api/logout') {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '')
    if (m) sessions.delete(m[1])
    return sendJson(res, { ok: true })
  }

  // ---- 管理员管理 ----

  if (req.method === 'GET' && pathname === '/api/admins') {
    return sendJson(res, {
      admins: admins.map(a => ({ name: a.name, created: a.created, last_login: a.last_login }))
    })
  }

  if (req.method === 'POST' && pathname === '/api/admins/add') {
    const name = String(body.username || '').trim()
    const password = String(body.password || '')
    if (!USERNAME_RE.test(name)) return sendJson(res, { error: '用户名不合法（字母开头，可含数字和 _ -）' }, 400)
    if (password.length < 6) return sendJson(res, { error: '密码至少 6 位' }, 400)
    if (admins.some(a => a.name === name)) return sendJson(res, { error: `管理员「${name}」已存在` }, 400)
    admins.push({
      name, salt: crypto.randomBytes(8).toString('hex'),
      hash: '', created: Math.floor(Date.now() / 1000), last_login: 0
    })
    admins[admins.length - 1].hash = hashAdminPw(admins[admins.length - 1].salt, password)
    saveAdmins()
    auditAdd('admin_add', name, [], true)
    return sendJson(res, { ok: true })
  }

  if (req.method === 'POST' && pathname === '/api/admins/delete') {
    const name = String(body.username || '').trim()
    if (!admins.some(a => a.name === name)) return sendJson(res, { error: '管理员不存在' }, 400)
    if (name === currentActor) return sendJson(res, { error: '不能删除当前登录的自己' }, 400)
    if (admins.length <= 1) return sendJson(res, { error: '至少保留一名管理员' }, 400)
    admins = admins.filter(a => a.name !== name)
    saveAdmins()
    auditAdd('admin_delete', name, [], true)
    return sendJson(res, { ok: true })
  }

  // ---- 机器管理（网页增删，自动持久化到 config.json，立即生效） ----

  if (req.method === 'POST' && pathname === '/api/machines/add') {
    const host = String(body.host || '').trim()
    const ip = String(body.ip || '').trim()
    const os = body.os === 'windows' ? 'windows' : 'linux'
    const sshUser = String(body.ssh_user || '').trim()
    if (!HOSTNAME_RE.test(host)) return sendJson(res, { error: '机器名不合法（字母/数字开头，可含 . _ -，最长 63 字符）' }, 400)
    if (!ADDR_RE.test(ip)) return sendJson(res, { error: 'IP / 主机名不合法' }, 400)
    if (os === 'windows' && !sshUser) return sendJson(res, { error: 'Windows 机器必须填写 SSH 登录用户名（该机器的 Windows 账号）' }, 400)
    if (state.machines.has(host)) return sendJson(res, { error: `机器「${host}」已存在` }, 400)
    if ([...state.machines.values()].some(m => m.ip === ip)) return sendJson(res, { error: `地址 ${ip} 已被机器「${[...state.machines.values()].find(m => m.ip === ip).host}」使用` }, 400)

    state.machines.set(host, {
      host, ip, os, ssh_user: sshUser,
      online: false, last_seen: 0, error: '尚未采集',
      gpus: [], procs: [], who: [],
      cpu: {}, mem: {}, disk: {},
      history: []
    })
    CFG.machines.push({ host, ip, os, ssh_user: sshUser })
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
    const sshUser = String(body.ssh_user || '').trim()
    if (!ADDR_RE.test(ip)) return sendJson(res, { error: 'IP / 主机名不合法' }, 400)
    try {
      await sshExec({ ip, ssh_user: sshUser }, 'echo @@SSH_OK', 12000)
      return sendJson(res, { ok: true })
    } catch (e) {
      return sendJson(res, { ok: false, error: String(e.message || e).slice(0, 200) })
    }
  }

  // ---- 密码引导：用一次密码登录目标机器，自动装好免密通道（gpuops + 公钥 + 受限 sudo） ----

  if (req.method === 'POST' && pathname === '/api/machines/bootstrap') {
    const host = String(body.host || '').trim()
    const username = String(body.username || '').trim()
    const password = String(body.password || '')
    const m = state.machines.get(host)
    if (!m) return sendJson(res, { error: '机器不存在' }, 400)
    if (!USERNAME_RE.test(username)) return sendJson(res, { error: '登录用户名不合法' }, 400)
    if (!password) return sendJson(res, { error: '请输入登录密码' }, 400)

    if (CFG.demo_mode) {
      auditAdd('bootstrap', username, [host], true, 'demo 模式')
      return sendJson(res, { ok: true })
    }

    try {
      const pub = ensurePubKey()

      if (m.os === 'windows') {
        // Windows：写入公钥 + 持久化该机器的 SSH 登录用户
        const out = await sshExecWithPassword({ ip: m.ip, user: username }, password, buildBootstrapWinScript(pub), 60000)
        if (!out.includes('@@OK')) {
          throw new Error(out.includes('@@ERR:no_key') ? '中心节点公钥异常' : '引导脚本执行失败：' + out.replace(/\s+/g, ' ').slice(-120))
        }
        m.ssh_user = username
        const cm = CFG.machines.find(x => x.host === host)
        if (cm) cm.ssh_user = username
        saveConfig()
        state.usersCache.delete(host)
        pollMachine(host).catch(() => {})
        auditAdd('bootstrap', username, [host], true, 'windows')
        return sendJson(res, { ok: true })
      }

      const out = await sshExecWithPassword({ ip: m.ip, user: username }, password, buildBootstrapScript(pub, password))
      if (!out.includes('@@OK')) {
        const why = out.includes('no_sudo')
          ? `账号「${username}」没有 root/sudo 权限，无法完成引导`
          : out.includes('useradd')
            ? '创建 gpuops 账号失败（useradd）'
            : '引导脚本未成功执行'
        throw new Error(why)
      }
      state.usersCache.delete(host)
      pollMachine(host).catch(() => {})   // 引导成功，立即重新采集
      auditAdd('bootstrap', username, [host], true)
      return sendJson(res, { ok: true })
    } catch (e) {
      let msg = String(e.message || e)
      if (m.os === 'windows' && /refused|timed?\s?out|No route|unreachable/i.test(msg)) {
        msg = '无法连接：目标 Windows 可能未启用 OpenSSH 服务器。请先在该机器上（管理员 PowerShell）执行：Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Start-Service sshd; Set-Service sshd -StartupType Automatic，然后重试（详见 README）'
      }
      auditAdd('bootstrap', username, [host], false, msg.slice(0, 200))
      return sendJson(res, { error: msg.includes('Permission denied') ? '密码错误或该账号不允许密码登录' : msg }, 400)
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
      me: currentActor,
      machines,
      audit: state.audit.slice(0, 60)
    })
  }

  if (req.method === 'GET' && pathname === '/api/users') {
    const out = {}
    for (const m of state.machines.values()) {
      out[m.host] = m.os === 'windows'
        ? { ts: Date.now() / 1000, users: [], error: 'Windows 机器仅支持监控，账号管理仅限 Linux 机器' }
        : (CFG.demo_mode ? demo.users(m.host) : await collectUsers(m.host))
    }
    return sendJson(res, { users: out })
  }

  const hostList = arr => (Array.isArray(arr) ? arr : [])
    .filter(h => { const m = state.machines.get(h); return m && m.os !== 'windows' })

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
    console.log('─'.repeat(56))
    console.log('  GPU Ops Center API 已启动')
    console.log(`  监听     http://${host === '0.0.0.0' ? '0.0.0.0' : host}:${port}/`)
    console.log(`  管理员   ${admins.map(a => a.name).join('、')}（admins.json，可在网页"管理员"页维护）`)
    console.log(`  采集     ${CFG.demo_mode ? '演示模式' : `SSH 轮询，间隔 ${CFG.poll_interval}s`}`)
    console.log('─'.repeat(56))
  })
}

main()
