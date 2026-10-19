'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('auraSet', {
  init: () => ipcRenderer.invoke('settings:init'),
  patchDisplay: (key, patch) => ipcRenderer.invoke('settings:patch-display', key, patch),
  patchGlobal: (patch) => ipcRenderer.invoke('settings:patch-global', patch),
  pickWallpaper: (key, kind) => ipcRenderer.invoke('settings:pick-wallpaper', key, kind),
  addGames: () => ipcRenderer.invoke('settings:add-games'),
  scanFolder: () => ipcRenderer.invoke('settings:scan-folder'),
  setCover: (id) => ipcRenderer.invoke('settings:set-cover', id),
  removeGame: (id) => ipcRenderer.invoke('settings:remove-game', id),
  renameGame: (id, name) => ipcRenderer.invoke('settings:rename-game', id, name),
  addMusic: () => ipcRenderer.invoke('settings:add-music'),
  scanMusic: () => ipcRenderer.invoke('settings:scan-music'),
  removeMusicFolder: (f) => ipcRenderer.invoke('settings:remove-music-folder', f),
  importSteam: () => ipcRenderer.invoke('settings:import-steam'),
  importEpic: () => ipcRenderer.invoke('settings:import-epic'),
  scanStartMenu: () => ipcRenderer.invoke('settings:scan-startmenu'),
  importStartMenu: (ids) => ipcRenderer.invoke('settings:import-startmenu', ids),
  fillCovers: () => ipcRenderer.invoke('settings:fill-covers'),
  smtcStatus: () => ipcRenderer.invoke('settings:smtc-status'),
  openFolder: (p) => ipcRenderer.invoke('settings:open-folder', p),
  window: (a) => ipcRenderer.invoke('settings:window', a),
  quit: () => ipcRenderer.invoke('settings:quit'),
  openUserData: () => ipcRenderer.invoke('settings:open-settings-folder'),
  companionInit: () => ipcRenderer.invoke('companion:init'),
  companionPatch: (patch) => ipcRenderer.invoke('companion:patch-settings', patch),
  companionModels: (baseUrl, apiKey) => ipcRenderer.invoke('companion:models', baseUrl, apiKey),
  onRefresh: (cb) => ipcRenderer.on('settings:refresh', () => cb()),
  onMusicProgress: (cb) => ipcRenderer.on('music:progress', (_e, p) => cb(p)),
  onImportProgress: (cb) => ipcRenderer.on('import:progress', (_e, p) => cb(p)),
  onSmtc: (cb) => ipcRenderer.on('smtc:state', (_e, p) => cb(p))
})
