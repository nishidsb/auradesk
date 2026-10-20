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
let overlayBroadcast = null // main 注入：向所有 overlay 广播（桌宠气泡聊天用）

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
  // 多语言语音：用户可能说中/英/日。回复语言（replyLang）与朗读音色（voice）是两个独立设置：
  // auto = 跟用户语言走；固定语言 = 理解任何语言后都用该语言回复（即翻译）。
  const rl = cfg().replyLang || 'zh'
  if (rl === 'auto') {
    parts.push('【语言要求·最高优先级】用与用户发言相同的语言回复：用户说什么语言，你就用什么语言作答（语音识别后可能保留原文，按其语言作答）。\n' +
      '硬性规则：\n' +
      '1. 整条回复只用一种语言（用户发言的主语言），禁止一半中文一半日语混写。\n' +
      '2. 唯一例外：专有名词（产品名、命令、代码、符号）可以保留原文。\n' +
      '3. 回复会被合成为语音朗读，任何混入的外语都会被读得很怪，务必检查输出。')
  } else {
    const langName = { zh: '中文', en: '英文', ja: '日文' }[rl] || '中文'
    parts.push('【语言要求·最高优先级】无论用户使用什么语言发言（中文、英文、日文等，语音识别后可能保留原文），你都必须先理解全部内容，然后【只】使用' + langName + '回复。\n' +
      '硬性规则：\n' +
      '1. 每一句话、每一个句子片段都必须是' + langName + '，禁止出现任何其它语言的完整句子（例如禁止一半日语一半中文混写）。\n' +
      '2. 唯一例外：专有名词（产品名、命令、代码、符号）可以保留原文，但也必须用' + langName + '语法包裹。\n' +
      '3. 你的回复会被合成为语音朗读，任何混入的外语都会被读得很怪，务必检查输出。')
  }
  parts.push('【当前时间】' + new Date().toLocaleString('zh-CN', { hour12: false }))
  return parts.join('\n\n')
}

/* ---------------- 对话流水线 ---------------- */

/** 语言守卫的粗判（参考 dialogue_language_guard）：固定回复语言时，明显用错语种才触发 */
function langMismatch (text, lang) {
  const t = String(text || '')
  if (!t) return false
  const hasKana = /[\u3040-\u30ff]/.test(t)   // 假名 = 日文
  const hasHan = /[\u4e00-\u9fff]/.test(t)    // 汉字 = 中文（日文汉字不算，已被假名覆盖）
  const hasLatin = /[a-zA-Z]{3,}/.test(t)     // 连续拉丁字母 = 英文词
  if (lang === 'ja') return !hasKana
  if (lang === 'zh') return hasKana || (!hasHan && hasLatin)
  if (lang === 'en') return hasKana || hasHan
  return false
}

