'use strict'
/* ============================================================
   AuraDesk 覆盖层渲染逻辑
   - 桌面常态：左右各一列封面 + 内侧平台图标 + 左下播放器 + 右下时钟
   - 点侧栏第一个图标铺开整页游戏库（搜索 / 筛选 / 右键管理）
   - 进度条支持拖拽（本地音频与 Listen1/SMTC 直播都能跳）
   ============================================================ */

const ICONS = {
  grid: '<rect x="3.2" y="3.2" width="7.4" height="7.4" rx="2.2"/><rect x="13.4" y="3.2" width="7.4" height="7.4" rx="2.2"/><rect x="3.2" y="13.4" width="7.4" height="7.4" rx="2.2"/><rect x="13.4" y="13.4" width="7.4" height="7.4" rx="2.2"/>',
  gamepad: '<rect x="2" y="7" width="20" height="10" rx="5"/><path d="M7.2 10.6v3M5.7 12.1h3"/><circle cx="16" cy="11.2" r=".85" fill="currentColor" stroke="none"/><circle cx="18.2" cy="13.6" r=".85" fill="currentColor" stroke="none"/>',
  chat: '<path d="M20.4 12.2c0 3.7-3.8 6.7-8.4 6.7-1.2 0-2.3-.2-3.3-.6L4.3 20l1.4-3.4c-1-1.2-1.6-2.7-1.6-4.4 0-3.7 3.8-6.7 8.3-6.7s8 3 8 6.7z"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 15.8a5.4 5.4 0 0 0 0-7.6M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 18.6a9.3 9.3 0 0 0 0-13.2"/>',
  bag: '<path d="M6.2 8h11.6l-1.1 12H7.3L6.2 8z"/><path d="M9.2 8V6.4a2.8 2.8 0 0 1 5.6 0V8"/>',
  gem: '<path d="M12 3.4l7.4 6.2L12 20.6 4.6 9.6z"/><path d="M4.6 9.6h14.8"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.6" r="3.4"/><path d="M8.2 7l1.4-2.2h4.8L15.8 7"/>',
  music: '<path d="M9.2 18.2V5.6l9.6-1.9v11.6"/><circle cx="6.9" cy="18.4" r="2.3"/><circle cx="16.5" cy="15.2" r="2.3"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.2v1.9M12 18.9v1.9M5.1 7.8l1.6 1M17.3 15.2l1.6 1M5.1 16.2l1.6-1M17.3 8.8l1.6-1"/>',
  folder: '<path d="M3.4 7.2a2 2 0 0 1 2-2h3.9l2 2.1h7.3a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z"/>',
  terminal: '<rect x="3" y="4.4" width="18" height="15.2" rx="3"/><path d="M7.2 9.4l3 2.9-3 2.9M12.6 15.4h4.2"/>',
  monitor: '<rect x="3" y="4.2" width="18" height="12.2" rx="2.4"/><path d="M8.4 20.2h7.2M12 16.4v3.8"/>',
  search: '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6l4 4"/>',
  play: '<path d="M8.4 5.8l10.4 6.2-10.4 6.2z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7.2" y="5.6" width="3.4" height="12.8" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.4" y="5.6" width="3.4" height="12.8" rx="1.2" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18.6 6.2v11.6L9.8 12z" fill="currentColor" stroke="none"/><rect x="5.4" y="6.2" width="2.2" height="11.6" rx="1" fill="currentColor" stroke="none"/>',
  next: '<path d="M5.4 6.2v11.6L14.2 12z" fill="currentColor" stroke="none"/><rect x="16.4" y="6.2" width="2.2" height="11.6" rx="1" fill="currentColor" stroke="none"/>',
  wifi: '<path d="M4.2 9.4a11 11 0 0 1 15.6 0"/><path d="M7.4 12.6a7 7 0 0 1 9.2 0"/><circle cx="12" cy="16.8" r="1.2" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="8" cy="8.2" r="3"/><path d="M8 2.8v1.6M2.8 8.2h1.6M3.9 4.1l1.1 1.1M12.1 4.1l-1.1 1.1"/><path d="M9.8 19.8h7.6a2.6 2.6 0 0 0 .4-5.2 3.6 3.6 0 0 0-6.8-1 2.7 2.7 0 0 0-1.2 6.2z"/>',
  note: '<path d="M9 18V7l9-1.8v9"/><circle cx="6.8" cy="18.2" r="2.2"/><circle cx="15.8" cy="15.6" r="2.2"/>',
  eyeoff: '<path d="M3.2 3.2l17.6 17.6"/><path d="M10.6 6.5A9.6 9.6 0 0 1 12 6.4c5.2 0 8.8 4.4 8.8 5.6 0 .7-1.2 2.4-3.2 3.7"/><path d="M6.1 8.3C4.1 9.6 3.2 11.2 3.2 12c0 1.2 3.6 5.6 8.8 5.6 1.4 0 2.7-.3 3.8-.8"/><path d="M9.9 10.1a3 3 0 0 0 4.1 4.2"/>',
  chevL: '<path d="M14.6 5.6L8 12l6.6 6.4"/>',
  chevR: '<path d="M9.4 5.6L16 12l-6.6 6.4"/>',
  plus: '<path d="M12 5.4v13.2M5.4 12h13.2"/>',
  list: '<path d="M4.2 6.6h15.6M4.2 12h15.6M4.2 17.4h9.6"/>'
}

const WIDGET_DEFS = {
  w_steam: { icon: 'gamepad', label: '游戏库', action: 'library' },
  w_discord: { icon: 'chat', label: '聊天' },
  w_obs: { icon: 'broadcast', label: '录制/直播' },
  w_shop: { icon: 'bag', label: '商店' },
  w_gem: { icon: 'gem', label: '助手' },
  w_camera: { icon: 'camera', label: '截图' },
  w_music: { icon: 'music', label: '音乐' },
  w_folder: { icon: 'folder', label: '文件夹' },
  w_terminal: { icon: 'terminal', label: '终端' },
  w_monitor: { icon: 'monitor', label: '显示器' },
  w_settings: { icon: 'gear', label: '设置', action: 'settings' }
}

const $ = (id) => document.getElementById(id)
const clamp01 = (n) => Math.max(0, Math.min(1, n))

/* 未捕获异常上报主进程写日志：渲染层挂了在用户机器上谁都看不见，
   日志里能看到 boot 断在哪一步（沙箱复现不了的问题的关键线索） */
function reportErr (kind, err) {
  try {
    const e = err && err.reason ? err.reason : err
    window.aura && window.aura.reportError &&
      window.aura.reportError(kind, (e && e.message) || String(e), (e && e.stack) || '')
  } catch {}
}
window.addEventListener('error', (e) => reportErr('error', e.error || e.message))
window.addEventListener('unhandledrejection', (e) => reportErr('unhandledrejection', e.reason))

let S = null
let audio = null
let lyricIdx = -2
let simTime = 0
let simTimer = null
let tickTimer = null
let liveClock = null
let libOpen = false
let libQuery = ''
let libSrc = 'all'
let libView = []
let games = []

// launcher：卡片运行状态（id -> {h,min,fg}）、音量、音频设备
let apps = {}
let vol = { v: null, m: false }
let devs = { out: [], in: [], cur: '', curIn: '' }
let hoverGame = null // 当前悬停的卡片对应游戏（气泡跟随状态刷新）
let ctlPopTimer = null

