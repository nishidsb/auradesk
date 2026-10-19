/* 设置面板预览假数据（仅自查用） */
(function () {
  const PRESET_ORDER = ['sakura', 'twilight', 'abyss', 'noir', 'paper']
  const lib = [
    ['赛博朋克 2077', 330], ['巫师 3', 8], ['星露谷物语', 92], ['空洞骑士', 250],
    ['哈迪斯', 18], ['极限竞速', 200], ['死亡搁浅', 210], ['只狼', 40]
  ].map(([name, hue], i) => ({
    id: 'g' + i, name, kind: 'exe',
    target: 'C:\\Program Files\\Games\\' + name + '\\game.exe',
    cover: '', coverUrl: '', hue
  }))

  const cfg = {
    label: '',
    wallpaper: { type: 'desktop', preset: 'sakura', path: '', url: '', dim: 0.06, blur: 0, scale: 1.06 },
    ui: {
      scale: 1, showDock: true, dockSide: 'left',
      showPlayer: true, showClock: true, showLyrics: true, lowFx: false
    },
    followPrimary: false
  }

  const data = {
    primaryKey: 'd1',
    displays: [
      { key: 'd1', index: 1, label: '主屏', primary: true, width: 2560, height: 1440, x: 0, y: 0, scaleFactor: 1.5, cfg },
      { key: 'd2', index: 2, label: '显示器 2', primary: false, width: 1920, height: 1080, x: 2560, y: 0, scaleFactor: 1, cfg: JSON.parse(JSON.stringify(cfg)) },
      { key: 'd3', index: 3, label: '显示器 3', primary: false, width: 1920, height: 1080, x: -1920, y: 0, scaleFactor: 1, cfg: JSON.parse(JSON.stringify(cfg)) }
    ],
    global: {
      library: lib, tracks: Array.from({ length: 6 }, (_, i) => ({
        id: 't' + i, title: ['夜に駆ける', 'アイドル', 'Lemon', '紅蓮華', '打上花火', '群青'][i],
        artist: ['YOASOBI', 'YOASOBI', '米津玄師', 'LiSA', 'DAOKO', 'YOASOBI'][i],
        album: 'THE BOOK', duration: 189 + i * 12, cover: '', coverUrl: '', lyrics: ''
      })),
      musicFolders: ['D:\\Music\\ACG', 'E:\\Music\\J-Pop'],
      musicSource: 'smtc', sgdbKey: '',
      hotkeyToggle: 'Control+Alt+A', hotkeySettings: 'Control+Alt+S',
      autoLaunch: false, alwaysOnTop: false, primaryOnly: false, widgetIds: []
    }
  }

  window.auraSet = {
    init: async () => JSON.parse(JSON.stringify(data)),
    patchDisplay: async () => ({}),
    patchGlobal: async () => ({ ok: true }),
    pickWallpaper: async () => null,
    addGames: async () => null,
    scanFolder: async () => null,
    setCover: async () => null,
    removeGame: async () => true,
    renameGame: async () => true,
    addMusic: async () => null,
    scanMusic: async () => ({ tracks: [] }),
    removeMusicFolder: async () => true,
    openFolder: async () => {},
    window: () => {},
    quit: () => {},
    openUserData: () => {},
    importSteam: async () => ({ ok: true, added: 0, scanned: 0 }),
    importEpic: async () => ({ ok: true, added: 0, scanned: 0 }),
    scanStartMenu: async () => ({ ok: true, items: [] }),
    importStartMenu: async () => ({ ok: true, added: 0 }),
    fillCovers: async () => ({ ok: true, total: 0, filled: 0 }),
    smtcStatus: async () => ({ ready: true, active: false }),
    onRefresh: () => {},
    onMusicProgress: () => {},
    onImportProgress: () => {},
    onSmtc: () => {}
  }
})()
