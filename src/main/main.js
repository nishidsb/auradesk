'use strict'
/**
 * AuraDesk 主进程
 * - 每块屏幕一个透明覆盖层窗口（壁纸/游戏库/播放器）
 * - 一个设置窗口（每屏独立配置）
 * - 音乐播放状态集中管理，只有主屏那个窗口真正持有 <audio>，其余屏只做歌词同步
 */
const {
  app, BrowserWindow, ipcMain, screen, dialog, shell, globalShortcut, protocol, net,
  Tray, Menu, nativeImage, powerSaveBlocker
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const store = require('./store')
const library = require('./library')
const steam = require('./sources/steam')
const epic = require('./sources/epic')
const covers = require('./sources/covers')
const smtc = require('./sources/smtc')
const startmenu = require('./sources/startmenu')
const lyrics = require('./lyrics')
const icons = require('./icons')
const taskbar = require('./launcher')
const edgebar = require('./edgebar')
const { log } = require('./logger')

const CAPTURE = process.argv.includes('--capture')
const DEMO = CAPTURE || process.argv.includes('--demo')

// 单实例（截图模式例外：不抢正在运行的实例，方便随时出图）
if (!CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit()
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aura',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

const overlayWins = new Map() // key -> win
const winKey = new Map() // webContents.id -> key
let settingsWin = null
let rebuildTimer = null

const playback = {
  index: 0,
  playing: false,
  time: 0,
  duration: 0,
  trackId: null
}

/* ------------------------------------------------------------------ 工具 */

/** 线上封面地址：本地缓存丢了 / 被清理时，卡片还能直接联网拿到海报 */
function remoteCover (g) {
  if (g.coverRemote) return g.coverRemote
  const m = /steam:\/\/rungameid\/(\d+)/.exec(g.target || '')
  if (m) return 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + m[1] + '/library_600x900.jpg'
  return ''
}

function toUrl (p) {
  if (!p) return ''
  const abs = p.replace(/\\/g, '/')
  if (!/^[a-zA-Z]:\//.test(abs)) return ''
  // 封面 / 壁纸文件被删掉或还没下完时别给渲染进程一个必然 404 的地址，
  // 让它退回文字色块，而不是一块黑
  try {
    if (!fs.existsSync(abs)) return ''
  } catch {
    return ''
  }
  return 'aura://local/' + encodeURI(abs)
}

/* 显示器的配置键必须跨重启稳定：Windows 上 display.id 是枚举时分配的，
   重启后可能变，导致按屏存的设置（主屏隐藏等）对不上号而全部回默认。
   EDID 是显示器硬件身份（厂商/型号/序列号），拔插、重启都不变，
   用它做主键；拿不到 EDID 的极少数情况退回旧的 display.id。 */
const crypto = require('node:crypto')
const displayKeyCache = new Map() // display.id -> 稳定 key（buildOverlays 时填充）

function edidKeyOf (display) {
  const e = display.edid
  if (!e) return null
  const raw = [e.manufacturer, e.productCode, e.serialNumber, e.yearOfManufacture]
    .map((x) => (x == null ? '' : String(x))).join('|')
  if (!raw.replace(/\|/g, '')) return null
  return 'e_' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10)
}

/** 给当前所有显示器分配稳定 key（同一批次内保证唯一、所有调用点一致） */
function assignDisplayKeys (displays) {
  const used = new Map()
  displayKeyCache.clear()
  const sorted = [...displays].sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y))
  for (const d of sorted) {
    let key = edidKeyOf(d) || 'd' + d.id
    const n = used.get(key) || 0
    used.set(key, n + 1)
    if (n > 0) key += '_' + n // 两台完全同型号同序列号的显示器才走这里
    displayKeyCache.set(d.id, key)
  }
}

function displayKey (display) {
  if (displayKeyCache.has(display.id)) return displayKeyCache.get(display.id)
  return edidKeyOf(display) || 'd' + display.id
}

/**
 * 老配置的键是 display.id（跨重启不稳定）。启动时对不上号的屏幕，
 * 按上一次记录的分辨率/几何信息找回旧配置条目并搬到新键下。
 */
function reconcileDisplayKeys () {
  const cfg = store.get()
  const displays = screen.getAllDisplays()
  const curKeys = new Set(displays.map((d) => displayKey(d)))
  const free = Object.keys(cfg.displays).filter((k) => !curKeys.has(k))
  if (!free.length) return
  let moved = 0
  for (const d of displays) {
    const key = displayKey(d)
    if (cfg.displays[key]) continue
    const sig = d.bounds.width + 'x' + d.bounds.height
    const hit = free.find((k) => {
      const lb = cfg.displays[k] && cfg.displays[k].lastBounds
      return lb && (lb.w + 'x' + lb.h) === sig
    })
    if (hit) {
      cfg.displays[key] = cfg.displays[hit]
      delete cfg.displays[hit]
      free.splice(free.indexOf(hit), 1)
      moved++
    }
  }
  if (moved) {
    store.save()
    console.log('[display] 按几何信息迁移了 ' + moved + ' 个屏幕配置')
  }
}

function primaryKey () {
  const p = screen.getPrimaryDisplay()
  return displayKey(p)
}

function getTrack () {
  const cfg = store.get().global
  if (cfg.musicSource === 'smtc') {
    const live = smtc.snapshot()
    if (!live.active || !live.title) return null
    return {
      id: 'smtc',
      title: live.title,
      artist: live.artist,
      album: live.album,
      cover: live.cover,
      duration: live.duration,
      path: '',
      url: '',
      lyrics: '',
      live: true,
      appId: live.appId
    }
  }
  const { tracks } = cfg
  if (!tracks.length) return DEMO ? DEMO_TRACK : null
  const i = Math.min(Math.max(playback.index, 0), tracks.length - 1)
  return tracks[i]
}

/* 本地曲目：同目录 .lrc 优先，没有就联网找一份（找到后重推一次配置） */
const localLyricCache = new Map() // track.id -> { text, lines }

function localLyricFor (track) {
  if (!track) return { text: '', lines: [] }
  const own = String(track.lyrics || '').trim()
  if (own) return { text: own, lines: library.parseLrc(own) }
  const hit = localLyricCache.get(track.id)
  if (hit) return hit
  if (!lyricBusy.has('t:' + track.id)) {
    lyricBusy.add('t:' + track.id)
    lyrics
      .getLyrics({ title: track.title, artist: track.artist, duration: track.duration })
      .then((text) => {
        const pack = { text: text || '', lines: library.parseLrc(text || '') }
        localLyricCache.set(track.id, pack)
        if (pack.lines.length) refreshAllOverlays()
      })
      .catch(() => {})
      .finally(() => lyricBusy.delete('t:' + track.id))
  }
  return { text: '', lines: [] }
}

