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
const store = require('../store')
const { log } = require('../logger')
const character = require('./character')
const memory = require('./memory')
const llm = require('./llm')
const tools = require('./tools')
const tts = require('./tts')

let win = null
let genAbort = null // AbortController

function cfg () {
  const g = store.get()
  if (!g.companion) store.patchGlobal({ companion: {} })
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
      preload: path.join(__dirname, '../preload/companion.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile(path.join(__dirname, '../renderer/companion/index.html'))
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
          speed: 1, text: full
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
    if (c.asrLang) fd.append('language', c.asrLang)
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

function registerIpc () {
  ipcMain.handle('companion:init', () => {
    const c = cfg()
    return {
      characters: character.list(),
      history: character.history(character.get().id),
      settings: {
        apiBaseUrl: c.apiBaseUrl || '', apiModel: c.apiModel || '', apiKey: c.apiKey || '',
        visionOn: c.visionOn !== false,
        ttsMode: c.ttsMode || 'browser', ttsProvider: c.ttsProvider || 'openai',
        ttsBaseUrl: c.ttsBaseUrl || '', ttsModel: c.ttsModel || '', ttsApiKey: c.ttsApiKey || '',
        ttsRefAudio: c.ttsRefAudio || '', ttsTextLang: c.ttsTextLang || 'zh', ttsPromptText: c.ttsPromptText || '', ttsPromptLang: c.ttsPromptLang || 'zh',
        asrBaseUrl: c.asrBaseUrl || '', asrModel: c.asrModel || 'whisper-1', asrApiKey: c.asrApiKey || ''
      }
    }
  })

  ipcMain.handle('companion:models', async (_e, baseUrl, apiKey) => llm.listModels({ baseUrl, apiKey }))
  ipcMain.handle('companion:patch-settings', (_e, patch) => { patchCfg(patch); return true })

  ipcMain.handle('companion:set-active', (_e, id) => {
    const chars = character.list()
    const i = chars.findIndex((c) => c.id === id)
    if (i > 0) { const [c] = chars.splice(i, 1); chars.unshift(c); character.save(chars) }
    return { char: character.get(id), history: character.history(id) }
  })

  ipcMain.handle('companion:save-character', (_e, char) => {
    character.upsert(char)
    return character.get(char.id)
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
    return true
  })

  ipcMain.handle('companion:import-asset', async (_e, charId, kind) => {
    const filters = kind === 'vrm'
      ? [{ name: '3D 模型', extensions: ['vrm', 'glb'] }]
      : kind === 'spine'
        ? [{ name: 'Spine', extensions: ['skel', 'json', 'atlas', 'png'] }]
        : [{ name: '图片', extensions: ['png', 'webp', 'jpg', 'gif'] }]
    const r = await dialog.showOpenDialog(win, { filters, properties: ['openFile'] })
    if (r.canceled || !r.filePaths.length) return ''
    return character.importAsset(charId, r.filePaths[0])
  })

  ipcMain.handle('companion:asset-url', (_e, p) => character.assetUrl(p))

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
        speed: 1, text
      })
      return { ok: true, url: r.url }
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

app.on('before-quit', () => stop())

module.exports = { createWindow, registerIpc, stop }
