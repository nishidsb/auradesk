'use strict'
/* AI 伴侣渲染层：流式聊天 + 立绘/Spine/3D 形象 + 语音输入/播报 */
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** node integration 关闭，拿不到 path 模块：自实现 basename（/ 与 \ 都认） */
const basename = (p) => String(p || '').replace(/\\/g, '/').split('/').pop()

let S = { characters: [], history: [], settings: {} }
let char = null
let generating = false
let pendingAi = null // 流式中的消息元素

/* ---------------- 消息渲染 ---------------- */
function addMsg (role, text, cls) {
  const d = document.createElement('div')
  d.className = 'msg ' + (cls || role)
  d.textContent = text || ''
  $('chat').appendChild(d)
  $('chat').scrollTop = $('chat').scrollHeight
  return d
}
function trimChat () {
  const chat = $('chat')
  while (chat.children.length > 120) chat.removeChild(chat.firstChild)
}

function renderHistory () {
  $('chat').innerHTML = ''
  for (const m of S.history.slice(-60)) addMsg(m.role === 'user' ? 'user' : 'ai', m.content)
}

/* ---------------- 流式回复 ---------------- */
window.companion.onDelta(({ text }) => {
  if (!pendingAi) { pendingAi = addMsg('ai', '', 'ai typing'); pendingAi.dataset.buf = '' }
  pendingAi.dataset.buf += text
  pendingAi.textContent = pendingAi.dataset.buf
  $('chat').scrollTop = $('chat').scrollHeight
})

window.companion.onDone(async ({ content, tools: toolCalls, audio }) => {
  generating = false
  $('btnStop').hidden = true
  $('btnSend').hidden = false
  document.body.id = ''
  if (pendingAi) {
    pendingAi.classList.remove('typing')
    if (toolCalls && toolCalls.length) {
      const t = document.createElement('div')
      t.className = 'tools'
      t.textContent = toolCalls.map((x) => x.name).join(' · ')
      pendingAi.appendChild(t)
    }
  }
  pendingAi = null
  trimChat()
  // TTS：api 音频直接播；否则浏览器本地合成
  const clean = stripTags(content)
  if (clean && S.settings.ttsMode === 'api' && audio && audio.url) playAudio(audio.url, audio.speed)
  else if (clean && S.settings.ttsMode !== 'off') speakBrowser(clean)
  // 新对话入账后刷新时间线（若抽屉开着）
  if (!$('charDrawer').hidden && !$('tabPersona').hidden) renderTimeline()
})

window.companion.onError(({ message, partial }) => {
  generating = false
  $('btnStop').hidden = true
  $('btnSend').hidden = false
  document.body.id = ''
  if (pendingAi) { pendingAi.classList.remove('typing'); if (partial) pendingAi.textContent = pendingAi.dataset.buf }
  pendingAi = null
  addMsg('', message, 'syserr')
})

/** 旁白/台词分段显示：*斜体旁白* 与正文分开 */
function stripTags (s) {
  return String(s || '')
    .replace(/<(?:think|tool_call|function_call)[^>]*>[\s\S]*?<\/(?:think|tool_call|function_call)>/gi, '')
    .replace(/<answer>|<\/answer>|<code>|<\/code>/gi, '')
    .trim()
}
function renderAiText (raw) {
  // 简易分段：整段 *...* 或（...）开头的行当旁白
  const el = document.createElement('div')
  el.className = 'msg ai'
  for (const line of String(raw).split('\n')) {
    const t = line.trim()
    if (!t) continue
    const seg = document.createElement('div')
    if (/^\*.*\*$/.test(t) || /^（.*）$/.test(t)) { seg.className = 'msg narr'; seg.textContent = t.replace(/^\*|\*$|^（|）$/g, '') }
    else seg.textContent = t
    el.appendChild(seg)
  }
  return el
}

/* ---------------- 发送 ---------------- */
async function sendText () {
  const v = $('input').value.trim()
  if (!v || generating) return
  $('input').value = ''
  $('input').style.height = 'auto'
  addMsg('user', v)
  generating = true
  pendingAi = null
  $('btnSend').hidden = true
  $('btnStop').hidden = false
  window.companion.send(v)
}
$('btnSend').addEventListener('click', sendText)
$('btnStop').addEventListener('click', () => window.companion.stop())
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() }
})
$('input').addEventListener('input', function () {
  this.style.height = 'auto'
  this.style.height = Math.min(88, this.scrollHeight) + 'px'
})

