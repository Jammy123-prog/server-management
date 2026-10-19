<script setup>
/** 资产设备管理：设备台账（类型 / 型号 / 使用人 / 项目 / 凭据），中心节点 assets.json 持久化 */
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api.js'

const props = defineProps({
  toast: { type: Function, required: true }
})

const STATUS = ['在用', '闲置', '维修', '报废']
const TYPE_SUGGEST = ['显示器', '工控机', '工作站', '服务器', '笔记本', '台式机', '网络设备', '其他']

const assets = ref([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const r = await api('/api/assets')
    assets.value = r.assets || []
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    loading.value = false
  }
}
onMounted(load)

// ---- 筛选 ----
const q = ref('')
const fType = ref('')
const fStatus = ref('')
const fProject = ref('')

const types = computed(() => [...new Set(assets.value.map(a => a.type).filter(Boolean))])
const projects = computed(() => [...new Set(assets.value.map(a => a.project).filter(Boolean))])

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase()
  return assets.value.filter(a =>
    (!fType.value || a.type === fType.value) &&
    (!fStatus.value || a.status === fStatus.value) &&
    (!fProject.value || a.project === fProject.value) &&
    (!kw || [a.type, a.model, a.user, a.project, a.project_no, a.ip, a.username, a.note]
      .some(v => String(v || '').toLowerCase().includes(kw)))
  )
})

const stats = computed(() => ({
  total: assets.value.length,
  active: assets.value.filter(a => a.status === '在用').length,
  idle: assets.value.filter(a => a.status === '闲置' || a.status === '维修').length,
  projects: projects.value.length
}))

const STATUS_COLOR = {
  '在用': 'var(--accent-2)',
  '闲置': 'var(--muted)',
  '维修': 'var(--warn)',
  '报废': 'var(--danger)'
}
const STATUS_BG = {
  '在用': 'rgba(52,211,153,.12)',
  '闲置': 'rgba(148,163,184,.12)',
  '维修': 'rgba(245,158,11,.12)',
  '报废': 'rgba(239,68,68,.12)'
}

// ---- 新增 / 编辑 ----
const editModal = reactive({ show: false, id: '', busy: false })
const form = reactive({ type: '显示器', model: '', user: '', project: '', project_no: '', ip: '', username: '', password: '', note: '', status: '在用' })

function openAdd() {
  Object.assign(form, {
    type: types.value[0] || '显示器', model: '', user: '',
    project: fProject.value || '', project_no: '', ip: '',
    username: '', password: '', note: '', status: '在用'
  })
  editModal.id = ''
  editModal.show = true
}
function openEdit(a) {
  Object.assign(form, a)
  editModal.id = a.id
  editModal.show = true
}
const formValid = computed(() => form.type.trim() || form.model.trim())
async function saveAsset() {
  editModal.busy = true
  try {
    const r = await api('/api/assets/save', { id: editModal.id, ...form })
    assets.value = r.assets || []
    props.toast(editModal.id ? '已更新资产' : '已新增资产')
    editModal.show = false
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    editModal.busy = false
  }
}

// ---- 删除 ----
const delModal = reactive({ show: false, id: '', label: '', busy: false })
function confirmDel(a) {
  delModal.id = a.id
  delModal.label = `${a.type} ${a.model || ''}（${a.user || '未分配'}）`
  delModal.show = true
}
async function doDel() {
  delModal.busy = true
  try {
    const r = await api('/api/assets/delete', { id: delModal.id })
    assets.value = r.assets || []
    props.toast('已删除资产')
    delModal.show = false
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    delModal.busy = false
  }
}

// ---- 密码显隐 / 复制 ----
const shown = reactive({})
function togglePw(id) { shown[id] = !shown[id] }
async function copy(text, tip) {
  try {
    await navigator.clipboard.writeText(text)
    props.toast(tip + '已复制')
  } catch { props.toast('复制失败，请手动选择复制', false) }
}