function svg (name, cls) {
  const body = ICONS[name] || ICONS.gem
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ''}>${body}</svg>`
}

function esc (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function fmt (sec) {
  if (!sec || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m + ':' + String(s).padStart(2, '0')
}

/* -------------------------------------------------------- 缩放与壁纸 */

function applyScale () {
  const h = window.innerHeight || 1080
  const w = window.innerWidth || 1920
  let ui = h / 1080
  ui = Math.min(1.34, Math.max(0.76, ui))
  // 超宽屏不要跟着高度无限放大
  ui = Math.min(ui, (w / 1920) * 1.15)
  ui *= (S && S.cfg.ui.scale) || 1
  document.documentElement.style.setProperty('--ui', ui.toFixed(3))
}

function applyWallpaper () {
  const wp = (S && S.cfg.wallpaper) || {}
  const type = wp.type || 'desktop'
  // desktop：整窗透明，壁纸交给桌面（Wallpaper Engine / 系统壁纸），我们只画组件
  document.body.dataset.wall = type
  const dim = wp.dim == null ? 0.06 : wp.dim
  document.documentElement.style.setProperty('--dim', dim)
}

/* --------------------------------------------------------- 侧边栏 */

function renderDock () {
  const ui = S.cfg.ui
  const dock = $('dock')
  dock.hidden = ui.showDock === false
  dock.dataset.side = 'left'

  const host = $('iconsL')
  if (host && dock.parentElement !== host) host.appendChild(dock)
  const hr = document.querySelector('.rail-hr')
  if (hr) hr.hidden = dock.hidden

  $('dockLib').innerHTML = svg('list')
  $('dockAura').innerHTML = svg('chat')
  $('dockLib').classList.toggle('is-active', libOpen)
  $('dockSet').innerHTML = svg('gear')
  $('dockHide').innerHTML = svg('eyeoff')
}

/* ------------------------------------------------- 左右两列封面 */

/* 桌面常态就是这张参考图的布局：左右各一列封面，中间留壁纸。
   平台图标用来筛「只看这一家的」，点一下切换，再点回到全部。 */

let railSrc = 'all'

const PLAT_DEFS = [
  { id: 'all', label: '全部游戏', icon: 'grid', acc: 'rgba(255, 255, 255, .86)' },
  { id: 'steam', label: 'Steam', icon: 'gamepad', acc: '#8ecdf3' },
  { id: 'epic', label: 'Epic', icon: 'gem', acc: '#c9b8ff' },
  { id: 'local', label: '本地 / 快捷方式', icon: 'folder', acc: '#9fe0bd' }
]

function platDefs () {
  return PLAT_DEFS.filter((d) => d.id === 'all' || games.some((g) => inTab(g, d.id)))
}

function renderPlats () {
  const defs = platDefs()
  const box = $('platL')
  if (!box) return
  box.innerHTML = ''
  for (const d of defs) {
    const b = document.createElement('button')
    b.className = 'plat-btn'
    b.dataset.hot = ''
    b.dataset.src = d.id
    b.title = d.label
    b.style.setProperty('--acc', d.acc)
    b.classList.toggle('is-on', railSrc === d.id)
    b.innerHTML = svg(d.icon)
    b.addEventListener('click', () => {
      railSrc = railSrc === d.id ? 'all' : d.id
      renderRails()
    })
    box.appendChild(b)
  }
}

function railList () {
  const raw = gameList()
  // 拖过顺序之后就以用户摆的为准，不再按「有没有封面」自动排
  const mine = Array.isArray(S.gameOrder) && S.gameOrder.length
  if (railSrc !== 'all') {
    const list = raw.filter((g) => inTab(g, railSrc))
    return mine ? list : sortByArt(list)
  }
  // 没拖过时：有封面的排前面（Steam/Epic 的海报是桌面主体，色块放后面）
  // （Array#sort 是稳定的，同组内保持原来的「最近玩过」顺序）
  return mine ? raw : sortByArt(raw)
}

function sortByArt (list) {
  const hasArt = (g) => !!(g.coverUrl || g.coverRemote || g.iconUrl)
  return list.slice().sort((a, b) => (hasArt(a) ? 0 : 1) - (hasArt(b) ? 0 : 1))
}

/* 按行数反推封面宽度：竖版卡片，高度 = 宽度 × TILE_RATIO */
// 每栏几行：4 = 大卡片（默认），5 = 标准，6 = 紧凑
function railRowCount () {
  const n = Number(S && S.cfg && S.cfg.ui && S.cfg.ui.railRows)
  return n >= 3 && n <= 8 ? n : 4
}

function fitRail (rows) {
  const host = $('rails')
  if (!host || !host.clientHeight) return
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const cssRatio = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tile-ratio'))
  const ratio = cssRatio > 0 ? cssRatio : 1.45
  const zoom = uiZoom()
  // rem 里已经含了整体缩放，先还原成「100% 时的 rem」再算基准尺寸，
  // 否则卡片会被反推出的宽度抵消掉，拉比例时纹丝不动（以前就是这个毛病）
  const remBase = rem / zoom
  const gap = .42 * rem
  // 与 style.css 里 .rail-grid 的上下 padding 对齐：那圈留白是给悬停放大用的
  const padV = .55 * rem
  const avail = host.clientHeight - remBase * .5 - padV * 2
  const max = 11.4 * remBase
  const min = 4.6 * remBase
  // 每行高 = w * ratio，总高 = rows * w * ratio + 行间距
  let base = rows > 0 ? (avail - (rows - 1) * gap) / (rows * ratio) : max
  base = Math.max(min, Math.min(max, base))
  // 基准宽 × 整体缩放 = 实际宽。放大后放不下就滚动，缩小就留白，比例滑块才有反馈
  const w = Math.max(1, Math.round(base * zoom))
  document.documentElement.style.setProperty('--rail-w', (w / rem).toFixed(3) + 'rem')
  // 可视高度锁成「正好 N 行」（按 100% 算），多的整张滚出去，不会在底部露出半张
  const h = Math.round(rows * base * ratio + (rows - 1) * gap + padV * 2 + remBase * .2)
  for (const id of ['gridL', 'gridR']) {
    const el = $(id)
    if (el) el.style.maxHeight = h + 'px'
  }
}

/** 设置里的「界面比例」，钳在滑块允许的范围里 */
function uiZoom () {
  const n = Number(S && S.cfg && S.cfg.ui && S.cfg.ui.scale)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.max(.75, Math.min(1.4, n))
}

function fillRail (box, list, quiet) {
  if (!box) return
  box.innerHTML = ''
  list.forEach((g, i) => {
    const el = makeTile(g, i, quiet)
    tileMap.set(String(g.id), el)
    box.appendChild(el)
  })
  // 滚到顶就不画顶部渐隐，滚到底就不画底部渐隐：
  // 不滚动时看起来就是干净的整行卡片，能滚的时候才露一点提示
  const sync = () => {
    const more = box.scrollHeight > box.clientHeight + 2
    const atTop = box.scrollTop <= 4
    const atBot = box.scrollTop + box.clientHeight >= box.scrollHeight - 4
    box.classList.toggle('ovf-top', more && !atTop)
    box.classList.toggle('ovf-bot', more && !atBot)
  }
  box._sync = sync
  if (!box._scrollBound) {
    box._scrollBound = true
    box.addEventListener('scroll', () => box._sync && box._sync(), { passive: true })
  }
  box.scrollTop = 0
  requestAnimationFrame(sync)
}

let lastRailPaint = 0

function renderRails () {
  games = gameList()
  const rows = railRowCount()
  // 一屏放 rows 行，多的往下滚（滚轮 / 触控板），不裁也不丢
  const list = railList()
  // 左右交替分：两侧都能分到封面好看的，不会一边全是色块
  const left = []
  const right = []
  list.forEach((g, i) => (i % 2 === 0 ? left : right).push(g))
  fitRail(rows)
  // 拖完顺序 / 改个开关会重建一遍卡片，这时候别重播入场动画，不然闪一下
  const quiet = performance.now() - lastRailPaint < 900
  lastRailPaint = performance.now()
  tileMap.clear()
  fillRail($('gridL'), left, quiet)
  fillRail($('gridR'), right, quiet)
  const empty = list.length === 0
  $('rails').hidden = empty
  $('railEmpty').hidden = !empty
  renderPlats()
}

/* ------------------------------------------------- 拖拽调整卡片位置 */

/* 侧栏是「左栏一张、右栏一张」交替铺的，所以拖拽的其实是「一个全局序号」：
   把卡片拖到哪一格，就把它插到那一格的位置，两栏会跟着整体错位重排。
   松手后整份顺序存进配置，下次启动还是这个样子。 */

const tileMap = new Map() // game.id -> 卡片元素
const DND = {
  el: null,        // 按下去的那张卡
  pointerId: 0,
  from: { x: 0, y: 0 },
  grab: { x: 0, y: 0 },   // 指针相对卡片左上角的偏移
  active: false,
  ghost: null,
  list: [],        // 拖拽开始时的顺序（只含当前筛选出来的）
  idx: -1,
  x: 0,
  y: 0,
  raf: 0,
  suppressUntil: 0
}

function railTileOf (target) {
  if (!target || !target.closest) return null
  return target.closest('.rail-grid .tile')
}

function onRailDown (e) {
  if (libOpen || e.button !== 0) return
  const el = railTileOf(e.target)
  if (!el) return
  DND.el = el
  DND.pointerId = e.pointerId
  DND.from = { x: e.clientX, y: e.clientY }
  DND.active = false
  window.addEventListener('pointermove', onRailMove, true)
  window.addEventListener('pointerup', onRailUp, true)
  window.addEventListener('pointercancel', onRailUp, true)
}

function onRailMove (e) {
  if (!DND.el) return
  if (!DND.active) {
    const dx = e.clientX - DND.from.x
    const dy = e.clientY - DND.from.y
    if (dx * dx + dy * dy < 36) return
    if (!startDrag(e)) return
  }
  DND.x = e.clientX
  DND.y = e.clientY
  if (DND.raf) return
  DND.raf = requestAnimationFrame(() => {
    DND.raf = 0
    moveGhost()
    reorderToCursor()
  })
}

function startDrag (e) {
  const el = DND.el
  const id = String(el.dataset.id || '')
  const list = railList().slice()
  const idx = list.findIndex((g) => String(g.id) === id)
  if (idx < 0) return false
  const r = el.getBoundingClientRect()
  DND.active = true
  DND.list = list
  DND.idx = idx
  DND.grab = { x: DND.from.x - r.left, y: DND.from.y - r.top }
  DND.x = DND.from.x
  DND.y = DND.from.y

  // 跟着鼠标走的浮层：直接克隆卡片，连封面一起带过来
  const ghost = el.cloneNode(true)
  ghost.className = 'tile tile-ghost'
  ghost.style.width = r.width + 'px'
  ghost.style.height = r.height + 'px'
  ghost.style.left = r.left + 'px'
  ghost.style.top = r.top + 'px'
  document.body.appendChild(ghost)
  DND.ghost = ghost
  el.classList.add('is-dragging')
  document.body.classList.add('rail-dragging')
  // 拖出卡片范围后不能让鼠标穿透，否则事件直接丢了
  scheduleShape()
  try { el.setPointerCapture(e.pointerId) } catch {}
  return true
}

function moveGhost () {
  const gh = DND.ghost
  if (!gh) return
  const x = DND.x - DND.grab.x - parseFloat(gh.style.left || 0)
  const y = DND.y - DND.grab.y - parseFloat(gh.style.top || 0)
  gh.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) scale(1.06)`
}

