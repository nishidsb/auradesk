'use strict'
/**
 * 封面获取，多级回退，尽量不需要用户填任何 Key：
 *   1) Epic 商店在线搜索（GraphQL，免 Key，竖版）
 *   2) Epic 启动器的目录缓存（本地，免费，竖版）
 *   3) Steam 本机安装目录反查 appid（appmanifest_*.acf）→ 官方 CDN 的 library_600x900.jpg
 *   4) Steam 商店搜索 → 官方 CDN（部分网络环境下 store.steampowered.com 不通，留作备用）
 *   5) SteamGridDB（需要免费 API Key，覆盖不在前几者里的游戏）
 */
const fs = require('node:fs')
const path = require('node:path')
const { net } = require('electron')
const { spawnSync } = require('node:child_process')
const { app } = require('electron')
const { cacheDir, download, hashName } = require('../util')

const API = 'https://www.steamgriddb.com/api/v2'
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** 本地程序的名字在 Steam/Epic 都没匹配到：记下来，几天内别再白跑（很多网络环境搜不了商店） */
let missCache = null
const MISS_TTL = 7 * 24 * 3600 * 1000
function missFile () {
  return path.join(cacheDir('covers'), '.miss.json')
}
function loadMiss () {
  if (missCache) return missCache
  missCache = {}
  try { missCache = JSON.parse(fs.readFileSync(missFile(), 'utf8')) || {} } catch {}
  return missCache
}
function missed (name) {
  const m = loadMiss()
  const ts = m[name]
  return typeof ts === 'number' && Date.now() - ts < MISS_TTL
}
function markMissed (name) {
  const m = loadMiss()
  m[name] = Date.now()
  // 顺带清理过期项，文件不至于越长越大
  for (const k of Object.keys(m)) if (Date.now() - m[k] > MISS_TTL) delete m[k]
  try { fs.writeFileSync(missFile(), JSON.stringify(m)) } catch {}
}
function clearMissed (name) {
  const m = loadMiss()
  if (name in m) {
    delete m[name]
    try { fs.writeFileSync(missFile(), JSON.stringify(m)) } catch {}
  }
}

