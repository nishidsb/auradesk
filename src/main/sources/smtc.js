'use strict'
/**
 * 系统媒体会话（SMTC）桥
 * 常驻一个 Windows PowerShell 子进程读取会话，通过 stdout 逐行 JSON 回传。
 * 控制指令走另一个常驻进程（stdin 逐行喂命令）：PowerShell 冷启动要
 * 300–500ms，按一次按钮等半秒太难受，所以改成常驻只付一次启动成本。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { cacheDir, hashName, unpackedPath } = require('../util')

const POLL = unpackedPath(path.join(__dirname, '..', 'resources', 'smtc-poll.ps1'))
const CTL = unpackedPath(path.join(__dirname, '..', 'resources', 'smtc-ctl.ps1'))

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

let proc = null
let stdoutBuf = ''
let onState = null
let starting = false
let stopping = false

const state = {
  ready: false,
  active: false,
  error: '',
  appId: '',
  title: '',
  artist: '',
  album: '',
  playing: false,
  position: 0,
  duration: 0,
  cover: ''
}

function snapshot () {
  return { ...state }
}

function emit () {
  if (onState) onState(snapshot())
}

function writeCover (base64) {
  try {
    const buf = Buffer.from(base64, 'base64')
    if (buf.length < 512) return ''
    const isPng = buf[0] === 0x89 && buf[1] === 0x50
    const ext = isPng ? 'png' : 'jpg'
    const file = path.join(cacheDir('covers'), 'smtc_' + hashName(state.title + '|' + state.artist + '|' + buf.length) + '.' + ext)
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf)
    return file
  } catch {
    return ''
  }
}

function handleLine (line) {
  let msg = null
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.error) {
    state.error = msg.error
    emit()
    return
  }
  if (msg.ready) {
    state.ready = true
    state.error = ''
    emit()
    return
  }
  state.error = ''
  if (msg.none) {
    Object.assign(state, { active: false, title: '', artist: '', album: '', playing: false, position: 0, duration: 0, cover: '', appId: '' })
    emit()
    return
  }

  const changed = !!msg.changed || msg.title !== state.title || msg.artist !== state.artist
  Object.assign(state, {
    active: true,
    title: msg.title || '',
    artist: msg.artist || '',
    album: msg.album || '',
    playing: !!msg.playing,
    position: Number(msg.position) || 0,
    duration: Number(msg.duration) || 0,
    appId: msg.app || ''
  })

  if (msg.thumb) state.cover = writeCover(msg.thumb)
  else if (changed) state.cover = ''

  emit()
}

function start (cb) {
  if (cb) onState = cb
  if (proc || starting) return
  starting = true
  stopping = false
  try {
    proc = spawn('powershell.exe', [...PS_ARGS, POLL], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (err) {
    starting = false
    proc = null
    state.error = 'spawn-failed'
    emit()
    return
  }

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk
    let idx = stdoutBuf.indexOf('\n')
    while (idx >= 0) {
      const line = stdoutBuf.slice(0, idx).trim()
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (line) handleLine(line)
      idx = stdoutBuf.indexOf('\n')
    }
  })

  proc.on('error', () => {
    state.error = 'spawn-failed'
    proc = null
    starting = false
    emit()
  })

  proc.on('exit', () => {
    proc = null
    starting = false
    state.ready = false
    state.active = false
    emit()
    // 意外退出（WinRT 偶发异常）时自愈，用户不需要重启整个软件
    if (!stopping) {
      setTimeout(() => {
        if (!proc && !starting && onState) start()
      }, 4000)
    }
  })
}

function stop () {
  stopping = true
  if (proc) {
    try {
      proc.kill()
    } catch {}
  }
  proc = null
  starting = false
  state.ready = false
  state.active = false
  stopCtl()
}

/* --------------------------------------------------------- 控制指令 */

let ctlProc = null

function ensureCtl () {
  if (ctlProc && !ctlProc.killed) return ctlProc
  try {
    ctlProc = spawn('powershell.exe', [...PS_ARGS, CTL], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    // 常驻进程只回一小行 JSON，读掉即可，避免管道缓冲堆满
    ctlProc.stdout.resume()
    ctlProc.stdin.on('error', () => {})
    ctlProc.on('exit', () => { ctlProc = null })
    ctlProc.on('error', () => { ctlProc = null })
  } catch {
    ctlProc = null
  }
  return ctlProc
}

function stopCtl () {
  if (!ctlProc) return
  try {
    ctlProc.stdin.write('quit\n')
    ctlProc.stdin.end()
  } catch {}
  const p = ctlProc
  ctlProc = null
  setTimeout(() => {
    try {
      if (!p.killed) p.kill()
    } catch {}
  }, 400)
}

/** 一次性调用（常驻进程不可用时的兜底） */
function controlOnce (action) {
  return new Promise((resolve) => {
    let child = null
    try {
      child = spawn('powershell.exe', [...PS_ARGS, CTL, action], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      resolve(false)
      return
    }
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => { out += c })
    child.on('error', () => resolve(false))
    child.on('exit', () => {
      let ok = false
      try {
        ok = JSON.parse(out.trim().split('\n').pop()).ok === true
      } catch {}
      resolve(ok)
    })
    setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve(false)
    }, 5000)
  })
}

/** 发送控制指令，返回 Promise<boolean> */
function control (action = 'toggle') {
  const p = ensureCtl()
  if (p && p.stdin && p.stdin.writable) {
    try {
      p.stdin.write(action + '\n')
      return Promise.resolve(true)
    } catch {}
  }
  return controlOnce(action)
}

/** 跳转到指定秒数：SMTC 的进度单位是 100ns tick */
function seek (sec) {
  const ticks = Math.max(0, Math.round(Number(sec) * 1e7))
  return control('seek ' + ticks)
}

function setCover (file) {
  if (!file) return
  state.cover = file
  emit()
}

module.exports = { start, stop, control, seek, snapshot, setCover, isRunning: () => !!proc }
