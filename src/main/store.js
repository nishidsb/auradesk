'use strict'
/**
 * 配置存储：单个 config.json，写盘做 200ms 防抖。
 * 所有渲染进程拿到的都是同源配置的深拷贝，避免意外串改。
 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SAMPLE_GAMES = [
  { id: 'g_notepad', name: '记事本', kind: 'exe', target: 'C:\\Windows\\System32\\notepad.exe', hue: 205 },
  { id: 'g_mspaint', name: '画图', kind: 'exe', target: 'C:\\Windows\\System32\\mspaint.exe', hue: 320 },
  { id: 'g_calc', name: '计算器', kind: 'exe', target: 'C:\\Windows\\System32\\calc.exe', hue: 160 },
  { id: 'g_terminal', name: '终端', kind: 'exe', target: 'C:\\Windows\\System32\\wt.exe', hue: 265 },
  { id: 'g_taskmgr', name: '任务管理器', kind: 'exe', target: 'C:\\Windows\\System32\\Taskmgr.exe', hue: 12 },
  { id: 'g_settings', name: '设置', kind: 'url', target: 'ms-settings:', hue: 190 },
  { id: 'g_explorer', name: '资源管理器', kind: 'exe', target: 'C:\\Windows\\explorer.exe', hue: 44 },
  { id: 'g_snip', name: '截图工具', kind: 'url', target: 'ms-screenclip:', hue: 280 },
  { id: 'g_control', name: '控制面板', kind: 'exe', target: 'C:\\Windows\\System32\\control.exe', hue: 220 },
  { id: 'g_cmd', name: '命令提示符', kind: 'exe', target: 'C:\\Windows\\System32\\cmd.exe', hue: 100 },
  { id: 'g_msinfo', name: '系统信息', kind: 'exe', target: 'C:\\Windows\\System32\\msinfo32.exe', hue: 340 },
  { id: 'g_regedit', name: '字体查看器', kind: 'exe', target: 'C:\\Windows\\System32\\fontview.exe', hue: 240 }
]

// 配置版本：v2 壁纸让位给桌面；v3 换成 PS5 布局（单侧边栏 + 点开游戏库）；
// v4 封面卡改成竖版长方形；v5「只在主屏显示」拆成每屏开关；
// v6 竖版卡片的默认档位落到 4 行（旧的 5 行会让卡片偏小）
const CFG_VERSION = 6

function defaults () {
  return {
    version: CFG_VERSION,
    global: {
      library: SAMPLE_GAMES.map((g) => ({ ...g, cover: '' })),
      musicFolders: [],
      tracks: [],
      musicIndex: 0,
      // smtc = 系统媒体会话（Listen1 / 网易云 / Spotify…）；local = 本地文件
      musicSource: 'smtc',
      sgdbKey: '',
      hotkeyToggle: 'Control+Alt+A',
      hotkeySettings: 'Control+Alt+S',
      autoLaunch: false,
      alwaysOnTop: false,
      // 已废弃：v5 起改为每屏的 ui.enabled，这里只用来读老配置做迁移
      primaryOnly: false,
      // 游戏库已经是侧边栏第一个固定按钮，这里只放额外的小图标
      widgetIds: ['w_discord', 'w_obs', 'w_gem'],
      topIds: ['t_search', 't_explorer', 't_terminal'],
      // 用户在桌面上拖出来的卡片顺序（存 id）。空 = 还没拖过，按最近玩过排
      gameOrder: []
    },
    displays: {}
  }
}

const DEFAULT_DISPLAY = () => ({
  label: '',
  // type: desktop = 不画壁纸，直接透出桌面（Wallpaper Engine 友好）
  //       preset  = 内置渐变；image = 本地图片
  wallpaper: { type: 'desktop', preset: 'sakura', path: '', dim: 0.06, blur: 0, scale: 1.06 },
  ui: {
    // 这块屏要不要显示桌面层：每屏独立，主屏也能关掉只在副屏显示
    enabled: true,
    scale: 1,
    // 两侧封面栏每栏显示几行：行数越少卡片越大
    railRows: 4,
    // 单侧边栏：只在一边，可按屏幕单独开关（关掉副屏的即可只在一屏出现）
    showDock: true,
    dockSide: 'left',
    showPlayer: true,
    showClock: true,
    showLyrics: true,
    lowFx: false
  },
  leftIds: [],
  rightIds: [],
  followPrimary: false
})

let cache = null
let timer = null

function file () {
  return path.join(app.getPath('userData'), 'config.json')
}

function hydrate (raw) {
  const base = defaults()
  if (!raw || typeof raw !== 'object') return base
  const fromVersion = Number(raw.version) || 1
  const out = {
    ...base,
    ...raw,
    version: CFG_VERSION,
    global: { ...base.global, ...(raw.global || {}) },
    displays: { ...(raw.displays || {}) }
  }
  if (!Array.isArray(out.global.library)) out.global.library = base.global.library
  if (!Array.isArray(out.global.tracks)) out.global.tracks = []
  if (!Array.isArray(out.global.gameOrder)) out.global.gameOrder = []
  for (const key of Object.keys(out.displays)) {
    const d = out.displays[key] || {}
    out.displays[key] = {
      ...DEFAULT_DISPLAY(),
      ...d,
      wallpaper: { ...DEFAULT_DISPLAY().wallpaper, ...(d.wallpaper || {}) },
      ui: { ...DEFAULT_DISPLAY().ui, ...(d.ui || {}) },
      leftIds: Array.isArray(d.leftIds) ? d.leftIds : [],
      rightIds: Array.isArray(d.rightIds) ? d.rightIds : []
    }
  }
  migrate(out, fromVersion)
  return out
}

/**
 * v1 → v2：老配置里每屏默认是自绘渐变壁纸，会把用户在 Wallpaper Engine
 * 里的动态壁纸整块盖住。这里统一改成「透出桌面」，但把原来的预设记下来，
 * 用户想切回渐变时还是原来那一套。
 */