/** 组装给渲染进程的载荷（路径统一转成 aura:// URL） */
function payloadForKey (key) {
  const cfg = store.get()
  const display = key === 'demo'
    ? { id: 'demo', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: true }
    : (screen.getAllDisplays().find((d) => displayKey(d) === key) || screen.getPrimaryDisplay())

  let dcfg = store.displayCfg(key)
  const lib = cfg.global.library

  // 跟随主屏：只镜像壁纸，界面开关与缩放任然独立
  const pk = primaryKey()
  if (key !== 'demo' && key !== pk && dcfg.followPrimary && store.get().displays[pk]) {
    const p = store.get().displays[pk]
    dcfg = { ...dcfg, wallpaper: p.wallpaper }
  }

  // 顺序：用户拖过就完全按拖出来的顺序（global.gameOrder），
  // 没拖过才按「最近玩过的在前」（PS5 也是这个逻辑）
  const userOrder = Array.isArray(cfg.global.gameOrder) ? cfg.global.gameOrder : []
  const ordered = lib.map((g, i) => ({ g, i }))
  if (userOrder.length) {
    const pos = new Map(userOrder.map((id, i) => [id, i]))
    ordered.sort((a, b) => {
      const pa = pos.has(a.g.id) ? pos.get(a.g.id) : Infinity
      const pb = pos.has(b.g.id) ? pos.get(b.g.id) : Infinity
      if (pa !== pb) return pa - pb
      return a.i - b.i
    })
  } else {
    ordered.sort((a, b) => ((b.g.playedAt || 0) - (a.g.playedAt || 0)) || (a.i - b.i))
  }
  const orderedGames = ordered.map((x) => x.g)


  const track = getTrack()
  const lyricPack = track && !track.live ? localLyricFor(track) : null
  const lyrics = lyricPack ? lyricPack.text : ''
  const liveSnap = track && track.live ? smtc.snapshot() : null

  return {
    key,
    screen: {
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor,
      primary: !!display.primary,
      label: display.label || ''
    },
    demo: DEMO && !cfg.global.tracks.length,
    cfg: { ...dcfg, wallpaper: { ...dcfg.wallpaper, url: toUrl(dcfg.wallpaper.path) } },
    musicSource: cfg.global.musicSource,
    library: orderedGames.map((g) => ({
      ...g,
      coverUrl: toUrl(g.cover),
      coverRemote: remoteCover(g),
      iconUrl: toUrl(g.icon)
    })),
    gameOrder: userOrder,
    track: track
      ? {
          ...track,
          coverUrl: toUrl(track.cover),
          url: toUrl(track.path),
          lyrics,
          lyricLines: lyricPack ? lyricPack.lines : []
        }
      : null,
    tracks: cfg.global.tracks.length,
    playback: liveSnap
      ? { time: liveSnap.position, duration: liveSnap.duration, playing: liveSnap.playing, trackId: 'smtc' }
      : { ...playback, trackId: track ? track.id : null },
    isOwner: key === primaryKey() || key === 'demo',
    widgets: cfg.global.widgetIds || []
  }
}

function broadcast (channel, data, exceptId = null) {
  for (const [, win] of overlayWins) {
    if (win.isDestroyed()) continue
    if (exceptId && win.webContents.id === exceptId) continue
    win.webContents.send(channel, data)
  }
}

/* ------------------------------------------------------- 直播歌曲（SMTC） */

let lastCoverKey = ''

/* 当前在播歌曲的歌词。SMTC 只给标题歌手，歌词得自己按名字去网上找，
   找到之前先用空的，找到后再推一次，界面就滚起来了。 */
const liveLyric = { key: '', text: '', lines: [] }
const lyricBusy = new Set()

function trackLyricKey (t) {
  return String((t && t.artist) || '') + '|' + String((t && t.title) || '')
}

function liveTrackPayload () {
  const t = getTrack()
  if (!t) return null
  const ok = trackLyricKey(t) === liveLyric.key
  return {
    ...t,
    coverUrl: toUrl(t.cover),
    lyrics: ok ? liveLyric.text : '',
    lyricLines: ok ? liveLyric.lines : []
  }
}

/** 切歌了就异步去网上找歌词，找到后把 payload 重新推一遍 */
function maybeLookupLyrics (live) {
  if (!live || !live.active || !live.title) return
  const key = trackLyricKey(live)
  if (key === liveLyric.key || lyricBusy.has('s:' + key)) return
  lyricBusy.add('s:' + key)
  lyrics
    .getLyrics({ title: live.title, artist: live.artist, duration: live.duration })
    .then((text) => {
      liveLyric.key = key
      liveLyric.text = text || ''
      liveLyric.lines = library.parseLrc(liveLyric.text)
      // 只有还在放这首才值得重推
      if (trackLyricKey(getTrack() || {}) === key) pushLiveState()
    })
    .catch(() => {})
    .finally(() => lyricBusy.delete('s:' + key))
}

function pushLiveState () {
  const live = smtc.snapshot()
  maybeLookupLyrics(live)
  const payload = {
    track: liveTrackPayload(),
    playback: {
      time: live.position,
      duration: live.duration,
      playing: live.playing,
      trackId: live.active ? 'smtc' : null
    }
  }
  broadcast('smtc:state', payload)
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('smtc:state', payload)
}

async function maybeLookupCover (live) {
  if (!live.active || live.cover || !live.title) return
  const key = live.title + '|' + live.artist
  if (key === lastCoverKey) return
  lastCoverKey = key
  const file = await covers.onlineCover(live.title, live.artist)
  if (file && smtc.isRunning()) {
    smtc.setCover(file)
    pushLiveState()
  }
}

function onSmtcState (live) {
  if (store.get().global.musicSource !== 'smtc') return
  pushLiveState()
  if (live.active) maybeLookupCover(live)
}

function applyMusicSource () {
  const src = store.get().global.musicSource
  if (src === 'smtc') smtc.start(onSmtcState)
  else {
    smtc.stop()
    refreshAllOverlays()
  }
}

/** 把扫描到的游戏合并进资源库，并追加到主屏两侧 */
function mergeGames (games) {
  const cfg = store.get()
  const byId = new Set(cfg.global.library.map((g) => g.id))
  const byTarget = new Set(cfg.global.library.map((g) => String(g.target || '').toLowerCase()))
  const added = []
  for (const g of games) {
    const t = String(g.target || '').toLowerCase()
    if (byId.has(g.id) || (t && byTarget.has(t))) continue
    cfg.global.library.push(g)
    byId.add(g.id)
    if (t) byTarget.add(t)
    added.push(g)
  }
  store.save()
  refreshAllOverlays()
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:refresh')
  // 新加进来的程序先抠图标；紧接着试一轮 Steam / Epic 封面匹配，
  // 命中就直接用官方海报，不用等下一次启动
  if (added.length) {
    setTimeout(() => autoFillIcons(), 200)
    setTimeout(() => autoFillCovers(), 1400)
  }
  return added.length
}

