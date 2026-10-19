'use strict'
/**
 * 歌词抓取自检：不需要开界面，命令行直接跑一遍在线歌词。
 * 用法：electron tools/lyric-once.js "歌名" "歌手" [时长秒]
 */
const { app } = require('electron')
const lyrics = require('../src/main/lyrics')

const [, , title, artist, dur] = process.argv
if (!title) {
  console.log('用法：electron tools/lyric-once.js "歌名" "歌手" [时长秒]')
  app.quit()
} else {
  app.whenReady().then(async () => {
    const t0 = Date.now()
    const text = await lyrics.getLyrics({ title, artist: artist || '', duration: Number(dur || 0) })
    const lines = text.split('\n').filter(Boolean)
    console.log('耗时 %dms  行数 %d', Date.now() - t0, lines.length)
    console.log(lines.slice(0, 6).join('\n'))
    app.quit()
  })
}