function migrate (cfg, fromVersion) {
  // v2 → v3：侧边栏第一个按钮就是游戏库，去掉重复的 w_steam 小图标
  if (fromVersion < 3 && Array.isArray(cfg.global.widgetIds)) {
    cfg.global.widgetIds = cfg.global.widgetIds.filter((id) => id !== 'w_steam')
  }
  // v3 → v4/v6：卡片从正方形改成竖版长方形，旧的默认 5 行会让卡片偏小，
  // 统一落到 4 行（之后用户自己选的档位不再被改）
  if (fromVersion < 6) {
    for (const key of Object.keys(cfg.displays)) {
      const ui = cfg.displays[key].ui
      if (ui && Number(ui.railRows) === 5) ui.railRows = 4
    }
  }
  if (fromVersion >= 2) return
  for (const key of Object.keys(cfg.displays)) {
    const w = cfg.displays[key].wallpaper
    if (!w) continue
    if (w.type === 'preset' || w.type === 'none') {
      w.prevPreset = w.preset || 'sakura'
      w.type = 'desktop'
      w.dim = Math.min(w.dim == null ? 0.06 : w.dim, 0.2)
    }
  }
}

function load () {
  if (cache) return cache
  try {
    cache = hydrate(JSON.parse(fs.readFileSync(file(), 'utf8')))
  } catch {
    cache = defaults()
  }
  return cache
}

function flush () {
  clearTimeout(timer)
  timer = null
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8')
  } catch (err) {
    console.error('[store] 保存失败', err)
  }
}

function save () {
  clearTimeout(timer)
  timer = setTimeout(flush, 200)
}

function get () {
  return load()
}

/** 导入备份用：整体替换配置（走 hydrate 合并默认值+版本迁移），立即落盘 */
function replace (data) {
  cache = hydrate(data)
  flush()
  return cache
}

function patchGlobal (patch) {
  const cfg = load()
  cfg.global = { ...cfg.global, ...patch }
  save()
  return cfg.global
}

/** 取某块屏幕的配置，没有就按主屏模板生成一份 */
function ensureDisplay (key, { primary = false, primaryKey = null, fallbackLists = null } = {}) {
  const cfg = load()
  if (!cfg.displays[key]) {
    const base = DEFAULT_DISPLAY()
    if (fallbackLists) {
      base.leftIds = fallbackLists.leftIds.slice()
      base.rightIds = fallbackLists.rightIds.slice()
    }
    cfg.displays[key] = base
    save()
  }
  return cfg.displays[key]
}

function patchDisplay (key, patch) {
  const cfg = load()
  const cur = cfg.displays[key] || DEFAULT_DISPLAY()
  cfg.displays[key] = {
    ...cur,
    ...patch,
    wallpaper: { ...cur.wallpaper, ...(patch.wallpaper || {}) },
    ui: { ...cur.ui, ...(patch.ui || {}) }
  }
  save()
  return cfg.displays[key]
}

function displayCfg (key) {
  return load().displays[key] || DEFAULT_DISPLAY()
}

module.exports = {
  get,
  replace,
  flush,
  save,
  patchGlobal,
  patchDisplay,
  displayCfg,
  ensureDisplay,
  DEFAULT_DISPLAY,
  defaults
}