/* ------------------------------------------------------------ 覆盖层窗口 */

function createOverlay (key, display, opts = {}) {
  if (overlayWins.has(key)) return overlayWins.get(key)

  const b = display.bounds
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: CAPTURE ? 1600 : b.width,
    height: CAPTURE ? 900 : b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  })

  winKey.set(win.webContents.id, key)
  overlayWins.set(key, win)

  win.loadFile(path.join(__dirname, '../renderer/overlay/index.html'), {
    query: { key, capture: CAPTURE ? '1' : '' }
  })

  // 诊断全链路：overlay 渲染层的日志/报错必须留痕（桌面层曾因无转发成盲区，
  // pet.js 语法错误导致整层空白都查不到）
  {
    const owc = win.webContents
    const short = (u) => String(u || '').split('/').pop()
    owc.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 1) log('[overlay] 渲染层:', message, '@', short(sourceId) + ':' + line)
    })
    owc.on('did-fail-load', (_e, code, desc, url) => log('[overlay] 加载失败', code, desc, url))
    owc.on('preload-error', (_e, p, err) => log('[overlay] preload 报错:', p, err && err.message))
  }

  win.once('ready-to-show', () => {
    win.showInactive()
    // 默认整窗穿透 + 转发鼠标事件：渲染层判断光标是否在热元素上，动态切换穿透
    // （v0.3.38 弃用 setShape——SetWindowRgn 裁剪视觉，导致角色灰框/拖动裁剪）
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setAlwaysOnTop(!!store.get().global.alwaysOnTop)
    if (CAPTURE) win.setAlwaysOnTop(true, 'screen-saver')
    // 合成兜底：周期性强制触发一次合成帧调度。透明常驻窗口被 Chromium 判为
    // 「无自主上屏需求」时，invalidate 是把 BeginFrame 叫醒的最直接手段
    setInterval(() => {
      if (!win.isDestroyed()) win.webContents.invalidate()
    }, 40)
  })

  win.on('closed', () => {
    overlayWins.delete(key)
  })

  // 用户按 Win+D 显示桌面时，把覆盖层重新叫到桌面之上
  win.on('blur', () => {
    if (!win.isDestroyed() && win.isVisible()) {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isFocused()) win.setSkipTaskbar(true)
      }, 50)
    }
  })

  return win
}

/* v4 及以前只有一个「只在主屏显示」的总开关。现在改成每屏独立开关，
   这里把老配置换算过去：原来被这个开关藏掉的副屏，标记为本屏不显示。 */
function migratePrimaryOnly () {
  const cfg = store.get()
  if (!cfg.global.primaryOnly) return
  const pKey = primaryKey()
  for (const [key, d] of Object.entries(cfg.displays)) {
    if (key === pKey || !d || !d.ui) continue
    d.ui.enabled = false
  }
  cfg.global.primaryOnly = false
  store.save()
  console.log('[migrate] 「只在主屏显示」已拆成每屏开关')
}

function buildOverlays () {
  const displays = screen.getAllDisplays()
  assignDisplayKeys(displays)
  reconcileDisplayKeys()
  const pKey = primaryKey()
  const present = new Set()
  const edgeSpecs = []

  for (const d of displays) {
    const key = displayKey(d)
    const cfg = store.ensureDisplay(key, { primary: key === pKey, primaryKey: pKey })
    // 记录几何信息，供 EDID 变化（换线/换口）后按分辨率找回配置
    const lb = { w: d.bounds.width, h: d.bounds.height }
    if (!cfg.lastBounds || cfg.lastBounds.w !== lb.w || cfg.lastBounds.h !== lb.h) {
      cfg.lastBounds = lb
      store.save()
    }
    // 每屏独立开关：关掉的那块屏不建窗口，连透明覆盖层都没有
    if (cfg.ui && cfg.ui.enabled === false) continue
    present.add(key)
    createOverlay(key, d)
    // 边缘任务条：每屏独立开关（ui.edgeBar，默认开）
    if (!cfg.ui || cfg.ui.edgeBar !== false) {
      edgeSpecs.push({ id: key, display: { bounds: d.bounds } })
    }
  }

  for (const [key, win] of [...overlayWins]) {
    if (!present.has(key)) {
      if (!win.isDestroyed()) win.destroy()
      overlayWins.delete(key)
    }
  }

  edgebar.sync(edgeSpecs)
  syncBounds()
}

function syncBounds () {
  for (const [key, win] of overlayWins) {
    if (key === 'demo' || win.isDestroyed()) continue
    const d = screen.getAllDisplays().find((x) => displayKey(x) === key)
    if (!d) continue
    win.setBounds(d.bounds)
  }
}

function refreshAllOverlays () {
  for (const [, win] of overlayWins) {
    if (win.isDestroyed()) continue
    win.webContents.send('overlay:config', payloadForKey(winKey.get(win.webContents.id)))
  }
}

/* -------------------------------------------------------------- 设置窗口 */

function openSettings () {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return settingsWin
  }
  settingsWin = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 900,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0b0c11',
    show: false,
    title: 'AuraDesk 设置',
    icon: path.join(__dirname, 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/settings.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  settingsWin.loadFile(path.join(__dirname, '../renderer/settings/index.html'))
  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => { settingsWin = null })
  return settingsWin
}

function displayList () {
  const pKey = primaryKey()
  return screen.getAllDisplays()
    .sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y))
    .map((d, i) => {
      const key = displayKey(d)
      const cfg = store.ensureDisplay(key, { primary: key === pKey, primaryKey: pKey })
      return {
        key,
        index: i + 1,
        label: cfg.label || (key === pKey ? '主屏' : `显示器 ${i + 1}`),
        primary: key === pKey,
        width: d.bounds.width,
        height: d.bounds.height,
        x: d.bounds.x,
        y: d.bounds.y,
        scaleFactor: d.scaleFactor,
        cfg: { ...cfg, wallpaper: { ...cfg.wallpaper, url: toUrl(cfg.wallpaper.path) } }
      }
    })
}

/* ------------------------------------------------------------------ 启动 */