/** 字幕翻译（参考独立翻译 independent_translation）：台词翻成显示语言，只返回译文 */
async function translateLine (c, text, targetName) {
  try {
    const res = await llm.chatStream({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: [
        { role: 'system', content: '你是翻译引擎。把用户给的台词翻译成目标语言。只输出译文本身，不要任何解释、引号、注音或额外内容。保留台词的语气和称呼。' },
        { role: 'user', content: '翻译成' + targetName + '：\n' + String(text).slice(0, 1500) }
      ],
      temperature: 0.3
    })
    return String(res.content || '').trim()
  } catch (err) {
    log('[companion] 字幕翻译失败（显示原文）:', err.message)
    return ''
  }
}

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
  // 一轮流式生成。语言守卫纠正时会用新 seq 再跑一轮（渲染层按 seq 重置气泡）
  const runStream = (msgs, s) => {
    let acc = ''
    return llm.chatStream({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: msgs, temperature: c.temperature != null ? c.temperature : 0.8,
      tools: toolDefs, signal: ctrl.signal,
      toolExec: (name, args) => {
        if (['remember', 'forget', 'recall_memory'].includes(name)) return memory.execTool(char.id, name, args)
        return tools.exec(name, args)
      },
      onDelta: (t) => { acc += t; send('companion:delta', { seq: s, text: t }); bcast('companion:delta', { seq: s, text: t }) }
    }).then((res) => ({ res, content: res.content || acc }))
  }
  let full = ''
  let toolResults = null
  try {
    const r = await runStream(messages, seq)
    full = r.content
    toolResults = r.res.toolResults
    // 语言守卫：固定回复语言但输出明显错语 → 追加一条定向纠正，重生成一次（对齐参考 dialogue_language_guard）
    const langName = { zh: '中文', en: '英文', ja: '日文' }[c.replyLang] || ''
    if (langName && full && langMismatch(full, c.replyLang)) {
      log('[companion] 语言守卫触发：回复语言不符（设为' + langName + '），定向纠正一次')
      const r2 = await runStream([
        ...messages,
        { role: 'assistant', content: full },
        { role: 'user', content: '【系统纠正·最高优先级】你上一条回复的语言不符合要求。请把同样的内容【只】用' + langName + '重新输出一遍：只输出纠正后的回复正文，不要任何解释，不要夹杂任何其它语言。' }
      ], seq + 1)
      if (r2.content && !langMismatch(r2.content, c.replyLang)) full = r2.content
    }
    history.push({ role: 'assistant', content: full, at: Date.now() })
    memory.extractFacts(char.id, userText)
    // 台词（full，按回复语言=配音语言生成）与字幕（display，翻译后的显示文本）分流：
    // TTS 朗读台词原文，气泡/聊天窗显示字幕 —— 例：台词=日语 + 字幕=中文 → 说日语显示中文
    let display = full
    let audio = null
    const jobs = []
    if (c.ttsMode === 'api' && full) {
      jobs.push(tts.speak({
        provider: c.ttsProvider || 'openai',
        // Fish 必须用自己的端点/Key——回退到 LLM 的 apiBaseUrl 会把请求发到 DeepSeek 等非 Fish 服务
        baseUrl: c.ttsProvider === 'fish' ? (c.fishBaseUrl || 'https://api.fish.audio/v1/tts') : (c.ttsBaseUrl || c.apiBaseUrl),
        apiKey: c.ttsProvider === 'fish' ? (c.fishApiKey || c.ttsApiKey || c.apiKey) : (c.ttsApiKey || c.apiKey),
        model: c.ttsModel || 'tts-1', voice: c.ttsVoice || (char.voice && char.voice.apiVoice) || 'alloy',
        refAudio: c.ttsRefAudio, textLang: c.ttsTextLang, promptText: c.ttsPromptText, promptLang: c.ttsPromptLang,
        fishModel: c.fishModel, voiceId: c.fishVoiceId, asmrVoiceId: c.fishAsmrVoiceId,
        format: c.fishFormat, latency: c.fishLatency, feeling: c.fishFeeling, tagDensity: c.fishTagDensity,
        speed: c.ttsSpeed || 1, text: full
      }).then((a) => { audio = a }).catch((err) => {
        log('[companion] TTS 失败，回退浏览器:', err.message)
      }))
    }
    const subLang = c.subLang || 'off'
    const subName = { zh: '中文', en: '英文', ja: '日文' }[subLang] || ''
    // 台词本来就是字幕语言时不浪费一次翻译调用
    if (subName && full && !(c.replyLang !== 'auto' && c.replyLang === subLang) && langMismatch(full, subLang)) {
      jobs.push(translateLine(c, full, subName).then((s) => { if (s) display = s }))
    }
    if (jobs.length) await Promise.all(jobs)
    // 历史条目带上字幕：回看时台词+译文都看得到
    if (display && display !== full) history[history.length - 1].sub = display
    character.saveHistory(char.id, history)
    send('companion:done', { seq, content: display, raw: full, tools: toolResults, audio })
    bcast('companion:done', { seq, content: display, raw: full, audio })
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? '（已停止生成）' : String(err && err.message)
    if (full) {
      history.push({ role: 'assistant', content: full + msg, at: Date.now() })
      character.saveHistory(char.id, history)
    }
    send('companion:error', { seq, message: msg, partial: full })
    bcast('companion:error', { seq, message: msg, partial: full })
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
    petScale: c.petScale != null ? c.petScale : 1,
    replyLang: c.replyLang || 'zh',
    subLang: c.subLang || 'off',
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
    fishFeeling: c.fishFeeling || 0, fishTagDensity: c.fishTagDensity || 0,
    asrBaseUrl: c.asrBaseUrl || '', asrModel: c.asrModel || 'whisper-1', asrLang: c.asrLang || 'auto', asrApiKey: c.asrApiKey || ''
  }
}