/* ---------------- 语音输入（Whisper 兼容端点） ---------------- */
let recorder = null
let chunks = []
$('btnMic').addEventListener('pointerdown', async () => {
  if (recorder) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    chunks = []
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => chunks.push(e.data)
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      $('btnMic').classList.remove('rec')
      const blob = new Blob(chunks, { type: 'audio/webm' })
      if (blob.size < 1200) return
      const b64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))
      addMsg('', '识别中…', 'syserr')
      const r = await window.companion.transcribe(b64, 'audio/webm')
      const last = $('chat').lastChild
      if (last && last.textContent === '识别中…') last.remove()
      if (r.ok && r.text) { $('input').value = r.text; sendText() }
      else if (r.message) addMsg('', '语音识别失败：' + r.message, 'syserr')
    }
    recorder.start()
    $('btnMic').classList.add('rec')
  } catch { addMsg('', '麦克风不可用', 'syserr') }
})
const micUp = () => { if (recorder && recorder.state === 'recording') { recorder.stop(); recorder = null } }
$('btnMic').addEventListener('pointerup', micUp)
$('btnMic').addEventListener('pointerleave', micUp)

/* ---------------- TTS 播放 ---------------- */
let curAudio = null
function playAudio (url, speed) {
  try {
    if (curAudio) curAudio.pause()
    curAudio = new Audio(url)
    // 语速：Fish API 本身不支持 speed，用播放速率实现
    if (speed && speed !== 1) curAudio.playbackRate = speed
    document.body.id = 'speaking'
    curAudio.onended = () => { document.body.id = '' }
    curAudio.play()
  } catch {}
}
function speakBrowser (text) {
  try {
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text.slice(0, 400))
    u.lang = 'zh-CN'
    const v = char && char.voice ? char.voice : {}
    u.pitch = v.pitch != null ? v.pitch : 1
    u.rate = v.rate != null ? v.rate : 1
    const zh = speechSynthesis.getVoices().find((x) => /zh|Chinese/i.test(x.lang))
    if (zh) u.voice = zh
    document.body.id = 'speaking'
    u.onend = () => { document.body.id = '' }
    speechSynthesis.speak(u)
  } catch {}
}

/* ---------------- 形象（立绘 / Spine / 3D VRM） ---------------- */
let vrmRuntime = null
let spineRuntime = null

async function assetUrl (p) { return p ? window.companion.assetUrl(p) : '' }

async function showVisual () {
  const v = (char && char.visual) || {}
  const mode = v.mode || 'still'
  $('stillImg').hidden = mode !== 'still'
  $('spineCanvas').hidden = mode !== 'spine'
  $('vrmCanvas').hidden = mode !== 'vrm'
  $('stageFallback').hidden = true
  try {
    if (mode === 'still') {
      const url = await assetUrl(v.image)
      if (url) { $('stillImg').src = url; $('stillImg').hidden = false }
      else { $('stillImg').hidden = true; $('stageFallback').hidden = false }
    } else if (mode === 'spine') {
      await showSpine(v)
    } else if (mode === 'vrm') {
      await showVrm(v)
    }
  } catch (err) {
    console.error('[visual]', err)
    $('stageFallback').hidden = false
  }
}