function launchGame (id) {
  const g = store.get().global.library.find((x) => x.id === id)
  log('[launch] id=' + id + ' →', g ? (g.name + ' target=' + (g.target || '') + ' kind=' + g.kind) : '（卡片不存在）')
  if (!g) return { ok: false, message: '卡片不存在' }
  try {
    if (g.kind === 'url') {
      shell.openExternal(g.target)
    } else if (g.kind === 'folder') {
      shell.openPath(g.target)
    } else if (g.kind === 'lnk') {
      // 直接开快捷方式，ShellExecute 会处理参数、工作目录和管理员标记
      if (fs.existsSync(g.target)) shell.openPath(g.target)
      else if (g.exe && fs.existsSync(g.exe)) shell.openPath(g.exe)
      else return { ok: false, message: '快捷方式已失效：' + g.name }
    } else {
      if (!fs.existsSync(g.target)) return { ok: false, message: '文件不存在：' + g.target }
      shell.openPath(g.target)
    }
    // 记住最近玩过，游戏库里自然排到最前面
    g.playedAt = Date.now()
    store.save()
    return { ok: true }
  } catch (err) {
    return { ok: false, message: String(err && err.message) }
  }
}

/* ---------------------------------------------------------------- 托盘 */

let tray = null

function toggleOverlays () {
  const anyVisible = [...overlayWins.values()].some((w) => !w.isDestroyed() && w.isVisible())
  for (const [, w] of overlayWins) {
    if (w.isDestroyed()) continue
    if (anyVisible) w.hide()
    else w.showInactive()
  }
  refreshTrayMenu()
  return !anyVisible
}

function refreshTrayMenu () {
  if (!tray || tray.isDestroyed()) return
  const g = store.get().global
  const visible = [...overlayWins.values()].some((w) => !w.isDestroyed() && w.isVisible())
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开设置…', accelerator: g.hotkeySettings || undefined, click: () => openSettings() },
    { label: visible ? '隐藏桌面层' : '显示桌面层', accelerator: g.hotkeyToggle || undefined, click: toggleOverlays },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: !!g.autoLaunch,
      click: (item) => {
        store.patchGlobal({ autoLaunch: item.checked })
        try {
          app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: ['--silent'] })
        } catch {}
        refreshTrayMenu()
      }
    },
    { label: '打开配置目录', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    {
      label: '退出 AuraDesk',
      click: () => {
        store.flush()
        app.quit()
      }
    }
  ]))
}

function createTray () {
  if (tray && !tray.isDestroyed()) return
  try {
    const dir = path.join(__dirname, 'resources')
    let img = nativeImage.createFromPath(path.join(dir, 'tray-32.png'))
    if (img.isEmpty()) img = nativeImage.createFromPath(path.join(dir, 'tray-64.png'))
    tray = new Tray(img)
    tray.setToolTip('AuraDesk · 桌面层')
    tray.on('click', () => openSettings())
    tray.on('double-click', () => openSettings())
    refreshTrayMenu()
  } catch (err) {
    console.warn('[tray] 创建失败', err)
    tray = null
  }
}

function registerShortcuts () {
  globalShortcut.unregisterAll()
  const g = store.get().global
  try {
    if (g.hotkeyToggle) globalShortcut.register(g.hotkeyToggle, toggleOverlays)
    if (g.hotkeySettings) globalShortcut.register(g.hotkeySettings, openSettings)
  } catch (err) {
    console.warn('[hotkey] 注册失败', err)
  }
  refreshTrayMenu()
}

// Windows 原生遮挡计算会把置底/透明/穿透窗口判定为「被遮挡」而暂停其合成帧，
// 桌宠等常驻透明窗口的 rAF/渲染会被冻结在第一帧。禁用该特性才能让画面持续刷新
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
// 同类问题第二层：窗口被判遮挡后 renderer 会整体被挂起（上屏停住）。
// 实测 renderer 在产帧（canvas 位图在变）但屏幕不动，必须再禁掉这个
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
// 同类问题第三层：renderer 进程整体「后台化」降级（timer/rAF/合成全被节流）。
// 0.3.25 心跳证实：动画时间在涨、GL 在画，但屏幕冻结在第一帧 → renderer 呈现被节流
app.commandLine.appendSwitch('disable-renderer-backgrounding')
// 2D canvas 走 CPU 光栅化：本机 GPU 合成对透明窗口中的 canvas 纹理层有 bug
// （角色区域灰框/薄纱，内容位图实测干净）。canvas 变软件位图后合成路径不同可绕开；
// 桌宠画布仅 300x520，CPU 光栅化无压力。注意：不可用 disable-gpu-compositing
// （0.3.20 实测会把透明窗口整体变灰）
app.commandLine.appendSwitch('disable-accelerated-2d-canvas')
// 注意：不要加 disable-gpu-compositing——软件合成会把透明窗口底色变灰
// （0.3.20 实测翻车）。桌宠已改为渲染进 overlay 窗口，不再依赖独立透明小窗口

