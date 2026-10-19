/**
 * 预览页截图（自查用，不参与应用运行）
 *   npx electron tools/shot.js
 * 把 tools/preview/*.html 渲染成 captures/*.png
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')

const PAGES = [
  { file: 'preview-overlay.html', out: 'overlay-mock.png', w: 1920, h: 1080, probe: '#gridL .tile', hoverOut: 'overlay-mock-hover.png' },
  { file: 'preview-library.html', out: 'library.png', w: 1920, h: 1080, probe: '#libGrid .tile', hoverOut: 'library-hover.png', menu: true },
  { file: 'preview-settings.html', out: 'settings.png', w: 1280, h: 800 }
]

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.disableHardwareAcceleration()

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[shot] 超时'); app.exit(1) }, 30000)
  const outDir = path.join(__dirname, '..', 'captures')
  fs.mkdirSync(outDir, { recursive: true })

  for (const p of PAGES) {
    const win = new BrowserWindow({
      width: p.w,
      height: p.h,
      show: false,
      frame: false,
      backgroundColor: '#0a0d14',
      webPreferences: { offscreen: false }
    })
    try {
      await win.loadURL(pathToFileURL(path.join(__dirname, 'preview', p.file)).toString())
    } catch (err) {
      console.error('[shot] 载入失败 ' + p.file, err && err.message)
    }
    win.showInactive()
    await wait(1800)
    try {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(outDir, p.out), img.toPNG())
      console.log('[shot] ' + p.out + ' ' + JSON.stringify(img.getSize()))
    } catch (err) {
      console.error('[shot] ' + p.out + ' 失败', err)
    }

    // 额外验证鼠标交互：悬停高亮（侧栏是名字浮出）+ 右键菜单
    if (p.probe) {
      try {
        const pt = await win.webContents.executeJavaScript(
          `(() => { const el = document.querySelectorAll(${JSON.stringify(p.probe)})[2]; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()`
        )
        win.webContents.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y })
        await wait(450)
        const hov = await win.webContents.capturePage()
        fs.writeFileSync(path.join(outDir, p.hoverOut), hov.toPNG())
        console.log('[shot] ' + p.hoverOut)

        if (p.menu) {
          win.webContents.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'right', clickCount: 1 })
          win.webContents.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'right', clickCount: 1 })
          await wait(450)
          const menu = await win.webContents.capturePage()
          fs.writeFileSync(path.join(outDir, 'library-menu.png'), menu.toPNG())
          console.log('[shot] library-menu.png')
        }
      } catch (err) {
        console.error('[shot] 交互截图失败', err)
      }
    }

    win.destroy()
    await wait(200)
  }
  app.exit(0)
})
