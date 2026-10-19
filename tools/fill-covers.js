/**
 * 维护工具：把库里缺封面 / 封面文件已失效的条目重新补一遍
 *   npx electron tools/fill-covers.js
 * 只在本地缓存目录里写图片，不动游戏本身。
 */
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

app.on('window-all-closed', () => {})

// 直接跑脚本时 Electron 会用默认的 appData/Electron，跟正式应用不是同一个目录
app.setPath('userData', path.join(app.getPath('appData'), 'auradesk'))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[covers] 超时'); app.exit(1) }, 180000)

  const store = require('../src/main/store')
  const covers = require('../src/main/sources/covers')
  const cfg = store.get()
  const lib = cfg.global.library || []
  const key = cfg.global.sgdbKey || ''

  const before = lib.filter((g) => g.cover && fs.existsSync(g.cover)).length
  console.log(`[covers] 共 ${lib.length} 项，现有可用封面 ${before}`)

  const res = await covers.fillMissingCovers(lib, key, ({ done, total, name, ok }) => {
    process.stdout.write(`\r[covers] ${done}/${total}  成功 ${ok}  ${String(name).slice(0, 26).padEnd(26)}`)
  })

  store.flush()
  const after = lib.filter((g) => g.cover && fs.existsSync(g.cover)).length
  console.log(`\n[covers] 处理 ${res.total} 项，成功 ${res.ok}；现在可用封面 ${after}/${lib.length}`)
  app.exit(0)
})
