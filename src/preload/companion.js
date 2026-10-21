'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('companion', {
  init: () => ipcRenderer.invoke('companion:init'),
  settings: () => ipcRenderer.invoke('companion:settings'),
  patchSettings: (patch) => ipcRenderer.invoke('companion:patch-settings', patch),
  setActive: (id) => ipcRenderer.invoke('companion:set-active', id),
  saveCharacter: (c) => ipcRenderer.invoke('companion:save-character', c),
  newCharacter: (name) => ipcRenderer.invoke('companion:new-character', name),
  delCharacter: (id) => ipcRenderer.invoke('companion:del-character', id),
  importAsset: (charId, kind) => ipcRenderer.invoke('companion:import-asset', charId, kind),
  assetUrl: (p) => ipcRenderer.invoke('companion:asset-url', p),
  assetData: (p) => ipcRenderer.invoke('companion:asset-data', p),
  logImage: (name, dataUrl) => ipcRenderer.invoke('companion:log-image', name, dataUrl),
  tts: (text) => ipcRenderer.invoke('companion:tts', text),
  fishVoices: () => ipcRenderer.invoke('companion:fish-voices'),
  exportBackup: () => ipcRenderer.invoke('companion:export-backup'),
  importBackup: () => ipcRenderer.invoke('companion:import-backup'),
  win: (action) => ipcRenderer.invoke('companion:win', action),
  // 桌面角色
  petShow: () => ipcRenderer.invoke('pet:show'),
  petHide: () => ipcRenderer.invoke('pet:hide'),
  petWin: (action) => ipcRenderer.invoke('pet:win', action),
  petGetChar: () => ipcRenderer.invoke('pet:get-char'),
  onPetRefresh: (cb) => ipcRenderer.on('companion:pet-refresh', (_e, d) => cb(d))
})