function registerIpc () {
  // 语音请求代理：启动时按配置初始化（空=跟随系统，direct=强制直连，其它=自定义规则）
  try { require('./tts').setTtsProxy(cfg().netProxy) } catch (err) { log('[companion] 初始化 TTS 代理失败:', err.message) }
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
    // 角色大小实时生效：广播给 overlay 重新按比例布置舞台
    if (patch.petScale != null) bcast('pet:config', { scale: patch.petScale })
    // 回复语言实时生效：overlay 触摸语音短语跟着切语种
    if (patch.replyLang != null) bcast('pet:config', { replyLang: patch.replyLang })
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

  /* ---------------- 备份：设置（含 API Key）+ 角色卡 + 历史 + 记忆，全部本地文件 ---------------- */

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
        title: '导出 AuraDesk 全部设置（含 API Key，请妥善保管）',
        defaultPath: 'AuraDesk-backup-' + new Date().toISOString().slice(0, 10) + '.json',
        filters: [{ name: 'AuraDesk 备份', extensions: ['json'] }]
      })
      if (r.canceled || !r.filePath) return { ok: false, message: '' }
      const characters = readCompanionJson('characters.json', [])
      const backup = {
        app: 'AuraDesk', kind: 'full-backup', exportedAt: new Date().toISOString(),
        config: store.get(),
        characters,
        histories: {}, memories: {}
      }
      for (const ch of characters) {
        backup.histories[ch.id] = readCompanionJson(ch.id + '/history.json', [])
        backup.memories[ch.id] = readCompanionJson(ch.id + '/memory.json', {})
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
      // 2) 角色卡 / 历史 / 记忆
      if (Array.isArray(backup.characters)) {
        writeCompanionJson('characters.json', backup.characters)
        for (const ch of backup.characters) {
          if (backup.histories && backup.histories[ch.id]) writeCompanionJson(ch.id + '/history.json', backup.histories[ch.id])
          if (backup.memories && backup.memories[ch.id]) writeCompanionJson(ch.id + '/memory.json', backup.memories[ch.id])
        }
      }
      log('[companion] 备份已导入:', r.filePaths[0])
      // 3) 重启应用让桌面层/伴侣全部按新配置初始化（最干净）
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
      return { ok: true, voices: await tts.listFishVoices(c.fishApiKey || c.ttsApiKey || c.apiKey) }
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
  ipcMain.handle('companion:tts', async (_e, text) => {
    const c = cfg()
    // lang 随语音结果带回：overlay 触摸反应的短语/系统兜底语种跟回复语言设置走
    if (c.ttsMode !== 'api') {
      return { ok: false, message: '请先把上方「语音合成」切换为「API / 本地引擎」，再试听', lang: c.replyLang || 'zh' }
    }
    try {
      const r = await tts.speak({
        provider: c.ttsProvider || 'openai',
        baseUrl: c.ttsProvider === 'fish' ? (c.fishBaseUrl || 'https://api.fish.audio/v1/tts') : (c.ttsBaseUrl || c.apiBaseUrl),
        apiKey: c.ttsProvider === 'fish' ? (c.fishApiKey || c.ttsApiKey || c.apiKey) : (c.ttsApiKey || c.apiKey),
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
  if (genAbort) genAbort.abort()
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