/* Spine：spine-canvas 加载 atlas + skel(.json/.skel)，播放 idle 动画，说话切 talk */
async function showSpine (v) {
  const { SPINE } = window.AuraLibs
  if (!v.spine || !v.spine.atlas || !v.spine.skel) { $('stageFallback').hidden = false; return }
  const atlasUrl = await assetUrl(v.spine.atlas)
  const skelUrl = await assetUrl(v.spine.skel)
  if (spineRuntime && spineRuntime.sig === atlasUrl + skelUrl) return
  disposeSpine()
  const canvas = $('spineCanvas')
  const scale = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * scale
  canvas.height = canvas.clientHeight * scale
  const ctx = canvas.getContext('2d')
  // spine-canvas 4.3 构造签名是 (pathPrefix, downloader)——没有 ctx 参数，
  // 之前把 ctx 传进去了，prefix 串被当成 downloader 导致 downloadText 报错
  const assetManager = new SPINE.AssetManager(atlasUrl.replace(/[^/]*$/, ''))
  assetManager.loadTextureAtlas(basename(decodeURIComponent(atlasUrl)))
  const skelName = basename(decodeURIComponent(skelUrl))
  if (/\.json$/i.test(skelName)) assetManager.loadText(skelName)
  else assetManager.loadBinary(skelName)
  // spine-canvas 4.3 没有 onLoadAll 回调，用 isLoadingComplete() 轮询；
  // errors 里会记录真实加载失败原因（fetch 失败/404 等）
  await new Promise((resolve, reject) => {
    const t0 = Date.now()
    const poll = () => {
      if (assetManager.isLoadingComplete()) {
        const errs = Object.values(assetManager.errors || {})
        if (errs.length) reject(new Error('Spine 资源加载失败: ' + String(errs[0]).slice(0, 200)))
        else resolve()
      } else if (Date.now() - t0 > 15000) reject(new Error('Spine 资源加载超时'))
      else setTimeout(poll, 80)
    }
    poll()
  })
  // 4.3 取数统一用 require(相对文件名)（内部自拼 pathPrefix），
  // 老 API requireAtlas/requireText/requireBinary 已删除
  const atlas = assetManager.require(basename(decodeURIComponent(atlasUrl)))
  let skeletonData
  const skelData = assetManager.require(skelName)
  if (/\.json$/i.test(skelName)) {
    skeletonData = new SPINE.SkeletonJson(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(skelData)
  } else {
    skeletonData = new SPINE.SkeletonBinary(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(skelData)
  }
  const skeleton = new SPINE.Skeleton(skeletonData)
  const state = new SPINE.AnimationState(skeletonData)
  const idle = skeletonData.animations.find((a) => /idle|待机/i.test(a.name)) || skeletonData.animations[0]
  console.warn('[spine] 加载成功: 动画', skeletonData.animations.map((a) => a.name).join(','), '→ 播放', idle && idle.name)
  if (idle) state.setAnimation(0, idle, true)
  let talkTrack = -1
  spineRuntime = {
    sig: atlasUrl + skelUrl,
    render: true,
    step () {
      const dt = 1 / 60
      state.update(dt)
      skeleton.updateWorldTransform(SPINE.Physics.update)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      // 适配：骨架包围盒缩放居中
      const offset = new SPINE.Vector2()
      const size = new SPINE.Vector2()
      skeleton.getBounds(offset, size, [])
      const s = Math.min(canvas.width / (size.x || 1), canvas.height / (size.y || 1)) * 0.92
      ctx.save()
      ctx.translate((canvas.width - (size.x || 0) * s) / 2 - (offset.x || 0) * s, canvas.height - 10)
      ctx.scale(s, s)
      const renderer = new SPINE.SkeletonRenderer(ctx)
      renderer.draw(skeleton)
      ctx.restore()
    }
  }
  state.addListener({
    event: () => {},
    complete: (e) => { if (e.trackIndex === talkTrack) { talkTrack = -1; if (idle) state.setAnimation(0, idle, true) } }
  })
  spineRuntime.playTalk = () => {
    const talk = skeletonData.animations.find((a) => /talk|speak|说话/i.test(a.name))
    if (talk) { talkTrack = 1; state.setAnimation(1, talk, false) }
  }
  if (!spineRuntime.raf) {
    const loop = () => { if (spineRuntime && spineRuntime.render) spineRuntime.step(); requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  }
}
function disposeSpine () {
  if (spineRuntime) { spineRuntime.render = false; spineRuntime = null }
}

/* three.js + VRM */
async function showVrm (v) {
  const { THREE, GLTFLoader, THREEVRM } = window.AuraLibs
  if (!v.vrm) { $('stageFallback').hidden = false; return }
  const url = await assetUrl(v.vrm)
  if (vrmRuntime && vrmRuntime.sig === url) return
  disposeVrm()
  const canvas = $('vrmCanvas')
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, canvas.clientWidth / canvas.clientHeight, 0.1, 20)
  camera.position.set(0, 1.35, -1.6)
  camera.lookAt(0, 1.25, 0)
  scene.add(new THREE.DirectionalLight(0xffffff, Math.PI))
  const grid = new THREE.GridHelper(6, 12, 0x8f7bff, 0x333344)
  scene.add(grid)
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().load(url, resolve, undefined, reject)
  })
  const vrm = await THREEVRM.VRM.from(gltf)
  scene.add(vrm.scene)
  vrm.scene.rotation.y = Math.PI
  const clock = new THREE.Clock()
  vrmRuntime = { sig: url, renderer, scene, camera, vrm, alive: true }
  const loop = () => {
    if (!vrmRuntime || !vrmRuntime.alive) return
    requestAnimationFrame(loop)
    const dt = clock.getDelta()
    vrm.update(dt)
    renderer.render(scene, camera)
  }
  loop()
}
function disposeVrm () {
  if (vrmRuntime) { vrmRuntime.alive = false; vrmRuntime = null }
}

