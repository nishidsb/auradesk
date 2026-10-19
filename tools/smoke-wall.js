/**
 * 桌面透传模式回归：
 * 1) 默认配置的壁纸类型必须是 desktop（不能自己画壁纸盖住 Wallpaper Engine）
 * 2) 渲染层把 data-wall 落到 body 上，样式表里没有任何自绘壁纸/毛玻璃
 * 3) 老配置（v1 自绘渐变）迁移后自动变成 desktop
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { JSDOM, VirtualConsole } = require('jsdom')

const root = path.resolve(__dirname, '..')
let fail = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? '  → ' + extra : ''))
  if (!ok) fail++
}

/* ---------------- 1. store 默认值 ---------------- */
const electronPath = require.resolve('electron')
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-store-'))
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => tmpHome } }
}
const store = require('../src/main/store')
const d = store.DEFAULT_DISPLAY()
check('默认壁纸类型为 desktop', d.wallpaper.type === 'desktop', d.wallpaper.type)
check('默认暗化很轻（不压暗壁纸）', d.wallpaper.dim <= 0.1, String(d.wallpaper.dim))

/* ---------------- 2. v1 配置迁移 ---------------- */
const v1 = {
  version: 1,
  global: { library: [], tracks: [], musicSource: 'local' },
  displays: { d1: { wallpaper: { type: 'preset', preset: 'twilight', dim: 0.3 } } }
}
fs.mkdirSync(path.join(tmpHome, 'config.json', '..'), { recursive: true })
fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(v1), 'utf8')
// 清掉可能的缓存，重新 require 拿新实例
delete require.cache[require.resolve('../src/main/store')]
const store2 = require('../src/main/store')
const cfg = store2.get()
const w = cfg.displays.d1.wallpaper
check('v1 自绘壁纸迁移为 desktop', w.type === 'desktop', w.type)
check('迁移后记住原预设', w.prevPreset === 'twilight', String(w.prevPreset))
check('配置版本升到 6', cfg.version === 6, String(cfg.version))
// v4：卡片改竖版长方形，旧默认 5 行跟着降到 4 行（卡片不会因此变小）
check('旧的 5 行封面档位迁到 4 行', cfg.displays.d1.ui.railRows === 4, String(cfg.displays.d1.ui.railRows))

/* ---------------- 3. 渲染层 ---------------- */
const htmlRaw = fs.readFileSync(path.join(root, 'src/renderer/overlay/index.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src/renderer/overlay/style.css'), 'utf8')
check('整窗透明，不画自己的壁纸', /body\s*\{[^}]*background:\s*transparent/.test(css))
check('不用 backdrop-filter（透明窗口里采不到其它进程）', !/backdrop-filter\s*:/.test(css))
check('DOM 里没有自绘壁纸层', !/id="wallImg"/.test(htmlRaw))

/* 卡片必须是竖版长方形：高/宽 = 1.45，不是正方形 */
const ratio = /--tile-ratio:\s*([\d.]+)/.exec(css)
check('封面卡是竖版比例（高 > 宽）', !!ratio && Number(ratio[1]) > 1.2, ratio && ratio[1])
check('卡片用 --tile-ratio 而不是写死 1/1', /\.tile-art\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*var\(--tile-ratio\)/.test(css))

/* 悬停放大：卡片要真的放大，不能被入场动画的 fill-mode 压住 */
check('悬停有放大（scale > 1）', /\.tile:hover\s*\{[^}]*scale\(1\.0[2-9]/.test(css))
check('侧栏悬停是纯放大', /\.rail-grid\s+\.tile:hover\s*\{[^}]*scale\(1\.0[2-9]/.test(css))
check('入场动画不固化 transform（否则 hover 不生效）', /\.tile\s*\{[^}]*animation:\s*tileIn[^;]*\bbackwards\b/.test(css))
check('侧栏给悬停放大留了内边距', /\.rail-grid\s*\{[^}]*padding:\s*\.55rem/.test(css))

const html = fs.readFileSync(path.join(root, 'src/renderer/overlay/index.html'), 'utf8')
  .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
const errors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail || e.message)))
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')))
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc })
const w2 = dom.window
w2.eval(fs.readFileSync(path.join(root, 'tools/preview/mock.js'), 'utf8'))
Object.assign(w2.aura, {
  appState: async () => ({}), windowShot: async () => ({ ok: false }), toggleApp () {}, onApps () {}, onToggleResult () {},
  volume () {}, mute () {}, volumeState: async () => ({ v: null, m: false }),
  audioDevs: async () => ({ out: [], in: [], cur: '', curIn: '' }),
  setDev () {}, onVolume () {}, onDevs () {}, showDesktop () {}
})
w2.eval(fs.readFileSync(path.join(root, 'src/renderer/overlay/app.js'), 'utf8'))

setTimeout(() => {
  check('body 上标记了 desktop 模式', w2.document.body.dataset.wall === 'desktop', w2.document.body.dataset.wall)
  check('渲染无报错', errors.length === 0, errors.join(' | '))
  fs.rmSync(tmpHome, { recursive: true, force: true })
  console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
  process.exit(fail ? 1 : 0)
}, 900)
