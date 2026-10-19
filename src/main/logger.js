'use strict'
/**
 * 轻量文件日志：写到 %APPDATA%/AuraDesk/logs/main.log
 * 用途：用户机器上排查「点击没反应」这类只在真机出现的问题——
 * 沙箱 / jsdom 复现不了的链路（助手进程、setShape、IPC），全都记下来。
 * 超过 512KB 轮转为 main.old.log，不会无限膨胀。
 */
const fs = require('node:fs')
const path = require('node:path')
let app = null
try { app = require('electron').app } catch {}

let file = null

function logfile () {
  if (file !== null) return file
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, 'main.log')
    const old = path.join(dir, 'main.old.log')
    try {
      if (fs.statSync(file).size > 512 * 1024) {
        fs.rmSync(old, { force: true })
        fs.renameSync(file, old)
      }
    } catch { /* 不存在就不管 */ }
    fs.appendFileSync(file, `\n==== ${new Date().toLocaleString()} v${app.getVersion()} pid=${process.pid} ====\n`)
  } catch {
    file = null
  }
  return file
}

function fmt (a) {
  if (typeof a === 'string') return a
  try { return JSON.stringify(a) } catch { return String(a) }
}

function log (...args) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${args.map(fmt).join(' ')}\n`
  const f = logfile()
  if (!f) { console.log(line.trim()); return }
  try { fs.appendFileSync(f, line) } catch { /* 磁盘问题不炸主进程 */ }
}

module.exports = { log, logfile }
