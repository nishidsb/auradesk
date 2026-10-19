'use strict'
/**
 * Steam 库扫描：定位安装目录 → 解析 libraryfolders.vdf → 读 appmanifest_*.acf
 * 封面走 Steam 官方 CDN 的竖版库封面（600×900，正好是我们卡片的 2:3）
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { cacheDir, download, pmap, hueOf } = require('../util')

const JUNK = /(redistributable|steamworks|proton|steam linux runtime|steamvr|soundtrack|dedicated server|sdk$|^steam$)/i

function regGet (key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true })
    const m = out.match(new RegExp(value + '\\s+REG_SZ\\s+(.+)'))
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

function findRoots () {
  const cands = [
    regGet('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    regGet('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    regGet('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam',
    'D:\\SteamLibrary',
    'E:\\Steam',
    'E:\\SteamLibrary'
  ].filter(Boolean)

  // 注册表读不到时（某些环境 reg.exe 不可用）按盘符兜一圈
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'
  for (const ch of letters) {
    for (const sub of ['\\Steam', '\\SteamLibrary', '\\Games\\Steam', '\\Program Files (x86)\\Steam']) {
      cands.push(ch + ':' + sub)
    }
  }

  const seen = new Set()
  const roots = []
  for (const c of cands) {
    const p = c.replace(/\//g, '\\').replace(/\\+$/, '')
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (fs.existsSync(path.join(p, 'steamapps'))) roots.push(p)
  }
  return roots
}

function libraryPaths (root) {
  const files = [
    path.join(root, 'steamapps', 'libraryfolders.vdf'),
    path.join(root, 'config', 'libraryfolders.vdf')
  ]
  const out = new Map() // lower -> 原始路径，避免 E:\Steam 与 E:\steam 重复
  const add = (p) => {
    const clean = p.replace(/\\+$/, '')
    const key = clean.toLowerCase()
    if (!out.has(key)) out.set(key, clean)
  }
  add(root)
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      add(m[1].replace(/\\\\/g, '\\'))
    }
    // 老版本格式： "1"  "D:\\Games"
    for (const m of text.matchAll(/"\d+"\s+"([A-Za-z]:[^"]*)"/g)) {
      add(m[1].replace(/\\\\/g, '\\'))
    }
  }
  return [...out.values()].filter((p) => fs.existsSync(path.join(p, 'steamapps')))
}

function readAcf (file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const get = (k) => {
    const m = text.match(new RegExp('"' + k + '"\\s+"([^"]*)"'))
    return m ? m[1] : ''
  }
  const appid = get('appid')
  const name = get('name')
  const state = Number(get('StateFlags') || 0)
  const installdir = get('installdir')
  if (!appid || !name) return null
  if (state && !(state & 4)) return null // 4 = 已完整安装
  if (JUNK.test(name)) return null
  return { appid, name, installdir }
}

function coverUrls (appid) {
  return [
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`
  ]
}

/**
 * @returns {Promise<{games:Array, roots:string[], scanned:number}>}
 */
async function scanSteam (onProgress) {
  const roots = findRoots()
  if (!roots.length) return { games: [], roots: [], scanned: 0 }

  const libs = new Set()
  for (const r of roots) for (const l of libraryPaths(r)) libs.add(l)

  const found = new Map()
  for (const lib of libs) {
    const steamapps = path.join(lib, 'steamapps')
    let files = []
    try {
      files = fs.readdirSync(steamapps).filter((f) => /^appmanifest_\d+\.acf$/i.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      const info = readAcf(path.join(steamapps, f))
      if (info && !found.has(info.appid)) found.set(info.appid, info)
    }
  }

  const list = [...found.values()]
  const dir = cacheDir('covers')
  let done = 0

  const games = await pmap(list, 6, async (g) => {
    let cover = ''
    for (const url of coverUrls(g.appid)) {
      const dest = path.join(dir, `steam_${g.appid}.jpg`)
      cover = await download(url, dest)
      if (cover) break
    }
    done++
    if (onProgress && (done % 4 === 0 || done === list.length)) onProgress({ done, total: list.length, name: g.name })
    return {
      id: 's_' + g.appid,
      name: g.name,
      kind: 'url',
      target: 'steam://rungameid/' + g.appid,
      source: 'steam',
      appId: g.appid,
      cover,
      hue: hueOf(g.name)
    }
  })

  return { games: games.filter(Boolean), roots: [...libs], scanned: list.length }
}

module.exports = { scanSteam, findRoots, libraryPaths, readAcf }
