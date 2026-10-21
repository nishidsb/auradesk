'use strict'
/**
 * 桌面角色 · 编排层（v0.4.0 起 AI 对话已移除，由 Ryza Assistant 承担）
 * - 角色管理面板窗口（独立、玻璃风格）：角色卡 / 形象资产导入 / TTS 音色配置 / 备份
 * - TTS 合成与代理（触摸语音、试听用）
 * - 桌宠渲染与触摸语音由 overlay + pet.js 承担
 */
const { BrowserWindow, app, ipcMain, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const store = require('../store')
const { log } = require('../logger')
const character = require('./character')
const tts = require('./tts')
const pet = require('./pet')

let win = null
let overlayBroadcast = null // main 注入：向所有 overlay 广播（桌宠配置同步用）

/** main 启动时注入，向全部 overlay 窗口广播的通道 */
function setOverlayBroadcast (fn) { overlayBroadcast = fn }
function bcast (ch, data) { if (overlayBroadcast) overlayBroadcast(ch, data) }

function cfg () {
  const g = store.get() // { global: {...}, displays: {...} } —— companion 配置在 global 下
  if (!g.global.companion) store.patchGlobal({ companion: {} })
  return store.get().global.companion || {}
}
function patchCfg (patch) {
  store.patchGlobal({ companion: { ...cfg(), ...patch } })
  // 语音请求代理设置实时生效（system/direct/自定义规则）
  if (patch.netProxy !== undefined) {
    try { require('./tts').setTtsProxy(patch.netProxy) } catch (err) { log('[companion] 设置 TTS 代理失败:', err.message) }
  }
}

function createWindow () {
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: 460, height: 700,
    minWidth: 380, minHeight: 520,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    show: false,
    skipTaskbar: false,
    title: 'Aura',
    webPreferences: {
      // 本文件在 src/main/companion/ 下，须回跳两级到 src/ 根
      preload: path.join(__dirname, '../../preload/companion.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 透明窗口被判定遮挡时会节流 rAF，动画卡在第一帧
      backgroundThrottling: false
    }
  })
  win.loadFile(path.join(__dirname, '../../renderer/companion/index.html'))
  // 诊断全链路：加载失败 / preload 报错 / 渲染进程崩溃 / 控制台错误都要留痕
  const wc = win.webContents
  wc.on('did-finish-load', () => log('[companion] 页面加载完成'))
  wc.on('did-fail-load', (_e, code, desc, url) => log('[companion] 页面加载失败', code, desc, url))
  wc.on('preload-error', (_e, p, err) => log('[companion] preload 报错', p, err && err.message))
  wc.on('render-process-gone', (_e, d) => log('[companion] 渲染进程退出', JSON.stringify(d)))
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log('[companion] 渲染层:', message, '@', sourceId + ':' + line)
  })
  win.once('ready-to-show', () => { log('[companion] ready-to-show'); win.show() })
  // 兜底：ready-to-show 因任何原因不触发（透明窗口首帧异常等）也必须把窗口亮出来
  const ensureShow = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      log('[companion] ready-to-show 未触发，兜底强制显示')
      win.show()
    }
  }
  wc.once('did-finish-load', () => setTimeout(ensureShow, 800))
  setTimeout(ensureShow, 3000)
  // 兜底：透明窗口被判定遮挡时合成上屏会被挂起，定期强制全量重绘
  setInterval(() => { try { if (win && !win.isDestroyed()) wc.invalidate() } catch {} }, 40)
  win.on('closed', () => { win = null })
  log('[companion] 面板已创建')
}

function send (ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data)
}

/* ---------------- IPC ---------------- */