function norm (s) {
  return String(s || '').toLowerCase().replace(/[™®©:：\-–—_·'"!,.]/g, '').replace(/\s+/g, ' ').trim()
}

async function api (url, key) {
  const res = await net.fetch(url, { headers: { Authorization: 'Bearer ' + key } })
  if (res.status === 401) throw new Error('API Key 无效')
  if (res.status === 429) throw new Error('请求过于频繁，稍后再试')
  if (!res.ok) return null
  return res.json()
}

/** 按名字查一张 600×900 竖图，返回图片直链 */
async function findGrid (name, key) {
  const search = await api(`${API}/search/autocomplete/${encodeURIComponent(name)}`, key)
  const list = (search && search.data) || []
  if (!list.length) return ''
  const exact = list.find((g) => norm(g.name) === norm(name))
  const hit = exact || list[0]
  const grids = await api(`${API}/grids/game/${hit.id}?dimensions=600x900&mimes=image/jpeg,image/png&types=static`, key)
  const arr = (grids && grids.data) || []
  return arr.length ? arr[0].url : ''
}

/* -------------------------------------------------- 免 Key 的几条路 */

/** Epic 商店在线搜索（GraphQL，免 Key）。返回封面直链 */
async function epicSearchCover (name) {
  if (!name || missed('epic:' + norm(name))) return ''
  const q = {
    query: 'query searchStoreQuery($category: String, $count: Int!, $country: String!, $keywords: String!, $locale: String!, $start: Int!) { Catalog { searchStore(category: $category, count: $count, country: $country, keywords: $keywords, locale: $locale, start: $start) { elements { title keyImages { type url } } } } }',
    variables: { category: null, count: 8, country: 'US', keywords: name, locale: 'en', start: 0 }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 7000)
  try {
    const res = await net.fetch('https://store.epicgames.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Referer: 'https://store.epicgames.com/' },
      body: JSON.stringify(q),
      signal: ctrl.signal
    })
    if (!res.ok) {
      markMissed('epic:' + norm(name))
      return ''
    }
    const j = await res.json()
    const items = ((j.data || {}).Catalog || {}).searchStore || {}
    const list = items.elements || []
    if (!list.length) {
      markMissed('epic:' + norm(name))
      return ''
    }
    // 竖版优先；标题得对得上才用，免得封面张冠李戴。
    // 精确同名优先；其次前缀匹配里取标题最短的（「Hades」别抓成「Hades + Soundtrack」）
    const want = norm(name)
    const exact = list.find((it) => norm(it.title) === want)
    let hit = exact
    if (!hit) {
      const loose = list
        .filter((it) => {
          const t = norm(it.title)
          return t && (t.startsWith(want) || want.startsWith(t)) && Math.min(t.length, want.length) >= 4
        })
        .sort((a, b) => norm(a.title).length - norm(b.title).length)
      hit = loose[0]
    }
    if (!hit) {
      markMissed('epic:' + norm(name))
      return ''
    }
    const url = pickEpicImage(hit.keyImages)
    if (!url) {
      markMissed('epic:' + norm(name))
      return ''
    }
    const file = await download(url, path.join(cacheDir('covers'), 'epic_' + hashName(want) + '.jpg'))
    if (file) clearMissed('epic:' + norm(name))
    return file
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** Epic keyImages 里挑竖版 */
function pickEpicImage (imgs) {
  const list = Array.isArray(imgs) ? imgs : []
  for (const type of ['DieselGameBoxTall', 'OfferImageTall', 'DieselGameBox', 'Thumbnail']) {
    const hit = list.find((i) => i && i.type === type && i.url)
    if (hit) return hit.url
  }
  return ''
}

/** Steam 安装目录：注册表 → 默认路径兜底 */
function steamRoot () {
  try {
    const out = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', '/v', 'InstallPath'], { encoding: 'utf8', timeout: 3000 }).stdout || ''
    const m = /REG_SZ\s+(\S.+)/.exec(out)
    if (m && fs.existsSync(m[1].trim())) return m[1].trim()
  } catch {}
  for (const p of [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam')
  ]) {
    if (fs.existsSync(p)) return p
  }
  return ''
}

let localApps = null
/** 本机 Steam 装了哪些游戏：appmanifest_*.acf 里的 appid + name */
function steamLocalApps () {
  if (localApps) return localApps
  localApps = new Map()
  const root = steamRoot()
  if (!root) return localApps
  // libraryfolders.vdf 列出所有库存目录
  const libs = [path.join(root, 'steamapps')]
  try {
    const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      const p = m[1].replace(/\\\\/g, '\\')
      const sp = path.join(p, 'steamapps')
      if (fs.existsSync(sp) && !libs.includes(sp)) libs.push(sp)
    }
  } catch {}
  for (const sp of libs) {
    let files = []
    try { files = fs.readdirSync(sp) } catch { continue }
    for (const f of files) {
      const m = /^appmanifest_(\d+)\.acf$/.exec(f)
      if (!m) continue
      try {
        const acf = fs.readFileSync(path.join(sp, f), 'utf8')
        const nm = /"name"\s+"([^"]+)"/.exec(acf)
        if (nm) localApps.set(norm(nm[1]), m[1])
      } catch {}
    }
  }
  return localApps
}