// ---- CSV 导出（当前筛选结果，带 BOM 方便 Excel 直接打开） ----
function exportCsv() {
  const head = ['设备类型', '设备型号', '设备使用人', '对应项目', '项目工号', '对应IP', '用户名', '密码', '状态', '备注']
  const rows = filtered.value.map(a => [a.type, a.model, a.user, a.project, a.project_no, a.ip, a.username, a.password, a.status, a.note])
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = '\uFEFF' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const el = document.createElement('a')
  el.href = url
  el.download = `设备使用情况表_${new Date().toISOString().slice(0, 10)}.csv`
  el.click()
  URL.revokeObjectURL(url)
  props.toast(`已导出 ${rows.length} 条`)
}

// ---- 批量导入（CSV 文件直传 / JSON 粘贴） ----
const FIELD_ALIASES = {
  type: ['设备类型', '类型'],
  model: ['设备型号', '型号'],
  user: ['设备使用人', '使用人'],
  project: ['对应项目', '所属项目', '项目'],
  project_no: ['项目工号', '工号'],
  ip: ['对应ip', 'ip地址', 'ip'],
  username: ['用户名', '登录用户名', '登录用户', '账号'],
  password: ['密码'],
  note: ['备注'],
  status: ['状态']
}
const CSV_HEADS = ['设备类型', '设备型号', '设备使用人', '对应项目', '项目工号', '对应IP', '用户名', '密码', '状态', '备注']

const impModal = reactive({ show: false, busy: false, fileName: '', items: [], mapped: [], unmapped: [], error: '', wipe: false, jsonText: '' })
const fileInput = ref(null)
const dragOver = ref(false)

function openImport() {
  Object.assign(impModal, { fileName: '', items: [], mapped: [], unmapped: [], error: '', wipe: false })
  impModal.jsonText = ''
  impModal.show = true
}

function normHead(h) { return String(h || '').trim().toLowerCase().replace(/\s+/g, '') }

/** 解析 CSV 文本（支持引号包裹、双引号转义、\r\n / \n 换行） */
function parseCsv(text) {
  const rows = []
  let cur = [], field = '', inQ = false
  const push = () => { cur.push(field); field = '' }
  const endRow = () => { push(); if (cur.some(f => String(f).trim() !== '')) rows.push(cur); cur = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') push()
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow() }
    else field += c
  }
  endRow()
  return rows
}

/** 表头 → 字段映射（先精确匹配，再包含匹配），返回数据条目与识别情况 */
function csvToItems(rows) {
  const heads = rows[0].map(normHead)
  const keyOf = h => {
    for (const [k, alias] of Object.entries(FIELD_ALIASES)) {
      if (alias.some(a => normHead(a) === h)) return k
    }
    for (const [k, alias] of Object.entries(FIELD_ALIASES)) {
      if (alias.some(a => a.length >= 2 && h.includes(normHead(a)))) return k
    }
    return ''
  }
  const keyMap = heads.map(keyOf)
  const mapped = [...new Set(keyMap.filter(Boolean))]
  const unmapped = heads.filter((h, i) => h && !keyMap[i]).map((h, i) => rows[0][i]).filter(Boolean)
  const items = []
  for (const r of rows.slice(1)) {
    if (!r.some(v => String(v || '').trim())) continue
    const it = {}
    keyMap.forEach((k, i) => { if (k) it[k] = String(r[i] ?? '').trim() })
    if (it.type || it.model || it.user || it.ip) items.push(it)
  }
  return { items, mapped, unmapped }
}

