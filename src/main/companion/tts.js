'use strict'
/**
 * AI 伴侣 · TTS
 * provider=openai：OpenAI 兼容 /v1/audio/speech —— OpenAI、本地 fish-speech /
 *   IndexTTS 的 OpenAI 兼容服务都能接。合成 mp3 存临时文件，渲染层播放。
 * provider=fish：Fish Audio 官方 /v1/tts（https://api.fish.audio/v1/tts），
 *   支持 voice model reference_id、模型选择（s2.1-pro-free 等）、WAV/MP3、
 *   延迟策略、Drama 3 情绪标签增强（感情程度 / 句内演出密度）、ASMR 音色。
 * provider=gptsovits：GPT-SoVITS api_v2（http://127.0.0.1:9880/tts），
 *   本地运行零费用，可带参考音频克隆音色，返回 wav。
 * browser 模式：渲染层 speechSynthesis（Windows 自带中文语音，零配置）。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, net, session } = require('electron')
const { log } = require('../logger')

/* 语音请求走独立 session：系统代理可能是「API 中转网关」，会接管 api.fish.audio
   并替换 Authorization（实测 Fish 收到的 key 与发送的不一致 → 401）。
   独立 session 可配置：跟随系统 / 强制直连 / 自定义代理规则。 */
let ttsSession = null
function getTtsSession () {
  if (!ttsSession) ttsSession = session.fromPartition('companion-tts-net')
  return ttsSession
}
function setTtsProxy (mode) {
  const ses = getTtsSession()
  const m = String(mode || '').trim()
  const bypass = { session: ses, bypassList: ['localhost', '127.0.0.1', '<local>'] }
  if (!m || m === 'system') return ses.setProxy({ mode: 'system', ...bypass })
  if (m === 'direct') return ses.setProxy({ mode: 'direct', ...bypass })
  return ses.setProxy({ proxyRules: m, ...bypass })
}
/** 主进程 net.fetch + 专用 session（不走系统默认代理链路） */
async function nfetch (url, opts = {}) {
  return net.fetch(url, { ...opts, session: getTtsSession() })
}

let dir = null
function tmpDir () {
  if (!dir) {
    dir = path.join(app.getPath('userData'), 'companion', 'tts')
    fs.mkdirSync(dir, { recursive: true })
    // 清理超过 50 个的旧音频
    try {
      const files = fs.readdirSync(dir).map((f) => ({
        f, t: fs.statSync(path.join(dir, f)).mtimeMs
      })).sort((a, b) => b.t - a.t)
      files.slice(50).forEach((x) => fs.rmSync(path.join(dir, x.f), { force: true }))
    } catch {}
  }
  return dir
}

/** 合成语音，返回 { ok, url } 或 { ok:false }（渲染层回退 browser TTS） */
async function speak (opts) {
  if (opts.provider === 'fish') return speakFish(opts)
  return opts.provider === 'gptsovits' ? speakGptSovits(opts) : speakOpenAI(opts)
}

async function writeAudio (buf, ext, key) {
  if (buf.length < 512) throw new Error('TTS 返回内容过短')
  const file = path.join(tmpDir(), crypto.createHash('md5').update(key + Date.now()).digest('hex').slice(0, 12) + ext)
  fs.writeFileSync(file, buf)
  log('[companion-tts] 合成', buf.length, 'bytes', ext)
  return { url: require('node:url').pathToFileURL(file).href }
}

async function speakOpenAI ({ baseUrl, apiKey, model = 'tts-1', voice = 'alloy', speed = 1, text }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const url = /\/audio\/speech$/.test(base) ? base : base + '/audio/speech'
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey
  const res = await nfetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ model, voice, input: String(text).slice(0, 1000), speed, response_format: 'mp3' })
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error('TTS ' + res.status + ': ' + t.slice(0, 200))
  }
  return writeAudio(Buffer.from(await res.arrayBuffer()), '.mp3', text)
}

/**
 * Fish Audio 官方 TTS（照抄参考应用的配置面板）：
 * POST https://api.fish.audio/v1/tts
 *   { text, reference_id, format: wav|mp3, chunk_length, normalize, latency, model }
 * 感情程度 → temperature 映射（参考 tts_emotion_intensity：0.55~0.90）；
 * 句内情绪演出密度 → Drama 3 标签增强（<emphasis>/<soft>… + [情绪] 提示）。
 * 文本含 [asmr]/[耳语] 提示时改用 ASMR 音色 reference_id，并开 normalize_loudness。
 * 语速 Fish API 不支持 → 返回 { url, speed } 由渲染层 playbackRate 实现。
 */
