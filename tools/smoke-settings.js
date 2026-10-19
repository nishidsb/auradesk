/**
 * 设置面板冒烟测试：jsdom 里跑真实设置页
 * node tools/smoke-settings.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM, VirtualConsole } = require('jsdom')

const root = path.resolve(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'src/renderer/settings/index.html'), 'utf8')
  .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')

const errors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail || e.message)))
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')))

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc })
const { window } = dom
window.prompt = () => null
window.eval(fs.readFileSync(path.join(root, 'tools/preview/mock-settings.js'), 'utf8'))

const patchCalls = []
const origPatch = window.auraSet.patchDisplay
window.auraSet.patchDisplay = (key, p) => { patchCalls.push([key, p]); return origPatch(key, p) }

let fail = 0
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : ''))
  if (!ok) fail++
}

try {
  window.eval(fs.readFileSync(path.join(root, 'src/renderer/settings/app.js'), 'utf8'))
} catch (e) {
  errors.push('app: ' + e.stack)
}

setTimeout(async () => {
  const d = window.document
  console.log('--- 显示器面板 ---')
  check('显示器列表 3 项', d.querySelectorAll('.disp-item').length === 3, d.querySelectorAll('.disp-item').length)
  check('壁纸选项 7 个（跟随桌面+5 预设+本地）', d.querySelectorAll('.wall-chip').length === 7, d.querySelectorAll('.wall-chip').length)
  const sws = d.querySelectorAll('.sw').length
  check('组件开关 7 项', sws === 7, sws)
  check('侧边栏固定在左侧（不再有位置选项）', d.querySelectorAll('#dockSide button').length === 0)
  check('不再有左右分栏的卡片分配', d.querySelectorAll('.ass-row').length === 0)

  console.log('\n--- 资源库 ---')
  d.querySelector('#sideNav button[data-view="library"]').click()
  await new Promise((r) => setTimeout(r, 60))
  check('有「从开始菜单导入」入口', !!d.getElementById('scanStart'))
  check('导入按钮齐全', ['scanStart', 'importSteam', 'importEpic', 'addExe', 'scanDir'].every((id) => !!d.getElementById(id)))
  check('资源库列表渲染 8 行', d.querySelectorAll('.lib-row').length === 8, d.querySelectorAll('.lib-row').length)

  d.getElementById('scanStart').click()
  await new Promise((r) => setTimeout(r, 120))
  check('开始菜单弹层打开', !!d.getElementById('smModal'))

  console.log('\n报错 :', errors.length ? '\n  ' + errors.join('\n  ') : '无')
  console.log(fail || errors.length ? `\n${fail} 项失败` : '\n全部通过')
  process.exit(fail || errors.length ? 1 : 0)
}, 700)
