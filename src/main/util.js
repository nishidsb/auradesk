'use strict'
/** 通用小工具：缓存目录、下载、配色、名字清洗 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, net } = require('electron')

function cacheDir (sub) {
  const dir = path.join(app.getPath('userData'), 'cache', sub || '')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function hashName (str) {
  return crypto.createHash('md5').update(String(str)).digest('hex').slice(0, 12)
}

function hueOf (str) {
  let h = 0
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360
  return h
}

/** 下载到缓存目录，已存在直接复用；返回绝对路径，失败返回 '' */
async function download (url, destPath, { timeout = 12000 } = {}) {
  try {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024) return destPath
  } catch {}
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await net.fetch(url, { signal: ctrl.signal })
    if (!res.ok) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 512) return ''
    const tmp = destPath + '.part'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, destPath)
    return destPath
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** 并发限制的 map */
async function pmap (items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++
      try {
        out[idx] = await fn(items[idx], idx)
      } catch {
        out[idx] = null
      }
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 打包后 asar 内的文件无法被外部进程（powershell 等）直接读取，
 * 需要重写到 app.asar.unpacked；开发环境原样返回。
 */
function unpackedPath (p) {
  return String(p).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

module.exports = { cacheDir, hashName, hueOf, download, pmap, unpackedPath }