/** 读取 CSV 文件：自动识别 UTF-8（含 BOM）/ GBK（中文 Excel 默认）编码 */
async function handleFile(file) {
  if (!file) return
  if (!/\.csv$|\.txt$/i.test(file.name)) {
    impModal.error = '请选择 .csv 文件（Excel 中「另存为 → CSV(逗号分隔)」即可）'
    return
  }
  try {
    const buf = await file.arrayBuffer()
    let text = new TextDecoder('utf-8').decode(buf)
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)          // 去 UTF-8 BOM
    if (/\uFFFD/.test(text)) text = new TextDecoder('gbk').decode(buf) // 乱码 → 按 GBK 重解
    const rows = parseCsv(text)
    if (rows.length < 2) { impModal.error = '未解析到数据行（至少需要表头 + 1 行数据）'; return }
    const { items, mapped, unmapped } = csvToItems(rows)
    if (!items.length) {
      impModal.error = '未识别到有效数据。表头需包含：' + CSV_HEADS.slice(0, 5).join('、') + ' …（可先「下载导入模板」参考）'
      impModal.fileName = ''
      impModal.items = []
      return
    }
    Object.assign(impModal, { fileName: file.name, items, mapped, unmapped, error: '' })
  } catch (e) {
    impModal.error = '文件读取失败：' + (e.message || e)
  }
}

function onDrop(e) {
  dragOver.value = false
  handleFile(e.dataTransfer?.files?.[0])
}

