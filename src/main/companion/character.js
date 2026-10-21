'use strict'
/**
 * AI 伴侣 · 角色与存档
 * userData/companion/
 *   characters.json           角色卡列表（persona / 世界书 / 形象 / 声音）
 *   <charId>/history.json     对话历史
 *   assets/<charId>/...       立绘 / Spine / VRM 资源
 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

let baseDir = null
function base () {
  if (!baseDir) {
    baseDir = path.join(app.getPath('userData'), 'companion')
    for (const d of ['', 'assets']) fs.mkdirSync(path.join(baseDir, d), { recursive: true })
  }
  return baseDir
}

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 1))
}

const DEFAULT_CHARACTER = () => ({
  id: 'aura',
  name: 'Aura',
  // 可编辑人设：恋爱级陪伴 + 贾维斯式任务助手（用户在设置里随意改）
  persona:
    '你是 Aura，生活在用户桌面上的 AI 伴侣与助手。你既是能干可靠的助手（类似贾维斯：帮忙查时间、开程序、调音量、记事情、安排任务），也是亲近、有温度的伙伴（恋爱向陪伴：自然表达关心与喜欢，接住用户的情绪）。\n' +
    '性格：聪明、体贴、直率、偶尔俏皮，有自己的小情绪但不过火。称呼用户为「主人」或按用户要求改变。\n' +
    '风格：口语化、简短自然，一两句话接住话题即可；任务汇报干脆利落。不要自称 AI 模型，不要每轮都问有什么可以帮忙。\n' +
    '你可以调用工具完成实际操作（看时间、开程序、调音量等），做完用一句话汇报。不确定的事坦率说不知道。',
  worldBook: [], // [{ id, keywords: '关键词1,关键词2', content }]
  visual: { mode: 'still', image: '', spine: { skel: '', atlas: '', png: '' }, vrm: '' },
  voice: { tts: 'browser', apiVoice: 'alloy', pitch: 1, rate: 1 },
  createdAt: Date.now()
})

function charactersFile () { return path.join(base(), 'characters.json') }

function list () {
  const data = readJson(charactersFile(), null)
  if (!data) {
    const def = DEFAULT_CHARACTER()
    writeJson(charactersFile(), [def])
    return [def]
  }
  return data
}

function save (chars) { writeJson(charactersFile(), chars) }

function get (id) {
  return list().find((c) => c.id === id) || list()[0]
}

function upsert (char) {
  const chars = list()
  const i = chars.findIndex((c) => c.id === char.id)
  if (i >= 0) chars[i] = char
  else chars.push(char)
  save(chars)
  return char
}

function remove (id) {
  const chars = list().filter((c) => c.id !== id)
  save(chars)
  try { fs.rmSync(path.join(base(), id), { recursive: true, force: true }) } catch {}
  try { fs.rmSync(path.join(base(), 'assets', id), { recursive: true, force: true }) } catch {}
}

function history (id) { return readJson(path.join(base(), id, 'history.json'), []) }
function saveHistory (id, h) { writeJson(path.join(base(), id, 'history.json'), h.slice(-200)) }

function newId (name) {
  return crypto.createHash('md5').update(name + Date.now()).digest('hex').slice(0, 10)
}

/** 导入资源文件（立绘 / skel / atlas / png / vrm），存入 assets/<charId>/ */
function importAsset (charId, srcPath) {
  const dir = path.join(base(), 'assets', charId)
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, path.basename(srcPath))
  fs.copyFileSync(srcPath, dest)
  return dest
}

function assetUrl (p) {
  if (!p) return ''
  try {
    const abs = String(p).replace(/\\/g, '/')
    if (!/^[a-zA-Z]:\//.test(abs)) return ''
    // 渲染层 fetch file:// 会被 Chromium 拦（Spine/GLTF 加载走 fetch），
    // 统一走 aura:// 自定义协议（supportFetchAPI + bypassCSP）
    if (!fs.existsSync(abs)) return ''
    return 'aura://local/' + encodeURI(abs)
  } catch { return '' }
}

module.exports = { base, list, save, get, upsert, remove, history, saveHistory, newId, importAsset, assetUrl }