app.whenReady().then(() => {
  // 常驻透明桌面层依赖持续合成上屏：阻止系统/Chromium 出于节能挂起渲染
  try {
    const psbId = powerSaveBlocker.start('prevent-app-suspension')
    log('[boot] powerSaveBlocker prevent-app-suspension started, id=' + psbId)
  } catch (e) { log('[boot] powerSaveBlocker 启动失败: ' + e.message) }
  protocol.handle('aura', async (request) => {
    const u = new URL(request.url)
    const abs = decodeURIComponent(u.pathname.replace(/^\//, ''))
    const res = await net.fetch(pathToFileURL(abs).toString())
    // spine 贴图走 Image + crossOrigin=anonymous，Chromium 要求 CORS 头，否则 Couldn't load image
    const headers = new Headers({ 'access-control-allow-origin': '*' })
    const ct = res.headers.get('content-type')
    if (ct) headers.set('content-type', ct)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  })

  if (CAPTURE) return runCapture()

  log('[boot] 显示器: ' + JSON.stringify(screen.getAllDisplays().map((d) => ({ w: d.bounds.width, h: d.bounds.height, primary: d.id === screen.getPrimaryDisplay().id }))))
  migratePrimaryOnly()
  buildOverlays()
  /** 向所有覆盖层 + 边缘任务条广播（伴侣工具执行结果也要发给卡片刷新状态） */
  const broadcastAll = (ch, data) => {
    for (const [, w] of overlayWins) {
      if (!w.isDestroyed()) w.webContents.send(ch, data)
    }
    edgebar.send(ch, data)
  }
  taskbar.registerIpc()
  taskbar.setDeps({ broadcastAll })
  taskbar.start()
  edgebar.registerIpc()
  // v0.4.1：桌宠/AI 全部移除（AI 对话与桌面角色已由 Ryza Assistant 承担）
  registerShortcuts()
  createTray()
  applyMusicSource()
  startGpuWatchdog()

  screen.on('display-added', () => queueRebuild())
  screen.on('display-removed', () => queueRebuild())
  screen.on('display-metrics-changed', () => queueRebuild())

  if (!store.get().global.tracks.length && !fs.existsSync(path.join(app.getPath('userData'), 'config.json'))) {
    setTimeout(() => { if (!settingsWin) openSettings() }, 1200)
  }

  // 缓存目录被清理 / 换机器之后，封面路径还在但文件没了，桌面就只剩色块。
  // 启动后静默补一次，不用用户自己去设置里点按钮。
  setTimeout(() => autoFillCovers(), 4000)
  // 本地程序的图标更快也更便宜（纯本地 shell 调用），先补图标再补封面
  setTimeout(() => autoFillIcons(), 1200)
  }).catch((err) => {
    // whenReady 流程里任何一步抛异常都必须留痕——否则整个桌面层静默消失
    log('[boot] 启动流程异常:', err && (err.stack || err.message))
  })

/* ---- 开机白屏治理 ----
   开机自启动时 GPU 进程经常还没就绪甚至先崩一次，透明窗口一旦在
   GPU 不可用状态下渲染就会变成一块不透明白底，之后一直挂着。
   对策：GPU 崩溃重启完成后、以及 GPU 状态从不可用恢复可用时，
   把覆盖层窗口重载一遍，透明合成即恢复正常。 */
let gpuWasBad = false

function reloadOverlays () {
  for (const [, w] of overlayWins) {
    if (!w.isDestroyed() && w.isVisible()) w.webContents.reload()
  }
}

function startGpuWatchdog () {
  // GPU 进程崩溃：等它自己重启完再重载
  app.on('child-process-gone', (_e, details) => {
    if (String(details.type).toUpperCase() !== 'GPU') return
    setTimeout(reloadOverlays, 2500)
  })
  // 开机初期 GPU 状态反复横跳：变好之后重载一次
  const timer = setInterval(() => {
    try {
      const s = app.getGPUFeatureStatus()
      const bad = !!s.gpu && !/enable/i.test(s.gpu)
      if (gpuWasBad && !bad) {
        gpuWasBad = false
        setTimeout(reloadOverlays, 1200)
      } else if (bad) {
        gpuWasBad = true
      }
    } catch { /* 忽略 */ }
  }, 2000)
  // 90 秒后 GPU 稳定，不再轮询
  setTimeout(() => clearInterval(timer), 90000)
}

/** 给没有海报的程序抠出 exe / lnk 里的图标 */
async function autoFillIcons () {
  const cfg = store.get()
  const lib = cfg.global.library || []
  try {
    const res = await icons.ensureIcons(lib)
    if (!res.ok) return
    store.save()
    refreshAllOverlays()
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:refresh')
    console.log('[icons] 自动补全 ' + res.ok + '/' + res.total)
  } catch (err) {
    console.log('[icons] 自动补全失败：' + (err && err.message))
  }
}

async function autoFillCovers () {
  const cfg = store.get()
  const lib = cfg.global.library || []
  const missing = lib.filter((g) => !g.cover || !fs.existsSync(g.cover))
  if (!missing.length) return
  try {
    const res = await covers.fillMissingCovers(lib, String(cfg.global.sgdbKey || '').trim())
    store.save()
    refreshAllOverlays()
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:refresh')
    console.log('[covers] 启动自动补全 ' + res.ok + '/' + res.total)
  } catch (err) {
    console.log('[covers] 自动补全失败：' + (err && err.message))
  }
}

function queueRebuild () {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    buildOverlays()
    refreshAllOverlays()
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:refresh')
  }, 400)
}

app.on('window-all-closed', () => {
  // 桌面层是常驻的：设置窗口关掉、或按快捷键隐藏了桌面层，都不应该退出，
  // 否则托盘图标跟着消失，用户就再也找不回来了。退出统一走托盘菜单。
  if (process.platform === 'darwin') return
  store.flush()
  if (!tray || tray.isDestroyed()) app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  smtc.stop()
  taskbar.stop()
  edgebar.stop()
  store.flush()
  if (tray && !tray.isDestroyed()) tray.destroy()
})

/* -------------------------------------------------------------------- IPC */

ipcMain.handle('overlay:init', (e) => {
  const key = winKey.get(e.sender.id) || 'demo'
  return payloadForKey(key)
})

/* 输入穿透：v0.3.38 起弃用 setShape（SetWindowRgn 会裁剪视觉——热区矩形同时是
   可见区域，导致角色区域灰框、拖动时被裁）。改为标准桌宠方案：窗口整窗穿透
   + {forward:true} 转发鼠标事件给渲染层，渲染层判断光标是否在热元素上，
   动态切换穿透。窗口始终是完整矩形，无 region 裁剪。 */
ipcMain.on('overlay:ignore-mouse', (e, on) => {
  const win = overlayWins.get(winKey.get(e.sender.id))
  if (!win || win.isDestroyed()) return
  try { win.setIgnoreMouseEvents(!!on, { forward: !!on }) } catch {}
})

/* 渲染层未捕获异常：boot 挂掉 / 按钮没绑上这类问题，只有这里能看到 */
ipcMain.on('overlay:renderer-error', (_e, kind, msg, stack) => {
  log('[renderer] ' + kind + ':', String(msg || '').slice(0, 500), String(stack || '').slice(0, 800))
})

ipcMain.on('overlay:open-settings', () => openSettings())

ipcMain.on('overlay:hide', () => {
  for (const [, w] of overlayWins) if (!w.isDestroyed()) w.hide()
  refreshTrayMenu()
})

ipcMain.on('overlay:quit', () => app.quit())

ipcMain.handle('overlay:launch', (e, id) => launchGame(id))

// 拖拽排好的顺序：整份 id 列表存下来，比记「第几个挪到第几个」更抗增删
ipcMain.handle('games:set-order', (e, ids) => {
  if (!Array.isArray(ids)) return false
  const clean = ids.map((x) => String(x)).filter(Boolean)
  if (!clean.length) return false
  store.patchGlobal({ gameOrder: clean })
  refreshAllOverlays()
  return true
})

// 右键菜单：在资源管理器里定位这个程序（Steam / Epic 的启动 id 没有本地路径）
ipcMain.handle('overlay:reveal', (e, id) => {
  const g = store.get().global.library.find((x) => x.id === id)
  if (!g || !g.target) return false
  const target = String(g.target)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return false
  if (/^ms-/i.test(target)) return false
  if (!fs.existsSync(target)) return false
  shell.showItemInFolder(target)
  return true
})

