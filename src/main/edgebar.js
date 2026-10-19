'use strict'
/**
 * AuraDesk 边缘任务条：鼠标推到屏幕上/下边缘时滑出的运行程序卡片条
 *
 * - 每块屏一个独立置顶窗口（screen-saver 级，不被任何应用覆盖），
 *   由 main.js 的 buildOverlays 按每屏开关（ui.edgeBar）驱动 sync
 * - 平时整条藏在屏幕外、只露 3px 透明触发条；滑入/滑出是渲染层 transform 动画，
 *   窗口本身不动（省得鼠标相对坐标跳变）
 * - 热区由渲染层上报（edgebar:set-shape）：收起时只有 3px 触发条接收输入，
 *   其余区域 Windows 原生穿透——绝不挡程序的标题栏按钮
 * - 面板里是「桌面卡片同款」样式的小卡片，卡片内容直接铺该窗口的实时画面
 */
const { BrowserWindow, screen, ipcMain } = require('electron')
const path = require('node:path')
const { log } = require('./logger')

const WINS = new Map() // displayKey -> { win, bottom }
let bottomMode = false
let lastSpecs = []

const PANEL_H = 118 // 3px 触发条 + 卡片面板

function geoFor (d) {
  return {
    x: d.bounds.x,
    y: bottomMode ? d.bounds.y + d.bounds.height - PANEL_H : d.bounds.y,
    width: d.bounds.width,
    height: PANEL_H
  }
}

function createFor (spec) {
  const g = geoFor(spec.display)
  const win = new BrowserWindow({
    x: g.x, y: g.y, width: g.width, height: g.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/edgebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.loadFile(path.join(__dirname, '../renderer/edgebar/index.html'), {
    query: { bottom: bottomMode ? '1' : '' }
  })
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.showInactive()
    // screen-saver 级：压过普通置顶窗口，任务条永远摸得到
    win.setAlwaysOnTop(true, 'screen-saver')
    // 默认整窗穿透，等渲染层上报热区后精确放行（不能挡程序的标题栏按钮）
    win.setIgnoreMouseEvents(true)
  })
  win.on('closed', () => {
    for (const [k, v] of WINS) if (v.win === win) WINS.delete(k)
  })
  WINS.set(spec.id, { win, bottom: bottomMode })
}

/* main.js 的 buildOverlays 按每屏开关算好 specs 后调这里：
   specs = [{ id, display: { bounds }, }]，空数组 = 全部关闭 */
function sync (specs) {
  lastSpecs = specs || []
  try {
    bottomMode = !!require('./store').get().global.edgeBarBottom
  } catch {}
  const want = new Set(lastSpecs.map((s) => s.id))
  // 移除不该存在的（开关关了 / 屏幕没了 / 上下边切换）
  for (const [k, v] of WINS) {
    if (!want.has(k) || v.bottom !== bottomMode) {
      if (!v.win.isDestroyed()) v.win.destroy()
      WINS.delete(k)
    }
  }
  // 新增缺的
  for (const spec of lastSpecs) {
    if (!WINS.has(spec.id)) createFor(spec)
  }
  if (WINS.size) startPolling()
  else stopPolling()
}

function rebuild () {
  for (const [, v] of WINS) { if (!v.win.isDestroyed()) v.win.destroy() }
  WINS.clear()
  for (const spec of lastSpecs) createFor(spec)
  log('[edgebar] rebuilt x' + WINS.size + ' bottom=' + bottomMode)
}

function stop () {
  for (const [, v] of WINS) { if (!v.win.isDestroyed()) v.win.destroy() }
  WINS.clear()
  lastSpecs = []
  stopPolling()
}

function send (ch, data) {
  for (const [, v] of WINS) {
    if (!v.win.isDestroyed()) v.win.webContents.send(ch, data)
  }
}

let lastShapeLog = 0
function registerIpc () {
  ipcMain.on('edgebar:set-shape', (e, rects) => {
    for (const [, v] of WINS) {
      if (v.win.isDestroyed() || v.win.webContents.id !== e.sender.id) continue
      try {
        if (Array.isArray(rects) && rects.length) {
          v.win.setShape(rects)
          v.win.setIgnoreMouseEvents(false)
          const now = Date.now()
          if (now - lastShapeLog > 15000) {
            lastShapeLog = now
            log('[edgebar] 热区生效 rects=' + rects.length)
          }
        } else {
          v.win.setShape([])
          v.win.setIgnoreMouseEvents(true)
        }
      } catch (err) {
        try { v.win.setIgnoreMouseEvents(false) } catch {}
        log('[edgebar] setShape 异常，降级整窗可点:', err && err.message)
      }
      break
    }
  })
}

/* ---------------- 触发轮询：不依赖窗口 hit-test ----------------
   3px 透明条上的 DOM mouseenter 在部分环境收不到（per-pixel alpha 窗口
   的 hit-test 行为不定），改由主进程轮询光标位置判定——物理上必然可靠。
   驻留判定也在这里做：光标贴边连续 ~600ms（4 个 tick）才通知展开。 */
let pollTimer = null
let hitCount = 0
function startPolling () {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    try {
      const p = screen.getCursorScreenPoint()
      let inEdge = false
      for (const [, v] of WINS) {
        if (v.win.isDestroyed()) continue
        const b = v.win.getBounds()
        if (p.x < b.x || p.x >= b.x + b.width) continue
        if (bottomMode ? p.y >= b.y + b.height - 8 : p.y <= b.y + 8) { inEdge = true; break }
      }
      if (!inEdge) { hitCount = 0; return }
      if (++hitCount >= 4) {
        hitCount = 0
        send('edgebar:open')
      }
    } catch { /* 光标查询失败忽略本 tick */ }
  }, 150)
}

function stopPolling () {
  clearInterval(pollTimer)
  pollTimer = null
  hitCount = 0
}

module.exports = { sync, rebuild, stop, send, registerIpc, startPolling, stopPolling }
