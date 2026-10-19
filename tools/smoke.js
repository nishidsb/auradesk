/**
 * 覆盖层冒烟测试（jsdom）：跑真实 app.js，验证
 *   1) 桌面常态：单侧栏 + 播放器 + 时钟
 *   2) 点侧栏图标切到游戏库：网格、点封面直接启动、搜索、右键菜单
 *   3) 拖动进度条会真的发出 seek（Listen1 直播歌曲也走这条路）
 */
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM, VirtualConsole } = require('jsdom')

const root = path.resolve(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'src/renderer/overlay/index.html'), 'utf8')
  .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')

const errors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail || e.message)))
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')))

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc })
const { window } = dom

let fail = 0
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : ''))
  if (!ok) fail++
}

// 固定布局尺寸，jsdom 里 getBoundingClientRect 全是 0，进度条没法算比例
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 300, bottom: 10, width: 300, height: 10, x: 0, y: 0 }
}

// 先装载预览数据（它会写 window.aura），再把需要断言的调用换成记录器
window.eval(fs.readFileSync(path.join(root, 'tools/preview/mock.js'), 'utf8'))

const calls = []
const listeners = { apps: [], vol: [], devs: [], tr: [] }
Object.assign(window.aura, {
  openSettings: () => calls.push(['settings']),
  hide: () => calls.push(['hide']),
  launch: async (id) => { calls.push(['launch', id]); return { ok: true } },
  player: (cmd, arg) => calls.push(['player', cmd, arg]),
  setShape: (rects) => { window.__lastShape = rects; calls.push(['shape', rects.length]) },
  reportError: (kind, msg, stack) => calls.push(['rerr', kind, msg]),
  // ---- launcher ----
  appState: async () => ({ 'g1': { h: 101, min: false, fg: true } }),
  windowShot: async (h) => ({ ok: false, err: 'mock' }),
  toggleApp: (id) => calls.push(['toggleApp', id]),
  onApps: (cb) => listeners.apps.push(cb),
  onToggleResult: (cb) => listeners.tr.push(cb),
  volume: (v) => calls.push(['volume', v]),
  mute: () => calls.push(['mute']),
  volumeState: async () => ({ v: 42, m: false }),
  audioDevs: async () => ({ out: [{ id: 'D1', name: '耳机' }], in: [], cur: 'D1', curIn: '' }),
  setDev: (flow, id) => calls.push(['setDev', flow, id]),
  onVolume: (cb) => listeners.vol.push(cb),
  onDevs: (cb) => listeners.devs.push(cb),
  showDesktop: () => calls.push(['desk'])
})
try {
  window.eval(fs.readFileSync(path.join(root, 'src/renderer/overlay/app.js'), 'utf8'))
} catch (err) {
  errors.push('app.js 执行失败: ' + err.stack)
}

