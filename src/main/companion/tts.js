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
const { app } = require('electron')
const { log } = require('../logger')

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
  const res = await fetch(url, {
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
 * 感情程度 / 句内情绪演出密度 → Drama 3 标签增强（<emphasis>/<soft>… + [情绪] 提示）。
 * 文本含 [asmr]/[耳语] 提示时改用 ASMR 音色 reference_id。
 * 语速 Fish API 不支持 → 返回 { url, speed } 由渲染层 playbackRate 实现。
 */
async function speakFish (opts) {
  const {
    baseUrl, apiKey, model = 's2.1-pro-free', voiceId = '', asmrVoiceId = '',
    format = 'wav', latency = 'normal', text, speed = 1,
    feeling = 0, tagDensity = 0
  } = opts
  if (!apiKey) throw new Error('Fish Audio 需要填 API Key')
  if (!voiceId) throw new Error('Fish Audio 需要填 Voice model ID / reference_id')
  const url = String(baseUrl || 'https://api.fish.audio/v1/tts').replace(/\/+$/, '')
  const endpoint = /\/tts$/.test(url) ? url : url + '/tts'
  const enhanced = enhanceFishText(String(text).slice(0, 1200), Number(feeling) || 0, Number(tagDensity) || 0)
  // 文本带 ASMR / 耳语提示且配置了 ASMR 音色 → 换音色
  const useAsmr = /\[asmr\]|\[耳语\]/i.test(enhanced) && asmrVoiceId
  const body = {
    text: enhanced,
    reference_id: useAsmr ? asmrVoiceId : voiceId,
    format: format === 'mp3' ? 'mp3' : 'wav',
    chunk_length: 250,
    normalize: true,
    latency: latency === 'balanced' ? 'balanced' : 'normal',
    model: String(model || 's2.1-pro-free')
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error('Fish Audio ' + res.status + ': ' + t.slice(0, 200))
  }
  const r = await writeAudio(Buffer.from(await res.arrayBuffer()), body.format === 'mp3' ? '.mp3' : '.wav', text)
  return { ...r, speed: Math.max(0.5, Math.min(2, Number(speed) || 1)) }
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
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error('GPT-SoVITS ' + res.status + ': ' + t.slice(0, 200))
  }
  return writeAudio(Buffer.from(await res.arrayBuffer()), '.wav', text)
}

module.exports = { speak, enhanceFishText }