async function speakFish (opts) {
  const {
    baseUrl, apiKey, fishModel, voiceId = '', asmrVoiceId = '',
    format = 'wav', latency = 'normal', text, speed = 1,
    feeling = 0, tagDensity = 0
  } = opts
  // 只认 fishModel（设置页 Fish 区块填的 s2.1-pro-free 等）；
  // 绝不能读通用 model 字段——调用方会传 OpenAI 的 'tts-1'，Fish 不认识导致 401
  const model = String(fishModel || 's2.1-pro-free')
  if (!apiKey) throw new Error('Fish Audio 需要填 API Key')
  if (!voiceId) throw new Error('Fish Audio 需要填 Voice model ID / reference_id')
  // key 指纹诊断（不落盘完整 key）：确认实际发送的 key 与用户填写的一致
  log('[companion-tts] fish key 长度=' + String(apiKey).length + ' 尾4位=…' + String(apiKey).slice(-4),
    '模型=' + model, 'voiceId 尾4位=…' + String(voiceId).slice(-4))
  const url = String(baseUrl || 'https://api.fish.audio/v1/tts').replace(/\/+$/, '')
  const endpoint = /\/tts$/.test(url) ? url : url + '/tts'
  // 文本清洗（参考 tts_text_normalizer）：LLM 输出里的标点/省略号怪癖直接进 TTS 会被读得很怪
  const cleaned = normalizeFishText(String(text).slice(0, 1200))
  const enhanced = enhanceFishText(cleaned, Number(feeling) || 0, Number(tagDensity) || 0)
  // 文本带 ASMR / 耳语提示且配置了 ASMR 音色 → 换音色 + 开响度均衡（参考 normalize_loudness）
  const useAsmr = /\[asmr\]|\[耳语\]/i.test(enhanced) && asmrVoiceId
  // 感情程度 0~100 → Fish temperature 0.55~0.90（参考 TtsEmotionIntensity 五档的连续版）
  const feeling01 = Math.max(0, Math.min(100, Number(feeling) || 0)) / 100
  const temperature = Number((0.55 + feeling01 * 0.35).toFixed(2))
  const body = {
    text: enhanced,
    reference_id: useAsmr ? asmrVoiceId : voiceId,
    format: format === 'mp3' ? 'mp3' : 'wav',
    chunk_length: 250,
    normalize: true,
    temperature,
    normalize_loudness: !!useAsmr,
    latency: latency === 'balanced' ? 'balanced' : 'normal'
  }
  // 关键：Fish Audio 的模型选择是 HTTP 请求头（不是 body 字段）——放 body 会被忽略，
  // 请求按默认付费模型计费 → 402「Insufficient API credit」；
  // 放 header 才能让 s2.1-pro-free 免费模型生效（参考项目实测 $0.00 调用）
  const res = await nfetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, model: String(model || 's2.1-pro-free') },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    // 完整落盘 Fish 的原始响应（含 request_id）+ 实际请求端点：区分「请求没到达官方」vs「官方拒绝」
    log('[companion-tts] Fish 非 2xx:', res.status, '端点=' + endpoint, '响应体=' + t.slice(0, 400))
    let msg = t.slice(0, 200)
    try {
      const j = JSON.parse(t)
      if (res.status === 402 || /insufficient/i.test(t)) {
        msg = 'Fish API 余额不足——API 额度与网页平台积分独立计费，请到 https://fish.audio/app/developers 查看或充值'
      } else if (res.status === 401) {
        msg = 'API Key 无效——请到 fish.audio 的 API Keys 页面重新复制完整 key'
      } else if (j.message) msg = j.message
    } catch {}
    throw new Error('Fish Audio ' + res.status + ': ' + msg)
  }
  const r = await writeAudio(Buffer.from(await res.arrayBuffer()), body.format === 'mp3' ? '.mp3' : '.wav', text)
  return { ...r, speed: Math.max(0.5, Math.min(2, Number(speed) || 1)) }
}

/**
 * TTS 文本清洗（参考 tts_text_normalizer 简化版）：LLM 输出的标点怪癖会严重影响朗读观感。
 * - 压缩重复标点（！！！→！！、？？？→？？、！！！？→！！？）
 * - 修省略号（。。。/..→…；省略号后的つ/っ误读交给模型 normalize）
 * - 连续演出标签去重、[停顿] 标签设上限（每 80 字最多 3 个，参考暂停上限）
 */
