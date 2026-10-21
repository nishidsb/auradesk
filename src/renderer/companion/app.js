'use strict'
/* 桌面角色渲染层（v0.4.0 起 AI 对话已移除）：立绘/Spine/3D 形象 + 角色管理 + TTS 音色配置 */
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** node integration 关闭，拿不到 path 模块：自实现 basename（/ 与 \ 都认） */
const basename = (p) => String(p || '').replace(/\\/g, '/').split('/').pop()

let S = { characters: [], settings: {} }
let char = null

/* ---------------- TTS 播放（试听用） ---------------- */
let curAudio = null
function playAudio (url, speed) {
  try {
    if (curAudio) curAudio.pause()
    curAudio = new Audio(url)
    // 语速：Fish API 本身不支持 speed，用播放速率实现
    if (speed && speed !== 1) curAudio.playbackRate = speed
    curAudio.play()
  } catch {}
}

/* ---------------- 形象（立绘 / Spine / 3D VRM） ---------------- */
let vrmRuntime = null
let spineRuntime = null
let spineRafStarted = false

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

/* 读骨架文件头部版本号（二进制 .skel 在前 8 字节 hash 后跟 "4.2.43"；
   .json 在 "spine":"4.2.43" 字段），返回 "4.2" 这样的主次版本 */
async function detectSpineVersion (skelUrl) {
  try {
    const res = await fetch(skelUrl)
    const buf = new Uint8Array(await res.arrayBuffer())
    let s = ''
    for (let i = 0; i < Math.min(buf.length, 160); i++) s += String.fromCharCode(buf[i])
    const m = s.match(/(\d+)\.(\d+)\.\d+/)
    return m ? m[1] + '.' + m[2] : null
  } catch { return null }
}

/* 消除逐三角形 clip 的抗锯齿缝隙：spine-canvas 的 drawTriangle 用 path+clip+drawImage，
   相邻三角形边缘会露出网格状细缝（截图里身上的网格线）。
   补丁：把三角形沿质心向外扩 ~1.2 屏幕像素（u/v 采样不变，外扩部分 clamp 采样贴图边缘），
   相邻三角形互相重叠 1px，视觉无缝 */
function patchSpineSeam (SPINE) {
  if (!SPINE || !SPINE.SkeletonRenderer || SPINE.SkeletonRenderer.prototype.__seamPatched) return
  SPINE.SkeletonRenderer.prototype.__seamPatched = true
  const orig = SPINE.SkeletonRenderer.prototype.drawTriangle
  SPINE.SkeletonRenderer.prototype.drawTriangle = function (img, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2) {
    const s = this.__scale || 1
    const grow = 1.2 / (s || 1)
    const cx = (x0 + x1 + x2) / 3
    const cy = (y0 + y1 + y2) / 3
    const push = (px, py) => {
      const dx = px - cx
      const dy = py - cy
      const len = Math.hypot(dx, dy) || 1
      return [px + dx / len * grow, py + dy / len * grow]
    }
    ;[x0, y0] = push(x0, y0)
    ;[x1, y1] = push(x1, y1)
    ;[x2, y2] = push(x2, y2)
    orig.call(this, img, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2)
  }
}

