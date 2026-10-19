'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('edge', {
  onWinList: (cb) => ipcRenderer.on('edgebar:win-list', (_e, list) => cb(list)),
  onToggleResult: (cb) => ipcRenderer.on('overlay:toggle-result', (_e, r) => cb(r)),
  onOpen: (cb) => ipcRenderer.on('edgebar:open', () => cb()),
  toggleHwnd: (h) => ipcRenderer.send('edgebar:toggle-hwnd', h),
  windowShot: (h) => ipcRenderer.invoke('overlay:window-shot', h),
  setShape: (rects) => ipcRenderer.send('edgebar:set-shape', rects)
})