/* ---------------- 角色抽屉 ---------------- */
let editing = null
function openDrawer () {
  showDrawerTab('persona')
  refreshDrawer()
  $('charDrawer').hidden = false
  refreshDrawer()
}
function refreshDrawer () {
  const sel = $('charSelect')
  sel.innerHTML = S.characters.map((c) => `<option value="${esc(c.id)}" ${c.id === char.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
  editing = JSON.parse(JSON.stringify(char))
  $('fName').value = editing.name
  $('fPersona').value = editing.persona
  renderWorld()
  renderVisMode()
  renderMemory()
  renderTimeline()
}

/* 抽屉 tab 切换：人设 / 形象 / 设置（全部 AI 设置整合在此，不再分散到主设置页） */
function showDrawerTab (t) {
  for (const b of $('drawerTabs').children) b.classList.toggle('on', b.dataset.t === t)
  $('tabPersona').hidden = t !== 'persona'
  $('tabVisual').hidden = t !== 'visual'
  $('tabSettings').hidden = t !== 'settings'
  if (t === 'settings') renderCpSettings()
}
for (const b of $('drawerTabs').children) {
  b.addEventListener('click', () => showDrawerTab(b.dataset.t))
}

/* ---------------- 抽屉「设置」tab（自设置页整体迁入） ---------------- */
async function renderCpSettings () {
  let cs = {}
  try { cs = await window.companion.settings() } catch {}
  $('cpApiBase').value = cs.apiBaseUrl || ''
  $('cpApiKey').value = cs.apiKey || ''
  $('cpApiModel').value = cs.apiModel || ''
  $('cpVision').checked = cs.visionOn !== false
  $('cpPetOn').checked = cs.petOn !== false
  $('cpReplyLang').value = cs.replyLang || 'zh'
  $('cpTtsMode').value = cs.ttsMode || 'browser'
  $('cpTtsProvider').value = cs.ttsProvider || 'openai'
  $('cpTtsBase').value = cs.ttsBaseUrl || ''
  $('cpTtsModel').value = cs.ttsModel || ''
  $('cpTtsKey').value = cs.ttsApiKey || ''
  $('cpTtsRefAudio').value = cs.ttsRefAudio || ''
  $('cpTtsPromptText').value = cs.ttsPromptText || ''
  $('cpFishBase').value = cs.fishBaseUrl || 'https://api.fish.audio/v1/tts'
  $('cpFishModel').value = cs.fishModel || 's2.1-pro-free'
  $('cpFishVoice').value = cs.fishVoiceId || ''
  $('cpFishAsmr').value = cs.fishAsmrVoiceId || ''
  $('cpFishFormat').value = cs.fishFormat || 'wav'
  $('cpFishLatency').value = cs.fishLatency || 'normal'
  $('cpFishFeeling').value = cs.fishFeeling || 0
  $('cpFishDensity').value = cs.fishTagDensity || 0
  $('cpSpeed').value = Math.round((cs.ttsSpeed || 1) * 100)
  syncFishLabels()
  syncFishVisible()
  $('cpAsrBase').value = cs.asrBaseUrl || ''
  $('cpAsrModel').value = cs.asrModel || 'whisper-1'
  $('cpAsrKey').value = cs.asrApiKey || ''
  $('cpAsrLang').value = cs.asrLang || 'auto'
}
function syncFishLabels () {
  $('cpFishFeelingV').textContent = $('cpFishFeeling').value
  $('cpFishDensityV').textContent = $('cpFishDensity').value
  $('cpSpeedV').textContent = ($('cpSpeed').value / 100).toFixed(1)
}
/** Fish 专属字段只选 Fish 时显示；OpenAI 兼容字段只选 openai 时显示 */
function syncFishVisible () {
  const p = $('cpTtsProvider').value
  $('cpFish').hidden = p !== 'fish'
  $('cpTtsBase').hidden = p !== 'openai'
  $('cpTtsRefAudio').hidden = p !== 'gptsovits'
  $('cpTtsPromptText').hidden = p !== 'gptsovits'
}
const cpGather = () => ({
  apiBaseUrl: $('cpApiBase').value.trim(),
  apiKey: $('cpApiKey').value.trim(),
  apiModel: $('cpApiModel').value.trim(),
  visionOn: $('cpVision').checked,
  petOn: $('cpPetOn').checked,
  replyLang: $('cpReplyLang').value,
  ttsMode: $('cpTtsMode').value,
  ttsProvider: $('cpTtsProvider').value,
  ttsBaseUrl: $('cpTtsBase').value.trim(),
  ttsModel: $('cpTtsModel').value.trim(),
  ttsApiKey: $('cpTtsKey').value.trim(),
  ttsRefAudio: $('cpTtsRefAudio').value.trim(),
  ttsPromptText: $('cpTtsPromptText').value.trim(),
  ttsSpeed: $('cpSpeed').value / 100,
  fishBaseUrl: $('cpFishBase').value.trim() || 'https://api.fish.audio/v1/tts',
  fishModel: $('cpFishModel').value.trim() || 's2.1-pro-free',
  fishVoiceId: $('cpFishVoice').value.trim(),
  fishAsmrVoiceId: $('cpFishAsmr').value.trim(),
  fishFormat: $('cpFishFormat').value,
  fishLatency: $('cpFishLatency').value,
  fishFeeling: Number($('cpFishFeeling').value) || 0,
  fishTagDensity: Number($('cpFishDensity').value) || 0,
  asrBaseUrl: $('cpAsrBase').value.trim(),
  asrModel: $('cpAsrModel').value.trim(),
  asrLang: $('cpAsrLang').value,
  asrApiKey: $('cpAsrKey').value.trim()
})
async function cpSave () {
  await window.companion.patchSettings(cpGather())
  $('cpSaveTip').textContent = '✓ 已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })
  setTimeout(() => { $('cpSaveTip').textContent = '' }, 3000)
}
$('cpSave').addEventListener('click', cpSave)
$('cpTtsProvider').addEventListener('change', () => { syncFishVisible(); cpSave() })
$('cpFishFeeling').addEventListener('input', syncFishLabels)
$('cpFishDensity').addEventListener('input', syncFishLabels)
$('cpSpeed').addEventListener('input', syncFishLabels)
// 试听：保存当前设置后用当前档位合成并播放
$('cpPreviewBtn').addEventListener('click', async () => {
  const tip = $('cpPreviewTip')
  try {
    $('cpPreviewBtn').disabled = true
    tip.textContent = '合成中…'
    await cpSave()
    const r = await window.companion.tts($('cpFishPreview').value.trim().slice(0, 300))
    if (r && r.url) {
      tip.textContent = ''
      playAudio(r.url, r.speed)
    } else {
      tip.textContent = '失败：' + ((r && (r.message || r.fallback)) || '未知错误')
    }
  } catch (err) {
    tip.textContent = '失败：' + (err && err.message)
  } finally {
    $('cpPreviewBtn').disabled = false
  }
})
$('cpFetchModels').addEventListener('click', async () => {
  await cpSave()
  const btn = $('cpFetchModels')
  btn.textContent = '获取中…'
  let models = []
  try { models = await window.companion.models($('cpApiBase').value.trim(), $('cpApiKey').value.trim()) } catch {}
  const sel = $('cpApiModel')
  if (Array.isArray(models) && models.length) {
    const cur = sel.value
    sel.innerHTML = models.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('')
    btn.textContent = '已载入 ' + models.length + ' 个'
  } else {
    btn.textContent = '拉取失败'
  }
  setTimeout(() => { btn.textContent = '获取模型列表' }, 2500)
})
function renderWorld () {
  const list = $('worldList')
  list.innerHTML = ''
  for (const w of editing.worldBook || []) {
    const d = document.createElement('div')
    d.className = 'world-item'
    d.innerHTML = `<input placeholder="关键词（逗号分隔）" value="${esc(w.keywords)}">` +
      `<textarea placeholder="这一段世界观内容…">${esc(w.content)}</textarea>` +
      '<button class="cd-btn del">删除</button>'
    d.children[0].addEventListener('input', (e) => { w.keywords = e.target.value })
    d.children[1].addEventListener('input', (e) => { w.content = e.target.value })
    d.children[2].addEventListener('click', () => {
      editing.worldBook = editing.worldBook.filter((x) => x !== w)
      renderWorld()
    })
    list.appendChild(d)
  }
}
$('btnWorldAdd').addEventListener('click', () => {
  editing.worldBook = editing.worldBook || []
  editing.worldBook.push({ keywords: '', content: '' })
  renderWorld()
})
$('charSelect').addEventListener('change', async (e) => {
  const r = await window.companion.setActive(e.target.value)
  char = r.char
  S.history = r.history
  renderHistory()
  refreshDrawer()
  showVisual()
})
$('btnCharNew').addEventListener('click', async () => {
  const c = await window.companion.newCharacter('新角色 ' + (S.characters.length + 1))
  await window.companion.setActive(c.id)
  char = c
  S.characters = (await window.companion.init()).characters
  refreshDrawer()
})
$('btnCharDel').addEventListener('click', async () => {
  if (S.characters.length <= 1) return
  await window.companion.delCharacter(char.id)
  const init = await window.companion.init()
  S.characters = init.characters
  char = S.characters[0]
  S.history = init.history
  renderHistory()
  refreshDrawer()
  showVisual()
})
$('btnCharClose').addEventListener('click', () => { $('charDrawer').hidden = true })
$('btnCharSave').addEventListener('click', async () => {
  editing.name = $('fName').value.trim() || editing.name
  editing.persona = $('fPersona').value
  await window.companion.saveCharacter(editing)
  char = editing
  $('charName').textContent = char.name
  $('charSelect').innerHTML = S.characters.map((c) =>
    c.id === char.id ? `<option value="${esc(c.id)}" selected>${esc(c.name)}</option>` : `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
  $('charDrawer').hidden = true
  showVisual()
})
function renderVisMode () {
  const mode = editing.visual.mode || 'still'
  for (const b of $('visMode').children) b.classList.toggle('on', b.dataset.m === mode)
  const hints = {
    still: '导入 PNG / WebP 立绘',
    spine: '导入 Spine 导出文件：.atlas + .skel 或 .json + .png（idle 动画自动播放，talk 动画说话时切换）',
    vrm: '导入 VRM / GLB 3D 模型'
  }
  $('visHint').textContent = hints[mode]
}

