'use strict'
/* AuraDesk 边缘任务条渲染逻辑（卡片式）
   - edgebar:win-list 推送驱动卡片渲染（签名去重，不打断进行中的抓图）
   - 每张卡片直接铺该窗口的实时画面（PrintWindow 缩略图，双图交叉淡入防闪），
     面板打开时 3s 一轮刷新，收起即停（不打开不抓图，零开销）
   - 点击卡片 = 按句柄直接切换（与桌面卡片同一条 toggle 链路） */
const cardsEl = document.getElementById('cards')
const barEl = document.getElementById('bar')
const hotEl = document.getElementById('hot')
const toastEl = document.getElementById('toast')
const BOTTOM = new URLSearchParams(location.search).get('bottom') === '1'
document.body.classList.add(BOTTOM ? 'bottom' : 'top')

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function hueOf (str) {
  let h = 0
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360
  return h
}

/* ---------------- 热区上报（透明窗口必须精确放行，绝不挡程序标题栏） ---------------- */
function sendShape () {
  const w = window.innerWidth
  const h = window.innerHeight
  const open = document.body.classList.contains('open')
  // 收起：只有 3px 触发条接输入；展开：整条面板接输入（形状外原生穿透）
  const rects = open
    ? [{ x: 0, y: BOTTOM ? h - 115 : 0, width: w, height: 115 }]
    : [{ x: 0, y: BOTTOM ? h - 3 : 0, width: w, height: 3 }]
  window.edge.setShape(rects)
}

/* ---------------- 滑入 / 滑出 ----------------
   展开由主进程光标轮询通知（驻留 ~600ms，物理可靠，不依赖 3px 透明条的
   DOM 事件）；收起继续用面板 mouseleave（面板热区内鼠标事件正常）。 */
let closeTimer = null
function openBar () {
  clearTimeout(closeTimer)
  closeTimer = null
  if (document.body.classList.contains('open')) return
  document.body.classList.add('open')
  sendShape()
  refreshShots()
  clearInterval(refreshTimer)
  refreshTimer = setInterval(refreshShots, 3000)
}
function scheduleClose () {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    closeTimer = null
    document.body.classList.remove('open')
    clearInterval(refreshTimer)
    refreshTimer = null
    sendShape()
  }, 420)
}
barEl.addEventListener('mouseleave', scheduleClose)
window.edge.onOpen(openBar)

/* ---------------- 卡片渲染 ---------------- */
let list = []
let lastSig = ''
let refreshTimer = null
const shotInFlight = new Set()

function render () {
  const sig = list.map((w) => `${w.h}:${w.fg ? 1 : 0}${w.min ? 1 : 0}:${(w.t || '').slice(0, 24)}`).join(';')
  if (sig === lastSig) return
  lastSig = sig
  cardsEl.innerHTML = ''
  if (!list.length) {
    cardsEl.innerHTML = '<div class="empty">当前没有运行中的窗口</div>'
    return
  }
  // 前台的排最前，其余按原顺序
  const sorted = [...list].sort((a, b) => (b.fg ? 1 : 0) - (a.fg ? 1 : 0))
  sorted.forEach((w, i) => {
    const card = document.createElement('div')
    card.className = 'ecard' + (w.fg ? ' fg' : '') + (w.min ? ' min' : '')
    card.dataset.h = w.h
    card.style.animationDelay = Math.min(i * 18, 200) + 'ms'
    const letter = (w.pn || '?').replace(/\.exe$/i, '').charAt(0).toUpperCase() || '?'
    card.innerHTML =
      `<div class="ph" style="background:hsl(${hueOf(w.pn || 'x')} 46% 38%)">${esc(letter)}</div>` +
      '<img class="shot" alt="" draggable="false"><img class="shot alt" alt="" draggable="false">' +
      '<div class="badge"></div>' +
      `<div class="name">${esc(w.t || w.pn || '未命名窗口')}</div>`
    card.addEventListener('click', () => window.edge.toggleHwnd(w.h))
    cardsEl.appendChild(card)
  })
  if (document.body.classList.contains('open')) refreshShots()
}

/* ---------------- 实时画面：打开期间整轮刷新 ---------------- */
function pullInto (card, h) {
  if (shotInFlight.has(h)) return
  shotInFlight.add(h)
  const imgs = card.querySelectorAll('.shot')
  let front = imgs[0]
  window.edge.windowShot(h).then((s) => {
    shotInFlight.delete(h)
    if (!s || !s.ok || !s.url) return
    const probe = new Image()
    probe.onload = () => {
      if (!document.body.classList.contains('open') || !card.isConnected) return
      const back = front === imgs[0] ? imgs[1] : imgs[0]
      back.src = s.url
      back.classList.add('on')
      front.classList.remove('on')
      front = back
      card.classList.add('has-shot')
      if (s.cached) card.classList.add('min')
    }
    probe.src = s.url
  }).catch(() => shotInFlight.delete(h))
}

function refreshShots () {
  if (!document.body.classList.contains('open')) return
  for (const card of cardsEl.querySelectorAll('.ecard')) {
    pullInto(card, Number(card.dataset.h))
  }
}

/* ---------------- 推送与提示 ---------------- */
window.edge.onWinList((l) => { list = Array.isArray(l) ? l : []; render() })
window.edge.onToggleResult((r) => {
  if (r && !r.ok && r.err) {
    toastEl.textContent = r.err
    toastEl.hidden = false
    clearTimeout(toastEl._t)
    toastEl._t = setTimeout(() => { toastEl.hidden = true }, 2200)
  }
})

render()
// 初始热区：只有 3px 触发条，其余全部穿透
sendShape()
window.addEventListener('resize', sendShape)