/** 下载导入模板（含表头 + 示例行） */
function downloadTemplate() {
  const demo = ['显示器', 'Dell UltraSharp U2725QE', '张三', '巡检机器人', '1008000086', '192.168.1.100', 'zpmc', 'demo123456', '在用', '示例行，导入前可删除']
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = '\uFEFF' + [CSV_HEADS, demo].map(r => r.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const el = document.createElement('a')
  el.href = url
  el.download = '资产导入模板.csv'
  el.click()
  URL.revokeObjectURL(url)
}

async function doImport() {
  let items = []
  if (impModal.items.length) {
    items = impModal.items
  } else if (impModal.jsonText.trim()) {
    try {
      const j = JSON.parse(impModal.jsonText)
      if (!Array.isArray(j)) throw new Error('需要 JSON 数组格式')
      items = j
    } catch (e) {
      props.toast(e.message || 'JSON 解析失败', false)
      return
    }
  } else {
    props.toast('请先上传 CSV 文件或粘贴 JSON', false)
    return
  }
  impModal.busy = true
  try {
    const r = await api('/api/assets/import', { items, wipe: impModal.wipe })
    assets.value = r.assets || []
    props.toast(`已导入 ${items.length} 条资产${impModal.wipe ? '（覆盖模式）' : ''}`)
    impModal.show = false
  } catch (e) {
    props.toast(e.message, false)
  } finally {
    impModal.busy = false
  }
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <span class="eyebrow"><i></i>ASSETS</span>
        <h1>资产设备管理</h1>
        <div class="sub">设备台账 · 类型 / 使用人 / 项目 / 凭据 · 保存在中心节点 assets.json（不入库）</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost sm" @click="openImport"><span>导入</span></button>
        <button class="btn ghost sm" :disabled="!filtered.length" @click="exportCsv"><span>导出 CSV</span></button>
        <button class="btn sm" @click="openAdd">
          <span>新增设备</span>
          <span class="ic"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
        </button>
      </div>
    </div>

    <!-- 统计 -->
    <div class="bento" style="margin-bottom:18px">
      <div class="b-3 bezel stat rise in"><div class="core">
        <div class="label">设备总数</div>
        <div class="value">{{ stats.total }}</div>
      </div></div>
      <div class="b-3 bezel stat rise in"><div class="core">
        <div class="label">在用</div>
        <div class="value" style="color:var(--accent-2)">{{ stats.active }}</div>
      </div></div>
      <div class="b-3 bezel stat rise in"><div class="core">
        <div class="label">闲置 / 维修</div>
        <div class="value" style="color:var(--warn)">{{ stats.idle }}</div>
      </div></div>
      <div class="b-3 bezel stat rise in"><div class="core">
        <div class="label">涉及项目</div>
        <div class="value">{{ stats.projects }}</div>
      </div></div>
    </div>

    <!-- 筛选 -->
    <div class="bezel rise in" style="margin-bottom:18px"><div class="core">
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
        <div class="msearch bezel" style="max-width:420px;margin:0"><div class="core">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex:none"><circle cx="7" cy="7" r="4.5" stroke="var(--faint)" stroke-width="1.4"/><path d="m10.5 10.5 3 3" stroke="var(--faint)" stroke-width="1.4" stroke-linecap="round"/></svg>
          <input v-model="q" class="msearch-inp" placeholder="搜索型号 / 使用人 / 项目 / IP / 备注…" autocomplete="off">
        </div></div>
        <select v-model="fProject" class="inp" style="width:auto;padding:9px 14px">
          <option value="">全部项目</option>
          <option v-for="p in projects" :key="p" :value="p">{{ p }}</option>
        </select>
        <div class="mselect" style="flex:1">
          <button class="mpill" :class="{ on: !fType }" @click="fType = ''">全部类型</button>
          <button v-for="t in types" :key="t" class="mpill" :class="{ on: fType === t }" @click="fType = fType === t ? '' : t">{{ t }}</button>
        </div>
      </div>
      <div class="mselect" style="margin-top:10px">
        <button class="mpill all" :class="{ on: !fStatus }" @click="fStatus = ''">全部状态</button>
        <button v-for="s in ['在用', '闲置', '维修', '报废']" :key="s" class="mpill" :class="{ on: fStatus === s }" @click="fStatus = fStatus === s ? '' : s">{{ s }}</button>
      </div>
    </div></div>

    <!-- 台账表格 -->
    <div class="bezel rise in"><div class="core" style="padding:0">
      <div class="atable-wrap">
        <div v-if="loading" class="loading">加载中…</div>
        <div v-else-if="!filtered.length" class="loading">{{ assets.length ? '没有符合筛选条件的设备' : '暂无资产，点击右上角「新增设备」或「导入」开始建档' }}</div>
        <table v-else class="atable">
          <thead>
            <tr>
              <th>状态</th><th>类型</th><th>型号</th><th>使用人</th><th>所属项目</th><th>项目工号</th>
              <th>对应 IP</th><th>登录用户</th><th>密码</th><th>备注</th><th style="text-align:right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in filtered" :key="a.id">
              <td><span class="chip" :style="{ color: STATUS_COLOR[a.status], background: STATUS_BG[a.status], borderColor: 'transparent' }">{{ a.status }}</span></td>
              <td><span class="chip">{{ a.type }}</span></td>
              <td class="strong">{{ a.model || '—' }}</td>
              <td>{{ a.user || '—' }}</td>
              <td>{{ a.project || '—' }}</td>
              <td class="mono">{{ a.project_no || '—' }}</td>
              <td class="mono">{{ a.ip || '—' }}</td>
              <td class="mono">{{ a.username || '—' }}</td>
              <td>
                <template v-if="a.password">
                  <span class="mono" style="cursor:pointer" @click="togglePw(a.id)">{{ shown[a.id] ? a.password : '••••••••' }}</span>
                  <button class="iact" style="margin-left:6px;padding:1px 8px" @click="copy(a.password, '密码')">{{ shown[a.id] ? '隐藏' : '复制' }}</button>
                </template>
                <template v-else>—</template>
              </td>
              <td class="dim">{{ a.note || '—' }}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="iact" @click="openEdit(a)">编辑</button>
                <button class="iact del" style="margin-left:6px" @click="confirmDel(a)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div></div>

    <!-- 新增 / 编辑 -->
    <div class="modal-mask" :class="{ show: editModal.show }" @click.self="!editModal.busy && (editModal.show = false)">
      <div class="modal bezel" style="width:min(620px,100%)"><div class="core">
        <h3>{{ editModal.id ? '编辑设备' : '新增设备' }}</h3>
        <div class="msub">{{ editModal.id ? '修改后立即保存到中心节点' : '录入设备台账信息' }}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 18px">
          <div class="field">
            <label>设备类型</label>
            <input v-model="form.type" class="inp" list="asset-types" placeholder="如 显示器 / 工控机" autocomplete="off">
            <datalist id="asset-types"><option v-for="t in TYPE_SUGGEST" :key="t" :value="t" /></datalist>
          </div>
          <div class="field">
            <label>设备型号</label>
            <input v-model="form.model" class="inp" placeholder="如 Dell UltraSharp U2725QE" autocomplete="off">
          </div>
          <div class="field">
            <label>设备使用人</label>
            <input v-model="form.user" class="inp" placeholder="如 张三" autocomplete="off">
          </div>
          <div class="field">
            <label>状态</label>
            <div class="mselect">
              <button v-for="s in STATUS" :key="s" type="button" class="mpill" :class="{ on: form.status === s }" @click="form.status = s">{{ s }}</button>
            </div>
          </div>
          <div class="field">
            <label>对应项目</label>
            <input v-model="form.project" class="inp" list="asset-projects" placeholder="如 巡检机器人" autocomplete="off">
            <datalist id="asset-projects"><option v-for="p in projects" :key="p" :value="p" /></datalist>
          </div>
          <div class="field">
            <label>项目工号</label>
            <input v-model="form.project_no" class="inp mono" placeholder="如 1008000086" autocomplete="off">
          </div>
          <div class="field">
            <label>对应 IP（可选）</label>
            <input v-model="form.ip" class="inp mono" placeholder="如 192.168.1.100" autocomplete="off">
          </div>
          <div class="field">
            <label>登录用户名（可选）</label>
            <input v-model="form.username" class="inp mono" placeholder="设备登录账号" autocomplete="off">
          </div>
          <div class="field">
            <label>密码（可选）</label>
            <input v-model="form.password" class="inp mono" placeholder="保存后默认遮蔽显示" autocomplete="off">
          </div>
          <div class="field">
            <label>备注（可选）</label>
            <input v-model="form.note" class="inp" placeholder="如 cctv1 / 机器人1" autocomplete="off">
          </div>
        </div>
        <div class="actions">
          <button class="btn ghost sm" :disabled="editModal.busy" @click="editModal.show = false"><span>取消</span></button>
          <button class="btn sm" :disabled="!formValid || editModal.busy" @click="saveAsset"><span>{{ editModal.busy ? '保存中…' : '保存' }}</span></button>
        </div>
      </div></div>
    </div>

    <!-- 删除确认 -->
    <div class="modal-mask" :class="{ show: delModal.show }">
      <div class="modal bezel"><div class="core">
        <h3>删除设备</h3>
        <div class="msub">从台账中删除该条记录，不影响设备本身</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:22px">将删除 <b style="color:var(--text)">{{ delModal.label }}</b></div>
        <div class="actions">
          <button class="btn ghost sm" @click="delModal.show = false"><span>取消</span></button>
          <button class="btn danger sm" :disabled="delModal.busy" @click="doDel"><span>{{ delModal.busy ? '删除中…' : '确认删除' }}</span></button>
        </div>
      </div></div>
    </div>

    <!-- 批量导入（CSV 上传 / JSON 粘贴） -->
    <div class="modal-mask" :class="{ show: impModal.show }" @click.self="!impModal.busy && (impModal.show = false)">
      <div class="modal bezel" style="width:min(680px,100%)"><div class="core" style="max-height:88vh;overflow-y:auto">
        <h3>批量导入资产</h3>
        <div class="msub">上传 CSV 文件（Excel 直接「另存为 CSV」即可），或粘贴 JSON 数组</div>

        <!-- CSV 拖拽 / 选择区 -->
        <div
          class="csv-drop" :class="{ over: dragOver }"
          @click="fileInput?.click()"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <svg width="22" height="22" viewBox="0 0 16 16" fill="none" style="margin:0 auto 8px;display:block;color:var(--accent)">
            <path d="M8 11V2.8M5.2 5.4 8 2.6l2.8 2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M2.8 10.2v2A1.6 1.6 0 0 0 4.4 13.8h7.2a1.6 1.6 0 0 0 1.6-1.6v-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <div style="font-size:13.5px;color:var(--text)">点击选择 CSV 文件，或拖拽到此处</div>
          <div style="font-size:11.5px;color:var(--faint);margin-top:6px;line-height:1.7">
            自动识别 UTF-8 / GBK 编码，按表头自动映射：设备类型 / 设备型号 / 设备使用人 / 对应项目 / 项目工号 / 对应IP / 用户名 / 密码 / 状态 / 备注
          </div>
          <input ref="fileInput" type="file" accept=".csv,.txt,text/csv" style="display:none" @change="e => { handleFile(e.target.files[0]); e.target.value = '' }">
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <button class="expand-btn" style="padding:2px 0" @click="downloadTemplate">↓ 下载导入模板（含示例行）</button>
          <span v-if="impModal.fileName" style="font-size:11.5px;color:var(--faint)">{{ impModal.fileName }}</span>
        </div>

        <!-- 解析错误 -->
        <div v-if="impModal.error" style="color:var(--danger);font-size:12.5px;margin-top:10px">✕ {{ impModal.error }}</div>

        <!-- 解析预览 -->
        <div v-if="impModal.items.length" style="margin-top:14px">
          <div style="font-size:13px;color:var(--accent-2)">✓ 解析成功：{{ impModal.items.length }} 条记录 · 已识别字段 {{ impModal.mapped.join('、') }}</div>
          <div v-if="impModal.unmapped.length" style="font-size:11.5px;color:var(--warn);margin-top:4px">未识别的列（已忽略）：{{ impModal.unmapped.join('、') }}</div>
          <div class="atable-wrap" style="margin-top:10px;max-height:180px;overflow-y:auto">
            <table class="atable" style="min-width:0">
              <thead><tr><th>类型</th><th>型号</th><th>使用人</th><th>项目</th><th>IP</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-for="(a, i) in impModal.items.slice(0, 8)" :key="i">
                  <td>{{ a.type || '—' }}</td>
                  <td class="strong">{{ a.model || '—' }}</td>
                  <td>{{ a.user || '—' }}</td>
                  <td>{{ a.project || '—' }}</td>
                  <td class="mono">{{ a.ip || '—' }}</td>
                  <td>{{ a.status || '在用' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="impModal.items.length > 8" style="font-size:11px;color:var(--faint);margin-top:4px">…其余 {{ impModal.items.length - 8 }} 条已省略，导入后可见</div>
          <label style="display:flex;align-items:center;gap:8px;margin-top:14px;font-size:12.5px;color:var(--muted);cursor:pointer;user-select:none">
            <input type="checkbox" v-model="impModal.wipe" style="accent-color:var(--accent);width:14px;height:14px;cursor:pointer">
            覆盖导入（清空现有 {{ assets.length }} 条记录后重新导入）
          </label>
        </div>

        <!-- JSON 粘贴（高级） -->
        <details style="margin-top:14px">
          <summary style="font-size:12.5px;color:var(--muted);cursor:pointer;user-select:none">或粘贴 JSON 数组（高级）</summary>
          <textarea v-model="impModal.jsonText" class="inp mono" rows="5" style="resize:vertical;margin-top:10px" placeholder='[{"type": "显示器", "model": "Dell U2725QE", "user": "南俊宇", "project": "巡检机器人"}]' spellcheck="false"></textarea>
        </details>

        <div class="actions">
          <button class="btn ghost sm" :disabled="impModal.busy" @click="impModal.show = false"><span>取消</span></button>
          <button class="btn sm" :disabled="impModal.busy || (!impModal.items.length && !impModal.jsonText.trim())" @click="doImport">
            <span>{{ impModal.busy ? '导入中…' : (impModal.items.length ? `导入 ${impModal.items.length} 条` : '导入') }}</span>
          </button>
        </div>
      </div></div>
    </div>
  </section>
</template>
