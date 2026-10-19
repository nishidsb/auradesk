'use strict'
/**
 * AI 伴侣 · TTS
 * provider=openai：OpenAI 兼容 /v1/audio/speech —— OpenAI、Fish Audio 云
 *   （https://api.fish.audio/v1，voice=reference_id）、本地 fish-speech /
 *   IndexTTS 的 OpenAI 兼容服务都能接。合成 mp3 存临时文件，渲染层播放。
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

/** GPT-SoVITS api_v2：POST /tts，JSON 参数，返回 wav 音频流 */
async function speakGptSovits ({ baseUrl, text, refAudio, textLang, promptText, promptLang, speed = 1 }) {
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

module.exports = { speak }