/** 在 Steam 商店里按名字找 appid（不需要 Key） */
async function steamAppId (name) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=schinese&cc=CN`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4500)
  try {
    const res = await net.fetch(url, { signal: ctrl.signal })
    if (!res.ok) return ''
    const json = await res.json()
    const items = (json.items || []).filter((i) => i && i.id)
    if (!items.length) return ''
    const exact = items.find((i) => norm(i.name) === norm(name))
    return String((exact || items[0]).id)
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** 有 appid 就直接从 Steam CDN 拉竖版封面，退横版大图 */
async function pullSteamArt (id) {
  if (!id) return ''
  const dir = cacheDir('covers')
  for (const f of ['library_600x900.jpg', 'header.jpg', 'capsule_616x353.jpg']) {
    const file = await download(`${CDN}/${id}/${f}`, path.join(dir, `st_${id}_${f}`), { timeout: 9000 })
    if (file) return file
  }
  return ''
}

/** Steam 官方 CDN 竖版封面，退横版大图 */
async function steamCover (name) {
  const id = await steamAppId(name)
  return pullSteamArt(id)
}

/** 从 steam://rungameid/12345 里取 appid */
function steamIdOf (target) {
  const m = /steam:\/\/rungameid\/(\d+)/i.exec(String(target || ''))
  return m ? m[1] : ''
}

/** Epic 目录缓存里按标题匹配（本地文件，不联网） */
function epicCover (name) {
  let map = null
  try {
    map = require('./epic').readCatalogCache()
  } catch {
    return { url: '', map: null }
  }
  const url = map.get('t:' + norm(name)) || ''
  return { url, map }
}

/**
 * 免 Key 拿一张封面：
 *   Epic 在线搜索 → Epic 本地缓存 → Steam 本机 appmanifest → Steam 商店搜索
 * @returns {Promise<string>} 落盘的绝对路径，失败返回 ''
 */
async function freeCover (name) {
  if (!name) return ''
  const key = norm(name)
  if (missed('any:' + key)) return ''
  const dir = cacheDir('covers')
  // 1) Epic 商店在线搜（多数网络可达）
  let file = await epicSearchCover(name)
  // 2) Epic 启动器目录缓存
  if (!file) {
    const { url } = epicCover(name)
    if (url) file = await download(url, path.join(dir, 'epic_' + hashName(key) + '.jpg'))
  }
  // 3) 本机 Steam 装过的游戏：appmanifest 反查 appid，直接打 CDN（CDN 基本都可达）
  if (!file) {
    const id = steamLocalApps().get(key)
    if (id) file = await pullSteamArt(id)
  }
  // 4) Steam 商店搜索（部分网络环境不通，超时很短，失败记进 miss 名单）
  if (!file) {
    const id = await steamAppId(name)
    if (id) file = await pullSteamArt(id)
  }
  if (file) {
    clearMissed('any:' + key)
  } else {
    markMissed('any:' + key)
  }
  return file
}

/**
 * 给缺封面的卡片补图（就地修改传入的 games 数组对象）
 * @param {Array} games 资源库数组（会被修改 cover 字段）
 * @param {string} key SteamGridDB API Key（可为空：只用免 Key 的两条路）
 * @param {Function} onProgress ({done,total,name,ok})
 */
async function fillMissingCovers (games, key, onProgress) {
  // 封面路径写着但文件被清掉的，也算缺封面，重新下一张
  const targets = games.filter((g) => !g.cover || !fs.existsSync(g.cover))
  const dir = cacheDir('covers')
  let done = 0
  let ok = 0

  for (const g of targets) {
    let cover = ''
    try {
      // Steam 条目本身带着 appid，直接打 CDN，比按名字搜准得多
      cover = await pullSteamArt(steamIdOf(g.target))
      if (!cover) cover = await freeCover(g.name)
      if (!cover && key) {
        const url = await findGrid(g.name, key)
        if (url) cover = await download(url, path.join(dir, 'sgdb_' + hashName(g.name + '|' + g.id) + '.jpg'))
      }
    } catch (err) {
      if (String(err.message).includes('Key')) throw err
    }
    if (cover) {
      g.cover = cover
      ok++
    }
    done++
    if (onProgress) onProgress({ done, total: targets.length, name: g.name, ok })
    await new Promise((r) => setTimeout(r, key ? 320 : 160))
  }

  return { total: targets.length, ok }
}

/**
 * 在线补一张封面（免 Key）：iTunes Search 公开接口
 * 用于 SMTC 直播歌曲拿不到内嵌缩略图时的兜底
 */
async function onlineCover (title, artist) {
  const q = [title, artist].filter(Boolean).join(' ').trim()
  if (!q) return ''
  const dir = cacheDir('covers')
  const dest = path.join(dir, 'live_' + hashName(q.toLowerCase()) + '.jpg')
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const res = await net.fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=1`,
      { signal: ctrl.signal }
    )
    clearTimeout(timer)
    if (!res.ok) return ''
    const json = await res.json()
    const item = (json.results || [])[0]
    if (!item) return ''
    const url = String(item.artworkUrl100 || item.artworkUrl60 || '').replace(/\/\d+x\d+bb\./, '/600x600bb.')
    if (!url) return ''
    return await download(url, dest)
  } catch {
    return ''
  }
}

module.exports = { fillMissingCovers, findGrid, onlineCover, freeCover, steamAppId, steamCover, pullSteamArt, steamIdOf, norm }
