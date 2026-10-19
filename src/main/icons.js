'use strict'
/**
 * 程序图标
 *
 * 没有海报的程序（本地 exe、快捷方式、系统设置项）不应该只显示一个色块。
 * 这里用 Windows Shell 的 IShellItemImageFactory 直接抠出 exe / lnk 里
 * 嵌入的最大一帧图标（通常 256×256，不是 32×32 的小图），存成 PNG，
 * 卡片拿它当主视觉：图标居中，同一张图放大 + 模糊铺满背景。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { cacheDir, hashName, unpackedPath } = require('./util')

const PS = unpackedPath(path.join(__dirname, 'resources', 'icon-dump.ps1'))

/** 能从哪个本地文件抠图标：steam:// / https:// 这种没有本地文件，跳过 */
function iconSource (g) {
  const t = String((g && g.target) || '').trim()
  if (!t) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) return '' // 协议 URL
  if (!/\.(exe|lnk|ico|bat|cmd|com|msc)$/i.test(t)) return ''
  try {
    return fs.existsSync(t) ? t : ''
  } catch {
    return ''
  }
}

function iconFile (g) {
  return path.join(cacheDir('icons'), hashName(String(g.id || g.target || g.name)) + '.png')
}

function hasIcon (g) {
  if (!g || !g.icon) return false
  try {
    return fs.existsSync(g.icon) && fs.statSync(g.icon).size > 256
  } catch {
    return false
  }
}

/** 找出一道 PowerShell 命令跑完，逐行读 JSON 结果 */
function runDump (jobPath) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    let proc
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS, '-Job', jobPath],
        { windowsHide: true }
      )
    } catch {
      return finish('')
    }
    const timer = setTimeout(() => {
      try { proc.kill() } catch {}
      finish(out)
    }, 20000)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d) => { out += d })
    proc.on('error', () => { clearTimeout(timer); finish('') })
    proc.on('exit', () => { clearTimeout(timer); finish(out) })
  })
}

/**
 * 给还没有图标的补上，直接改传进来的 library 数组（调用方自己 save）
 * @returns {{ok:number, total:number}}
 */
async function ensureIcons (lib) {
  const list = Array.isArray(lib) ? lib : []
  const todo = []
  for (const g of list) {
    if (hasIcon(g)) continue
    const src = iconSource(g)
    if (!src) continue
    todo.push({ g, src, out: iconFile(g) })
  }
  if (!todo.length) return { ok: 0, total: 0 }

  const jobPath = path.join(cacheDir('icons'), '_job.json')
  const job = {
    size: 256,
    items: todo.map((t) => ({ id: String(t.g.id), src: t.src, out: t.out }))
  }
  try {
    fs.writeFileSync(jobPath, JSON.stringify(job), 'utf8')
  } catch {
    return { ok: 0, total: todo.length }
  }

  const raw = await runDump(jobPath)
  const byId = new Map(todo.map((t) => [String(t.g.id), t]))
  let ok = 0
  for (const line of String(raw || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let res
    try { res = JSON.parse(s) } catch { continue }
    const hit = byId.get(String(res.id))
    if (!hit || !res.ok) continue
    try {
      if (!fs.existsSync(hit.out) || fs.statSync(hit.out).size < 256) continue
    } catch { continue }
    hit.g.icon = hit.out
    ok++
  }
  try { fs.unlinkSync(jobPath) } catch {}
  return { ok, total: todo.length }
}

module.exports = { ensureIcons, iconSource, iconFile, hasIcon }
