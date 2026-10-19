'use strict'
/**
 * 开始菜单扫描：任何在 Windows 里装过的游戏，几乎都会在开始菜单留一个
 * .lnk —— Steam / Epic 会建，GOG、Ubisoft、EA、Battle.net、Riot、独立游戏
 * 也会建。所以这条路不挑平台，比逐个对接启动器可靠得多。
 *
 * 解析用一次 PowerShell（WScript.Shell COM）批量读，200 个快捷方式大约 1 秒。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { hueOf, hashName, unpackedPath } = require('../util')

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
const SCRIPT = unpackedPath(path.join(__dirname, '..', 'resources', 'lnk-resolve.ps1'))

// 明显不是游戏的东西
const BAD_NAME = /(uninstall|卸载|readme|说明|手册|帮助|帮助文档|文档|官网|网站|website|support|客服|编辑器|editor|mod工具|server|dedicated)/i
const BAD_TARGET = /[\\/](unins\d*|setup|install|update|vc_?redist|dxsetup|dotnet|crashreport|launcher_?helper)[^\\/]*\.exe$/i

function startMenuDirs () {
  const out = []
  const push = (p) => { if (p && fs.existsSync(p)) out.push(p) }
  push(path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  if (process.env.USERPROFILE) push(path.join(process.env.USERPROFILE, 'Desktop'))
  if (process.env.PUBLIC) push(path.join(process.env.PUBLIC, 'Desktop'))
  return out
}

function walkLinks (dir, depth, out) {
  if (depth < 0 || out.length > 1200) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || /^(windows 管理工具|administrative tools)$/i.test(e.name)) continue
      walkLinks(full, depth - 1, out)
    } else if (/\.lnk$/i.test(e.name)) {
      out.push({ lnk: full, name: path.basename(e.name, '.lnk') })
    }
  }
}

/** 用 PowerShell 批量解析 .lnk 的目标程序 */
function resolveLinks (links) {
  return new Promise((resolve) => {
    if (!links.length) return resolve([])
    const tmp = path.join(os.tmpdir(), 'aura-lnk-' + Date.now() + '.txt')
    try {
      fs.writeFileSync(tmp, links.map((l) => l.lnk).join('\r\n'), 'utf8')
    } catch {
      return resolve([])
    }

    let child = null
    try {
      child = spawn('powershell.exe', [...PS_ARGS, SCRIPT, tmp], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      try { fs.unlinkSync(tmp) } catch {}
      return resolve([])
    }

    let out = ''
    let done = false
    const finish = (list) => {
      if (done) return
      done = true
      try { fs.unlinkSync(tmp) } catch {}
      resolve(list)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => { out += c })
    child.on('error', () => finish([]))
    child.on('exit', () => {
      const list = []
      for (const line of out.split(/\r?\n/)) {
        const s = line.trim()
        if (!s.startsWith('{')) continue
        try {
          const o = JSON.parse(s)
          if (o && o.ok) list.push(o)
        } catch {}
      }
      finish(list)
    })
    setTimeout(() => {
      try { child.kill() } catch {}
      finish([])
    }, 20000)
  })
}

/**
 * 扫描开始菜单 + 桌面上的快捷方式
 * @returns {Promise<Array<{id,name,target,lnk,exe,source,hue}>>}
 */
async function scanStartMenu () {
  const links = []
  for (const dir of startMenuDirs()) walkLinks(dir, 3, links)

  // 同名去重（开始菜单里各语言目录经常重复）
  const seen = new Set()
  const unique = []
  for (const l of links) {
    const k = l.name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    unique.push(l)
  }

  const resolved = await resolveLinks(unique)
  const byLnk = new Map(resolved.map((r) => [String(r.path).toLowerCase(), r]))

  const out = []
  const usedTarget = new Set()
  for (const l of unique) {
    if (BAD_NAME.test(l.name)) continue
    const r = byLnk.get(l.lnk.toLowerCase())
    if (!r) continue
    const exe = String(r.target || '')
    if (!exe || !/\.exe$/i.test(exe)) continue
    if (BAD_TARGET.test(exe)) continue
    if (/^[a-z]:\\windows\\/i.test(exe)) continue
    const key = (exe + '|' + (r.args || '')).toLowerCase()
    if (usedTarget.has(key)) continue
    usedTarget.add(key)

    out.push({
      id: 's_' + hashName(key),
      name: l.name,
      kind: 'lnk',
      // 直接开 .lnk：ShellExecute 会自己处理工作目录、参数、管理员标记
      target: l.lnk,
      exe,
      args: r.args || '',
      dir: r.dir || '',
      source: 'startmenu',
      cover: '',
      hue: hueOf(l.name)
    })
  }

  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return out
}

module.exports = { scanStartMenu, startMenuDirs }
