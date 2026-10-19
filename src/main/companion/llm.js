'use strict'
/**
 * AI 伴侣 · LLM 客户端
 * OpenAI 兼容 Chat Completions（SSE 流式）。远程 API 与本地部署模型
 * （Ollama / LM Studio / vLLM 等 /v1 兼容端点）走同一协议，只差 baseURL。
 * 支持工具调用（function calling），工具由 tools.js 执行后回填继续生成。
 */
const { log } = require('../logger')

/**
 * 流式对话。onDelta(text) 逐段回调；遇到工具调用时执行 tools 并自动续轮。
 * 返回 { content, toolResults }
 */
async function chatStream ({ baseUrl, apiKey, model, messages, temperature = 0.8, tools, toolExec, signal, onDelta }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions'
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey

  const roundMessages = [...messages]
  const toolResults = []
  let content = ''

  for (let round = 0; round < 4; round++) {
    const body = { model, messages: roundMessages, temperature, stream: true }
    if (tools && tools.length) body.tools = tools
    const res = await fetch(url, {
      method: 'POST', headers, signal,
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`)
    }
    // SSE 解析
    let buf = ''
    let roundContent = ''
    const calls = [] // { id, name, arguments }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let j
        try { j = JSON.parse(data) } catch { continue }
        const d = j.choices && j.choices[0] && (j.choices[0].delta || {})
        if (d.content) {
          roundContent += d.content
          try { onDelta && onDelta(d.content) } catch {}
        }
        const tc = d.tool_calls
        if (Array.isArray(tc)) {
          for (const c of tc) {
            const idx = c.index != null ? c.index : 0
            if (!calls[idx]) calls[idx] = { id: c.id || '', name: '', arguments: '' }
            if (c.id) calls[idx].id = c.id
            if (c.function && c.function.name) calls[idx].name += c.function.name
            if (c.function && c.function.arguments) calls[idx].arguments += c.function.arguments
          }
        }
      }
    }
    content += roundContent
    if (!calls.length) break // 没有工具调用，对话结束

    // 工具调用轮：执行并回填
    roundMessages.push({
      role: 'assistant',
      content: roundContent || null,
      tool_calls: calls.map((c) => ({
        id: c.id || 'call_' + round, type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' }
      }))
    })
    for (const c of calls) {
      let result
      try {
        const args = JSON.parse(c.arguments || '{}')
        result = toolExec ? await toolExec(c.name, args) : '工具不可用'
      } catch (err) {
        result = '工具执行失败: ' + (err && err.message)
      }
      // 工具返回 { text, image }（如 see_screen 截屏）→ 组装多模态 tool 消息
      let toolContent = String(result)
      if (result && typeof result === 'object' && result.image) {
        toolContent = [
          { type: 'text', text: result.text || '截图如下' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + result.image } }
        ]
      }
      log('[companion] 工具', c.name, '->', String(typeof result === 'object' ? result.text : result).slice(0, 200))
      toolResults.push({ name: c.name, result: typeof result === 'object' ? (result.text || '') : String(result) })
      roundMessages.push({ role: 'tool', tool_call_id: c.id || 'call_' + round, content: toolContent })
    }
  }
  return { content, toolResults }
}

/** 模型列表（本地端点 /v1/models），失败返回空数组 */
async function listModels ({ baseUrl, apiKey }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const url = /\/models$/.test(base) ? base : base + '/models'
  try {
    const headers = {}
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey
    const res = await fetch(url, { headers })
    if (!res.ok) return []
    const j = await res.json()
    return (j.data || []).map((m) => m.id).filter(Boolean)
  } catch {
    return []
  }
}

module.exports = { chatStream, listModels }
