'use strict'
const { app } = require('electron')
const covers = require('../src/main/sources/covers')
app.whenReady().then(async () => {
  const names = ['Hades', 'Hollow Knight', 'Stardew Valley']
  for (const n of names) {
    const t0 = Date.now()
    const f = await covers.freeCover(n)
    console.log('[cover]', n, '->', f ? require('path').basename(f) : '(miss)', Date.now() - t0 + 'ms')
  }
  app.quit()
})