ipcMain.handle('overlay:remove', (e, id) => {
  const cfg = store.get()
  cfg.global.library = cfg.global.library.filter((g) => g.id !== id)
  for (const key of Object.keys(cfg.displays)) {
    const d = cfg.displays[key]
    d.leftIds = d.leftIds.filter((x) => x !== id)
    d.rightIds = d.rightIds.filter((x) => x !== id)
  }
  store.save()
  refreshAllOverlays()
  return true
})

ipcMain.on('player:command', (e, cmd, arg) => {
  // 直播歌曲：指令直接转给系统媒体会话（Listen1 / 网易云 / Spotify…）
  if (store.get().global.musicSource === 'smtc') {
    if (cmd === 'seek') {
      const sec = Number(arg)
      if (isFinite(sec)) smtc.seek(sec)
      return
    }
    const map = { toggle: 'toggle', next: 'next', prev: 'prev', play: 'play', pause: 'pause' }
    if (map[cmd]) smtc.control(map[cmd])
    return
  }
  // 本地文件：转给持有 audio 的窗口
  const owner = overlayWins.get(primaryKey()) || overlayWins.get('demo')
  if (owner && !owner.isDestroyed()) owner.webContents.send('player:cmd', cmd, arg)
  if (cmd === 'toggle') playback.playing = !playback.playing
  if (cmd === 'seek' && isFinite(Number(arg))) playback.time = Number(arg)
  broadcast('player:state', { ...playback })
})

ipcMain.on('player:tick', (e, state) => {
  const prevId = playback.trackId
  Object.assign(playback, state)
  if (state.trackId !== prevId) {
    const idx = store.get().global.tracks.findIndex((t) => t.id === state.trackId)
    if (idx >= 0) {
      playback.index = idx
      const g = store.get().global
      g.musicIndex = idx
      store.save()
    }
  }
  broadcast('player:sync', { ...playback }, e.sender.id)
})

/* ------------------------------------------------------------------ 设置 */

ipcMain.handle('settings:init', () => {
  const cfg = store.get()
  return {
    displays: displayList(),
    global: {
      ...cfg.global,
      library: cfg.global.library.map((g) => ({ ...g, coverUrl: toUrl(g.cover) })),
      tracks: cfg.global.tracks.map((t) => ({ ...t, coverUrl: toUrl(t.cover), lyrics: '' }))
    },
    primaryKey: primaryKey()
  }
})

ipcMain.handle('settings:patch-display', (e, key, patch) => {
  store.patchDisplay(key, patch)
  // 本屏开关一变就得重建窗口：关掉的屏连透明层都不留，打开的屏立刻出现
  if (patch && patch.ui && ('enabled' in patch.ui || 'edgeBar' in patch.ui)) queueRebuild()
  refreshAllOverlays()
  return payloadForKey(key)
})

ipcMain.handle('settings:patch-global', (e, patch) => {
  store.patchGlobal(patch)
  if ('alwaysOnTop' in patch) {
    for (const [, w] of overlayWins) if (!w.isDestroyed()) w.setAlwaysOnTop(!!patch.alwaysOnTop)
  }
  if ('autoLaunch' in patch) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!patch.autoLaunch, path: process.execPath, args: ['--silent'] })
    } catch (err) {
      console.warn('[autoLaunch] 设置失败', err)
    }
  }
  if ('hotkeyToggle' in patch || 'hotkeySettings' in patch) registerShortcuts()
  if ('musicSource' in patch) applyMusicSource()
  if ('edgeBarOn' in patch || 'edgeBarBottom' in patch) queueRebuild()
  refreshTrayMenu()
  refreshAllOverlays()
  return { ok: true }
})

/* ------------------------------------------------ Steam / Epic / 封面补全 */

function progressToSettings (payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('import:progress', payload)
}

ipcMain.handle('settings:import-steam', async () => {
  try {
    const res = await steam.scanSteam((p) => progressToSettings({ kind: 'steam', ...p }))
    const added = mergeGames(res.games)
    return { ok: true, added, scanned: res.scanned, roots: res.roots.length }
  } catch (err) {
    return { ok: false, message: String(err && err.message) }
  }
})

ipcMain.handle('settings:import-epic', async () => {
  try {
    const res = await epic.scanEpic((p) => progressToSettings({ kind: 'epic', ...p }))
    const added = mergeGames(res.games)
    return { ok: true, added, scanned: res.games.length, dirs: res.dirs.length, catalog: res.cached }
  } catch (err) {
    return { ok: false, message: String(err && err.message) }
  }
})

ipcMain.handle('settings:fill-covers', async () => {
  const cfg = store.get()
  const key = String(cfg.global.sgdbKey || '').trim()
  try {
    const res = await covers.fillMissingCovers(cfg.global.library, key, (p) => progressToSettings({ kind: 'covers', ...p }))
    store.save()
    refreshAllOverlays()
    return { ok: true, total: res.total, filled: res.ok, noKey: !key && res.ok < res.total }
  } catch (err) {
    return { ok: false, message: String(err && err.message) }
  }
})

/* ---------------------------------------------- 开始菜单 / 任意平台游戏 */

let lastStartMenu = []

ipcMain.handle('settings:scan-startmenu', async () => {
  try {
    lastStartMenu = await startmenu.scanStartMenu()
    return { ok: true, items: lastStartMenu }
  } catch (err) {
    return { ok: false, message: String(err && err.message) }
  }
})

/** 后台逐张补封面，不阻塞导入返回 */
async function fillCoversFor (ids) {
  const cfg = store.get()
  const list = cfg.global.library.filter((g) => ids.includes(g.id) && !g.cover)
  let done = 0
  for (const g of list) {
    const file = await covers.freeCover(g.name)
    if (file) g.cover = file
    done++
    progressToSettings({ kind: 'covers', done, total: list.length, name: g.name, ok: done })
    if (done % 4 === 0) {
      store.save()
      refreshAllOverlays()
    }
  }
  store.save()
  refreshAllOverlays()
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:refresh')
}

ipcMain.handle('settings:import-startmenu', async (e, ids) => {
  try {
    const picked = lastStartMenu.filter((g) => ids.includes(g.id))
    if (!picked.length) return { ok: false, message: '没有选中任何程序' }
    const added = mergeGames(picked)
    const newIds = store.get().global.library.filter((g) => picked.some((p) => p.id === g.id)).map((g) => g.id)
    fillCoversFor(newIds)
    return { ok: true, added, scanned: picked.length }
  } catch (err) {
    return { ok: false, message: String(err && err.message) }
  }
})

ipcMain.handle('settings:smtc-status', () => smtc.snapshot())