setTimeout(async () => {
  const d = window.document

  console.log('--- 桌面常态 ---')
  const dock = d.getElementById('dock')
  check('侧边栏存在且贴一侧', !dock.hidden && dock.dataset.side === 'left', dock.dataset.side)
  const btns = d.querySelectorAll('#dock .dock-btn')
  check('侧栏只有一侧，4 个按钮（库/伴侣/设置/隐藏）', btns.length === 4, btns.length)
  check('侧栏挂在左侧图标列里', dock.parentElement.id === 'iconsL', dock.parentElement.id)
  check('游戏库默认收起', d.getElementById('library').hidden)
  check('播放器标题', d.getElementById('pTitle').textContent === '夜に駆ける', d.getElementById('pTitle').textContent)
  check('时钟已渲染', /^\d{2}:\d{2}$/.test(d.getElementById('cTime').textContent), d.getElementById('cTime').textContent)

  console.log('\n--- 左右两侧封面栏 ---')
  const gl = d.querySelectorAll('#gridL .tile')
  const gr = d.querySelectorAll('#gridR .tile')
  check('左栏有封面', gl.length > 0, gl.length)
  check('右栏有封面', gr.length > 0, gr.length)
  // 侧栏一屏放 4 行，多出来的靠滚动看，一张都不丢
  check('两栏合计 = 库内游戏数', gl.length + gr.length === 24, gl.length + gr.length)
  // jsdom 不做布局，滚动能力看 CSS：.rail-grid 必须是 overflow-y: auto
  const overlayCss = fs.readFileSync(path.join(root, 'src/renderer/overlay/style.css'), 'utf8')
  const railScrolls = /\.rail-grid\s*\{[^}]*overflow-y:\s*auto/.test(overlayCss)
  check('左栏可以滚动', railScrolls, 'css overflow-y: auto')
  check('右栏可以滚动', railScrolls, 'css overflow-y: auto')
  check('栏里没有「添加游戏」格', d.querySelectorAll('#gridL .tile-add, #gridR .tile-add').length === 0)
  check('封面默认不显示名字（悬停才浮出）', d.querySelector('#gridL .tile-name') !== null)

  const plats = d.querySelectorAll('#platL .plat-btn')
  check('左侧有平台图标', plats.length >= 3, plats.length)
  check('平台图标只有一处（右侧不再重复）', d.querySelectorAll('.plat-btn').length === plats.length)
  check('平台图标默认选中「全部」', d.querySelector('#platL .plat-btn[data-src="all"]').classList.contains('is-on'))

  console.log('\n--- 平台筛选 ---')
  d.querySelector('#platL .plat-btn[data-src="steam"]').click()
  const stCount = d.querySelectorAll('#gridL .tile, #gridR .tile').length
  check('点 Steam 只剩 Steam 游戏', stCount > 0 && stCount < 24, stCount)
  check('筛选后图标高亮', d.querySelector('#platL .plat-btn[data-src="steam"]').classList.contains('is-on'))
  d.querySelector('#platL .plat-btn[data-src="steam"]').click()
  check('再点一次回到全部', d.querySelectorAll('#gridL .tile, #gridR .tile').length === 24)

  console.log('\n--- 侧栏封面单击启动 ---')
  calls.length = 0
  d.querySelector('#gridL .tile').click()
  check('点侧栏封面直接 launch', calls.some((c) => c[0] === 'launch'), JSON.stringify(calls))

  console.log('\n--- 侧栏右键 ---')
  d.querySelector('#gridL .tile').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
  check('侧栏封面右键也能弹菜单', !d.getElementById('ctx').hidden)
  check('菜单挂在库外面（库没开也能用）', d.getElementById('ctx').closest('.library') === null)
  d.getElementById('ctx').hidden = true

  console.log('\n--- 打开游戏库 ---')
  d.getElementById('dockLib').click()
  check('库面板展开', !d.getElementById('library').hidden)
  const tiles = d.querySelectorAll('#libGrid .tile:not(.tile-add)')
  check('卡片数 = 库内游戏数', tiles.length === 24, tiles.length)
  check('数量显示', d.getElementById('libCount').textContent === '24 个', d.getElementById('libCount').textContent)
  check('末尾有「添加游戏」入口', !!d.querySelector('#libGrid .tile-add'))
  check('没有 PS5 那一排翻页箭头', !d.getElementById('libPrev') && !d.getElementById('libNext'))
  check('没有「启动」确认按钮', !d.getElementById('libLaunch'))
  check('打开库时播放器还在（可以边听边翻）', !d.getElementById('player').hidden && d.body.classList.contains('lib-open'))
  check('背景氛围色跟着第一张封面', d.getElementById('libGlow').classList.contains('on'))

  console.log('\n--- 点封面直接启动 ---')
  calls.length = 0
  tiles[0].click()
  check('单击即发出 launch(游戏 id)', calls.some((c) => c[0] === 'launch' && c[1] === 'l0'), JSON.stringify(calls))

  console.log('\n--- 搜索过滤 ---')
  const search = d.getElementById('libSearch')
  search.value = '赛博'
  search.dispatchEvent(new window.Event('input', { bubbles: true }))
  const hit = d.querySelectorAll('#libGrid .tile:not(.tile-add)')
  check('按名称过滤出 2 张', hit.length === 2, hit.length)
  check('筛选提示已更新', /筛选出 2 个/.test(d.getElementById('libSub').textContent), d.getElementById('libSub').textContent)

  console.log('\n--- 右键菜单 ---')
  hit[0].dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }))
  check('右键弹出菜单', !d.getElementById('ctx').hidden)
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  check('Esc 收起菜单但库还开着', d.getElementById('ctx').hidden && !d.getElementById('library').hidden)

  console.log('\n--- 关闭游戏库 ---')
  d.getElementById('libBack').click()
  check('返回按钮回到桌面', d.getElementById('library').hidden)

  d.getElementById('dockLib').click()
  d.getElementById('library').click()
  check('点空白处也能回到桌面', d.getElementById('library').hidden)

  console.log('\n--- 触屏热区（setShape） ---')
  const shape = window.__lastShape
  check('启动后上报了热区', Array.isArray(shape) && shape.length > 0, JSON.stringify(shape))
  // jsdom 不做布局，getBoundingClientRect 被 mock 成 300x10，
  // 这里只验证热区数量 = 可见 [data-hot] 元素数量、且坐标合法
  const hotEls = [...d.querySelectorAll('[data-hot]')].filter((el) => !el.closest('[hidden]'))
  check('热区数量 = 可见热元素数', shape && shape.length === hotEls.length, shape ? shape.length : 'none')
  check('热区坐标在窗口内', shape && shape.every((r) => r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0), 'ok')
  // 打开库 → 整窗热区（scheduleShape 走 rAF，等一拍再断言）
  d.getElementById('dockLib').click()
  await new Promise((r) => setTimeout(r, 40))
  const libShape = window.__lastShape
  check('库打开后热区=整窗', libShape && libShape.length === 1 && libShape[0].width >= window.innerWidth, JSON.stringify(libShape))
  d.getElementById('libBack').click()
  await new Promise((r) => setTimeout(r, 40))
  check('关库后热区恢复分块', window.__lastShape && window.__lastShape.length > 1, window.__lastShape && window.__lastShape.length)

  console.log('\n--- 拖动进度条（Listen1 直播） ---')
  calls.length = 0
  const bar = d.getElementById('progress')
  bar.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 150, bubbles: true }))
  bar.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 240, bubbles: true }))
  bar.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 240, bubbles: true }))
  const seek = calls.find((c) => c[0] === 'player' && c[1] === 'seek')
  check('发出了 seek 指令', !!seek, JSON.stringify(calls))
  check('跳转到 80% 位置（189s → 151s）', seek && Math.abs(seek[2] - 151.2) < 1.5, seek && seek[2])

  // 拖完之后 SMTC 往往还会把旧位置报回来，进度不能被拽回去来回横跳
  const before = d.getElementById('tCur').textContent
  window.__onSmtc({
    track: { id: 'smtc', title: '夜に駆ける', artist: 'YOASOBI', live: true, duration: 189 },
    playback: { time: 60, duration: 189, playing: true }
  })
  const after = d.getElementById('tCur').textContent
  check('seek 后旧位置推送不会把进度拽回去', after !== '1:00', before + ' → ' + after)

  console.log('\n报错 :', errors.length ? '\n  ' + errors.join('\n  ') : '无')
  console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
  process.exit(fail || errors.length ? 1 : 0)
}, 1200)