/** 离指针最近的那张卡就是目标位置 */
function nearestSlot (x, y) {
  let best = -1
  let bestD = Infinity
  DND.list.forEach((g, i) => {
    const el = tileMap.get(String(g.id))
    if (!el) return
    const r = el.getBoundingClientRect()
    const dx = r.left + r.width / 2 - x
    const dy = r.top + r.height / 2 - y
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

function reorderToCursor () {
  if (!DND.active) return
  const target = nearestSlot(DND.x, DND.y)
  if (target < 0 || target === DND.idx) return
  const [item] = DND.list.splice(DND.idx, 1)
  DND.list.splice(target, 0, item)
  DND.idx = target
  placeTiles()
}

/** 按 DND.list 重新摆放两栏。appendChild / insertBefore 只搬节点，图片不会重新加载 */
function placeTiles () {
  const L = $('gridL')
  const R = $('gridR')
  if (!L || !R) return
  const wantL = []
  const wantR = []
  DND.list.forEach((g, i) => {
    const el = tileMap.get(String(g.id))
    if (!el) return
    ;(i % 2 === 0 ? wantL : wantR).push(el)
  })
  ;[[L, wantL], [R, wantR]].forEach(([box, want]) => {
    want.forEach((el, i) => {
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null)
    })
    if (box._sync) box._sync()
  })
}

function onRailUp () {
  window.removeEventListener('pointermove', onRailMove, true)
  window.removeEventListener('pointerup', onRailUp, true)
  window.removeEventListener('pointercancel', onRailUp, true)
  if (!DND.active) {
    DND.el = null
    return
  }
  commitOrder()
  if (DND.ghost) {
    DND.ghost.remove()
    DND.ghost = null
  }
  if (DND.el) DND.el.classList.remove('is-dragging')
  document.body.classList.remove('rail-dragging')
  DND.el = null
  DND.active = false
  // 松手后按当前热区恢复输入形状
  scheduleShape()
  // 松手这一下还会补一个 click，别让它顺手把游戏启动起来
  DND.suppressUntil = performance.now() + 400
}

/**
 * 把当前筛选下的新顺序映射回完整顺序：
 * 只挪被拖的这几张占的格子，没显示出来的游戏原地不动。
 */
function commitOrder () {
  const subset = DND.list.slice()
  const full = gameList()
  const set = new Set(subset.map((g) => String(g.id)))
  const slots = []
  full.forEach((g, i) => {
    if (set.has(String(g.id))) slots.push(i)
  })
  if (!slots.length || slots.length !== subset.length) return
  const out = full.slice()
  slots.forEach((slot, i) => { out[slot] = subset[i] })
  const ids = out.map((g) => String(g.id))
  S.gameOrder = ids
  window.aura.setGameOrder(ids)
}

/* --------------------------------------------------------- 游戏库 */

/* 这里刻意不用 PS5 手柄那套「悬停选中 + 确认键启动」：
   鼠标滑过只是高亮，点封面就启动，右键才有多余操作。 */

const SRC_TABS = [
  { id: 'all', label: '全部' },
  { id: 'steam', label: 'Steam' },
  { id: 'epic', label: 'Epic' },
  { id: 'local', label: '本地' }
]

function gameList () {
  const lib = (S.library || []).slice()
  if (!lib.length && S.games) lib.push(...(S.games.left || []), ...(S.games.right || []))
  return lib
}

function sourceLabel (g) {
  if (g.source === 'steam') return 'Steam'
  if (g.source === 'epic') return 'Epic'
  if (g.source === 'startmenu') return '开始菜单'
  if (g.kind === 'lnk') return '快捷方式'
  return '本地程序'
}

function hueOf (g) {
  if (g.hue != null) return g.hue
  let h = 0
  const name = String(g.name || '')
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

function inTab (g, tab) {
  if (tab === 'all') return true
  if (tab === 'steam') return g.source === 'steam'
  if (tab === 'epic') return g.source === 'epic'
  return g.source !== 'steam' && g.source !== 'epic'
}

function viewGames () {
  const q = libQuery.trim().toLowerCase()
  return games.filter((g) => {
    if (!inTab(g, libSrc)) return false
    if (!q) return true
    return String(g.name || '').toLowerCase().includes(q)
  })
}

function renderChips () {
  const box = $('libChips')
  box.innerHTML = ''
  if (!games.length) return
  for (const tab of SRC_TABS) {
    const n = games.filter((g) => inTab(g, tab.id)).length
    if (tab.id !== 'all' && !n) continue
    const b = document.createElement('button')
    b.className = 'chip'
    b.dataset.hot = ''
    b.classList.toggle('is-on', libSrc === tab.id)
    b.innerHTML = `${esc(tab.label)}<span class="n">${n}</span>`
    b.addEventListener('click', () => {
      if (libSrc === tab.id) return
      libSrc = tab.id
      renderLibrary()
    })
    box.appendChild(b)
  }
}

function renderLibrary () {
  const grid = $('libGrid')
  const empty = $('libEmpty')
  grid.innerHTML = ''
  $('libCount').textContent = games.length ? `${games.length} 个` : ''
  renderChips()

  libView = viewGames()
  const filtered = libView.length !== games.length

  if (!libView.length) {
    empty.hidden = false
    $('libEmptyTitle').textContent = games.length ? '没有匹配的游戏' : '还没有游戏'
    $('libEmptySub').textContent = games.length
      ? '换个关键词，或者切回「全部」'
      : '从 Steam / Epic 导入，或者扫描开始菜单里已经装好的程序'
    $('libEmptyBtn').hidden = !!games.length
    $('libSub').textContent = games.length ? '换个关键词试试' : '先往库里放点东西'
    $('libGlow').classList.remove('on')
    return
  }

  empty.hidden = true
  $('libSub').textContent = filtered ? `筛选出 ${libView.length} 个 · 右键更多操作` : '点封面直接启动 · 右键更多操作'

  libView.forEach((g, i) => grid.appendChild(makeTile(g, i)))

  // 末尾放一个添加入口，省得为了加一个程序去翻设置
  const add = document.createElement('button')
  add.className = 'tile tile-add'
  add.dataset.hot = ''
  add.title = '打开设置添加游戏'
  add.innerHTML = `<div class="tile-art">${svg('plus')}</div><div class="tile-name">添加游戏</div>`
  add.addEventListener('click', () => window.aura.openSettings())
  grid.appendChild(add)

  setAmbient(libView[0])
}

/* 一张封面卡片：两侧栏和整页库共用，单击直接启动 */
function makeTile (g, i, quiet) {
  const b = document.createElement('button')
  b.className = 'tile'
  b.dataset.hot = ''
  b.dataset.id = g.id
  b._game = g // 触屏长按弹菜单时要从元素反查游戏
  b.title = `${g.name}\n${sourceLabel(g)}${g.target ? '\n' + g.target : ''}`
  b.style.setProperty('--h', hueOf(g))
  b.style.animationDelay = Math.min((i || 0) * 12, 240) + 'ms'
  if (quiet) b.classList.add('no-in')
  // 用 <img> 而不是 background-image：封面文件丢了还能回落到线上封面 / 图标 / 文字块
  b.innerHTML = tileArtHtml(g) + `<div class="tile-name">${esc(g.name)}</div>`

  const img = b.querySelector('.tile-img')
  if (img) {
    img.addEventListener('error', () => {
      // 本地缓存没了就换线上地址再试一次，两张都挂才退回图标 / 色块
      if (g.coverRemote && !img.dataset.retried && img.getAttribute('src') !== g.coverRemote) {
        img.dataset.retried = '1'
        img.src = g.coverRemote
        return
      }
      downgradeArt(b, g)
    })
  }

  b.addEventListener('pointerenter', () => { setAmbient(g); showAppBubble(b, g) })
  b.addEventListener('focus', () => setAmbient(g))
  b.addEventListener('pointerleave', () => { if (hoverGame === g) scheduleBubbleHide() })
  b.addEventListener('click', () => {
    // 刚刚拖完的那一下不算点击
    if (performance.now() < DND.suppressUntil) return
    onLaunch(b, g)
  })
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (DND.active) return
    openCtx(e.clientX, e.clientY, g)
  })
  return b
}

/* 卡片悬停状态气泡：程序在运行时，悬停放大的同时旁边弹出聊天气泡。
   挂在 body 上用 fixed 定位——侧栏是滚动容器，挂卡片里会被 overflow 裁掉 */
function appStateText (a) {
  if (!a) return ''
  if (a.tray) return '运行中 · 在托盘'
  if (a.fg) return '运行中 · 正在前台'
  if (a.min) return '运行中 · 最小化'
  return '运行中 · 在后台'
}

let bubbleShotTimer = null
let bubbleHideTimer = null

/* 延迟隐藏：鼠标从卡片移进气泡要经过一小段空隙，直接隐藏会让气泡永远点不到 */
function scheduleBubbleHide () {
  clearTimeout(bubbleHideTimer)
  bubbleHideTimer = setTimeout(() => { bubbleHideTimer = null; hideAppBubble() }, 260)
}

function hideAppBubble () {
  clearTimeout(bubbleHideTimer)
  bubbleHideTimer = null
  clearInterval(bubbleShotTimer)
  bubbleShotTimer = null
  const b = document.getElementById('appBubble')
  if (b) b.remove()
  hoverGame = null
  scheduleShape()
}

function showAppBubble (tile, g) {
  const a = apps[g.id]
  hideAppBubble()
  if (!a) return // 没运行就不打扰
  hoverGame = g
  const r = tile.getBoundingClientRect()
  if (!r.width) return
  const bubble = document.createElement('div')
  bubble.id = 'appBubble'
  bubble.className = 'app-bubble' + (a.fg ? ' live' : '')
  bubble.setAttribute('data-hot', '')
  bubble.innerHTML =
    '<div class="bubble-shot-wrap">' +
      '<img class="bubble-shot" alt="" draggable="false">' +
      '<img class="bubble-shot alt" alt="" draggable="false">' +
    '</div>' +
    `<div class="bubble-state">${esc(appStateText(a))}</div>`
  bubble.style.left = Math.round(r.left + r.width / 2) + 'px'
  bubble.style.top = Math.round(r.top - 6) + 'px'
  // 气泡本身可点 = 打开 / 切换到这个程序（与点卡片同效）
  bubble.addEventListener('pointerenter', () => clearTimeout(bubbleHideTimer))
  bubble.addEventListener('pointerleave', scheduleBubbleHide)
  bubble.addEventListener('click', () => {
    if (performance.now() < DND.suppressUntil) return
    hideAppBubble()
    onLaunch(tile, g)
  })
  document.body.appendChild(bubble)
  scheduleShape()

  // 有窗口句柄才做实时预览（托盘驻留抓不到，只显示文字状态）
  if (a.h == null || !Number.isFinite(Number(a.h))) return
  const imgs = bubble.querySelectorAll('.bubble-shot')
  let front = imgs[0]
  let lastUrl = ''
  const pull = async () => {
    if (hoverGame !== g) return
    try {
      const s = await window.aura.windowShot(a.h)
      if (!s || !s.ok || !s.url || hoverGame !== g) return
      if (s.url === lastUrl) return
      lastUrl = s.url
      const state = bubble.querySelector('.bubble-state')
      if (state) state.textContent = s.cached ? '最小化 · 最后画面' : appStateText(a)
      // 先离屏解码，加载完成后交叉切换——换图不再闪
      const probe = new Image()
      probe.onload = () => {
        if (hoverGame !== g) return
        const back = front === imgs[0] ? imgs[1] : imgs[0]
        back.src = s.url
        back.classList.add('on')
        front.classList.remove('on')
        front = back
        const wrap = bubble.querySelector('.bubble-shot-wrap')
        if (wrap) wrap.classList.add('on')
      }
      probe.src = s.url
    } catch { /* 截图失败保持纯文字气泡 */ }
  }
  pull()
  bubbleShotTimer = setInterval(pull, 2500) // 悬停期间低频刷新，窗口画面保持"活的"
}

/** 运行状态推送更新：刷新悬停中卡片的气泡 */
function refreshHoverBubble () {
  if (!hoverGame) return
  const tile = document.querySelector(`.tile[data-id="${CSS.escape(hoverGame.id)}"]`)
  if (!tile) { hoverGame = null; return }
  showAppBubble(tile, hoverGame)
}

/** 封面 > 程序图标 > 名字色块，三级回退 */
function tileArtHtml (g) {
  if (g.coverUrl || g.coverRemote) {
    return `<div class="tile-art"><img class="tile-img" src="${esc(g.coverUrl || g.coverRemote)}" alt="" loading="lazy" draggable="false"></div>`
  }
  if (g.iconUrl) return iconArtHtml(g)
  return `<div class="tile-art"><div class="tile-fallback">${esc(g.name)}</div></div>`
}

/* 没有海报的程序：原图标居中，同一张图放大 + 模糊当背景，比纯色块有辨识度 */
function iconArtHtml (g) {
  const src = esc(g.iconUrl || '')
  return `<div class="tile-art tile-art-icon">` +
    `<img class="tile-icon-bg" src="${src}" alt="" draggable="false">` +
    `<span class="tile-icon-veil"></span>` +
    `<img class="tile-icon" src="${src}" alt="" draggable="false">` +
    `</div>`
}

function downgradeArt (b, g) {
  const box = b.querySelector('.tile-art')
  if (!box) return
  if (g.iconUrl) {
    const holder = document.createElement('div')
    holder.innerHTML = iconArtHtml(g)
    b.replaceChild(holder.firstElementChild, box)
    return
  }
  if (box.querySelector('.tile-fallback')) return
  box.className = 'tile-art'
  box.innerHTML = `<div class="tile-fallback">${esc(g.name)}</div>`
}

/* 只是背景氛围色，不参与任何选中逻辑 */
function setAmbient (g) {
  if (!g) return
  const glow = $('libGlow')
  if (g.coverUrl) {
    glow.style.backgroundImage = `url("${g.coverUrl}")`
    glow.classList.add('on')
  } else if (g.hue != null) {
    glow.style.backgroundImage = `linear-gradient(140deg, hsl(${g.hue} 70% 55%), hsl(${(g.hue + 50) % 360} 65% 26%))`
    glow.classList.add('on')
  } else {
    glow.classList.remove('on')
  }
}

function openLib () {
  if (libOpen) { closeLib(); return }
  games = gameList()
  libOpen = true
  libQuery = ''
  libSrc = 'all'
  hideAppBubble()
  $('libSearch').value = ''
  $('library').hidden = false
  document.body.classList.add('lib-open')
  renderLibrary()
  renderDock()
  $('libScroll').scrollTop = 0
  // 整块面板都在吃鼠标，热区切到全窗
  scheduleShape()
}

function closeLib () {
  if (!libOpen) return
  libOpen = false
  hideCtx()
  hideAppBubble()
  $('library').hidden = true
  document.body.classList.remove('lib-open')
  $('libGlow').classList.remove('on')
  renderDock()
  renderRails()
  scheduleShape()
}

/* 方向键在网格里走位，回车直接启动（按钮原生行为） */
function moveFocus (delta) {
  const els = [...$('libGrid').children]
  if (!els.length) return
  let i = els.indexOf(document.activeElement)
  if (i < 0) i = 0
  const next = Math.max(0, Math.min(els.length - 1, i + delta))
  els[next].focus({ preventScroll: false })
}

function gridColumns () {
  const els = [...$('libGrid').children]
  if (!els.length) return 1
  const top = els[0].offsetTop
  let n = 0
  for (const el of els) {
    if (el.offsetTop !== top) break
    n++
  }
  return Math.max(1, n)
}

function scrollPage (dir) {
  const box = $('libScroll')
  const d = box.clientHeight * 0.9 * dir
  if (typeof box.scrollBy === 'function') box.scrollBy({ top: d, behavior: 'smooth' })
  else box.scrollTop += d
}

/* ------------------------------------------------------- 右键菜单 */

let ctxGame = null

function openCtx (x, y, g) {
  ctxGame = g
  const m = $('ctx')
  m.hidden = false
  m.style.left = '0px'
  m.style.top = '0px'
  const r = m.getBoundingClientRect()
  const w = r.width || 172
  const h = r.height || 120
  m.style.left = Math.min(x, Math.max(0, window.innerWidth - w - 8)) + 'px'
  m.style.top = Math.min(y, Math.max(0, window.innerHeight - h - 8)) + 'px'
  // 菜单开着的时候整窗接输入，不然移向菜单的路上就断在热区外了
  scheduleShape()
}

function hideCtx () {
  if (ctxGame) ctxGame = null
  const m = $('ctx')
  if (m.hidden) return
  m.hidden = true
  scheduleShape()
}

async function ctxAction (act) {
  const g = ctxGame
  hideCtx()
  if (!g) return
  if (act === 'launch') {
    const tile = [...$('libGrid').children].find((el) => el.dataset.id === g.id)
    if (tile) onLaunch(tile, g)
    else window.aura.launch(g.id)
    return
  }
  if (act === 'reveal') {
    const ok = await window.aura.reveal(g.id)
    if (ok === false) toast('这条没有本地文件位置')
    return
  }
  if (act === 'remove') {
    await window.aura.remove(g.id)
    toast(`已移除「${g.name}」`)
  }
}

async function onLaunch (tile, game) {
  hideCtx()
  // 已在运行（有窗口可切）：卡片就是任务切换入口——切到那个窗口，而不是再开一个
  const a = apps[game.id]
  if (a && a.h != null) {
    toast('正在切换到「' + game.name + '」')
    window.aura.toggleApp(game.id)
    if (libOpen) closeLib()
    return
  }
  // 托盘驻留 / 无窗口：只能重新拉起（多半会被已运行实例接管）
  tile.classList.remove('pulse')
  void tile.offsetWidth
  tile.classList.add('pulse')
  const res = await window.aura.launch(game.id)
  if (res && !res.ok) {
    toast(res.message || '启动失败')
    return
  }
  setTimeout(() => {
    if (libOpen) closeLib()
    tile.classList.remove('pulse')
  }, 320)
}

/* ---------------------------------------------------------- 播放器 */

async function setupPlayer () {
  $('pPlay').innerHTML = svg('pause')
  $('pPrev').innerHTML = svg('prev')
  $('pNext').innerHTML = svg('next')

  clearInterval(tickTimer)
  tickTimer = null
  renderPlayerMeta()

  if (!S.track) {
    applyProgress(0, 0)
    updateLyrics(0)
    return
  }

  // 直播歌曲（系统媒体会话 / Listen1）：没有本地音频，只跟随主进程推送
  if (S.track.live) {
    if (audio) {
      try { audio.pause() } catch {}
      audio = null
    }
    clearInterval(simTimer)
    simTimer = null
    liveClock = {
      time: S.playback.time || 0,
      duration: S.playback.duration || 0,
      playing: !!S.playback.playing,
      at: performance.now()
    }
    applyProgress(liveClock.time, liveClock.duration)
    setPlayingIcon(liveClock.playing)
    updateLyrics(liveClock.time)
    return
  }
  liveClock = null

  if (!S.isOwner) {
    // 只有主屏持有音频，其它屏仅同步进度与歌词
    applyProgress(S.playback.time || 0, S.playback.duration || 0)
    updateLyrics(S.playback.time || 0)
    return
  }

  if (S.track.url) {
    audio = new Audio()
    audio.src = S.track.url
    audio.preload = 'auto'
    audio.addEventListener('timeupdate', () => {
      if (dragging) return
      applyProgress(audio.currentTime, audio.duration || S.track.duration || 0)
      updateLyrics(audio.currentTime)
    })
    audio.addEventListener('ended', () => nextTrack())
    audio.addEventListener('error', () => toast('音频加载失败：' + S.track.title))
    audio.play().then(() => setPlayingIcon(true)).catch(() => setPlayingIcon(false))
  } else {
    simTime = S.playback.time || 0
    startSim()
  }

  tickTimer = setInterval(() => {
    const st = audio
      ? { time: audio.currentTime, duration: audio.duration || S.track.duration || 0, playing: !audio.paused, trackId: S.track.id }
      : { time: simTime, duration: S.track.duration || 0, playing: !!simTimer, trackId: S.track.id }
    window.aura.tick(st)
  }, 700)
}

function renderPlayerMeta () {
  const track = S.track
  const cover = $('pCover')
  if (!track) {
    $('pTitle').textContent = '未在播放'
    $('pArtist').textContent = S.musicSource === 'local' ? '设置 → 音乐里添加目录' : '在 Listen1 里放一首歌'
    cover.style.backgroundImage = ''
    cover.innerHTML = svg('note')
    return
  }
  $('pTitle').textContent = track.title
  $('pArtist').textContent = track.artist || track.album || (track.live ? 'Listen1' : '未知艺术家')
  if (track.coverUrl) {
    cover.style.backgroundImage = `url("${track.coverUrl}")`
    cover.innerHTML = ''
  } else {
    cover.style.backgroundImage = ''
    cover.innerHTML = svg('note')
  }
}

function startSim () {
  clearInterval(simTimer)
  simTimer = setInterval(() => {
    simTime += 0.25
    if (simTime > (S.track.duration || 189)) simTime = 0
    if (dragging) return
    applyProgress(simTime, S.track.duration || 189)
    updateLyrics(simTime)
  }, 250)
}

function setPlayingIcon (playing) {
  $('pPlay').innerHTML = svg(playing ? 'pause' : 'play')
}

function currentDuration () {
  if (liveClock && liveClock.duration) return liveClock.duration
  if (audio && isFinite(audio.duration) && audio.duration > 0) return audio.duration
  return (S.track && S.track.duration) || 0
}

function applyProgress (time, duration) {
  const d = duration || 0
  const pct = d > 0 ? Math.min(100, (time / d) * 100) : 0
  $('barFill').style.width = pct + '%'
  $('barDot').style.left = pct + '%'
  $('tCur').textContent = fmt(time)
  $('tDur').textContent = fmt(d)
}

function currentPlayTime () {
  if (audio) return audio.currentTime
  if (liveClock) {
    const t = liveClock.time + (liveClock.playing ? (performance.now() - liveClock.at) / 1000 : 0)
    return liveClock.duration ? Math.min(t, liveClock.duration) : t
  }
  if (simTimer) return simTime
  return (S.playback && S.playback.time) || 0
}

function updateLyrics (time) {
  const box = $('lyrics')
  if (!box) return
  const lines = (S.track && S.track.lyricLines) || []
  // 直播歌曲（Listen1 / 网易云…）的歌词由主进程按名字联网找好再推下来，
  // 所以这里不再按 live 区分，只看有没有拿到带时间轴的行。
  if (!S.track || !lines.length || (S.cfg && S.cfg.ui && S.cfg.ui.showLyrics === false)) {
    if (!box.hidden || box.innerHTML) {
      box.hidden = true
      box.innerHTML = ''
    }
    lyricIdx = -2
    return
  }
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= time + 0.15) idx = i
    else break
  }
  box.hidden = false
  if (idx === lyricIdx) return
  lyricIdx = idx
  const cur = lines[idx]
  const nxt = lines[idx + 1]
  box.innerHTML =
    `<div class="l1">${esc(cur ? cur.text : '')}</div>` +
    (nxt ? `<div class="l2">${esc(nxt.text)}</div>` : '')
}

