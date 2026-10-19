'use strict'
/**
 * 在线歌词
 *
 * 两处需要它：
 * 1. 音源是系统媒体会话（Listen1 / 网易云 / QQ 音乐…）——SMTC 只给标题歌手，没有歌词
 * 2. 本地音乐目录里没有同名 .lrc
 *
 * 按「歌手 + 标题（+ 时长）」去网上找一份带时间轴的 LRC：
 *   先网易云（中文曲库最全）→ 不行再 lrclib（国外曲库干净、免鉴权）
 * 结果缓存到 cache/lyrics/，查不到也缓存一个空文件，免得每次切歌都去刷网络。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app } = require('electron')

const TIMEOUT = 5200
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36'

const mem = new Map() // key -> 歌词文本（可能是空串，表示确实找不到）
const pending = new Map() // key -> Promise

function cacheDir () {
  const dir = path.join(app.getPath('userData'), 'cache', 'lyrics')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

function keyOf (info) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
  // 时长取整到 5 秒，避免不同来源的毫秒误差导致缓存穿透
  const dur = Math.round(Number(info.duration || 0) / 5) * 5
  return norm(info.artist) + '|' + norm(info.title) + '|' + dur
}

function cachePath (key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex')
  return path.join(cacheDir(), hash + '.lrc')
}

function readCache (key) {
  try {
    const p = cachePath(key)
    if (!fs.existsSync(p)) return undefined
    return fs.readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

function writeCache (key, text) {
  try {
    fs.writeFileSync(cachePath(key), text || '')
  } catch {}
}

/** 带超时的 GET / POST，失败一律返回 null（歌词拿不到不算错误） */
async function req (url, opts = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT)
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ac.signal,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) }
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function json (text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 去掉 LRC 里的元信息行（[by:] [ti:] [ar:] [al:] [offset:]），只留时间轴 */
function cleanLrc (text) {
  if (!text) return ''
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*\[(ti|ar|al|by|offset|re|ve|length|kana):/i.test(raw)) continue
    if (/^\s*\[[0-9]{1,2}:[0-9]{1,2}([.:][0-9]{1,3})?\]/.test(raw)) out.push(raw.trim())
  }
  return out.join('\n')
}

/** 只有一两行、或者「暂无歌词 / 纯音乐请欣赏」这种，当作没找到 */
function useful (text) {
  if (!text) return false
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 3) return false
  if (/(暂无歌词|纯音乐|请欣赏|没有歌词)/.test(text) && lines.length < 6) return false
  return true
}

/* ------------------------------------------------------------ 网易云音乐 */

async function netease (info) {
  const q = [info.title, info.artist].filter(Boolean).join(' ').trim()
  if (!q) return ''
  const body = 's=' + encodeURIComponent(q) + '&type=1&limit=10&offset=0'
  const found = json(
    await req('https://music.163.com/api/search/get/web', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://music.163.com/',
        Cookie: 'appver=2.0.2'
      },
      body
    })
  )
  const songs = (found && found.result && found.result.songs) || []
  if (!songs.length) return ''

  // 同名歌一大堆（翻唱 / 合集 / 电台），同一个歌名往往只有其中几个版本收录了歌词，
  // 所以不能只看第一个：按时长最接近排序，取前三个并发要歌词，谁有就用谁。
  const want = Number(info.duration || 0)
  const ranked = songs
    .filter((s) => s && s.id)
    .map((s) => ({ id: s.id, d: want > 0 ? Math.abs(Number(s.duration || 0) / 1000 - want) : 0 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
  if (!ranked.length) return ''

  const texts = await Promise.all(ranked.map((r) => neteaseLyric(r.id)))
  return texts.find((t) => useful(t)) || ''
}

async function neteaseLyric (id) {
  const got = json(
    await req('https://music.163.com/api/song/lyric?os=pc&id=' + id + '&lv=-1&kv=-1&tv=-1', {
      headers: { Referer: 'https://music.163.com/' }
    })
  )
  if (!got || got.nolyric || got.uncollected || got.pureMusic) return ''
  return cleanLrc((got.lrc && got.lrc.lyric) || '')
}

/* --------------------------------------------------------------- lrclib */

async function lrclib (info) {
  const u = new URL('https://lrclib.net/api/search')
  if (info.title) u.searchParams.set('track_name', info.title)
  if (info.artist) u.searchParams.set('artist_name', info.artist)
  if (!info.title) return ''
  const list = json(await req(u.toString(), { headers: { Accept: 'application/json' } }))
  if (!Array.isArray(list) || !list.length) return ''
  const want = Number(info.duration || 0)
  let best = null
  let delta = Infinity
  for (const it of list) {
    if (!it || !it.syncedLyrics) continue
    const d = want > 0 ? Math.abs(Number(it.duration || 0) - want) : 0
    if (d < delta) {
      delta = d
      best = it
    }
  }
  if (!best) return ''
  return cleanLrc(best.syncedLyrics)
}

/* --------------------------------------------------------------- 对外 */

async function hunt (info) {
  let text = ''
  try {
    text = await netease(info)
  } catch {}
  if (!useful(text)) {
    try {
      text = await lrclib(info)
    } catch {}
  }
  return useful(text) ? text : ''
}

/**
 * 取歌词。命中内存 / 磁盘缓存直接返回，否则联网找一遍。
 * @param {{title:string, artist:string, duration:number}} info
 * @returns {Promise<string>} LRC 文本，找不到就是空串
 */
function getLyrics (info) {
  if (!info || !info.title) return Promise.resolve('')
  const key = keyOf(info)
  if (mem.has(key)) return Promise.resolve(mem.get(key))
  if (pending.has(key)) return pending.get(key)

  const p = (async () => {
    const disk = readCache(key)
    if (disk !== undefined) {
      mem.set(key, disk)
      return disk
    }
    const text = await hunt(info)
    mem.set(key, text)
    writeCache(key, text)
    return text
  })()
    .catch(() => '')
    .finally(() => pending.delete(key))

  pending.set(key, p)
  return p
}

module.exports = { getLyrics, cleanLrc, keyOf }
