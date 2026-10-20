'use strict'
const { contextBridge, ipcRenderer } = require('electron')
// 桌宠依赖持续自主上屏：渲染层层面再兜底关闭后台节流（rAF/timer/合成）
try {
  const { webFrame } = require('electron')
  if (webFrame && webFrame.setBackgroundThrottling) webFrame.setBackgroundThrottling(false)
} catch (e) { console.warn('[overlay preload] webFrame 节流关闭失败', e && e.message) }

contextBridge.exposeInMainWorld('aura', {
  init: () => ipcRenderer.invoke('overlay:init'),
  // v0.3.38：弃用 setShape（裁剪视觉）。动态穿透：渲染层判断光标在热元素上时关穿透
  ignoreMouse: (on) => ipcRenderer.send('overlay:ignore-mouse', on),
  setShape: (rects) => ipcRenderer.send('overlay:set-shape', rects),
  reportError: (kind, msg, stack) => ipcRenderer.send('overlay:renderer-error', kind, msg, stack),
  openSettings: () => ipcRenderer.send('overlay:open-settings'),
  openCompanion: () => ipcRenderer.send('overlay:open-companion'),
  hide: () => ipcRenderer.send('overlay:hide'),
  quit: () => ipcRenderer.send('overlay:quit'),
  launch: (id) => ipcRenderer.invoke('overlay:launch', id),
  reveal: (id) => ipcRenderer.invoke('overlay:reveal', id),
  remove: (id) => ipcRenderer.invoke('overlay:remove', id),
  setGameOrder: (ids) => ipcRenderer.invoke('games:set-order', ids),
  player: (cmd, arg) => ipcRenderer.send('player:command', cmd, arg),
  tick: (state) => ipcRenderer.send('player:tick', state),
  onConfig: (cb) => ipcRenderer.on('overlay:config', (_e, p) => cb(p)),
  onCommand: (cb) => ipcRenderer.on('player:cmd', (_e, cmd, arg) => cb(cmd, arg)),
  onSync: (cb) => ipcRenderer.on('player:sync', (_e, s) => cb(s)),
  onSmtc: (cb) => ipcRenderer.on('smtc:state', (_e, s) => cb(s)),
  onLibraryChange: (cb) => ipcRenderer.on('player:library', () => cb()),
  // ---- launcher：程序运行状态 / 音量 / 音频设备 / 显示桌面 ----
  appState: () => ipcRenderer.invoke('overlay:app-state'),
  windowShot: (h) => ipcRenderer.invoke('overlay:window-shot', h),
  toggleApp: (id) => ipcRenderer.send('overlay:toggle-app', id),
  onApps: (cb) => ipcRenderer.on('overlay:app-state', (_e, m) => cb(m)),
  onToggleResult: (cb) => ipcRenderer.on('overlay:toggle-result', (_e, r) => cb(r)),
  volume: (v) => ipcRenderer.send('overlay:volume', v),
  mute: () => ipcRenderer.send('overlay:mute'),
  volumeState: () => ipcRenderer.invoke('overlay:volume-state'),
  onVolume: (cb) => ipcRenderer.on('overlay:volume-state', (_e, s) => cb(s)),
  audioDevs: () => ipcRenderer.invoke('overlay:audio-devs'),
  setDev: (flow, id) => ipcRenderer.send('overlay:set-dev', flow, id),
  onDevs: (cb) => ipcRenderer.on('overlay:audio-devs', (_e, s) => cb(s)),
  showDesktop: () => ipcRenderer.send('overlay:show-desktop'),
  // ---- 桌宠（overlay 内嵌渲染）：角色状态 + 资产加载 ----
  petState: () => ipcRenderer.invoke('pet:state'),
  petGetChar: () => ipcRenderer.invoke('pet:get-char'),
  assetUrl: (p) => ipcRenderer.invoke('companion:asset-url', p),
  assetData: (p) => ipcRenderer.invoke('companion:asset-data', p),
  onPetState: (cb) => ipcRenderer.on('pet:state', (_e, s) => cb(s)),
  petSnapshot: (tag) => ipcRenderer.invoke('pet:snapshot', tag),
  logImage: (name, dataUrl) => ipcRenderer.invoke('companion:log-image', name, dataUrl),
  // ---- 桌宠增强：视觉跟踪光标 / 气泡聊天 / 语音捕捉 / 角色大小 ----
  onCursor: (cb) => ipcRenderer.on('overlay:cursor', (_e, p) => cb(p)),
  petSettings: () => ipcRenderer.invoke('companion:settings'),
  petChatSend: (text) => ipcRenderer.invoke('companion:send', text),
  // 聊天面板显示时让 overlay 窗口可聚焦（收键盘），隐藏时切回不可聚焦
  petChatFocus: (on) => ipcRenderer.invoke('pet:chat-focus', on),
  petChatStop: () => ipcRenderer.invoke('companion:stop'),
  petTranscribe: (b64, mime) => ipcRenderer.invoke('companion:transcribe', b64, mime),
  // 触摸反应语音：用当前 TTS 档位合成一句反应语（{ok,url,speed} 或 {fallback}）
  petSpeak: (text) => ipcRenderer.invoke('companion:tts', String(text || '').slice(0, 200)),
  onPetDelta: (cb) => ipcRenderer.on('companion:delta', (_e, d) => cb(d)),
  onPetDone: (cb) => ipcRenderer.on('companion:done', (_e, d) => cb(d)),
  onPetError: (cb) => ipcRenderer.on('companion:error', (_e, d) => cb(d)),
  onPetConfig: (cb) => ipcRenderer.on('pet:config', (_e, c) => cb(c))
})
