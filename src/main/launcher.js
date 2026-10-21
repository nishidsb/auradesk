'use strict'
/**
 * AuraDesk launcher：把「任务栏的功能」融进桌面层（替代而非覆盖）
 *
 * - 常驻 PowerShell 助手（assistant.ps1）扫描运行中的窗口，
 *   按 library 卡片的 exe 路径算出每张卡片的运行状态 { h, min, fg }
 * - 广播 overlay:app-state 给所有覆盖层：卡片悬停显示状态气泡，
 *   点击运行中的卡片 = 切换到那个窗口（未运行 = 启动）
 * - 音量 / 静音 / 音频输出输入设备切换 / 显示桌面 也走这个助手，
 *   由覆盖层右下角时钟旁的小面板承载
 */
const { ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const store = require('./store')
const { unpackedPath } = require('./util')
const { log } = require('./logger')

/* 悬停气泡的窗口实时预览：渲染层请求 → 助手 PrintWindow 截图存 PNG → 返回 file:// 地址 */
const shotReq = new Map() // reqId -> { resolve, timer }
let shotSeq = 0
function shotsDir () {
  const { app } = require('electron')
  const dir = path.join(app.getPath('userData'), 'shots')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

function requestShot (hwnd, timeout = 1500) {
  const id = 's' + (++shotSeq)
  const file = path.join(shotsDir(), `w${hwnd}-${Date.now()}-${id}.png`)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      shotReq.delete(id)
      resolve({ ok: false, err: 'timeout' })
    }, timeout)
    shotReq.set(id, { resolve, file })
    helperCmd(`shot ${Math.trunc(Number(hwnd))} ${file} ${id}`, 'shot')
  })
}

function onShotReply (msg) {
  const pend = shotReq.get(msg.id)
  if (!pend) return
  shotReq.delete(msg.id)
  clearTimeout(pend.timer)
  if (msg.ok && msg.path) {
    // 同一 hwnd 只留最新一张，避免目录膨胀
    try {
      const base = path.basename(msg.path)
      const m = /^w(\d+)-/.exec(base)
      if (m) {
        for (const f of fs.readdirSync(shotsDir())) {
          if (f.startsWith(`w${m[1]}-`) && f !== base) {
            try { fs.rmSync(path.join(shotsDir(), f), { force: true }) } catch {}
          }
        }
      }
    } catch {}
    pend.resolve({
      ok: true,
      url: pathToFileURL(msg.path).href,
      w: msg.w, h: msg.h, t: msg.t || ''
    })
  } else {
    pend.resolve({ ok: false, err: msg.err || 'shot failed' })
  }
}

const PS = unpackedPath(path.join(__dirname, 'resources', 'assistant.ps1'))

let helper = null
let helperBuf = ''
let scanTimer = null
let retryTimer = null
let latestWindows = []
let latestProcs = []
let latestApps = {} // gameId -> { h, min, fg } 或 { h: null, tray: true }
let latestVol = { v: null, m: false }
let latestDevs = { out: [], in: [], cur: '', curIn: '' }
let deps = { broadcastAll: () => {} }

/* ---------------------------------------------------------------- 助手进程 */

function helperCmd (line, tag) {
  if (!helper || !helper.stdin.writable) {
    if (tag) log('[helper] 写入失败（进程不在）: ' + line.slice(0, 200))
    return
  }
  try { helper.stdin.write(line + '\n') } catch (err) {
    if (tag) log('[helper] 写入异常:', err && err.message)
  }
}

function start () {
  if (helper) return
  try {
    helper = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS
    ], { windowsHide: true, env: { ...process.env, AURA_PID: String(process.pid) } })
  } catch (err) {
    console.warn('[launcher] 助手进程启动失败', err)
    log('[helper] 启动失败:', err && err.message)
    scheduleRetry()
    return
  }
  log('[helper] 已启动 pid=' + helper.pid)
  helper.stdout.setEncoding('utf8')
  helper.stdout.on('data', (d) => {
    helperBuf += d
    let i
    while ((i = helperBuf.indexOf('\n')) >= 0) {
      const line = helperBuf.slice(0, i).trim()
      helperBuf = helperBuf.slice(i + 1)
      if (line.startsWith('{')) onHelperLine(line)
      else if (line) log('[helper-out]', line.slice(0, 400))
    }
  })
  // 助手的报错全走 stderr，之前根本没监听——ps1 报错时这里完全失聪
  helper.stderr.setEncoding('utf8')
  helper.stderr.on('data', (d) => {
    const s = String(d).trim()
    if (s) log('[helper-stderr]', s.slice(0, 800))
  })
  const restart = () => {
    log('[helper] 退出，准备重启')
    helper = null
    scheduleRetry()
  }
  helper.on('error', (err) => {
    log('[helper] error 事件:', err && err.message)
    restart()
  })
  helper.on('exit', (code) => {
    log('[helper] exit 事件 code=' + code)
    restart()
  })
  helperCmd('scan')
  clearInterval(scanTimer)
  scanTimer = setInterval(() => helperCmd('scan'), 1500)
}

