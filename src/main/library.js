'use strict'
/**
 * 资源扫描：本地 exe / 文件夹 → 游戏卡片；音乐文件夹 → 曲目 + 内嵌封面 + 同名 .lrc 歌词。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app } = require('electron')

let mm = null
try {
  mm = require('music-metadata')
} catch (err) {
  console.warn('[library] music-metadata 不可用，退化为文件名解析')
}

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.wma'])
const SKIP_DIR = new Set(['node_modules', '$recycle.bin', 'system volume information', 'windows', 'winsxs', 'cache', 'temp'])
const EXE_BLACKLIST = /^(unins|setup|install|update|crash|vc_?redist|dxsetup|dotnet|python|node|7z|ffmpeg|launcher_?helper)/i

function cacheDir () {
  const dir = path.join(app.getPath('userData'), 'cache')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function newId (prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex')
}

function walk (dir, depth, out, filter) {
  if (depth < 0) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name.toLowerCase())) continue
      if (entry.name.startsWith('.')) continue
      walk(full, depth - 1, out, filter)
    } else if (entry.isFile() && filter(entry.name)) {
      out.push(full)
    }
  }
}

/** 从一个目录里猜游戏主程序：优先名字含 game/launcher 且体积最大的 exe */
function scanGamesInFolder (dir) {
  const files = []
  walk(dir, 2, files, (name) => name.toLowerCase().endsWith('.exe') && !EXE_BLACKLIST.test(name))
  const scored = files.map((file) => {
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {}
    const base = path.basename(file).toLowerCase()
    let score = size
    if (/launcher|game|start|play/.test(base)) score *= 1.6
    return { file, size, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 5).map((s) => ({
    id: newId('g'),
    name: path.basename(path.dirname(s.file)) || path.basename(s.file, '.exe'),
    kind: 'exe',
    target: s.file,
    cover: '',
    hue: Math.floor(Math.random() * 360)
  }))
}

function gameFromExe (file) {
  return {
    id: newId('g'),
    name: path.basename(file, path.extname(file)),
    kind: 'exe',
    target: file,
    cover: '',
    hue: Math.floor(Math.random() * 360)
  }
}

/** 内嵌封面写到缓存目录，返回绝对路径 */
function writeCover (buf, key) {
  const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 12)
  const out = path.join(cacheDir(), hash + '.jpg')
  if (!fs.existsSync(out)) {
    try {
      fs.writeFileSync(out, buf)
    } catch {
      return ''
    }
  }
  return out
}

async function readTrack (file) {
  const base = path.basename(file, path.extname(file))
  const track = { id: newId('t'), path: file, title: base, artist: '', album: '', duration: 0, cover: '', lyrics: '' }
  if (mm) {
    try {
      const meta = await mm.parseFile(file, { duration: true })
      const c = meta.common || {}
      if (c.title) track.title = c.title
      if (c.artist) track.artist = c.artist
      if (c.album) track.album = c.album
      track.duration = Math.round(meta.format?.duration || 0)
      const pic = (c.picture && c.picture[0]) || null
      if (pic && pic.data) track.cover = writeCover(Buffer.from(pic.data), file + ':' + pic.data.length)
    } catch {
      /* 元数据坏了就用文件名 */
    }
  }
  const lrcPath = file.replace(/\.[^.]+$/, '.lrc')
  if (fs.existsSync(lrcPath)) {
    try {
      track.lyrics = fs.readFileSync(lrcPath, 'utf8')
    } catch {}
  }
  return track
}

async function scanMusic (folders, onProgress) {
  const files = []
  for (const folder of folders) {
    walk(folder, 3, files, (name) => AUDIO_EXT.has(path.extname(name).toLowerCase()))
  }
  const list = [...new Set(files)].slice(0, 500)
  const tracks = []
  for (let i = 0; i < list.length; i++) {
    const t = await readTrack(list[i])
    tracks.push(t)
    if (onProgress && (i % 5 === 0 || i === list.length - 1)) {
      onProgress({ done: i + 1, total: list.length, title: t.title })
    }
  }
  tracks.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  return tracks
}

/** 解析 LRC → [{t, text}]，兼容 [mm:ss.xx] 与多时间标签 */
function parseLrc (text) {
  if (!text) return []
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (!stamps.length) continue
    const content = raw.replace(/\[[^\]]*\]/g, '').trim()
    if (!content) continue
    for (const s of stamps) {
      const ms = s[3] ? Number(s[3].padEnd(3, '0')) : 0
      lines.push({ t: Number(s[1]) * 60 + Number(s[2]) + ms / 1000, text: content })
    }
  }
  return lines.sort((a, b) => a.t - b.t)
}

module.exports = { scanGamesInFolder, gameFromExe, scanMusic, parseLrc, newId }
