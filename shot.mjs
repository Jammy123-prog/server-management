#!/usr/bin/env node
/**
 * shot.mjs — 用 CDP 驱动 Chrome headless：登录 GPU Ops Center 并截全页图
 * 用法：node shot.mjs <url> <password> <输出.png> [视口宽] [视口高]
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [url, password, outPng, vw = '1440', vh = '2400', clickSel = ''] = process.argv.slice(2)
const PORT = 9333
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function httpGetJson(u) {
  return new Promise((resolve, reject) => {
    http.get(u, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gpuops-shot-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${vw},${vh}`,
    'about:blank'
  ], { stdio: 'ignore' })

  try {
    // 等调试端口就绪
    let targets = null
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      try {
        targets = await httpGetJson(`http://127.0.0.1:${PORT}/json/list`)
        if (targets?.length) break
      } catch {}
    }
    const page = targets.find(t => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

    let id = 0
    const pending = new Map()
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    }
    const send = (method, params = {}) => new Promise(res => {
      const mid = ++id
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })

    const evalJs = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      return r.result?.result?.value
    }

    await send('Emulation.setDeviceMetricsOverride', {
      width: +vw, height: +vh, deviceScaleFactor: 1, mobile: false
    })
    await send('Page.enable')
    await send('Page.navigate', { url })
    await sleep(2500)

    // 自动登录（轮询等待登录框出现，触发 Vue v-model）
    const r1 = await evalJs(`new Promise(res => {
      let n = 0;
      const t = setInterval(() => {
        const el = document.querySelector('#login-pw');
        if (el) {
          clearInterval(t);
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(el, ${JSON.stringify(password)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#login-btn').click();
          res('clicked');
        } else if (++n > 60) { clearInterval(t); res('timeout url=' + location.href + ' html=' + document.body.innerHTML.slice(0, 200)); }
      }, 250);
    })`)
    console.log('login-eval:', r1)
    await sleep(3500)
    if (clickSel) {
      await evalJs(`(() => {
        const els = [...document.querySelectorAll('${clickSel}')]
        els.find(e => !e.classList.contains('on'))?.click()
        return 'nav:' + els.length
      })()`)
      await sleep(2500)
    }
    // 强制触发入场动画终态（headless 下 IntersectionObserver 可能不触发）
    await evalJs(`document.querySelectorAll('.rise').forEach(e => e.classList.add('in')); 'ok'`)
    await sleep(1400)

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'))
    console.log('saved:', outPng)
    ws.close()
  } finally {
    try { chrome.kill() } catch {}
    await sleep(300)
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  }
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