function togglePlay () {
  if (S.track && S.track.live) {
    window.aura.player('toggle')
    if (liveClock) {
      liveClock.playing = !liveClock.playing
      liveClock.at = performance.now()
      setPlayingIcon(liveClock.playing)
    }
    return
  }
  if (audio) {
    if (audio.paused) audio.play().then(() => setPlayingIcon(true)).catch(() => {})
    else { audio.pause(); setPlayingIcon(false) }
  } else if (S.track) {
    if (simTimer) { clearInterval(simTimer); simTimer = null; setPlayingIcon(false) } else { startSim(); setPlayingIcon(true) }
  }
}

/* ------------------------------ 进度条：点按 + 拖拽（含 SMTC 跳转） */

let dragging = false
let dragRatio = 0
let seekHoldAt = 0
let seekHoldTarget = 0
let pushMark = { time: -1, at: 0 }

function ratioAt (clientX) {
  const bar = $('progress').querySelector('.cc-bar').getBoundingClientRect()
  if (!bar.width) return 0
  return clamp01((clientX - bar.left) / bar.width)
}

function previewSeek (ratio) {
  const d = currentDuration()
  if (!d) return
  dragRatio = ratio
  applyProgress(ratio * d, d)
}

function seekTo (sec) {
  const d = currentDuration()
  const t = Math.max(0, Math.min(d || sec, sec))
  if (S.track && S.track.live) {
    // 交给主进程转发给 Listen1（SMTC TryChangePlaybackPosition）
    window.aura.player('seek', t)
    seekHoldAt = performance.now()
    seekHoldTarget = t
    if (liveClock) {
      liveClock.time = t
      liveClock.at = performance.now()
    } else {
      liveClock = { time: t, duration: d, playing: !!(S.playback && S.playback.playing), at: performance.now() }
    }
    applyProgress(t, d)
    updateLyrics(t)
    return
  }
  if (audio) {
    audio.currentTime = t
    applyProgress(t, d)
    updateLyrics(t)
    return
  }
  if (S.isOwner) {
    simTime = t
    applyProgress(t, d)
    updateLyrics(t)
    return
  }
  // 副屏：没有音频，让主屏去跳
  window.aura.player('seek', t)
  S.playback = { ...(S.playback || {}), time: t, duration: d }
  applyProgress(t, d)
  updateLyrics(t)
}

