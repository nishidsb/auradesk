'use strict'
/**
 * AI 伴侣 · 编排层
 * - 伴侣面板窗口（独立、可输入、玻璃风格）
 * - 对话流水线：人设 + 世界书命中 + 记忆召回 + 历史 → 流式 LLM（工具调用自动续轮）
 *   → 回复落账（本地事实提取）→ 可选 TTS
 * - ASR 转发（Whisper 兼容 /audio/transcriptions；本地 faster-whisper / Groq 均可）
 */
const { BrowserWindow, app, ipcMain, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const store = require('../store')
const { log } = require('../logger')
const character = require('./character')
const memory = require('./memory')
const llm = require('./llm')
const tools = require('./tools')
const tts = require('./tts')
const pet = require('./pet')

let win = null
let genAbort = null // AbortController

function cfg () {
  const g = store.get() // { global: {...}, displays: {...} } —— companion 配置在 global 下
  if (!g.global.companion) store.patchGlobal({ companion: {} })
  return store.get().global.companion || {}
}
function patchCfg (patch) {
  store.patchGlobal({ companion: { ...cfg(), ...patch } })
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
  win.on('closed', () => { win = null })
  log('[companion] 面板已创建')
}

function send (ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data)
}

/* ---------------- 提示词组装 ---------------- */

function systemPrompt (char, userText) {
  const parts = [char.persona]
  // 世界书：关键词命中才注入（省 token）
  const q = String(userText || '')
  for (const entry of char.worldBook || []) {
    const kws = String(entry.keywords || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean)
    if (!kws.length || kws.some((k) => q.includes(k))) {
      parts.push('【世界观设定 · ' + (kws[0] || '常驻') + '】\n' + entry.content)
    }
  }
  const memText = memory.summaryText(char.id, userText)
  if (memText) parts.push(memText)
  // 多语言语音：用户可能说中/英/日，理解后按配置语言回复（即翻译）
  const langName = { zh: '中文', en: '英文', ja: '日文' }[cfg().replyLang || 'zh'] || '中文'
  parts.push('【语言】用户可能用中文、英文或日文说话（语音识别后可能保留原文），理解全部语言；无论对方说什么语言，都用' + langName + '回复。')
  parts.push('【当前时间】' + new Date().toLocaleString('zh-CN', { hour12: false }))
  return parts.join('\n\n')
}

/* ---------------- 对话流水线 ---------------- */

async function handleMessage (char, userText) {
  const c = cfg()
  const history = character.history(char.id)
  history.push({ role: 'user', content: userText, at: Date.now() })

  const messages = [
    { role: 'system', content: systemPrompt(char, userText) },
    ...history.slice(-30).map((m) => ({ role: m.role, content: m.content }))
  ]

  const seq = Date.now()
  const toolDefs = [...memory.toolDefs(), ...tools.defs(c.visionOn !== false)]
  const ctrl = new AbortController()
  genAbort = ctrl
  let full = ''
  try {
    const res = await llm.chatStream({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages, temperature: c.temperature != null ? c.temperature : 0.8,
      tools: toolDefs, signal: ctrl.signal,
      toolExec: (name, args) => {
        if (['remember', 'forget', 'recall_memory'].includes(name)) return memory.execTool(char.id, name, args)
        return tools.exec(name, args)
      },
      onDelta: (t) => { full += t; send('companion:delta', { seq, text: t }) }
    })
    full = res.content || full
    history.push({ role: 'assistant', content: full, at: Date.now() })
    character.saveHistory(char.id, history)
    memory.extractFacts(char.id, userText)
    // TTS（api 模式；browser 由渲染层处理）
    let audio = null
    if (c.ttsMode === 'api' && full) {
      try {
        audio = await tts.speak({
          provider: c.ttsProvider || 'openai',
          baseUrl: c.ttsBaseUrl || c.apiBaseUrl, apiKey: c.ttsApiKey || c.apiKey,
          model: c.ttsModel || 'tts-1', voice: (char.voice && char.voice.apiVoice) || 'alloy',
          refAudio: c.ttsRefAudio, textLang: c.ttsTextLang, promptText: c.ttsPromptText, promptLang: c.ttsPromptLang,
          fishModel: c.fishModel, voiceId: c.fishVoiceId, asmrVoiceId: c.fishAsmrVoiceId,
          format: c.fishFormat, latency: c.fishLatency, feeling: c.fishFeeling, tagDensity: c.fishTagDensity,
          speed: c.ttsSpeed || 1, text: full
        })
      } catch (err) {
        log('[companion] TTS 失败，回退浏览器:', err.message)
      }
    }
    send('companion:done', { seq, content: full, tools: res.toolResults, audio })
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? '（已停止生成）' : String(err && err.message)
    if (full) {
      history.push({ role: 'assistant', content: full + msg, at: Date.now() })
      character.saveHistory(char.id, history)
    }
    send('companion:error', { seq, message: msg, partial: full })
  } finally {
    genAbort = null
  }
}

/* ---------------- ASR 转发（Whisper 兼容） ---------------- */