/* Spine：spine-canvas 加载 atlas + skel(.json/.skel)，播放 idle 动画 */
async function showSpine (v) {
  const libs = window.AuraLibs
  if (!v.spine || !v.spine.atlas || !v.spine.skel) { $('stageFallback').hidden = false; return }
  const atlasUrl = await assetUrl(v.spine.atlas)
  const skelUrl = await assetUrl(v.spine.skel)
  if (spineRuntime && spineRuntime.sig === atlasUrl + skelUrl) return
  disposeSpine()
  // Spine 运行时严格锁版本（4.3 读不了 4.2 导出的骨架，报 Bone name must not be null），
  // 从骨架文件头部扫版本号，选对应运行时；识别不出就用最新 4.3 兜底
  const ver = await detectSpineVersion(skelUrl)
  const SPINE = (libs.AuraSpine && ver && libs.AuraSpine[ver]) || libs.SPINE
  patchSpineSeam(SPINE)
  console.warn('[spine] 骨架版本', ver || '未知', '→ 运行时', SPINE === libs.SPINE ? '4.3（兜底）' : ver)
  const canvas = $('spineCanvas')
  const scale = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * scale
  canvas.height = canvas.clientHeight * scale
  const ctx = canvas.getContext('2d')
  // spine-canvas 4.3 构造签名是 (pathPrefix, downloader)——没有 ctx 参数，
  // 之前把 ctx 传进去了，prefix 串被当成 downloader 导致 downloadText 报错
  const assetManager = new SPINE.AssetManager(atlasUrl.replace(/[^/]*$/, ''))
  // 贴图页预转 dataURL：spine 用 Image+crossOrigin=anonymous 读贴图，
  // 自定义协议下该请求的 CORS 校验比 fetch 严（实测 fetch 通、Image 被拦）；
  // 先 fetch 把 atlas 引用的页面图转成 data: 塞进 downloader.rawDataUris，
  // spine 加载贴图时直接用 dataURL，彻底绕开协议/CORS
  try {
    const atlasText = await (await fetch(atlasUrl)).text()
    const prefix = atlasUrl.replace(/[^/]*$/, '')
    // 贴图在磁盘上的目录（v.spine.atlas 是本地绝对路径），fetch 失败时走主进程读文件兜底
    const diskDir = String(v.spine.atlas || '').replace(/\\/g, '/').replace(/[^/]*$/, '')
    const pages = [...new Set([...atlasText.matchAll(/([^\s"']+?\.(?:png|jpe?g|webp))/gi)].map((m) => m[1]))]
    for (const name of pages) {
      try {
        const full = prefix + name
        let dataUrl = null
        for (let i = 0; i < 3 && !dataUrl; i++) {
          try {
            const blob = await (await fetch(full)).blob()
            dataUrl = await new Promise((ok, bad) => {
              const r = new FileReader()
              r.onload = () => ok(r.result)
              r.onerror = () => bad(new Error('readAsDataURL 失败'))
              r.readAsDataURL(blob)
            })
          } catch (e) {
            if (i === 2 && window.companion.assetData) {
              dataUrl = await window.companion.assetData(diskDir + name).catch(() => null)
            } else {
              await new Promise((ok) => setTimeout(ok, 200))
            }
          }
        }
        if (!dataUrl) throw new Error('预载三次均失败')
        assetManager.downloader.rawDataUris[full] = dataUrl
        assetManager.downloader.rawDataUris[name] = dataUrl
      } catch (e) { console.warn('[spine] 预载贴图失败', name, e.message) }
    }
  } catch (e) { console.warn('[spine] atlas 预读失败', e.message) }
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
  // 附件可能挂在命名皮肤里（导出时勾了皮肤）：default skin 为空时骨骼照常摆位
  // （bounds/动画都正常）但什么都画不出来。列出皮肤并显式选一个
  const skins = skeletonData.skins || []
  console.warn('[spine] 皮肤列表:', skins.map((s) => s.name).join(',') || '(无)')
  if (skins.length) {
    const pick = skins.find((s) => /default|base|normal/i.test(s.name)) || skins[skins.length - 1]
    skeleton.setSkin(skins.length > 1 ? pick : skins[0])
    skeleton.setSlotsToSetupPose()
    console.warn('[spine] 使用皮肤:', pick.name)
  }
  console.warn('[spine] 槽位附件:', skeleton.slots.filter((sl) => sl.getAttachment()).length + '/' + skeleton.slots.length)
  // 所有 4.x 的 AnimationState 构造参数都是 AnimationStateData（不是 SkeletonData）：
  // 直接传 SkeletonData 会让内部 this.data.skeletonData 为 undefined，
  // 一调 setAnimation 就报 Cannot read properties of undefined (reading 'findAnimation')
  const state = new SPINE.AnimationState(new SPINE.AnimationStateData(skeletonData))
  // idle 选择：优先全身待机（motion_*_idle），眉毛/脸部/特效类 idle 幅度太小
  // 会被当成「静态」，所以放最后兜底
  const anims = skeletonData.animations
  const idle = anims.find((a) => /^motion_[A-Z]_\d+_idle$/i.test(a.name))
    || anims.find((a) => /motion.*idle/i.test(a.name))
    || anims.find((a) => /stand|wait|待机/i.test(a.name))
    || anims.find((a) => /idle|待机/i.test(a.name) && !/facial|face|effect/i.test(a.name))
    || anims.find((a) => /idle|待机/i.test(a.name))
    || anims[0]
  console.warn('[spine] 加载成功: 动画', skeletonData.animations.map((a) => a.name).join(','), '→ 播放', idle && idle.name)
  // setAnimation 在 4.0/4.1/4.2 里只认动画名字符串（内部 this.data.skeletonData.findAnimation(name)），
  // 传 Animation 对象会在这些版本炸掉，所以统一传名字
  if (idle) state.setAnimation(0, idle.name, true)
  let firstFrame = true
  spineRuntime = {
    sig: atlasUrl + skelUrl,
    render: true,
    step () {
      const dt = 1 / 60
      state.update(dt)
      skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.update : undefined)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      // 适配：骨架包围盒缩放居中
      const offset = new SPINE.Vector2()
      const size = new SPINE.Vector2()
      skeleton.getBounds(offset, size, [])
      const s = Math.min(canvas.width / (size.x || 1), canvas.height / (size.y || 1)) * 0.92
      if (firstFrame) {
        firstFrame = false
        console.warn('[spine] 首帧: canvas', canvas.width + 'x' + canvas.height, 'bounds', Math.round(offset.x) + ',' + Math.round(offset.y), Math.round(size.x) + 'x' + Math.round(size.y), 'scale', s.toFixed(3))
      }
      ctx.save()
      // spine 世界坐标 y 向上、canvas y 向下：必须 scale(s, -s) 翻转 y 并把 bounds
      // 底边对到画布底部——不翻转会整只画到画布上方之外（无异常但画面空白）
      ctx.translate((canvas.width - size.x * s) / 2 - offset.x * s, canvas.height - 6 + offset.y * s)
      ctx.scale(s, -s)
      const renderer = new SPINE.SkeletonRenderer(ctx)
      // 默认 drawImages 只画 Region 四边形，Mesh 全部跳过（精致皮肤几乎全是
      // mesh → 整帧 0 像素）。必须开 triangleRendering 才走 mesh 逐三角形渲染
      renderer.triangleRendering = true
      renderer.__scale = s
      renderer.draw(skeleton)
      ctx.restore()
    }
  }
  // 驱动用 setInterval 而非 rAF：窗口被判定遮挡时 rAF 的 BeginFrame 会被暂停
  // （计时器不会），配合主进程禁用 CalculateNativeWinOcclusion 双保险
  if (!spineRafStarted) {
    spineRafStarted = true
    let errCount = 0
    setInterval(() => {
      if (spineRuntime && spineRuntime.render) {
        try { spineRuntime.step() } catch (e) { if (++errCount <= 3) console.warn('[spine] step 异常:', e.message) }
      }
    }, 16)
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
  renderVisMode()
}

/* 抽屉 tab 切换：角色 / 形象 / 设置 */
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

/* ---------------- 抽屉「设置」tab ---------------- */
async function renderCpSettings () {
  let cs = {}
  try { cs = await window.companion.settings() } catch {}
  $('cpPetOn').checked = cs.petOn !== false
  $('cpPetScale').value = Math.round((cs.petScale != null ? cs.petScale : 1) * 100)
  $('cpPetScaleV').textContent = ($('cpPetScale').value / 100).toFixed(1) + '×'
  $('cpTtsMode').value = cs.ttsMode || 'browser'
  $('cpTtsProvider').value = cs.ttsProvider || 'openai'
  $('cpTtsBase').value = cs.ttsBaseUrl || ''
  $('cpTtsModel').value = cs.ttsModel || ''
  $('cpTtsKey').value = cs.ttsApiKey || ''
  $('cpTtsVoice').value = cs.ttsVoice || 'alloy'
  fillSysVoices()
  $('cpSysVoice').value = cs.sysVoiceName || ''
  $('cpTtsRefAudio').value = cs.ttsRefAudio || ''
  $('cpTtsPromptText').value = cs.ttsPromptText || ''
  $('cpFishBase').value = cs.fishBaseUrl || 'https://api.fish.audio/v1/tts'
  $('cpFishModel').value = cs.fishModel || 's2.1-pro-free'
  $('cpFishVoice').value = cs.fishVoiceId || ''
  $('cpFishKey').value = cs.fishApiKey || ''
  $('cpNetProxy').value = cs.netProxy || ''
  $('cpFishAsmr').value = cs.fishAsmrVoiceId || ''
  $('cpFishFormat').value = cs.fishFormat || 'wav'
  $('cpFishLatency').value = cs.fishLatency || 'normal'
  $('cpFishFeeling').value = cs.fishFeeling || 0
  $('cpFishDensity').value = cs.fishTagDensity || 0
  $('cpSpeed').value = Math.round((cs.ttsSpeed || 1) * 100)
  syncFishLabels()
  syncFishVisible()
  syncSysVoiceRow()
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
  $('cpTtsVoice').hidden = p !== 'openai'
  $('cpTtsRefAudio').hidden = p !== 'gptsovits'
  $('cpTtsPromptText').hidden = p !== 'gptsovits'
}
/** 系统语音音色只在「系统语音」模式下显示 */
function syncSysVoiceRow () {
  const row = $('cpSysVoiceRow')
  if (row) row.hidden = $('cpTtsMode').value !== 'browser'
}
/** 枚举本机全部系统语音（中日英法…都有） */
function fillSysVoices () {
  const sel = $('cpSysVoice')
  if (!sel || !window.speechSynthesis) return
  const list = speechSynthesis.getVoices()
  if (!list.length) return
  const cur = sel.value
  sel.innerHTML = '<option value="">自动</option>' +
    list.map((v) => '<option value="' + String(v.name).replace(/"/g, '&quot;') + '">' + v.name + '（' + v.lang + '）</option>').join('')
  sel.value = cur || ''
}
if (window.speechSynthesis) {
  speechSynthesis.onvoiceschanged = fillSysVoices
  setTimeout(fillSysVoices, 300)
}
const cpGather = () => ({
  petOn: $('cpPetOn').checked,
  petScale: Number($('cpPetScale').value) / 100,
  ttsMode: $('cpTtsMode').value,
  ttsProvider: $('cpTtsProvider').value,
  ttsBaseUrl: $('cpTtsBase').value.trim(),
  ttsModel: $('cpTtsModel').value.trim(),
  ttsApiKey: $('cpTtsKey').value.trim(),
  ttsVoice: $('cpTtsVoice').value,
  sysVoiceName: $('cpSysVoice').value,
  ttsRefAudio: $('cpTtsRefAudio').value.trim(),
  ttsPromptText: $('cpTtsPromptText').value.trim(),
  ttsSpeed: $('cpSpeed').value / 100,
  fishBaseUrl: $('cpFishBase').value.trim() || 'https://api.fish.audio/v1/tts',
  fishApiKey: $('cpFishKey').value.trim(),
  netProxy: $('cpNetProxy').value.trim(),
  fishModel: $('cpFishModel').value.trim() || 's2.1-pro-free',
  fishVoiceId: $('cpFishVoice').value.trim(),
  fishAsmrVoiceId: $('cpFishAsmr').value.trim(),
  fishFormat: $('cpFishFormat').value,
  fishLatency: $('cpFishLatency').value,
  fishFeeling: Number($('cpFishFeeling').value) || 0,
  fishTagDensity: Number($('cpFishDensity').value) || 0
})
async function cpSave () {
  await window.companion.patchSettings(cpGather())
  $('cpSaveTip').textContent = '✓ 已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })
  setTimeout(() => { $('cpSaveTip').textContent = '' }, 3000)
}
$('cpSave').addEventListener('click', cpSave)
// 备份：导出/导入全部设置（含语音 Key）+ 角色卡，纯本地文件
$('cpExportBtn').addEventListener('click', async () => {
  const tip = $('cpDataTip')
  try {
    await cpSave()
    tip.textContent = '导出中…'
    const r = await window.companion.exportBackup()
    tip.textContent = r.ok ? '✓ 已导出：' + r.path : ((r.message || '已取消') )
  } catch (err) { tip.textContent = '导出失败：' + (err && err.message) }
})
$('cpImportBtn').addEventListener('click', async () => {
  const tip = $('cpDataTip')
  try {
    const r = await window.companion.importBackup()
    if (r.ok) { tip.textContent = '✓ 导入成功，应用即将重启生效…'; return }
    tip.textContent = r.message || '已取消'
  } catch (err) { tip.textContent = '导入失败：' + (err && err.message) }
})
$('cpPetScale').addEventListener('input', () => { $('cpPetScaleV').textContent = ($('cpPetScale').value / 100).toFixed(1) + '×' })
$('cpTtsProvider').addEventListener('change', () => { syncFishVisible(); cpSave() })
$('cpTtsMode').addEventListener('change', () => { syncSysVoiceRow(); cpSave() })
$('cpTtsVoice').addEventListener('change', cpSave)
$('cpSysVoice').addEventListener('change', cpSave)
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
      tip.textContent = '失败：' + ((r && r.message) || (r && r.fallback ? '语音合成未开启' : '未知错误'))
    }
  } catch (err) {
    tip.textContent = '失败：' + (err && err.message)
  } finally {
    $('cpPreviewBtn').disabled = false
  }
})
// Fish 我的声音库：拉列表 → 下拉选择 → 自动填入 reference_id（不用再手抠 ID）
$('cpFishVoiceFetch').addEventListener('click', async () => {
  const tip = $('cpFishVoiceTip')
  try {
    $('cpFishVoiceFetch').disabled = true
    tip.textContent = '获取声音列表中…'
    await cpSave()
    const r = await window.companion.fishVoices()
    if (!r || !r.ok) { tip.textContent = '失败：' + ((r && r.message) || '未知错误'); return }
    const sel = $('cpFishVoiceSel')
    sel.innerHTML = '<option value="">— 选择一个声音（选中自动填入 ID）—</option>' +
      r.voices.map((v) => '<option value="' + v.id + '">' + v.title + '</option>').join('')
    sel.hidden = false
    tip.textContent = r.voices.length ? '共 ' + r.voices.length + ' 个声音，下拉选择即可填入 ID' : '账号下没有声音模型'
  } catch (err) {
    tip.textContent = '失败：' + (err && err.message)
  } finally {
    $('cpFishVoiceFetch').disabled = false
  }
})
$('cpFishVoiceSel').addEventListener('change', function () {
  if (this.value) { $('cpFishVoice').value = this.value; cpSave() }
})
$('charSelect').addEventListener('change', async (e) => {
  const r = await window.companion.setActive(e.target.value)
  char = r.char
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
  refreshDrawer()
  showVisual()
})
$('btnCharClose').addEventListener('click', () => { $('charDrawer').hidden = true })
async function saveChar () {
  editing.name = $('fName').value.trim() || editing.name
  await window.companion.saveCharacter(editing)
  char = editing
  $('charName').textContent = char.name
  $('charSelect').innerHTML = S.characters.map((c) =>
    c.id === char.id ? `<option value="${esc(c.id)}" selected>${esc(c.name)}</option>` : `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
  $('charDrawer').hidden = true
  showVisual()
}
$('btnCharSave').addEventListener('click', saveChar)
function renderVisMode () {
  const mode = editing.visual.mode || 'still'
  for (const b of $('visMode').children) b.classList.toggle('on', b.dataset.m === mode)
  const hints = {
    still: '导入 PNG / WebP 立绘',
    spine: '导入 Spine 导出文件：.atlas + .skel 或 .json + .png（idle 动画自动播放）',
    vrm: '导入 VRM / GLB 3D 模型'
  }
  $('visHint').textContent = hints[mode]
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
$('btnChar').addEventListener('click', openDrawer)
// 形象 tab 里也有一个保存按钮
$('btnCharSave2').addEventListener('click', saveChar)

/* ---------------- 启动 ---------------- */
;(async () => {
  S = await window.companion.init()
  char = S.characters[0]
  $('charName').textContent = char.name
  showVisual()
})().catch((e) => console.error('[companion] 初始化失败:', e))
