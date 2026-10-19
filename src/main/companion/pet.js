'use strict'
/**
 * AI 伴侣 · 桌面角色
 * 把当前角色的形象（立绘 / Spine / VRM）以透明无边框窗口显示在桌面右下角，
 * 可拖动、可关闭；角色保存/切换后自动刷新（notifyPet）。
 * 独立窗口不抢焦点、不进任务栏，普通层级（会被其他窗口盖住，像桌面的一部分）。
 */
const { BrowserWindow, screen, desktopCapturer, app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const store = require('../store')
const { log } = require('../logger')

let win = null

function petCfg () {
  const g = store.get()
  return (g.global && g.global.companion) || {}
}

function createWindow () {
  const wa = screen.getPrimaryDisplay().workArea
  const W = 380
  const H = 620
  win = new BrowserWindow({
    width: W, height: H,
    x: Math.max(0, wa.x + wa.width - W - 24),
    y: Math.max(0, wa.y + wa.height - H - 8),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    show: false,
    skipTaskbar: true,
    focusable: true,
    title: 'Aura 桌面角色',
    webPreferences: {
      // 本文件在 src/main/companion/ 下，须回跳两级到 src/ 根
      preload: path.join(__dirname, '../../preload/companion.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关键：frameless 透明置底窗口会被 Chromium 判定「被遮挡」而节流 rAF，
      // 角色动画就永远停在第一帧——必须关掉后台节流
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(false)
  win.loadFile(path.join(__dirname, '../../renderer/pet/index.html'))
  const wc = win.webContents
  wc.on('did-fail-load', (_e, code, desc, url) => log('[pet] 加载失败', code, desc, url))
  wc.on('render-process-gone', (_e, d) => log('[pet] 渲染进程退出', JSON.stringify(d)))
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log('[pet] 渲染层:', message, '@', sourceId + ':' + line)
  })
  win.once('ready-to-show', () => win.showInactive())
  // 兜底：透明窗口 ready-to-show 不可靠（同 AI 面板）
  const ensureShow = () => { if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive() }
  wc.once('did-finish-load', () => setTimeout(ensureShow, 800))
  setTimeout(ensureShow, 3000)
  // 兜底：置底透明窗口被判定遮挡时合成上屏会被挂起（renderer 在产帧但屏幕不动），
  // 定期强制全量重绘保证画面持续刷新
  setInterval(() => { try { if (win && !win.isDestroyed()) wc.invalidate() } catch {} }, 40)
  win.on('closed', () => { win = null })
  // 屏幕级取证：capturePage（窗口渲染结果）+ desktopCapturer（真实屏幕）各拍两帧，
  // 判定「位图动/屏幕不动」卡在哪一层
  setTimeout(async () => {
    const shot = async (tag, i) => {
      try {
        if (!win || win.isDestroyed()) return
        const img = await win.webContents.capturePage()
        fs.writeFileSync(path.join(app.getPath('userData'), 'logs', 'win-pet-' + i + '.png'), img.toPNG())
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2560, height: 1440 } })
        const s = sources[0]
        if (s) fs.writeFileSync(path.join(app.getPath('userData'), 'logs', 'screen-' + i + '.png'), s.thumbnail.toPNG())
        log('[pet] 取证 ' + tag + ' 完成 (win/screen-' + i + '.png)')
      } catch (e) { log('[pet] 取证失败:', e && e.message) }
    }
    await shot('t1', 1)
    setTimeout(() => shot('t2', 2), 2000)
  }, 6000)
  log('[pet] 桌面角色窗口已创建')
}

function show () {
  if (win && !win.isDestroyed()) { if (!win.isVisible()) win.showInactive(); return }
  createWindow()
}

function hide () {
  if (win && !win.isDestroyed()) win.hide()
}

/** 角色保存/切换后通知刷新（把最新角色卡带给渲染层） */
function refresh (char) {
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.webContents.send('companion:pet-refresh', { char })
  }
}

function registerIpc (getChar, patchCfgFn) {
  const { ipcMain } = require('electron')
  ipcMain.handle('pet:show', () => { show(); return true })
  ipcMain.handle('pet:hide', () => {
    hide()
    if (patchCfgFn) patchCfgFn({ petOn: false })
    return true
  })
  ipcMain.handle('pet:win', (_e, action) => {
    if (!win || win.isDestroyed()) return
    if (action === 'close') { hide(); if (patchCfgFn) patchCfgFn({ petOn: false }) }
    return true
  })
  ipcMain.handle('pet:get-char', () => getChar())
}

module.exports = { show, hide, refresh, registerIpc }