let retryCount = 0
function scheduleRetry () {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(start, Math.min(3000 * (++retryCount), 30000))
}

function stop () {
  clearInterval(scanTimer)
  clearTimeout(retryTimer)
  if (helper) {
    try { helper.stdin.write('quit\n'); helper.kill() } catch {}
    helper = null
  }
}

let lastWinSig = ''
function onHelperLine (line) {
  let msg
  try { msg = JSON.parse(line) } catch {
    log('[helper] 非 JSON 输出:', line.slice(0, 400))
    return
  }
  if (msg.type === 'windows' && Array.isArray(msg.list)) {
    const sig = msg.list.length + ':' + msg.procs.length
    if (sig !== lastWinSig) {
      lastWinSig = sig
      log('[scan] 窗口数=' + msg.list.length + ' 进程数=' + (Array.isArray(msg.procs) ? msg.procs.length : 0) +
        ' list=' + JSON.stringify(msg.list.slice(0, 12)))
    }
    latestWindows = msg.list
    latestProcs = Array.isArray(msg.procs) ? msg.procs : []
    rebuildApps()
    deps.broadcastAll('overlay:app-state', latestApps)
    // 边缘任务条：所有运行中窗口的轻量列表（1.5s 一次，渲染层做签名去重）
    deps.broadcastAll('edgebar:win-list', latestWindows.map((w) => ({
      h: w.h, t: w.t, pn: w.pn, min: !!w.min, fg: !!w.fg
    })))
  } else if (msg.act !== undefined && msg.ok !== undefined && !msg.type) {
    // toggle 指令的执行结果（act = 是否真的切到了前台）
    log('[toggle] 助手结果:', line.slice(0, 300))
    deps.broadcastAll('overlay:toggle-result', { ok: !!msg.ok, act: !!msg.act, err: msg.err || '' })
  } else if (msg.type === 'shot') {
    onShotReply(msg)
  } else if (msg.type === 'vol') {
    if (msg.v != null) {
      latestVol = { v: msg.v, m: !!msg.m }
      deps.broadcastAll('overlay:volume-state', latestVol)
    }
  } else if (msg.type === 'devs' && msg.d) {
    latestDevs = { out: msg.d.out || [], in: msg.d.in || [], cur: msg.d.cur || '', curIn: msg.d.curIn || '' }
    deps.broadcastAll('overlay:audio-devs', latestDevs)
  }
}

/* ------------------------------------------------- 卡片 ↔ 运行窗口匹配 */

/** exe 命中打分：精确路径 > 同名文件 > 进程名，前台 > 后台 > 最小化
 *  管理员权限运行的程序 Get-Process 拿不到 Path（pp 为 null），必须用 pn 兜底 */
function matchScore (w, cands) {
  const ppl = w.pp ? w.pp.toLowerCase() : ''
  const pn = (w.pn || '').toLowerCase()
  let best = 0
  for (const c of cands) {
    let s = 0
    if (ppl && c === ppl) s = 4
    else if (ppl && path.basename(c) === path.basename(ppl)) s = 2
    else if (pn && path.basename(c).replace(/\.exe$/i, '') === pn) s = 2
    if (s > best) best = s
  }
  if (!best) return 0
  if (w.fg) best += 2
  if (!w.min) best += 1
  return best
}

let lastAppsSig = ''

function rebuildApps () {
  const map = {}
  let lib = []
  try { lib = store.get().global.library || [] } catch {}
  for (const g of lib) {
    if (g.kind === 'url' || g.kind === 'folder') continue
    const cands = []
    if (g.exe) cands.push(String(g.exe).toLowerCase())
    if (g.target && /\.exe$/i.test(g.target)) cands.push(String(g.target).toLowerCase())
    if (!cands.length) continue
    let bestW = null
    let bestS = 0
    for (const w of latestWindows) {
      const s = matchScore(w, cands)
      if (s > bestS) { bestS = s; bestW = w }
    }
    if (bestW) { map[g.id] = { h: bestW.h, min: !!bestW.min, fg: !!bestW.fg }; continue }
    // 没有窗口但进程在跑（托盘驻留 / 无窗口程序）：标记 tray，点击时不重复启动
    const baseExe = path.basename(cands[0]).replace(/\.exe$/i, '').toLowerCase()
    if (baseExe && latestProcs.includes(baseExe)) map[g.id] = { h: null, tray: true }
  }
  latestApps = map
  const sig = JSON.stringify(map)
  if (sig !== lastAppsSig) {
    lastAppsSig = sig
    log('[scan] 卡片运行状态映射: ' + (sig === '{}' ? '（空——没有任何卡片匹配到运行中的程序）' : sig))
  }
}

