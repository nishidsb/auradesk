/* 预览用的假数据：仅用于无头浏览器截图自查，不参与应用运行 */
(function () {
  function cover (title, h, tag) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="450" viewBox="0 0 320 450">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="hsl(${h},72%,58%)"/>
          <stop offset="1" stop-color="hsl(${(h + 55) % 360},62%,26%)"/>
        </linearGradient>
        <radialGradient id="r" cx="0.7" cy="0.2" r="0.8">
          <stop offset="0" stop-color="rgba(255,255,255,.55)"/>
          <stop offset="1" stop-color="rgba(255,255,255,0)"/>
        </radialGradient>
      </defs>
      <rect width="320" height="450" fill="url(#g)"/>
      <rect width="320" height="450" fill="url(#r)"/>
      <circle cx="250" cy="360" r="150" fill="rgba(255,255,255,.10)"/>
      <circle cx="60" cy="90" r="110" fill="rgba(0,0,0,.14)"/>
      <path d="M0 330 L120 210 L200 300 L320 180 L320 450 L0 450 Z" fill="rgba(0,0,0,.28)"/>
      <text x="26" y="392" font-family="Microsoft YaHei UI, sans-serif" font-size="34" font-weight="700" fill="#fff">${title}</text>
      <text x="26" y="422" font-family="Microsoft YaHei UI, sans-serif" font-size="15" letter-spacing="3" fill="rgba(255,255,255,.7)">${tag}</text>
    </svg>`
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  }

  const L = [
    ['赛博朋克', 330, 'CYBERPUNK'], ['巫师 3', 8, 'WITCHER'], ['星露谷', 92, 'STARDEW'],
    ['空洞骑士', 250, 'HOLLOW'], ['哈迪斯', 18, 'HADES'], ['极限竞速', 200, 'FORZA'],
    ['死亡搁浅', 210, 'STRANDING'], ['只狼', 40, 'SEKIRO'], ['无主之地', 300, 'BORDERLANDS'],
    ['女神异闻录', 350, 'PERSONA'], ['双人成行', 160, 'IT TAKES TWO'], ['失落城堡', 270, 'LOST CASTLE']
  ]
  const R = [
    ['荒野大镖客', 20, 'REDEMPTION'], ['PEAK', 190, 'PEAK'], ['赛博朋克 2', 320, 'CYBERPUNK'],
    ['王国两位君主', 40, 'KINGDOMS'], ['歧路旅人', 30, 'OCTOPATH'], ['VALHEIM', 110, 'VALHEIM'],
    ['如何钓鱼', 210, 'HOW TO FISH'], ['刺客信条', 220, 'ASSASSIN'], ['博德之门', 285, 'BALDURS GATE'],
    ['双影奇境', 170, 'SPLIT FICTION'], ['光与影', 45, 'EXPEDITION'], ['星之翼', 140, 'STAR WING']
  ]

  function mk (arr, prefix) {
    return arr.map(([name, hue, tag], i) => ({
      id: prefix + i, name, kind: 'exe', target: 'C:\\demo\\' + name + '.exe',
      hue, coverUrl: cover(name, hue, tag)
    }))
  }

  // 混一点别的来源，预览里能看出平台筛选的样子
  const left = mk(L, 'l').map((g, i) => ({ ...g, source: i % 5 === 4 ? 'startmenu' : 'steam' }))
  const right = mk(R, 'r').map((g, i) => ({ ...g, source: i % 4 === 3 ? 'local' : 'epic' }))
  // 最近玩过的排前面（PS5 也是这个逻辑）
  left[0].playedAt = Date.now() - 3600e3
  right[2].playedAt = Date.now() - 86400e3

  const lyricLines = [
    { t: 0, text: '沈むように溶けてゆくように' },
    { t: 12, text: '二人だけの空が広がる夜に' },
    { t: 24, text: '「さよなら」だけだった' },
    { t: 36, text: 'その一言で全てが分かった' },
    { t: 48, text: '日が沈み出した空と君の姿' },
    { t: 60, text: 'フェンス越しに重なっていた' },
    { t: 72, text: '初めて会った日から' },
    { t: 84, text: '僕の心の全てを奪った' },
    { t: 96, text: 'どこか儚い空気を纏う君は' },
    { t: 108, text: '寂しい目をしてたんだ' },
    { t: 120, text: 'いつだってチックタックと' },
    { t: 132, text: '鳴る世界で何故だ' }
  ]

  const payload = {
    key: 'demo',
    screen: { width: 1600, height: 900, scaleFactor: 1, primary: true },
    demo: true,
    cfg: {
      label: '', followPrimary: false,
      wallpaper: { type: 'desktop', preset: 'sakura', path: '', url: '', dim: 0.06, blur: 0, scale: 1.06 },
      ui: {
        scale: 1, showDock: true, dockSide: 'left',
        showPlayer: true, showClock: true, showLyrics: true, lowFx: false
      }
    },
    musicSource: 'smtc',
    library: [...left, ...right],
    track: {
      id: 'smtc', title: '夜に駆ける', artist: 'YOASOBI · THE BOOK', album: 'THE BOOK',
      duration: 189, url: '', coverUrl: cover('夜', 330, 'YOASOBI'), lyricLines, live: true
    },
    playback: { time: 113, duration: 189, playing: true, trackId: 'smtc' },
    isOwner: true,
    widgets: ['w_discord', 'w_obs', 'w_gem']
  }

  window.aura = {
    init: async () => payload,
    setIgnore: () => {},
    openSettings: () => {},
    hide: () => {},
    quit: () => {},
    launch: async () => ({ ok: false, message: '预览模式' }),
    reveal: async () => false,
    remove: async () => true,
    player: () => {},
    tick: () => {},
    onConfig: (cb) => { window.__onConfig = cb },
    onCommand: () => {},
    onSync: (cb) => { window.__onSync = cb },
    onSmtc: (cb) => { window.__onSmtc = cb },
    onLibraryChange: () => {}
  }
})()
