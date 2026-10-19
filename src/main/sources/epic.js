'use strict'
/**
 * Epic 库扫描
 * - 已安装列表：%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item
 * - 封面：启动器自己缓存的 catcache.bin（base64 的目录 JSON），里面有
 *   DieselGameBoxTall 竖版封面直链 —— 不需要任何 API Key
 * - 启动：官方 launcher 协议，失败退安装目录里的 exe
 */
const fs = require('node:fs')
const path = require('node:path')
const { hueOf, cacheDir, download, hashName } = require('../util')

function programData () {
  return process.env.ProgramData || 'C:\\ProgramData'
}

function manifestDirs () {
  const out = [path.join(programData(), 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')]
  const localApp = process.env.LOCALAPPDATA
  if (localApp) out.push(path.join(localApp, 'EpicGamesLauncher', 'Saved', 'Manifests'))
  return out.filter((p) => fs.existsSync(p))
}

function launchUri (m) {
  const parts = [m.CatalogNamespace, m.CatalogItemId, m.AppName].filter(Boolean).map(encodeURIComponent)
  if (parts.length === 3) return `com.epicgames.launcher://apps/${parts.join('%3A')}?action=launch&silent=true`
  return ''
}

function norm (s) {
  return String(s || '').toLowerCase().replace(/[™®©:：\-–—_·'"!,.]/g, '').replace(/\s+/g, ' ').trim()
}

/** 竖版优先：DieselGameBoxTall > DieselGameBox > Thumbnail */
function pickImage (imgs) {
  const list = Array.isArray(imgs) ? imgs : []
  for (const type of ['DieselGameBoxTall', 'DieselGameBox', 'Thumbnail']) {
    const hit = list.find((i) => i && i.type === type && i.url)
    if (hit) return hit.url
  }
  return ''
}

/** 读 Epic 的目录缓存，返回 id / entitlementName / title → 封面直链 */
function readCatalogCache () {
  const file = path.join(programData(), 'Epic', 'EpicGamesLauncher', 'Data', 'Catalog', 'catcache.bin')
  const map = new Map()
  if (!fs.existsSync(file)) return map
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    const json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    const list = Array.isArray(json) ? json : Object.values(json)
    for (const e of list) {
      if (!e) continue
      const url = pickImage(e.keyImages)
      if (!url) continue
      if (e.id) map.set(String(e.id).toLowerCase(), url)
      if (e.entitlementName) map.set(String(e.entitlementName).toLowerCase(), url)
      if (e.title) map.set('t:' + norm(e.title), url)
    }
  } catch {
    /* 缓存坏了就当没有 */
  }
  return map
}

/** 把一份 .item manifest 转成卡片（纯函数，方便测试） */
function parseManifest (m, coverUrl = '') {
  if (!m || !m.DisplayName) return null
  const cats = Array.isArray(m.AppCategories) ? m.AppCategories.map((c) => String(c).toLowerCase()) : []
  if (cats.length && !cats.includes('games')) return null
  if (!m.LaunchExecutable) return null
  return {
    id: 'e_' + (m.AppName || hueOf(m.DisplayName)),
    name: m.DisplayName,
    kind: 'url',
    target: launchUri(m),
    fallbackTarget: m.InstallLocation && m.LaunchExecutable
      ? path.join(m.InstallLocation, m.LaunchExecutable)
      : '',
    source: 'epic',
    appId: m.AppName || '',
    cover: '',
    coverUrl: coverUrl || '',
    hue: hueOf(m.DisplayName)
  }
}

/**
 * @returns {Promise<{games:Array, dirs:string[], cached:number}>}
 */
async function scanEpic (onProgress) {
  const dirs = manifestDirs()
  if (!dirs.length) return { games: [], dirs: [], cached: 0 }

  const catalog = readCatalogCache()
  const seen = new Set()
  const picked = []

  for (const dir of dirs) {
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.item'))
    } catch {
      continue
    }
    for (const f of files) {
      let m = null
      try {
        m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      } catch {
        continue
      }
      if (!m) continue
      const url = catalog.get(String(m.CatalogItemId || '').toLowerCase()) ||
        catalog.get('t:' + norm(m.DisplayName)) || ''
      const g = parseManifest(m, url)
      if (!g) continue
      const dedupe = g.appId || g.name
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      picked.push(g)
    }
  }

  const cache = cacheDir('covers')
  let done = 0
  for (const g of picked) {
    if (g.coverUrl) {
      const dest = path.join(cache, 'epic_' + hashName(g.name) + '.jpg')
      const file = await download(g.coverUrl, dest)
      if (file) g.cover = file
    }
    delete g.coverUrl
    done++
    if (onProgress) onProgress({ done, total: picked.length, name: g.name })
  }

  return { games: picked, dirs, cached: catalog.size }
}

module.exports = { scanEpic, parseManifest, launchUri, readCatalogCache, pickImage }