function normalizeFishText (text) {
  let t = String(text || '').trim()
  if (!t) return t
  // 省略号归一
  t = t.replace(/。{2,}|．{2,}|\.{3,}|…{2,}/g, '……')
  // 压缩重复句尾标点：同种标点最多连用 2 个
  t = t.replace(/([！!?？～~])\1{2,}/g, '$1$1')
  // 逗号/顿号最多连用 1 个
  t = t.replace(/([，,、])\1+/g, '$1')
  // 连续演出/暂停标签去重（如 [停顿][停顿] / <soft><soft>）
  t = t.replace(/(\[(?:停顿|pause|呼吸|breath)\]\s*){2,}/gi, '$1')
  t = t.replace(/(<(?:soft|emphasis|whisper)>)(\s*\1)+/gi, '$1')
  // [停顿] 上限：每 80 字最多 3 个，超出部分删掉
  let pauseCount = 0
  t = t.replace(/\[停顿\]/g, () => {
    pauseCount++
    return pauseCount <= Math.max(3, Math.floor(t.length / 80) * 3) ? '[停顿]' : '，'
  })
  return t
}

/**
 * Drama 3 情绪标签增强（参考 AgentAtelierR fish_drama3_tags 的思路简化版）：
 * - 感情程度 feeling (0~100)：越高越倾向给整句加强调/轻语类包裹
 * - 句内演出密度 tagDensity (0~100)：控制对感叹/疑问/停顿句插 <emphasis>、[停顿] 等的频率
 * 不改变文本语义，只加 Fish Drama 3 认识的控制标签。
 */
function enhanceFishText (text, feeling, density) {
  let t = String(text || '').trim()
  if (!t || (feeling <= 0 && density <= 0)) return t
  const sentences = t.split(/(?<=[。！？!?；;\n])/).filter(Boolean)
  const f = Math.max(0, Math.min(100, feeling)) / 100
  const d = Math.max(0, Math.min(100, density)) / 100
  const out = sentences.map((s, i) => {
    let piece = s
    if (density > 0 && d > 0 && i % Math.max(1, Math.round(1 / Math.max(0.15, d))) === 0) {
      // 按密度挑句子插演出标签：感叹→<emphasis>，问句→轻柔提示，长句→停顿
      if (/[！!]/.test(s)) piece = '<emphasis>' + piece + '</emphasis>'
      else if (/[？?]/.test(s) && d > 0.4) piece = '<soft>' + piece + '</soft>'
      else if (piece.length > 18 && d > 0.6) piece = piece.replace(/，/, '，[停顿]，')
    }
    return piece
  })
  t = out.join('')
  if (feeling > 0 && f > 0.55) t = '[充满感情]' + t
  else if (feeling > 0 && f > 0.25) t = '[温柔]' + t
  return t
}

/** GPT-SoVITS api_v2：POST /tts，JSON 参数，返回 wav 音频流 */async function speakGptSovits ({ baseUrl, text, refAudio, textLang, promptText, promptLang, speed = 1 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const url = /\/tts$/.test(base) ? base : base + '/tts'
  const body = {
    text: String(text).slice(0, 1000),
    text_lang: textLang || 'zh',
    ref_audio_path: String(refAudio || ''),
    prompt_text: String(promptText || ''),
    prompt_lang: promptLang || 'zh',
    speed_factor: Math.max(0.6, Math.min(1.65, Number(speed) || 1)),
    media_type: 'wav',
    streaming: false
  }
  if (!body.ref_audio_path) throw new Error('GPT-SoVITS 需要参考音频路径（设置里填 ref_audio_path）')
  const res = await nfetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error('GPT-SoVITS ' + res.status + ': ' + t.slice(0, 200))
  }
  return writeAudio(Buffer.from(await res.arrayBuffer()), '.wav', text)
}

/** Fish Audio 我的声音库（设置页「获取我的声音列表」用）：GET /model?self=true */
async function listFishVoices (apiKey) {
  if (!apiKey) throw new Error('需要先填 Fish Audio API Key')
  const res = await nfetch('https://api.fish.audio/model?self=true&page_size=100', {
    headers: { Authorization: 'Bearer ' + apiKey }
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error('Fish Audio ' + res.status + ': ' + t.slice(0, 200))
  }
  const j = await res.json()
  const items = Array.isArray(j.items) ? j.items : (Array.isArray(j) ? j : [])
  return items.map((m) => ({ id: m._id || m.id, title: m.title || '未命名声音' })).filter((x) => x.id)
}

module.exports = { speak, enhanceFishText, listFishVoices }