/* ---------------- 长期记忆账本 ---------------- */
/** 对话时间线：全部聊天记录（history 已持久化），参考 Horae append-only 账本 */
function renderTimeline () {
  const list = $('timelineList')
  const items = (S.history || []).slice(-60)
  if (!items.length) {
    list.innerHTML = '<div class="mem-empty">还没有对话记录</div>'
    return
  }
  list.innerHTML = ''
  for (const m of items) {
    const d = document.createElement('div')
    d.className = 'tl-item'
    const time = m.at ? new Date(m.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
    d.innerHTML = `<span class="tl-role ${m.role === 'user' ? 'me' : 'ai'}">${m.role === 'user' ? '你' : 'AI'}</span>` +
      `<span class="mem-text">${esc(stripTags(m.content)).slice(0, 120)}</span>` +
      `<span class="tl-time">${time}</span>`
    list.appendChild(d)
  }
  list.scrollTop = list.scrollHeight
}

async function renderMemory () {
  const list = $('memList')
  list.innerHTML = '<div class="mem-empty">加载中…</div>'
  let events = []
  try { events = await window.companion.memoryList() } catch {}
  list.innerHTML = ''
  if (!events.length) {
    list.innerHTML = '<div class="mem-empty">还没有记忆——聊天时说「记住我喜欢…」，AI 会自动记下来</div>'
    return
  }
  const catName = { promise: '承诺', preference: '偏好', relation: '关系', fact: '事实', task: '任务' }
  for (const ev of events) {
    const d = document.createElement('div')
    d.className = 'mem-item'
    d.innerHTML = `<span class="mem-cat c-${esc(ev.cat || 'fact')}">${esc(catName[ev.cat] || '事实')}</span>` +
      `<span class="mem-text">${esc(ev.text)}</span>` +
      '<button class="mem-del" title="删除这条记忆">✕</button>'
    d.children[2].addEventListener('click', async () => {
      await window.companion.memoryDel(ev.seq)
      renderMemory()
    })
    list.appendChild(d)
  }
}
for (const b of $('visMode').children) {
  b.addEventListener('click', () => {
    editing.visual.mode = b.dataset.m
    renderVisMode()
  })
}
$('btnImport').addEventListener('click', async () => {
  const mode = editing.visual.mode || 'still'
  if (mode === 'still') {
    const p = await window.companion.importAsset(char.id, 'image')
    if (p) editing.visual.image = p
  } else if (mode === 'spine') {
    // 一次导入：可多选 atlas/skel/json/png；只选一个时主进程自动补齐同目录同名文件
    const files = await window.companion.importAsset(char.id, 'spine')
    const spine = editing.visual.spine = editing.visual.spine || {}
    const hasSkel = files.some((p) => /\.skel$/i.test(p))
    for (const p of files) {
      if (/\.atlas$/i.test(p)) spine.atlas = p
      else if (/\.skel$/i.test(p)) spine.skel = p
      else if (/\.json$/i.test(p) && !hasSkel && !spine.skel) spine.skel = p
      else if (/\.png$/i.test(p) && !/cover/i.test(p)) spine.png = p
    }
  } else {
    const p = await window.companion.importAsset(char.id, 'vrm')
    if (p) editing.visual.vrm = p
  }
  $('visHint').textContent = '已导入：' + JSON.stringify(mode === 'spine' ? editing.visual.spine : editing.visual[mode] || '').slice(0, 160)
})

/* ---------------- 窗口控制 ---------------- */
$('btnMin').addEventListener('click', () => window.companion.win('min'))
$('btnClose').addEventListener('click', () => window.companion.win('close'))
$('btnPin').addEventListener('click', () => window.companion.win('pin'))
$('btnClear').addEventListener('click', async () => {
  await window.companion.clearHistory(char.id)
  S.history = []
  renderHistory()
})
$('btnChar').addEventListener('click', openDrawer)
// 形象 tab 里也有一个保存按钮
$('btnCharSave2').addEventListener('click', async () => {
  editing.name = $('fName').value.trim() || editing.name
  editing.persona = $('fPersona').value
  await window.companion.saveCharacter(editing)
  char = editing
  $('charName').textContent = char.name
  $('charDrawer').hidden = true
  showVisual()
})

/* ---------------- 启动 ---------------- */
;(async () => {
  S = await window.companion.init()
  char = S.characters[0]
  $('charName').textContent = char.name
  renderHistory()
  showVisual()
  addMsg('', '已就绪。语音合成：' + (S.settings.ttsMode === 'off' ? '关' : S.settings.ttsMode === 'api' ? 'API' : '系统语音') +
    (S.settings.apiBaseUrl ? '' : ' · 还没配置 AI 服务，请到设置 → AI 填入 API 地址与模型'), 'syserr')
})().catch((e) => addMsg('', '初始化失败：' + e.message, 'syserr'))