ipcMain.handle('settings:pick-wallpaper', async (e, key, kind) => {
  if (kind === 'reset') {
    // 复位 = 回到「跟随桌面」，而不是画一张内置渐变把人家的壁纸盖掉
    store.patchDisplay(key, { wallpaper: { type: 'desktop', path: '' } })
    refreshAllOverlays()
    return payloadForKey(key)
  }
  const res = await dialog.showOpenDialog(settingsWin, {
    title: '选择壁纸',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif'] }]
  })
  if (res.canceled || !res.filePaths[0]) return null
  store.patchDisplay(key, { wallpaper: { type: 'image', path: res.filePaths[0] } })
  refreshAllOverlays()
  return payloadForKey(key)
})

ipcMain.handle('settings:add-games', async () => {
  const res = await dialog.showOpenDialog(settingsWin, {
    title: '选择程序（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '程序', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
  })
  if (res.canceled) return null
  const cfg = store.get()
  const added = res.filePaths.map((f) => library.gameFromExe(f))
  cfg.global.library.push(...added)
  store.save()
  refreshAllOverlays()
  // 图标 + Steam/Epic 封面匹配，跟上
  setTimeout(() => autoFillIcons(), 200)
  setTimeout(() => autoFillCovers(), 1400)
  return added
})

ipcMain.handle('settings:scan-folder', async () => {
  const res = await dialog.showOpenDialog(settingsWin, {
    title: '选择游戏安装目录（会向下扫描 2 层）',
    properties: ['openDirectory']
  })
  if (res.canceled) return null
  const found = library.scanGamesInFolder(res.filePaths[0])
  const cfg = store.get()
  const exists = new Set(cfg.global.library.map((g) => g.target.toLowerCase()))
  const added = found.filter((g) => !exists.has(g.target.toLowerCase()))
  cfg.global.library.push(...added)
  store.save()
  refreshAllOverlays()
  if (added.length) {
    setTimeout(() => autoFillIcons(), 200)
    setTimeout(() => autoFillCovers(), 1400)
  }
  return added
})

ipcMain.handle('settings:set-cover', async (e, gameId) => {
  const res = await dialog.showOpenDialog(settingsWin, {
    title: '选择封面图（建议 2:3 竖图）',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }]
  })
  if (res.canceled || !res.filePaths[0]) return null
  const cfg = store.get()
  const g = cfg.global.library.find((x) => x.id === gameId)
  if (!g) return null
  g.cover = res.filePaths[0]
  store.save()
  refreshAllOverlays()
  return { ...g, coverUrl: toUrl(g.cover) }
})

ipcMain.handle('settings:remove-game', (e, gameId) => {
  const cfg = store.get()
  cfg.global.library = cfg.global.library.filter((g) => g.id !== gameId)
  for (const key of Object.keys(cfg.displays)) {
    const d = cfg.displays[key]
    d.leftIds = d.leftIds.filter((id) => id !== gameId)
    d.rightIds = d.rightIds.filter((id) => id !== gameId)
  }
  store.save()
  refreshAllOverlays()
  return true
})

ipcMain.handle('settings:rename-game', (e, gameId, name) => {
  const cfg = store.get()
  const g = cfg.global.library.find((x) => x.id === gameId)
  if (g) g.name = name
  store.save()
  refreshAllOverlays()
  return true
})

ipcMain.handle('settings:add-music', async () => {
  const res = await dialog.showOpenDialog(settingsWin, {
    title: '选择音乐文件夹',
    properties: ['openDirectory', 'multiSelections']
  })
  if (res.canceled) return null
  const cfg = store.get()
  const set = new Set([...cfg.global.musicFolders, ...res.filePaths])
  cfg.global.musicFolders = [...set]
  store.save()
  return { scanning: true }
})

ipcMain.handle('settings:scan-music', async (e) => {
  const cfg = store.get()
  if (!cfg.global.musicFolders.length) return { tracks: [] }
  const tracks = await library.scanMusic(cfg.global.musicFolders, (p) => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('music:progress', p)
  })
  cfg.global.tracks = tracks
  store.save()
  refreshAllOverlays()
  broadcast('player:library', true)
  return { tracks: tracks.map((t) => ({ ...t, coverUrl: toUrl(t.cover), lyrics: '' })) }
})

ipcMain.handle('settings:remove-music-folder', async (e, folder) => {
  const cfg = store.get()
  cfg.global.musicFolders = cfg.global.musicFolders.filter((f) => f !== folder)
  store.save()
  return true
})

ipcMain.handle('settings:open-folder', (e, p) => { shell.openPath(p) })

ipcMain.handle('settings:window', (e, action) => {
  if (!settingsWin) return
  if (action === 'close') settingsWin.close()
  if (action === 'min') settingsWin.minimize()
})

ipcMain.handle('settings:quit', () => app.quit())

ipcMain.handle('settings:open-settings-folder', () => shell.openPath(app.getPath('userData')))

/* --------------------------------------------------------------- 截图模式 */

const DEMO_TRACK = {
  id: 't_demo',
  title: '夜に駆ける',
  artist: 'YOASOBI · THE BOOK',
  album: 'THE BOOK',
  cover: '',
  duration: 189,
  lyrics: [
    '[00:00.00]沈むように溶けてゆくように',
    '[00:12.00]二人だけの空が広がる夜に',
    '[00:24.00]「さよなら」だけだった',
    '[00:36.00]その一言で全てが分かった',
    '[00:48.00]日が沈み出した空と君の姿',
    '[01:00.00]フェンス越しに重なっていた',
    '[01:12.00]初めて会った日から',
    '[01:24.00]僕の心の全てを奪った',
    '[01:36.00]どこか儚い空気を纏う君は',
    '[01:48.00]寂しい目をしてたんだ',
    '[02:00.00]いつだってチックタックと',
    '[02:12.00]鳴る世界で何故だ',
    '[02:24.00]針は進み続ける',
    '[02:36.00]息を止めて',
    '[02:48.00]その笑顔が消えないように',
    '[03:00.00]願ってた'
  ].join('\n')
}

/* 侧栏几何自检：PROBE=1 启动截图模式时跑一次。
   检查点：两栏上下沿是否一致、行数对不对、最后一张卡有没有被切掉。 */