/** 配置的对外视图（init / settings IPC 共用）。replyLang 保留：触摸语音短语语种跟它走 */
function settingsView () {
  const c = cfg()
  return {
    petOn: c.petOn !== false,
    petScale: c.petScale != null ? c.petScale : 1,
    replyLang: c.replyLang || 'zh',
    ttsMode: c.ttsMode || 'browser', ttsProvider: c.ttsProvider || 'openai',
    ttsBaseUrl: c.ttsBaseUrl || '', ttsModel: c.ttsModel || '', ttsApiKey: c.ttsApiKey || '',
    ttsVoice: c.ttsVoice || '', sysVoiceName: c.sysVoiceName || '',
    fishApiKey: c.fishApiKey || '',
    netProxy: c.netProxy || '',
    ttsRefAudio: c.ttsRefAudio || '', ttsTextLang: c.ttsTextLang || 'zh', ttsPromptText: c.ttsPromptText || '', ttsPromptLang: c.ttsPromptLang || 'zh',
    ttsSpeed: c.ttsSpeed || 1,
    fishBaseUrl: c.fishBaseUrl || 'https://api.fish.audio/v1/tts',
    fishModel: c.fishModel || 's2.1-pro-free',
    fishVoiceId: c.fishVoiceId || '', fishAsmrVoiceId: c.fishAsmrVoiceId || '',
    fishFormat: c.fishFormat || 'wav', fishLatency: c.fishLatency || 'normal',
    fishFeeling: c.fishFeeling || 0, fishTagDensity: c.fishTagDensity || 0
  }
}