async function transcribe (base64, mime) {
  const c = cfg()
  if (!c.asrBaseUrl) return { ok: false, message: '未配置语音识别端点' }
  const base = String(c.asrBaseUrl).replace(/\/+$/, '')
  const url = /\/transcriptions$/.test(base) ? base : base + '/audio/transcriptions'
  try {
    const buf = Buffer.from(base64, 'base64')
    const fd = new FormData()
    fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.webm')
    fd.append('model', c.asrModel || 'whisper-1')
    // auto（默认）不传 language，交给 Whisper 自动识别中/英/日
    if (c.asrLang && c.asrLang !== 'auto') fd.append('language', c.asrLang)
    const headers = {}
    if (c.asrApiKey || c.apiKey) headers.Authorization = 'Bearer ' + (c.asrApiKey || c.apiKey)
    const res = await fetch(url, { method: 'POST', headers, body: fd })
    if (!res.ok) return { ok: false, message: 'ASR ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 150) }
    const j = await res.json()
    return { ok: true, text: j.text || '' }
  } catch (err) {
    return { ok: false, message: String(err && err.message) }
  }
}

/* ---------------- IPC ---------------- */

/** AI 配置的对外视图（init / settings IPC 共用） */
function settingsView () {
  const c = cfg()
  return {
    apiBaseUrl: c.apiBaseUrl || '', apiModel: c.apiModel || '', apiKey: c.apiKey || '',
    visionOn: c.visionOn !== false,
    petOn: c.petOn !== false,
    replyLang: c.replyLang || 'zh',
    ttsMode: c.ttsMode || 'browser', ttsProvider: c.ttsProvider || 'openai',
    ttsBaseUrl: c.ttsBaseUrl || '', ttsModel: c.ttsModel || '', ttsApiKey: c.ttsApiKey || '',
    ttsRefAudio: c.ttsRefAudio || '', ttsTextLang: c.ttsTextLang || 'zh', ttsPromptText: c.ttsPromptText || '', ttsPromptLang: c.ttsPromptLang || 'zh',
    ttsSpeed: c.ttsSpeed || 1,
    fishBaseUrl: c.fishBaseUrl || 'https://api.fish.audio/v1/tts',
    fishModel: c.fishModel || 's2.1-pro-free',
    fishVoiceId: c.fishVoiceId || '', fishAsmrVoiceId: c.fishAsmrVoiceId || '',
    fishFormat: c.fishFormat || 'wav', fishLatency: c.fishLatency || 'normal',
    fishFeeling: c.fishFeeling || 0, fishTagDensity: c.fishTagDensity || 0,
    asrBaseUrl: c.asrBaseUrl || '', asrModel: c.asrModel || 'whisper-1', asrLang: c.asrLang || 'auto', asrApiKey: c.asrApiKey || ''
  }
}

function registerIpc () {
  ipcMain.handle('companion:init', () => {
    return {
      characters: character.list(),
      history: character.history(character.get().id),
      settings: settingsView()
    }
  })
  ipcMain.handle('companion:settings', () => settingsView())

  ipcMain.handle('companion:models', async (_e, baseUrl, apiKey) => llm.listModels({ baseUrl, apiKey }))
  ipcMain.handle('companion:patch-settings', (_e, patch) => {
    patchCfg(patch)
    // 桌面角色开关实时生效
    if (patch.petOn === true) pet.show()
    else if (patch.petOn === false) pet.hide()
    return true
  })

  // 长期记忆账本（可视化 + 手动删除）
  ipcMain.handle('companion:memory-list', () => {
    const mem = memory.get(character.get().id)
    return (mem.events || []).slice(-120).reverse()
  })
  ipcMain.handle('companion:memory-del', (_e, seq) => memory.removeEvent(character.get().id, seq))

  ipcMain.handle('companion:set-active', (_e, id) => {
    const chars = character.list()
    const i = chars.findIndex((c) => c.id === id)
    if (i > 0) { const [c] = chars.splice(i, 1); chars.unshift(c); character.save(chars) }
    const nc = character.get(id)
    pet.refresh(nc)
    return { char: nc, history: character.history(id) }
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

  ipcMain.handle('companion:send', (_e, text) => {
    const t = String(text || '').trim()
    if (!t) return false
    const c = cfg()
    if (!c.apiBaseUrl || !c.apiModel) {
      send('companion:error', { seq: Date.now(), message: '还没有配置 AI 服务：打开设置 → AI，填入 API 地址与模型（本地模型填 http://127.0.0.1:11434/v1 这类端点即可）' })
      return false
    }
    handleMessage(character.get(), t)
    return true
  })
  ipcMain.handle('companion:stop', () => { if (genAbort) genAbort.abort(); return true })
  ipcMain.handle('companion:clear-history', (_e, id) => { character.saveHistory(id || character.get().id, []); return true })

  ipcMain.handle('companion:transcribe', (_e, base64, mime) => transcribe(base64, mime))

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
  ipcMain.handle('companion:tts', async (_e, text) => {
    const c = cfg()
    if (c.ttsMode !== 'api') return { fallback: true }
    try {
      const r = await tts.speak({
        provider: c.ttsProvider || 'openai',
        baseUrl: c.ttsBaseUrl || c.apiBaseUrl, apiKey: c.ttsApiKey || c.apiKey,
        model: c.ttsModel || 'tts-1', voice: (character.get().voice && character.get().voice.apiVoice) || 'alloy',
        refAudio: c.ttsRefAudio, textLang: c.ttsTextLang, promptText: c.ttsPromptText, promptLang: c.ttsPromptLang,
        fishModel: c.fishModel, voiceId: c.fishVoiceId, asmrVoiceId: c.fishAsmrVoiceId,
        format: c.fishFormat, latency: c.fishLatency, feeling: c.fishFeeling, tagDensity: c.fishTagDensity,
        speed: c.ttsSpeed || 1, text
      })
      return { ok: true, url: r.url, speed: r.speed }
    } catch (err) {
      return { fallback: true, message: err.message }
    }
  })
}

function stop () {
  if (genAbort) genAbort.abort()
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

/** 开机按配置拉起桌面角色（默认开） */
function bootPet () {
  const g = store.get()
  if (!g.global.companion || g.global.companion.petOn !== false) pet.show()
}

app.on('before-quit', () => stop())

module.exports = { createWindow, registerIpc, stop, bootPet }
