'use strict'
/**
 * AI 伴侣 · 贾维斯工具集
 * 把 AuraDesk 已有的桌面能力暴露给模型（function calling）：
 * 看时间、列运行程序、启动卡片程序、音量、显示桌面、打开网址。
 * 设备/启动器能力复用 launcher 助手，不新开进程。
 */
const store = require('../store')
const { log } = require('../logger')

let launcher = null // 注入 src/main/launcher.js（复用 latestApps / helper 指令）
let deps = { broadcastAll: () => {} }

function init (launcherMod, broadcastAll, launchGameFn) {
  launcher = launcherMod
  deps.broadcastAll = broadcastAll
  if (launchGameFn) deps.launchGame = launchGameFn
}

function defs () {
  return [
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: '获取当前日期与时间',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_running',
        description: '列出当前正在运行的程序（窗口标题列表，标注前台/最小化）',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'launch_program',
        description: '启动用户桌面卡片上的程序（按名字模糊匹配），已运行则切换到它',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '程序或游戏名（支持模糊）' } },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'set_volume',
        description: '设置系统音量（0-100）或静音切换',
        parameters: {
          type: 'object',
          properties: {
            volume: { type: 'integer', description: '0-100，不传则切换静音' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'show_desktop',
        description: '显示桌面（等价 Win+D）',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_url',
        description: '用默认浏览器打开网址',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        }
      }
    }
  ]
}

function exec (name, args) {
  const g = store.get().global
  switch (name) {
    case 'get_time': {
      const d = new Date()
      return '现在时间：' + d.toLocaleString('zh-CN', { hour12: false })
    }
    case 'list_running': {
      const win = (launcher && launcher.latestWindows) || []
      if (!win.length) return '当前没有检测到运行中的窗口'
      return win.slice(0, 15).map((w) => `${w.fg ? '[前台] ' : ''}${w.t || w.pn}${w.min ? '（最小化）' : ''}`).join('\n')
    }
    case 'launch_program': {
      const q = String(args.name || '').toLowerCase()
      const lib = g.library || []
      const hit = lib.find((x) => (x.name || '').toLowerCase().includes(q)) ||
        lib.find((x) => (x.target || '').toLowerCase().includes(q))
      if (!hit) return '桌面上没有叫「' + args.name + '」的卡片。已导入的程序有：' + lib.slice(0, 10).map((x) => x.name).join('、')
      // 复用渲染层同款逻辑：已运行→切换，未运行→启动
      const apps = (launcher && launcher.latestApps) || {}
      const a = apps[hit.id]
      if (a && Number.isFinite(Number(a.h))) {
        launcher.toggleByHandle(a.h)
        return '「' + hit.name + '」正在运行，已切换过去'
      }
      deps.launchGame ? deps.launchGame(hit.id) : null
      return '正在启动「' + hit.name + '」'
    }
    case 'set_volume': {
      if (!launcher) return '助手未就绪'
      if (args.volume == null) { launcher.helperCmdPublic('mute') ; return '已切换静音' }
      const v = Math.max(0, Math.min(100, Math.trunc(Number(args.volume) || 0)))
      launcher.helperCmdPublic('vol ' + v)
      return '音量已设为 ' + v
    }
    case 'show_desktop': {
      if (!launcher) return '助手未就绪'
      launcher.helperCmdPublic('desk')
      return '已显示桌面'
    }
    case 'open_url': {
      const u = String(args.url || '')
      if (!/^https?:\/\//.test(u)) return '网址格式不对'
      require('electron').shell.openExternal(u)
      return '已打开 ' + u
    }
    default:
      return '未知工具'
  }
}

module.exports = { init, defs, exec }
