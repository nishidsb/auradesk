'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('companion', {
  init: () => ipcRenderer.invoke('companion:init'),
  send: (text) => ipcRenderer.invoke('companion:send', text),
  stop: () => ipcRenderer.invoke('companion:stop'),
  clearHistory: (id) => ipcRenderer.invoke('companion:clear-history', id),
  models: (baseUrl, apiKey) => ipcRenderer.invoke('companion:models', baseUrl, apiKey),
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
  transcribe: (b64, mime) => ipcRenderer.invoke('companion:transcribe', b64, mime),
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
  onPetRefresh: (cb) => ipcRenderer.on('companion:pet-refresh', (_e, d) => cb(d)),
  // 长期记忆账本
  memoryList: () => ipcRenderer.invoke('companion:memory-list'),
  memoryDel: (seq) => ipcRenderer.invoke('companion:memory-del', seq),
  onDelta: (cb) => ipcRenderer.on('companion:delta', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('companion:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('companion:error', (_e, d) => cb(d))
})
