'use strict'
/**
 * AI 伴侣 · 记忆账本
 * 参考 AgentAtelierR 的 Horae 思路：记忆 = 可追加事件账本 + 关键词时间评分召回。
 * - 本地保守事实提取（明确约定 / 偏好 / 关系 / 重要物品），问句与瞬时情绪不入账
 * - 模型可主动调用 remember/forget 工具写删
 * - 召回 = 关键词命中 + 重要度 + 时间新近度，不依赖向量模型
 */
const fs = require('node:fs')
const path = require('node:path')
const character = require('./character')

const CATS = {
  promise: { w: 3, label: '约定' },
  preference: { w: 2, label: '偏好' },
  relation: { w: 3, label: '关系' },
  fact: { w: 1, label: '事实' },
  task: { w: 2, label: '任务' }
}

function file (charId) { return path.join(character.base(), charId, 'memory.json') }

function read (f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return fallback }
}
function write (f, d) {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(d, null, 1))
}

function get (charId) { return read(file(charId), { events: [], seq: 0 }) }
function save (charId, mem) { write(file(charId), mem) }

function addEvent (charId, { cat = 'fact', text, keywords = [], importance = 1, source = 'local' }) {
  if (!text || !String(text).trim()) return null
  const mem = get(charId)
  const seq = (mem.seq || 0) + 1
  const ev = {
    seq,
    cat: CATS[cat] ? cat : 'fact',
    text: String(text).trim().slice(0, 300),
    keywords: (Array.isArray(keywords) ? keywords : String(keywords).split(/[,，\s]+/)).filter(Boolean).slice(0, 8),
    importance: Math.max(1, Math.min(5, importance | 0)),
    source,
    at: Date.now()
  }
  mem.events.push(ev)
  mem.seq = seq
  if (mem.events.length > 400) mem.events = mem.events.slice(-400)
  save(charId, mem)
  return ev
}

function removeEvent (charId, seq) {
  const mem = get(charId)
  const before = mem.events.length
  mem.events = mem.events.filter((e) => e.seq !== seq)
  save(charId, mem)
  return before - mem.events.length
}

/** 本地保守事实提取：只抓高置信的明确表述 */
const RULES = [
  { re: /(?:我叫|我的名字(?:是|叫)|call me)\s*([^\s，。,]{1,16})/i, cat: 'fact', imp: 4, fmt: (m) => '用户的名字是 ' + m[1], kw: (m) => [m[1]] },
  { re: /(?:记住|请记住|记得)[：:，,]?\s*(.{4,80})/, cat: 'fact', imp: 3, fmt: (m) => String(m[1]).trim(), kw: () => [] },
  { re: /(?:我(?:喜欢|爱|最爱)|我爱吃|我喜欢玩)\s*([^\s，。,]{1,24})/, cat: 'preference', imp: 2, fmt: (m) => '用户喜欢 ' + m[1], kw: (m) => [m[1]] },
  { re: /(?:我讨厌|我不喜欢|别再)\s*([^\s，。,]{1,24})/, cat: 'preference', imp: 2, fmt: (m) => '用户不喜欢 ' + m[1], kw: (m) => [m[1]] },
  { re: /(?:我们约好|说好了|明天|下周|后天)[^。]{0,40}(?:一起|要去|记得)/, cat: 'promise', imp: 3, fmt: (m) => null }
]
function extractFacts (charId, userText) {
  if (!userText || userText.length > 500) return
  for (const r of RULES) {
    const m = r.re.exec(userText)
    if (m) {
      const text = r.fmt ? r.fmt(m) : m[0]
      if (text) addEvent(charId, { cat: r.cat, text, keywords: r.kw ? r.kw(m) : [], importance: r.imp, source: 'local' })
      return // 每轮最多记一条，保守
    }
  }
}

/** 召回：与输入相关的长期事件（关键词 + 类别 + 重要度 + 新近度） */
function recall (charId, query, limit = 6) {
  const mem = get(charId)
  const q = String(query || '')
  const terms = []
  // 中文二元组 + 英文词
  const en = q.match(/[a-zA-Z]{2,}/g) || []
  terms.push(...en.map((x) => x.toLowerCase()))
  const zh = q.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const seg of zh.split(/\s+/)) {
    for (let i = 0; i + 1 < seg.length; i++) terms.push(seg.slice(i, i + 2))
  }
  const now = Date.now()
  const scored = mem.events.map((e) => {
    let s = e.importance * 0.6
    for (const t of terms) {
      if (e.text.includes(t) || (e.keywords || []).some((k) => k.includes(t))) { s += 2; break }
    }
    s += Math.max(0, 1.5 - (now - e.at) / (1000 * 60 * 60 * 24 * 14)) // 两周内新近加成
    return { e, s }
  })
  return scored.filter((x) => x.s > 1).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.e)
}

/** 记忆工具（暴露给模型的 function calling） */
function toolDefs () {
  return [
    {
      type: 'function',
      function: {
        name: 'remember',
        description: '把重要信息写入长期记忆（用户的约定、偏好、关系变化、任务安排等）',
        parameters: {
          type: 'object',
          properties: {
            cat: { type: 'string', enum: Object.keys(CATS), description: '类别' },
            text: { type: 'string', description: '要记住的内容，一句话' },
            keywords: { type: 'array', items: { type: 'string' }, description: '关键词，2-5 个' },
            importance: { type: 'integer', description: '重要度 1-5' }
          },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'forget',
        description: '按内容关键词删除一条记忆',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '要删除的记忆包含的词' } },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'recall_memory',
        description: '检索长期记忆里与关键词相关的内容',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }
    }
  ]
}

function execTool (charId, name, args) {
  if (name === 'remember') {
    const ev = addEvent(charId, {
      cat: args.cat, text: args.text, keywords: args.keywords, importance: args.importance || 3, source: 'model'
    })
    return ev ? `已记住（#${ev.seq} ${ev.text}）` : '内容为空，没有记住'
  }
  if (name === 'forget') {
    const mem = get(charId)
    const hit = [...mem.events].reverse().find((e) => e.text.includes(args.text || '\u0000'))
    if (!hit) return '没有找到相关记忆'
    removeEvent(charId, hit.seq)
    return `已删除记忆 #${hit.seq}：${hit.text}`
  }
  if (name === 'recall_memory') {
    const evs = recall(charId, args.query || '', 8)
    if (!evs.length) return '没有相关记忆'
    return evs.map((e) => `#${e.seq}[${CATS[e.cat].label}] ${e.text}`).join('\n')
  }
  return '未知记忆工具'
}

function summaryText (charId, query) {
  const evs = recall(charId, query || '', 6)
  if (!evs.length) return ''
  return '【你记得的事】\n' + evs.map((e) => `- ${e.text}`).join('\n')
}

module.exports = { addEvent, removeEvent, extractFacts, recall, toolDefs, execTool, summaryText, get }
