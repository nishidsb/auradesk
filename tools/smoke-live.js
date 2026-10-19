/**
 * 直播歌曲（SMTC / Listen1）渲染自检
 * node tools/smoke-live.js
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
const w = dom.window

// 时间打桩：跨秒的判断（位置卡住、seek 宽限）在测试里才可控
let fakeNow = 800
try { w.performance.now = () => fakeNow } catch {}

let smtcCb = null
const liveTrack = (title, artist, cover) => ({
  id: 'smtc', title, artist, album: '', cover: '', coverUrl: cover || '', url: '',
  lyrics: '', lyricLines: [], live: true, duration: 240
})

const payload = {
  key: 'demo',
  screen: { width: 1920, height: 1080 },
  demo: false,
  musicSource: 'smtc',
  cfg: {
    followPrimary: false,
    wallpaper: { type: 'preset', preset: 'twilight', dim: 0.2, blur: 0, scale: 1.06 },
    ui: { scale: 1, showDock: true, dockSide: 'left', showPlayer: true, showClock: true, showLyrics: true, lowFx: false }
  },
  library: [],
  track: liveTrack('起风了', '买辣椒也用券'),
  tracks: 0,
  playback: { time: 30, duration: 240, playing: true, trackId: 'smtc' },
  isOwner: true,
  widgets: []
}

w.aura = {
  init: async () => payload,
  setIgnore () {}, openSettings () {}, hide () {}, quit () {},
  launch: async () => ({ ok: true }),
  reveal: async () => false,
  remove: async () => true,
  player () {}, tick () {},
  onConfig () {}, onCommand () {}, onSync () {},
  onSmtc (cb) { smtcCb = cb },
  onLibraryChange () {},
  appState: async () => ({}), windowShot: async () => ({ ok: false }), toggleApp () {}, onApps () {}, onToggleResult () {},
  volume () {}, mute () {}, volumeState: async () => ({ v: null, m: false }),
  audioDevs: async () => ({ out: [], in: [], cur: '', curIn: '' }),
  setDev () {}, onVolume () {}, onDevs () {}, showDesktop () {}
}

try {
  w.eval(fs.readFileSync(path.join(root, 'src/renderer/overlay/app.js'), 'utf8'))
} catch (e) {
  errors.push('app: ' + e.stack)
}

let fail = 0
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : ''))
  if (!cond) fail++
}

setTimeout(() => {
  const d = w.document
  check('曲目标题', d.getElementById('pTitle').textContent === '起风了', d.getElementById('pTitle').textContent)
  check('副标题为歌手', d.getElementById('pArtist').textContent === '买辣椒也用券', d.getElementById('pArtist').textContent)
  const pct = parseFloat(d.getElementById('barFill').style.width)
  check('进度按 30/240 起算并本地插值', pct >= 12.5 && pct < 16, pct + '%')
  check('时间显示', d.getElementById('tCur').textContent === '0:30' && d.getElementById('tDur').textContent === '4:00',
    d.getElementById('tCur').textContent + ' / ' + d.getElementById('tDur').textContent)

  // 直播歌曲的歌词：SMTC 本身没有，主进程按「歌手 + 歌名」联网找到后随 smtc:state 一起推
  const withLyric = liveTrack('起风了', '买辣椒也用券')
  withLyric.lyricLines = [
    { t: 0, text: '这一路上走走停停' },
    { t: 5, text: '顺着少年漂流的痕迹' },
    { t: 10, text: '迈出车站的前一刻' }
  ]
  fakeNow += 100
  smtcCb && smtcCb({
    track: withLyric,
    playback: { time: 6, duration: 325, playing: true, trackId: 'smtc' }
  })
  const ly = d.getElementById('lyrics')
  check('直播歌曲能显示歌词', ly.hidden === false && ly.textContent.includes('顺着少年漂流的痕迹'), ly.textContent)
  check('歌词带下一句预览', /迈出车站的前一刻/.test(ly.textContent), ly.textContent)

  // 切歌
  smtcCb && smtcCb({
    track: liveTrack('Lemon', '米津玄師'),
    playback: { time: 5, duration: 255, playing: false, trackId: 'smtc' }
  })
  check('切歌后标题更新', d.getElementById('pTitle').textContent === 'Lemon', d.getElementById('pTitle').textContent)
  check('无歌词时歌词区收起', d.getElementById('lyrics').hidden === true, d.getElementById('lyrics').innerHTML)
  check('暂停状态进度不动', d.getElementById('tCur').textContent === '0:05', d.getElementById('tCur').textContent)

  // 视频类播放器：播放中一直报同一个位置（只有暂停才刷新）。
  // 这种情况不能让 UI 钉在起点，要继续本地插值往前走。
  const stuck = {
    track: liveTrack('某个视频', 'B站'),
    playback: { time: 60, duration: 300, playing: true, trackId: 'smtc' }
  }
  fakeNow += 1000
  smtcCb && smtcCb(stuck)
  check('视频位置首次推送被采用', d.getElementById('tCur').textContent === '1:00', d.getElementById('tCur').textContent)

  fakeNow += 3000
  smtcCb && smtcCb(stuck)
  setTimeout(() => {
    const t = d.getElementById('tCur').textContent
    check('位置卡住时进度仍往前走', t !== '1:00', '1:00 → ' + t)

    // 暂停后播放器会给一次准确位置，这时要采用
    fakeNow += 500
    smtcCb && smtcCb({ track: stuck.track, playback: { time: 75, duration: 300, playing: false, trackId: 'smtc' } })
    check('暂停时的准确位置会被采用', d.getElementById('tCur').textContent === '1:15', d.getElementById('tCur').textContent)

    // 会话消失
    smtcCb && smtcCb({ track: null, playback: { time: 0, duration: 0, playing: false, trackId: null } })
    check('会话消失回到空状态', d.getElementById('pTitle').textContent === '未在播放', d.getElementById('pTitle').textContent)

    console.log('报错 :', errors.length ? '\n  ' + errors.join('\n  ') : '无')
    process.exit(fail || errors.length ? 1 : 0)
  }, 350)
}, 1200)
