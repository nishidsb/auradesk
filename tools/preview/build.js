/**
 * 把渲染层真实页面包装成可直接用浏览器打开的预览页（仅用于视觉自查）
 * node tools/preview/build.js
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const out = __dirname

// 预览页里没有真正的桌面，这里画一层「模拟 Wallpaper Engine 壁纸」，
// 用来确认桌面透传模式下的对比度：组件以外的区域必须能看见这层。
const DEMO_DESKTOP = `
  <div class="demo-desktop"></div>
  <style>
    .demo-desktop {
      position: fixed; inset: 0; z-index: 0;
      background:
        radial-gradient(58% 64% at 22% 26%, rgba(92,156,220,.62), transparent 66%),
        radial-gradient(50% 56% at 78% 70%, rgba(152,112,222,.55), transparent 64%),
        radial-gradient(46% 50% at 62% 16%, rgba(120,220,214,.28), transparent 66%),
        linear-gradient(145deg, #0a1626 0%, #12293f 46%, #080d16 100%);
    }
    .demo-desktop::after {
      content: "↑ 这一层模拟 Wallpaper Engine 的动态壁纸，AuraDesk 不覆盖它";
      position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
      text-align: center; font: 600 13px/1.7 system-ui, sans-serif;
      letter-spacing: .12em; color: rgba(255,255,255,.26);
    }
    .stage { z-index: 1; }
  </style>`

function build (srcHtml, cssPath, scriptPath, mockName, dest, extra = '') {
  let html = fs.readFileSync(path.join(root, srcHtml), 'utf8')
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
  html = html.replace(/<link rel="stylesheet" href="[^"]*" \/>/, `<link rel="stylesheet" href="${cssPath}" />`)
  html = html.replace('<script src="app.js"></script>', `<script src="${mockName}"></script>\n  <script src="${scriptPath}"></script>`)
  if (extra) html = html.replace(/<body([^>]*)>/, '<body$1>' + extra)
  fs.writeFileSync(path.join(out, dest), html, 'utf8')
  console.log('built', dest)
}

build('src/renderer/overlay/index.html',
  '../../src/renderer/overlay/style.css',
  '../../src/renderer/overlay/app.js',
  'mock.js',
  'preview-overlay.html',
  DEMO_DESKTOP)

// 游戏库展开态：额外点一下侧边栏第一个图标，用来核对库面板的排版
build('src/renderer/overlay/index.html',
  '../../src/renderer/overlay/style.css',
  '../../src/renderer/overlay/app.js',
  'mock.js',
  'preview-library.html',
  DEMO_DESKTOP + '<script>window.addEventListener("load",()=>setTimeout(()=>document.getElementById("dockLib").click(),400))</script>')

build('src/renderer/settings/index.html',
  '../../src/renderer/settings/style.css',
  '../../src/renderer/settings/app.js',
  'mock-settings.js',
  'preview-settings.html')
