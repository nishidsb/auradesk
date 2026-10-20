'use strict'
/**
 * AI 伴侣 · 桌面角色（overlay 内嵌版）
 * 桌宠不再用独立 BrowserWindow——独立透明小窗口在本机被 Chromium 判定遮挡
 * （被全屏透明桌面层覆盖 / GPU 合成挂起，所有开关都救不回来，capturePage 永远
 * 冻结在第 1 帧）。改为把角色渲染进桌面层 overlay 窗口（合成被证实正常）。
 * 本模块只负责：状态维护（当前角色 + 显示开关）+ 向 overlay 广播。
 */
const store = require('../store')
const { log } = require('../logger')

let broadcast = null // main 注入：向所有 overlay 窗口发消息
let state = { char: null, visible: false }

function petCfg () {
  const g = store.get()
  return (g.global && g.global.companion) || {}
}

function setBroadcast (fn) { broadcast = fn }

function push () {
  try { if (broadcast) broadcast('pet:state', state) } catch (e) { log('[pet] 广播失败:', e && e.message) }
}

function show () {
  state.visible = true
  push()
}

function hide () {
  state.visible = false
  push()
}

/** 角色保存/切换后通知刷新（把最新角色卡带给 overlay） */
function refresh (char) {
  state.char = char
  push()
}

function boot () {
  const c = petCfg()
  state.visible = c.petOn !== false && !!(c.petOn || c.petOn === undefined)
  // petOn 未配置过时默认显示
  if (c.petOn === undefined) state.visible = true
  log('[pet] overlay 模式启动, visible =', state.visible)
}

function registerIpc (getChar, patchCfgFn) {
  const { ipcMain } = require('electron')
  ipcMain.handle('pet:show', () => {
    show()
    if (patchCfgFn) patchCfgFn({ petOn: true })
    return true
  })
  ipcMain.handle('pet:hide', () => {
    hide()
    if (patchCfgFn) patchCfgFn({ petOn: false })
    return true
  })
  // 兼容旧 pet:win（pet 窗口的关闭按钮）
  ipcMain.handle('pet:win', (_e, action) => {
    if (action === 'close') { hide(); if (patchCfgFn) patchCfgFn({ petOn: false }) }
    return true
  })
  // overlay 启动时拉取初始状态
  ipcMain.handle('pet:state', () => state)
  // 截屏取证：把屏幕真实画面存成 png（排查灰框等渲染问题，不用用户手动截图）
  const fs = require('fs')
  const path = require('path')
  const { screen, desktopCapturer } = require('electron')
  let snapSeq = 0
  ipcMain.handle('pet:snapshot', async (_e, tag) => {
    try {
      const d = screen.getPrimaryDisplay()
      const th = {
        width: Math.min(3840, Math.round(d.size.width * d.scaleFactor)),
        height: Math.min(2160, Math.round(d.size.height * d.scaleFactor))
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: th })
      if (!sources || !sources.length) return false
      snapSeq++
      const { app } = require('electron')
      const p = path.join(app.getPath('userData'), 'logs', 'pet-snap-' + (tag || snapSeq) + '.png')
      fs.writeFileSync(p, sources[0].thumbnail.toPNG())
      log('[pet] 截屏已保存:', p)
      return true
    } catch (e) { log('[pet] 截屏失败:', e && e.message); return false }
  })
}

module.exports = { show, hide, refresh, registerIpc, boot, setBroadcast, petCfg }