function bindProgress () {
  const box = $('progress')

  box.addEventListener('pointerdown', (e) => {
    if (!S.track) return
    dragging = true
    box.classList.add('dragging')
    previewSeek(ratioAt(e.clientX))
    try { box.setPointerCapture(e.pointerId) } catch {}
    e.preventDefault()
  })

  // 拖动时鼠标可能滑出进度条，所以监听整窗
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return
    previewSeek(ratioAt(e.clientX))
  })

  const end = (commit) => {
    if (!dragging) return
    dragging = false
    box.classList.remove('dragging')
    if (commit) {
      const d = currentDuration()
      seekTo(dragRatio * d)
    }
  }
  box.addEventListener('pointerup', () => end(true))
  box.addEventListener('pointercancel', () => end(false))
  window.addEventListener('pointerup', () => end(true))
}

/* -------------------------------------------------------------- 时钟 */

function startClock () {
  const tick = () => {
    const now = new Date()
    $('cTime').textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
    $('cDate').textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${wd}`
  }
  tick()
  setInterval(tick, 1000)
  $('cWeather').innerHTML = `${svg('sun')} 24°`
}

/* ------------------------------------------------------------ 渲染入口 */

function render () {
  applyScale()
  applyWallpaper()
  document.body.classList.toggle('lowfx', !!S.cfg.ui.lowFx)

  renderDock()

  const ui = S.cfg.ui
  $('player').hidden = ui.showPlayer === false
  $('ctrl').hidden = ui.showPlayer === false
  $('clockbox').hidden = ui.showClock === false
  if (ui.showLyrics === false) $('lyrics').hidden = true

  if (libOpen) {
    games = gameList()
    renderLibrary()
  } else {
    renderRails()
  }
  // 歌词是异步回来的（本地无 .lrc / 直播歌曲要联网找），
  // 配置一到就按当前时间重排一次，不然要等下一次进度推送才出现
  updateLyrics(currentPlayTime())
}

/* ------------------------------------------------------- 输入热区上报 */

/* 空白处要透出桌面，但不能再走「光标轮询命中后切换穿透」——那套对触屏
   无效：手指点下去光标才瞬间跳过去，轮询根本来不及解除穿透，这一下就
   点到桌面后面去了。
/* ------------------------------------------------ launcher（替代任务栏） */

function setupLauncher () {
  // 运行状态推送：刷新气泡
  window.aura.onApps((m) => {
    apps = m || {}
    refreshHoverBubble()
  })
  // 切换结果反馈：切不动时直接告诉用户原因
  window.aura.onToggleResult((r) => {
    if (!r.ok) toast('切换失败：' + (r.err || '未知错误'))
    else if (!r.act) toast('窗口没能置前——如果目标程序是管理员权限运行的，需要以管理员身份运行 AuraDesk 才能切换')
  })
  window.aura.onVolume((s) => {
    vol = s || { v: null, m: false }
    renderCtlVol()
  })
  window.aura.onDevs((s) => {
    devs = s || { out: [], in: [], cur: '', curIn: '' }
    renderCtlDevs()
  })

  // 初始状态
  window.aura.appState().then((m) => { apps = m || {} })
  window.aura.volumeState().then((s) => { vol = s || vol; renderCtlVol() })

  // 侧栏 / 库滚动时气泡会漂，直接收掉
  for (const el of document.querySelectorAll('.rail-grid, #libScroll')) {
    el.addEventListener('scroll', hideAppBubble, { passive: true })
  }

  const pop = $('ctlPop')
  $('ctlBtn').addEventListener('click', () => {
    pop.hidden = !pop.hidden
    if (!pop.hidden) {
      window.aura.audioDevs()
      scheduleCtlClose()
    }
    scheduleShape()
  })
  pop.addEventListener('pointerenter', () => clearTimeout(ctlPopTimer))
  pop.addEventListener('pointerleave', scheduleCtlClose)
  $('ctlBtn').addEventListener('pointerenter', () => clearTimeout(ctlPopTimer))
  $('ctlBtn').addEventListener('pointerleave', scheduleCtlClose)
}

function scheduleCtlClose () {
  clearTimeout(ctlPopTimer)
  ctlPopTimer = setTimeout(() => {
    const pop = $('ctlPop')
    if (pop.hidden) return
    pop.hidden = true
    scheduleShape()
  }, 10000)
}

function renderCtlVol () {
  $('ctlVol').value = vol.v == null ? 0 : vol.v
  $('ctlVolNum').textContent = vol.v == null ? '--' : String(vol.v)
  $('ctlMute').classList.toggle('on', !!vol.m)
  $('ctlWave').style.display = vol.m || !vol.v ? 'none' : ''
}

let ctlLastSent = 0
function bindCtlVol () {
  $('ctlVol').addEventListener('input', (e) => {
    const v = Number(e.target.value)
    $('ctlVolNum').textContent = String(v)
    vol.v = v
    vol.m = false
    renderCtlVolIcons()
    const now = Date.now()
    if (now - ctlLastSent > 90) {
      ctlLastSent = now
      window.aura.volume(v)
    }
  })
  $('ctlVol').addEventListener('change', (e) => window.aura.volume(Number(e.target.value)))
  $('ctlMute').addEventListener('click', () => window.aura.mute())
  $('ctlDesk').addEventListener('click', () => {
    window.aura.showDesktop()
    const pop = $('ctlPop')
    pop.hidden = true
    scheduleShape()
  })
}

function renderCtlVolIcons () {
  $('ctlMute').classList.toggle('on', !!vol.m)
  $('ctlWave').style.display = vol.m || !vol.v ? 'none' : ''
}

function renderCtlDevs () {
  renderDevGroup($('ctlDevOut'), devs.out, devs.cur, 'out')
  renderDevGroup($('ctlDevIn'), devs.in, devs.curIn, 'in')
}

function renderDevGroup (box, list, cur, flow) {
  const frag = document.createDocumentFragment()
  for (const d of (list || [])) {
    const b = document.createElement('button')
    b.className = 'ctl-dev' + (d.id === cur ? ' cur' : '')
    b.title = d.name
    b.textContent = d.name || d.id
    b.addEventListener('click', () => window.aura.setDev(flow, d.id))
    frag.appendChild(b)
  }
  if (!(list || []).length) {
    const e = document.createElement('div')
    e.className = 'ctl-dev-empty'
    e.textContent = '没有设备'
    frag.appendChild(e)
  }
  box.replaceChildren(frag)
}

/* 热区：主进程 setShape 主动上报（v0.2.0 起的输入架构） */

let shapeRaf = 0
let lastShapeSig = ''

function computeShape () {
  // 库面板打开 / 拖拽中 / 右键菜单开着 = 整窗都要接输入
  let rects
  if (libOpen || DND.active || !$('ctx').hidden) {
    rects = [{ x: 0, y: 0, width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) }]
  } else {
    rects = []
    for (const el of document.querySelectorAll('[data-hot]')) {
      if (el.closest('[hidden]')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      rects.push({
        x: Math.max(0, Math.floor(r.left)),
        y: Math.max(0, Math.floor(r.top)),
        width: Math.ceil(Math.min(r.width, window.innerWidth)),
        height: Math.ceil(Math.min(r.height, window.innerHeight))
      })
    }
  }
  const sig = rects.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';')
  if (sig === lastShapeSig) return
  lastShapeSig = sig
  window.aura.setShape(rects)
}

function scheduleShape () {
  if (shapeRaf) return
  shapeRaf = requestAnimationFrame(() => {
    shapeRaf = 0
    computeShape()
  })
}

function bindShape () {
  // 卡片增删 / 菜单开关 / 拖拽浮层都会改热区；rAF 合并，签名去重防抖
  new MutationObserver(scheduleShape).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'class', 'style']
  })
  window.addEventListener('resize', scheduleShape)
  window.addEventListener('contextmenu', (e) => e.preventDefault())

  // 光标离开窗口全部热区（如移出右键菜单）时收掉还开着的菜单
  document.addEventListener('pointerleave', () => {
    if (!$('ctx').hidden) hideCtx()
  })

  // 点菜单以外的地方关闭菜单（热区内点空白 = 点在窗口上，事件能收到）
  document.addEventListener('pointerdown', (e) => {
    if ($('ctx').hidden) return
    if (e.target.closest && e.target.closest('#ctx')) return
    hideCtx()
  }, true)

  bindLongPress()
  computeShape()
}

/* ---- 触屏长按 = 右键 ----
   Windows 桌面版 Chromium 长按不产生 contextmenu，手动补一个：
   手指按住卡片 450ms 不动（±10px 内）就弹菜单；笔的侧键本来就走
   真 contextmenu 事件，不用管。 */

const LP = { id: -1, timer: 0, x: 0, y: 0, game: null }

function cancelLP () {
  if (LP.timer) { clearTimeout(LP.timer); LP.timer = 0 }
  LP.id = -1
  LP.game = null
}

function bindLongPress () {
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || DND.active) return
    const t = e.target.closest ? e.target.closest('.tile') : null
    const g = t && t._game
    if (!g) return
    cancelLP()
    LP.id = e.pointerId
    LP.x = e.clientX
    LP.y = e.clientY
    LP.game = g
    LP.timer = setTimeout(() => {
      LP.timer = 0
      if (DND.active || !LP.game) return
      openCtx(LP.x, LP.y, LP.game)
      cancelLP()
      // 长按当右键，松手那一下别触发启动
      DND.suppressUntil = performance.now() + 500
    }, 450)
  }, true)
  document.addEventListener('pointermove', (e) => {
    if (e.pointerId !== LP.id || !LP.timer) return
    const dx = e.clientX - LP.x
    const dy = e.clientY - LP.y
    if (dx * dx + dy * dy > 100) cancelLP()
  }, true)
  document.addEventListener('pointerup', cancelLP, true)
  document.addEventListener('pointercancel', cancelLP, true)
}

/* ---------------------------------------------------------------- 提示 */

let toastTimer = null
function toast (msg) {
  const el = $('toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200)
}

/* ------------------------------------------------------------------ 启动 */

async function boot () {
  S = await window.aura.init()
  S.cfg = S.cfg || {}
  S.cfg.ui = S.cfg.ui || {}
  S.cfg.wallpaper = S.cfg.wallpaper || {}
  games = gameList()

  await new Promise((r) => requestAnimationFrame(r))
  render()
  startClock()
  setupPlayer()
  bindShape()
  bindProgress()
  bindCtlVol()
  setupLauncher()
  // 侧栏卡片拖拽排序（捕获阶段接，避免被卡片的点击逻辑吃掉）
  document.addEventListener('pointerdown', onRailDown, true)

  $('dockLib').addEventListener('click', openLib)
  $('dockAura').addEventListener('click', () => window.aura.openCompanion())
  $('dockSet').addEventListener('click', () => window.aura.openSettings())
  $('dockHide').addEventListener('click', () => window.aura.hide())

  $('libBack').innerHTML = svg('chevL')
  $('libBack').addEventListener('click', () => closeLib())
  $('libSearchIco').innerHTML = svg('search')
  $('libSearch').addEventListener('input', (e) => {
    libQuery = e.target.value || ''
    renderLibrary()
  })
  $('libSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if ($('libSearch').value) {
        $('libSearch').value = ''
        libQuery = ''
        renderLibrary()
      } else {
        $('libSearch').blur()
      }
    }
  })
  $('libScroll').addEventListener('scroll', () => {
    if (!$('ctx').hidden) hideCtx()
  }, { passive: true })

  $('libEmptyBtn').addEventListener('click', () => window.aura.openSettings())
  $('railEmptyBtn').addEventListener('click', () => window.aura.openSettings())

  $('ctxLaunch').addEventListener('click', () => ctxAction('launch'))
  $('ctxReveal').addEventListener('click', () => ctxAction('reveal'))
  $('ctxRemove').addEventListener('click', () => ctxAction('remove'))
  $('ctx').addEventListener('contextmenu', (e) => e.preventDefault())

  // 点菜单以外任何地方都收起（侧栏右键也走这条路）
  document.addEventListener('pointerdown', (e) => {
    if ($('ctx').hidden) return
    if (e.target.closest && e.target.closest('.ctx')) return
    hideCtx()
  }, true)

  // 点空白处退出库；点菜单/卡片不算
  $('library').addEventListener('click', (e) => {
    if (e.target.closest('.tile, .lib-back, .lib-search, .chip, .lib-empty-btn, .ctx')) return
    if ($('ctx').hidden === false) { hideCtx(); return }
    closeLib()
  })
  $('library').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tile')) return
    e.preventDefault()
    hideCtx()
  })

  // 键盘：方向键在网格里走、Esc 退出、/ 搜索、PageUp/Down 翻页
  document.addEventListener('keydown', (e) => {
    if (!libOpen) {
      // 桌面模式：Esc 也能收掉右键菜单
      if (e.key === 'Escape' && !$('ctx').hidden) { hideCtx(); e.preventDefault() }
      return
    }
    const inSearch = document.activeElement === $('libSearch')
    if (e.key === 'Escape') {
      if ($('ctx').hidden === false) { hideCtx(); return }
      if (inSearch) return
      closeLib()
      return
    }
    if (e.key === '/' && !inSearch) {
      e.preventDefault()
      $('libSearch').focus()
      return
    }
    if (inSearch) return
    if (e.key === 'ArrowRight') { e.preventDefault(); moveFocus(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); moveFocus(-1) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(gridColumns()) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-gridColumns()) }
    else if (e.key === 'Home') { e.preventDefault(); moveFocus(-9999) }
    else if (e.key === 'End') { e.preventDefault(); moveFocus(9999) }
    else if (e.key === 'PageDown') { e.preventDefault(); scrollPage(1) }
    else if (e.key === 'PageUp') { e.preventDefault(); scrollPage(-1) }
  })

  window.addEventListener('blur', hideCtx)
  window.addEventListener('resize', hideCtx)

  $('pPlay').addEventListener('click', togglePlay)
  $('pPrev').addEventListener('click', () => window.aura.player('prev'))
  $('pNext').addEventListener('click', () => window.aura.player('next'))

  window.aura.onConfig((p) => {
    const prevId = S.track ? S.track.id : null
    const prevUrl = S.track ? S.track.url : ''
    S = { ...S, ...p }
    render()
    const nextId = S.track ? S.track.id : null
    const nextUrl = S.track ? S.track.url : ''
    if (nextId !== prevId || nextUrl !== prevUrl) {
      if (audio) {
        try { audio.pause() } catch {}
        audio = null
      }
      clearInterval(simTimer)
      simTimer = null
      lyricIdx = -2
      setupPlayer()
    }
  })

  // 直播歌曲：主进程按 SMTC 推送，副屏也走这条通道
  window.aura.onSmtc((p) => {
    const prevTitle = S.track ? S.track.title : null
    S.track = p.track
    S.playback = p.playback
    if (!p.track) {
      liveClock = null
      lyricIdx = -2
      seekHoldAt = 0
      pushMark = { time: -1, at: 0 }
      renderPlayerMeta()
      applyProgress(0, 0)
      updateLyrics(0)
      setPlayingIcon(false)
      return
    }
    if (prevTitle !== p.track.title) {
      lyricIdx = -2
      seekHoldAt = 0
      pushMark = { time: -1, at: 0 }
      renderPlayerMeta()
    } else if (p.track.coverUrl && $('pCover').style.backgroundImage.indexOf(p.track.coverUrl) === -1) {
      renderPlayerMeta()
    }
    if (dragging) return // 拖动中不要被轮询打断

    const now = performance.now()
    const pushed = p.playback.time || 0
    const isPlaying = !!p.playback.playing

    // 刚拖过进度条：SMTC 往往还会把「旧位置」报回来一两次，
    // 直接采用就会看到 1:00 → 1:01 → 1:00 反复横跳。
    // 这里给它 4 秒宽限：报回来的位置和预期差太远就先不听，用本地插值往前走。
    if (seekHoldAt) {
      const elapsed = (now - seekHoldAt) / 1000
      const expect = seekHoldTarget + (isPlaying ? elapsed : 0)
      if (elapsed < 4 && Math.abs(pushed - expect) > 3) {
        if (liveClock) liveClock.playing = isPlaying
        setPlayingIcon(isPlaying)
        updateLyrics(pushed)
        return
      }
      seekHoldAt = 0
    }

    // 视频类播放器（浏览器 / 某些本地播放器）播放中根本不刷新 SMTC 位置，
    // 只在暂停、切集时才给一次准确值。照单全收的话进度条会一直钉在起点，
    // 看起来「只有暂停才拿到进度」。判据：隔了 1.2 秒以上又来一次推送，
    // 位置却几乎没动 → 认为对方不更新，保持本地插值继续走。
    if (isPlaying && pushMark.at && now - pushMark.at > 1200 && Math.abs(pushed - pushMark.time) < .5) {
      if (liveClock) liveClock.playing = true
      setPlayingIcon(true)
      updateLyrics(currentPlayTime())
      return
    }
    pushMark = { time: pushed, at: now }

    liveClock = {
      time: pushed,
      duration: p.playback.duration || 0,
      playing: isPlaying,
      at: now
    }
    setPlayingIcon(liveClock.playing)
    applyProgress(liveClock.time, liveClock.duration)
    updateLyrics(liveClock.time)
  })

  // 直播进度插值：SMTC 每 800ms 才给一次时间，中间靠本地补
  setInterval(() => {
    if (dragging) return
    if (!liveClock || !liveClock.playing) return
    const t = liveClock.time + (performance.now() - liveClock.at) / 1000
    if (liveClock.duration && t > liveClock.duration) return
    applyProgress(t, liveClock.duration)
    updateLyrics(t)
  }, 300)

  window.aura.onSync((st) => {
    if (S.isOwner || dragging) return
    S.playback = st
    applyProgress(st.time || 0, st.duration || 0)
    updateLyrics(st.time || 0)
    setPlayingIcon(!!st.playing)
  })

  window.aura.onCommand((cmd, arg) => {
    if (!S.isOwner) return
    if (cmd === 'toggle') togglePlay()
    else if (cmd === 'seek' && audio) audio.currentTime = Number(arg) || 0
  })

  window.aura.onLibraryChange(() => {
    window.aura.init().then((p) => {
      S = { ...S, ...p }
      games = gameList()
      render()
      setupPlayer()
    })
  })

  window.addEventListener('resize', () => {
    applyScale()
    fitRail(railRowCount())
  })
}

function nextTrack () {
  window.aura.player('next')
}

boot().catch((err) => {
  // boot 断在哪一步必须留痕：界面渲染了但事件没绑上 = 用户看到「一切没反应」
  reportErr('boot', err)
  console.error('[boot] 初始化失败', err)
})
