'use strict'
/**
 * AI 伴侣 · TTS
 * api 模式：OpenAI 兼容 /v1/audio/speech（Fish Audio/OpenAI/本地 GPT-SoVITS 网关等
 * 凡是实现该端点的都行），合成 mp3 存临时文件，渲染层 file:// 播放。
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
async function speak ({ baseUrl, apiKey, model = 'tts-1', voice = 'alloy', speed = 1, text }) {
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
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 512) throw new Error('TTS 返回内容过短')
  const file = path.join(tmpDir(), crypto.createHash('md5').update(text + Date.now()).digest('hex').slice(0, 12) + '.mp3')
  fs.writeFileSync(file, buf)
  log('[companion-tts] 合成', buf.length, 'bytes')
  return { url: require('node:url').pathToFileURL(file).href }
}

module.exports = { speak }