/* ---------------------------------------------------------------- IPC */

/** 句柄有效性：必须在最近一次 scan 的窗口列表里（失效/复用 HWND 绝不能去 toggle，
 *  否则 SwitchToThisWindow 会误激活别的窗口、任务栏闪红点） */
function windowAlive (h) {
  const n = Math.trunc(Number(h))
  return Number.isFinite(n) && n > 0 && latestWindows.some((w) => Math.trunc(Number(w.h)) === n)
}

function registerIpc () {
  ipcMain.handle('overlay:app-state', () => latestApps)
  ipcMain.handle('overlay:window-shot', (_e, hwnd) => {
    const h = Number(hwnd)
    if (!Number.isFinite(h) || h <= 0) return { ok: false, err: 'bad hwnd' }
    return requestShot(h)
  })
  ipcMain.handle('overlay:audio-devs', () => {
    helperCmd('devs')
    return latestDevs
  })
  ipcMain.handle('overlay:volume-state', () => latestVol)

  ipcMain.on('overlay:toggle-app', (_e, id) => {
    const a = latestApps[id]
    if (a && Number.isFinite(Number(a.h))) {
      if (!windowAlive(a.h)) {
        // 卡片映射可能是上一轮 scan 的旧数据：窗口刚被关掉/句柄复用时直接拒绝
        log('[toggle] id=' + id + ' h=' + a.h + ' 不在当前窗口列表（已关闭或句柄失效），拒绝切换')
        deps.broadcastAll('overlay:toggle-result', { ok: false, act: false, err: '该窗口可能已关闭，请稍后再试' })
        return
      }
      log('[toggle] 收到切换 id=' + id + ' → h=' + a.h + ' min=' + a.min + ' fg=' + a.fg)
      helperCmd(`toggle ${Math.trunc(Number(a.h))}`, 'toggle')
    } else {
      log('[toggle] 收到切换 id=' + id + ' 但无可切窗口，latestApps=' + JSON.stringify(latestApps).slice(0, 600))
      deps.broadcastAll('overlay:toggle-result', { ok: false, act: false, err: '没有找到该程序正在运行的窗口' })
    }
  })

  // 边缘任务条：直接按窗口句柄切换
  ipcMain.on('edgebar:toggle-hwnd', (_e, h) => {
    const n = Math.trunc(Number(h))
    if (!Number.isFinite(n) || n <= 0 || n > 0x7fffffff) return
    if (!windowAlive(n)) {
      log('[toggle] 边缘任务条 h=' + n + ' 不在当前窗口列表（已关闭或句柄失效），拒绝切换')
      deps.broadcastAll('overlay:toggle-result', { ok: false, act: false, err: '该窗口可能已关闭' })
      return
    }
    log('[toggle] 边缘任务条切换 h=' + n)
    helperCmd(`toggle ${n}`, 'toggle')
  })

  ipcMain.on('overlay:volume', (_e, v) => {
    if (Number.isFinite(Number(v))) helperCmd(`vol ${Math.max(0, Math.min(100, Math.trunc(Number(v))))}`)
  })

  ipcMain.on('overlay:mute', () => helperCmd('mute'))

  ipcMain.on('overlay:set-dev', (_e, flow, id) => {
    if ((flow !== 'out' && flow !== 'in') || typeof id !== 'string' || !/^[0-9.{}a-fA-F-]+$/.test(id)) return
    helperCmd(`set${flow} ${id}`)
  })

  ipcMain.on('overlay:show-desktop', () => helperCmd('desk'))
}

module.exports = {
  registerIpc,
  start,
  stop,
  setDeps (d) { deps = { ...deps, ...d } },
  // 桌面状态与动作（供内部与调试使用）
  get latestWindows () { return latestWindows },
  get latestApps () { return latestApps },
  toggleByHandle (h) {
    const n = Math.trunc(Number(h))
    if (!Number.isFinite(n) || n <= 0 || n > 0x7fffffff) return false
    if (!windowAlive(n)) {
      log('[toggle] AI 工具 toggleByHandle h=' + n + ' 不在当前窗口列表，拒绝切换')
      return false
    }
    helperCmd(`toggle ${n}`, 'toggle')
    return true
  },
  helperCmdPublic (line) { helperCmd(line) }
}