async function probeRails (win, outDir) {
  try {
    const geo = await win.webContents.executeJavaScript(`(() => {
      const box = (id) => {
        const el = document.getElementById(id)
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), sh: el.scrollHeight, n: el.children.length }
      }
      const tiles = [...document.querySelectorAll('#gridL .tile')]
      const first = tiles[0]
      const fb = first && first.getBoundingClientRect()
      const gEl = document.getElementById('gridL')
      const gb = gEl.getBoundingClientRect()
      return {
        L: box('gridL'), R: box('gridR'),
        tiles: tiles.length,
        scrollable: gEl.scrollHeight > gEl.clientHeight + 2,
        // 顶部第一行要完整露出来（滚动位置在 0 时不能被裁掉上沿）
        topOK: !fb || (fb.top >= gb.top - 1 && gEl.scrollTop === 0),
        railW: getComputedStyle(document.documentElement).getPropertyValue('--rail-w')
      }
    })()`)
    console.log('[probe] ' + JSON.stringify(geo))
    // 歌词探针：demo 曲目带时间轴，正常应该正在显示当前句
    const ly = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('lyrics')
      const cs = getComputedStyle(el)
      return { hidden: el.hidden, html: el.innerHTML, opacity: cs.opacity, text: el.textContent }
    })()`)
    console.log('[probe lyrics] ' + JSON.stringify(ly))
    for (const id of ['gridL', 'gridR']) {
      const r = await win.webContents.executeJavaScript(
        `(() => { const b = document.getElementById('${id}').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } })()`
      )
      const img = await win.webContents.capturePage(r)
      fs.writeFileSync(path.join(outDir, 'probe-' + id + '.png'), img.toPNG())
    }
    // 滚一段再截一张，确认下面真的还有内容
    await win.webContents.executeJavaScript("document.getElementById('gridL').scrollTop = 400")
    await new Promise((r) => setTimeout(r, 260))
    const box2 = await win.webContents.executeJavaScript(
      "(() => { const b = document.getElementById('gridL').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } })()"
    )
    const img2 = await win.webContents.capturePage(box2)
    fs.writeFileSync(path.join(outDir, 'probe-scrolled.png'), img2.toPNG())
    // 滚到底：最后一行必须是完整的，不能露出半张
    const tail = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('gridL')
      el.scrollTop = el.scrollHeight
      const tiles = [...el.querySelectorAll('.tile')]
      const last = tiles[tiles.length - 1].getBoundingClientRect()
      const gb = el.getBoundingClientRect()
      return { lastBottom: Math.round(last.bottom), gridBottom: Math.round(gb.bottom), tailOk: last.bottom <= gb.bottom + 1 }
    })()`)
    console.log('[probe] bottom ' + JSON.stringify(tail))
    // 探针会把栏滚下去，拍正式截图前还原到顶部
    await win.webContents.executeJavaScript("document.getElementById('gridL').scrollTop = 0")
    await new Promise((r) => setTimeout(r, 200))
  } catch (err) {
    console.error('[probe] 失败', err && err.message)
  }
}

async function runCapture () {
  setTimeout(() => {
    console.error('[capture] 超时退出')
    app.quit()
  }, 15000)

  const win = createOverlay('demo', {
    id: 'demo',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    primary: true
  }, { capture: true })

  playback.time = 113
  playback.duration = 189
  playback.playing = true
  playback.trackId = DEMO_TRACK.id

  const outDir = path.join(app.getAppPath(), 'captures')
  fs.mkdirSync(outDir, { recursive: true })
  win.showInactive()

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const shoot = async (w, name) => {
    try {
      const img = await w.webContents.capturePage()
      fs.writeFileSync(path.join(outDir, name), img.toPNG())
      console.log('[capture] ' + name + ' ' + JSON.stringify(img.getSize()))
    } catch (err) {
      console.error('[capture] ' + name + ' 失败', err)
    }
  }

  await wait(2600)
  // 截图自查时窗口是透明的，垫一层假壁纸，否则白底上看不清半透明白字
  try {
    await win.webContents.executeJavaScript(
      "(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;z-index:0;background:radial-gradient(120% 90% at 18% 12%, #2b3a5c 0%, #1a2233 46%, #0d1119 100%)'; document.body.insertBefore(d, document.body.firstChild) })()"
    )
    await wait(300)
  } catch {}

  // 截图里的播放器 / 歌词：模拟一次「Listen1 正在放歌」的 SMTC 推送。
  // 歌词走真实的联网抓取，截图看到的就是用户实际会看到的东西。
  try {
    const lrcText = await lyrics.getLyrics({ title: '夜に駆ける', artist: 'YOASOBI', duration: 189 })
    win.webContents.send('smtc:state', {
      track: {
        ...DEMO_TRACK,
        id: 'smtc',
        artist: 'YOASOBI',
        live: true,
        coverUrl: '',
        lyrics: lrcText,
        lyricLines: library.parseLrc(lrcText)
      },
      playback: { time: 113, duration: 189, playing: true, trackId: 'smtc' }
    })
    await wait(500)
  } catch {}

  if (process.env.PROBE) {
    const snap = () => win.webContents.executeJavaScript(`(() => { const cs = getComputedStyle(document.documentElement); const t = document.querySelector('#gridL .tile'); const tb = t && t.getBoundingClientRect(); return { fs: cs.fontSize, dim: cs.getPropertyValue('--dim'), railW: cs.getPropertyValue('--rail-w'), tileW: tb && Math.round(tb.width), scale: S.cfg.ui.scale } })()`)
    console.log('[uiprobe A] ' + JSON.stringify(await snap()))
    await win.webContents.executeJavaScript("S.cfg.ui.scale = 1.3; S.cfg.wallpaper.dim = .55; render(); 1")
    await wait(400)
    console.log('[uiprobe B] ' + JSON.stringify(await snap()))
    await shoot(win, 'probe-ui.png')
    await win.webContents.executeJavaScript("S.cfg.ui.scale = 1; S.cfg.wallpaper.dim = .06; render(); 1")
    await wait(300)
  }
  // PROBE=1 时打印侧栏盒模型并单独截出两栏：用来确认「没有半张卡 / 两栏对齐」
  if (process.env.PROBE) await probeRails(win, outDir)
  await shoot(win, 'overlay.png')

  // 悬停第一张侧栏封面：验证名字浮出 + 白描边
  try {
    const pt = await win.webContents.executeJavaScript(
      "(() => { const el = document.querySelector('#gridL .tile'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()"
    )
    if (pt) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y })
      await wait(600)
      await shoot(win, 'overlay-hover.png')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(win.getBounds().width / 2), y: Math.round(win.getBounds().height / 2) })
      await wait(300)
    }
  } catch (err) {
    console.error('[capture] 悬停截图失败', err)
  }

  // 切到游戏库再截一张：验证网格、筛选条与播放器共存
  try {
    await win.webContents.executeJavaScript("document.getElementById('dockLib').click()")
    await wait(900)
    await shoot(win, 'library.png')
    await win.webContents.executeJavaScript("document.getElementById('libBack').click()")
    await wait(300)
  } catch (err) {
    console.error('[capture] 游戏库截图失败', err)
  }

  const st = openSettings()
  await wait(2200)
  await shoot(st, 'settings.png')

  // 兜底：无论截图是否成功，最多 12 秒后退出
  setTimeout(() => app.quit(), 200)
}