function registerIpc () {
  // 语音请求代理：启动时按配置初始化（空=跟随系统，direct=强制直连，其它=自定义规则）
  try { require('./tts').setTtsProxy(cfg().netProxy) } catch (err) { log('[companion] 初始化 TTS 代理失败:', err.message) }
  ipcMain.handle('companion:init', () => {
    return {
      characters: character.list(),
      settings: settingsView()
    }
  })
  ipcMain.handle('companion:settings', () => settingsView())

  ipcMain.handle('companion:patch-settings', (_e, patch) => {
    patchCfg(patch)
    // 桌面角色开关实时生效
    if (patch.petOn === true) pet.show()
    else if (patch.petOn === false) pet.hide()
    // 角色大小实时生效：广播给 overlay 重新按比例布置舞台
    if (patch.petScale != null) bcast('pet:config', { scale: patch.petScale })
    // 语音语种实时生效：overlay 触摸语音短语跟着切语种
    if (patch.replyLang != null) bcast('pet:config', { replyLang: patch.replyLang })
    return true
  })

  ipcMain.handle('companion:set-active', (_e, id) => {
    const chars = character.list()
    const i = chars.findIndex((c) => c.id === id)
    if (i > 0) { const [c] = chars.splice(i, 1); chars.unshift(c); character.save(chars) }
    const nc = character.get(id)
    pet.refresh(nc)
    return { char: nc }
  })

  ipcMain.handle('companion:save-character', (_e, char) => {
    character.upsert(char)
    const nc = character.get(char.id)
    pet.refresh(nc)
    return nc
  })
  ipcMain.handle('companion:new-character', (_e, name) => {
    const id = character.newId(name || 'char')
    const char = { ...JSON.parse(JSON.stringify(character.get())), id, name: name || '新角色', worldBook: [], createdAt: Date.now() }
    character.upsert(char)
    return char
  })
  ipcMain.handle('companion:del-character', (_e, id) => {
    const chars = character.list()
    if (chars.length <= 1) return false
    character.remove(id)
    pet.refresh(character.get())
    return true
  })

  ipcMain.handle('companion:import-asset', async (_e, charId, kind) => {
    const filters = kind === 'vrm'
      ? [{ name: '3D 模型', extensions: ['vrm', 'glb'] }]
      : kind === 'spine'
        ? [{ name: 'Spine', extensions: ['skel', 'json', 'atlas', 'png'] }]
        : [{ name: '图片', extensions: ['png', 'webp', 'jpg', 'gif'] }]
    // Spine 支持一次多选（atlas + skel/json + png），单选时自动在同目录补齐同名三件套
    const props = kind === 'spine' ? ['openFile', 'multiSelections'] : ['openFile']
    const r = await dialog.showOpenDialog(win, { filters, properties: props })
    if (r.canceled || !r.filePaths.length) return kind === 'spine' ? [] : ''
    if (kind !== 'spine') return character.importAsset(charId, r.filePaths[0])
    // 归一化：正斜杠 + 统一小写扩展名判断
    let picked = r.filePaths.map((p) => path.normalize(p))
    // 自动补齐：对每个选中的主名（stem），同目录补齐同名 atlas / skel / json / png。
    // 之前只在单选时补，选 atlas+skel 两个文件时 png 不会跟进来，
    // 资产目录缺贴图 → 加载一直 Couldn't load image → 小蓝星
    const stemOf = (p) => path.basename(p).replace(/\.(atlas|skel|json|png)$/i, '')
    const isSpineExt = (p) => /\.(atlas|skel|json|png)$/i.test(p)
    const stems = [...new Set(picked.filter(isSpineExt).map(stemOf))]
    for (const stem of stems) {
      const dir = path.dirname(picked.find((p) => isSpineExt(p) && stemOf(p) === stem))
      for (const ext of ['.atlas', '.skel', '.json', '.png']) {
        const cand = path.join(dir, stem + ext)
        if (!picked.some((p) => p.toLowerCase() === cand.toLowerCase()) && fs.existsSync(cand)) picked.push(cand)
      }
    }
    return picked.map((p) => character.importAsset(charId, p))
  })

  // 桌面角色窗口 IPC（当前角色 getter / 配置回写）
  pet.registerIpc(() => character.get(), patchCfg)

  ipcMain.handle('companion:asset-url', (_e, p) => character.assetUrl(p))

  // 渲染层贴图兜底：自定义协议 fetch 偶发 Failed to fetch（Image 的 CORS 校验更严），
  // 这里直接主进程读本地文件转 dataURL 返回，彻底绕开协议链路
  ipcMain.handle('companion:asset-data', (_e, p) => {
    try {
      const abs = String(p || '').replace(/\\/g, '/')
      if (!/^[a-zA-Z]:\//.test(abs) || !fs.existsSync(abs)) return null
      const ext = (abs.match(/\.([a-z0-9]+)$/i) || [])[1] || ''
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext.toLowerCase()]
      if (!mime) return null
      return 'data:' + mime + ';base64,' + fs.readFileSync(abs).toString('base64')
    } catch (e) {
      log('[companion] asset-data 失败:', e && e.message)
      return null
    }
  })

  // 诊断：把渲染层 canvas 整帧存成 png，直接看画没画、画成什么样
  ipcMain.handle('companion:log-image', (_e, name, dataUrl) => {
    try {
      const b64 = String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '')
      if (!b64) return null
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, String(name || 'frame').replace(/[^\w.-]/g, '_'))
      fs.writeFileSync(file, Buffer.from(b64, 'base64'))
      log('[companion] 画面已保存:', file)
      return file
    } catch (e) {
      log('[companion] log-image 失败:', e && e.message)
      return null
    }
  })

  /* ---------------- 备份：设置（含语音 Key）+ 角色卡，全部本地文件 ---------------- */

  /** 读 userData/companion 下的 JSON（与 character.js 的落盘格式一致） */
  function readCompanionJson (rel, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'companion', rel), 'utf8')) } catch { return fallback }
  }
  function writeCompanionJson (rel, data) {
    const file = path.join(app.getPath('userData'), 'companion', rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8')
  }

  ipcMain.handle('companion:export-backup', async () => {
    try {
      const r = await dialog.showSaveDialog(win, {
        title: '导出 AuraDesk 全部设置（含语音 Key，请妥善保管）',
        defaultPath: 'AuraDesk-backup-' + new Date().toISOString().slice(0, 10) + '.json',
        filters: [{ name: 'AuraDesk 备份', extensions: ['json'] }]
      })
      if (r.canceled || !r.filePath) return { ok: false, message: '' }
      const backup = {
        app: 'AuraDesk', kind: 'full-backup', exportedAt: new Date().toISOString(),
        config: store.get(),
        characters: readCompanionJson('characters.json', [])
      }
      fs.writeFileSync(r.filePath, JSON.stringify(backup, null, 1), 'utf8')
      log('[companion] 备份已导出:', r.filePath)
      return { ok: true, path: r.filePath }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  ipcMain.handle('companion:import-backup', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '从备份文件导入（覆盖当前全部设置与角色数据）',
        filters: [{ name: 'AuraDesk 备份', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (r.canceled || !r.filePaths.length) return { ok: false, message: '' }
      const backup = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
      if (backup.app !== 'AuraDesk' || backup.kind !== 'full-backup') {
        return { ok: false, message: '不是有效的 AuraDesk 备份文件' }
      }
      // 1) 应用配置整体替换（hydrate 合并默认值 + 版本迁移），立即落盘
      if (backup.config) store.replace(backup.config)
      // 2) 角色卡（旧版备份里的 histories/memories 属已移除的 AI 对话数据，忽略不写）
      if (Array.isArray(backup.characters)) {
        writeCompanionJson('characters.json', backup.characters)
      }
      log('[companion] 备份已导入:', r.filePaths[0])
      // 3) 重启应用让桌面层/角色面板全部按新配置初始化（最干净）
      setTimeout(() => { app.relaunch(); app.exit(0) }, 1500)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  // Fish Audio 我的声音库（设置页下拉选择音色，不用再手抠 reference_id）
  ipcMain.handle('companion:fish-voices', async () => {
    const c = cfg()
    try {
      return { ok: true, voices: await tts.listFishVoices(c.fishApiKey || c.ttsApiKey) }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  ipcMain.handle('companion:win', (_e, action) => {
    if (!win || win.isDestroyed()) return
    if (action === 'min') win.minimize()
    else if (action === 'close') win.close()
    else if (action === 'pin') {
      const on = !win.isAlwaysOnTop()
      win.setAlwaysOnTop(on, 'screen-saver')
      return on
    }
    return true
  })
  // TTS 合成：触摸语音（overlay）与设置页试听共用
  ipcMain.handle('companion:tts', async (_e, text) => {
    const c = cfg()
    // lang 随语音结果带回：overlay 触摸反应的短语/系统兜底语种跟语音语种设置走
    if (c.ttsMode !== 'api') {
      return { ok: false, message: '请先把「语音合成」切换为「API / 本地引擎」，再试听', lang: c.replyLang || 'zh' }
    }
    try {
      const r = await tts.speak({
        provider: c.ttsProvider || 'openai',
        baseUrl: c.ttsProvider === 'fish' ? (c.fishBaseUrl || 'https://api.fish.audio/v1/tts') : (c.ttsBaseUrl || ''),
        apiKey: c.ttsProvider === 'fish' ? (c.fishApiKey || c.ttsApiKey) : (c.ttsApiKey || ''),
        model: c.ttsModel || 'tts-1', voice: c.ttsVoice || (character.get().voice && character.get().voice.apiVoice) || 'alloy',
        refAudio: c.ttsRefAudio, textLang: c.ttsTextLang, promptText: c.ttsPromptText, promptLang: c.ttsPromptLang,
        fishModel: c.fishModel, voiceId: c.fishVoiceId, asmrVoiceId: c.fishAsmrVoiceId,
        format: c.fishFormat, latency: c.fishLatency, feeling: c.fishFeeling, tagDensity: c.fishTagDensity,
        speed: c.ttsSpeed || 1, text
      })
      return { ok: true, url: r.url, speed: r.speed, lang: c.replyLang || 'zh' }
    } catch (err) {
      return { ok: false, fallback: true, message: err.message, lang: c.replyLang || 'zh' }
    }
  })
}

function stop () {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

/** 开机按配置拉起桌面角色（默认开） */
function bootPet () {
  const g = store.get()
  pet.refresh(character.get())
  if (!g.global.companion || g.global.companion.petOn !== false) pet.show()
}

app.on('before-quit', () => stop())

module.exports = { createWindow, registerIpc, stop, bootPet, setOverlayBroadcast }
