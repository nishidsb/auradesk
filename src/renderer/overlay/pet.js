'use strict'
;(function () {
/* 桌宠 · overlay 内嵌渲染
 * 独立透明 BrowserWindow 在本机被 Chromium 挂起合成器（画面冻结在第 1 帧，
 * 所有开关均无效），而桌面层 overlay 窗口合成正常——所以角色直接渲染在这里。
 * 逻辑与 companion/pet 窗口版本一致：立绘 / Spine（多运行时版本锁定）/ VRM。
 */
const $ = (id) => document.getElementById(id)
const basename = (p) => String(p || '').replace(/\\/g, '/').split('/').pop()

let vrmRuntime = null
let spineRuntime = null
let spineRafStarted = false
let currentSig = ''

// ---- 桌宠增强状态 ----
let petScale = 0 // 0 = 尚未从设置读取
let onTapHook = null // spine 加载后注入：轻点角色触发触摸反应
let cursorScreen = null // 主进程广播的全局光标（屏幕坐标）
let cursorMoveAt = 0 // 最近一次光标移动时间（视线跟踪的保持/释放）

/* 合成器活性探针：rAF 只在合成器调度 BeginFrame 时触发。
 * 若 rAF 计数不涨而 setInterval 正常 → 合成器被挂起（画面冻结的真凶） */
let rafCount = 0
;(function probeRaf () { rafCount++; requestAnimationFrame(probeRaf) })()
function liveness () {
  return ' rAF=' + rafCount + ' vis=' + document.visibilityState
}

/* ---- 语音播放：全局单实例（新语音开始时打断上一条，杜绝重叠回声） ---- */
let nowPlaying = null
function playVoice (url, speed) {
  try {
    if (nowPlaying) { nowPlaying.pause(); nowPlaying = null }
    const a = new Audio(url)
    if (speed && speed !== 1) a.playbackRate = speed
    nowPlaying = a
    a.onended = () => { if (nowPlaying === a) nowPlaying = null }
    a.onerror = () => { if (nowPlaying === a) nowPlaying = null }
    a.play().catch(() => { if (nowPlaying === a) nowPlaying = null })
  } catch {}
}
/** 立刻停止当前语音（发送新消息/新的语音反馈时用） */
function stopVoice () {
  try {
    if (nowPlaying) { nowPlaying.pause(); nowPlaying = null }
    if (window.speechSynthesis) speechSynthesis.cancel()
  } catch {}
}
/* ---- 触摸反应语音（对齐参考项目 tap_voice：不同部位不同反应语，随机变体）。
   短语语言跟「AI 回复语言」设置走（pet:config 广播 / petSpeak 返回的 lang），与朗读音色解耦 ---- */
const TOUCH_VOICE = {
  zh: {
    head: ['唔…不要揉头啦，头发会乱掉的', '嗯？摸头的话……就饶你这一次', '呜…头要被摸开了啦'],
    arm_l: ['咦，拉我的左手做什么呀', '手手不能随便牵哦'],
    arm_r: ['右手要用来拿东西的，别抓着不放啦', '咦？右臂怎么了吗'],
    body: ['别戳了啦，好痒的', '有什么话就好好说嘛'],
    breast: ['请、请自重！那里不可以！', '再碰那里真的要生气了哦'],
    weast: ['腰、腰不可以随便碰！', '戳腰是想让我跳起来吗']
  },
  ja: {
    head: ['ん…頭を撫でないで〜髪が乱れちゃう', 'えっ？頭なら…まあ今回だけ許してあげる', 'うぅ…頭がぐしゃぐしゃになっちゃう'],
    arm_l: ['わっ、急に左手引っ張らないでよ', '手は勝手に繋いじゃダメだよ？'],
    arm_r: ['右手は物を持つのに使うの！離して〜', 'え、右腕がどうかした？'],
    body: ['つつかないで〜くすぐったいってば', '何か話があるなら、ちゃんと言ってよね'],
    breast: ['ちょっ、ダメ！そこは触っちゃダメ！', '本当に怒るからね！'],
    weast: ['お、お腹は駄目〜！くすぐったい！', 'つつくと飛び上がっちゃうでしょ！']
  },
  en: {
    head: ['Hey, stop ruffling my hair!', 'Hmm? Okay, just this once...', 'Ah, you are messing up my hair!'],
    arm_l: ['Why are you pulling my arm?', 'You cannot just grab my hand, okay?'],
    arm_r: ['I need this hand for things! Let go~', 'Is something wrong with my arm?'],
    body: ['Stop poking me, that tickles!', 'If you have something to say, just say it.'],
    breast: ['P-please! That is not okay!', 'Touch there again and I will be mad!'],
    weast: ['N-not the waist! That tickles!', 'Poke me there and I will jump, I swear!']
  }
}
let touchLang = 'zh'
function speakTouch (part) {
  const set = TOUCH_VOICE[touchLang] || TOUCH_VOICE.zh
  const lines = set[part]
  if (!lines || !window.aura || !window.aura.petSpeak) return
  const text = lines[Math.floor(Math.random() * lines.length)]
  window.aura.petSpeak(text).then((r) => {
    // 主进程把当前回复语言带回，触摸短语语种保持同步
    if (r && r.lang && TOUCH_VOICE[r.lang]) touchLang = r.lang
    if (r && r.ok && r.url) return playVoice(r.url, r.speed)
    // 未配置 API TTS → 系统 voice 念一遍（保持有反馈，语种跟当前语言）
    if (r && r.fallback && window.speechSynthesis) {
      try {
        speechSynthesis.cancel()
        const u = new SpeechSynthesisUtterance(text)
        u.lang = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' }[touchLang] || 'zh-CN'
        const picked = speechSynthesis.getVoices().find((x) => x.lang && String(x.lang).toLowerCase().replace('_', '-').startsWith(u.lang.slice(0, 2)))
        if (picked) u.voice = picked
        speechSynthesis.speak(u)
      } catch {}
    }
  }).catch(() => {})
}

/* 视线跟踪的保持/释放曲线（参考 agentatelierR character_gaze.dart）：
 * 光标停下后保持 1.5s，随后 0.7s smoothstep 释放 */
function gazeInfluence () {
  const elapsed = performance.now() - cursorMoveAt
  if (!cursorMoveAt) return 0
  if (elapsed <= 1500) return 1
  const p = (elapsed - 1500) / 700
  if (p >= 1) return 0
  const r = 1 - p
  return r * r * (3 - 2 * r)
}

/* ---------------- 角色大小（设置可调） ---------------- */
async function applyScale (s, reload) {
  if (!isFinite(s) || s <= 0.1 || s > 4) return
  if (s === petScale) return
  petScale = s
  document.documentElement.style.setProperty('--pet-scale', String(s))
  // 舞台尺寸变了 → 相机锁定失效，重建渲染
  if (reload && spineRuntime) {
    try {
      const st = await window.aura.petState()
      if (st && st.visible && st.char) { disposeSpine(); showVisual(st.char) }
    } catch {}
  }
}

async function assetUrl (p) { return p ? window.aura.assetUrl(p) : '' }

function disposeSpine () { if (spineRuntime) { spineRuntime.render = false; spineRuntime = null } }
function disposeVrm () { if (vrmRuntime) { vrmRuntime.alive = false; vrmRuntime = null } currentSig = '' }

/* ---------------- 形象总入口 ---------------- */
async function showVisual (char) {
  const v = (char && char.visual) || {}
  const mode = v.mode || 'still'
  const has = mode === 'still' ? !!v.image : mode === 'spine' ? !!(v.spine && v.spine.atlas && v.spine.skel) : !!v.vrm
  if (!has) { $('petFallback').hidden = false; return }
  $('petFallback').hidden = true
  $('petStill').hidden = mode !== 'still'
  $('petSpineCanvas').hidden = mode !== 'spine'
  $('petVrmCanvas').hidden = mode !== 'vrm'
  if (mode !== 'spine') disposeSpine()
  if (mode !== 'vrm') disposeVrm()
  try {
    if (mode === 'still') {
      const url = await assetUrl(v.image)
      if (url) $('petStill').src = url
    } else if (mode === 'spine') {
      await showSpine(v)
    } else if (mode === 'vrm') {
      await showVrm(v)
    }
  } catch (err) {
    console.error('[pet-ov]', err)
    $('petFallback').hidden = false
  }
}

/* 读骨架文件头部版本号，返回 "4.2" 主次版本 */
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

/* 消除逐三角形 clip 抗锯齿缝隙：三角形沿质心外扩 ~1.2 屏幕像素（u/v 不变） */
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

async function showSpine (v) {
  const libs = window.AuraLibs
  const atlasUrl = await assetUrl(v.spine.atlas)
  const skelUrl = await assetUrl(v.spine.skel)
  const sig = atlasUrl + skelUrl
  if (spineRuntime && spineRuntime.sig === sig) return
  currentSig = sig
  disposeSpine()
  const ver = await detectSpineVersion(skelUrl)
  // 优先 WebGL 运行时（GPU 画 mesh，无逐三角形裁剪开销）；初始化失败降级 canvas
  let GL = libs.AuraSpineGL && ver && libs.AuraSpineGL[ver]
  let SPINE = GL || (libs.AuraSpine && ver && libs.AuraSpine[ver]) || libs.SPINE
  const canvas = $('petSpineCanvas')
  const scale = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * scale
  canvas.height = canvas.clientHeight * scale
  let ctx = null
  let managedGl = null
  let glCanvas = null // GL 离屏画布：本机合成器对 WebGL canvas 的透明合成有薄纱 bug，GL 只画在这里
  let assetManager
  let useGL = false
  if (GL) {
    try {
      // GL 画在离屏 canvas，每帧 blit 到显示用 2D canvas（2D 的透明合成最可靠）。
      // 预乘管线 + 贴图上传预乘（PMA 混合配对）
      glCanvas = document.createElement('canvas')
      glCanvas.width = canvas.width
      glCanvas.height = canvas.height
      managedGl = new GL.ManagedWebGLRenderingContext(glCanvas, { alpha: true, premultipliedAlpha: true, antialias: false })
      managedGl.gl.pixelStorei(managedGl.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      assetManager = new GL.AssetManager(managedGl, atlasUrl.replace(/[^/]*$/, ''))
      useGL = true
    } catch (e) {
      console.warn('[pet-ov] WebGL 初始化失败，降级 canvas:', e && e.message)
      GL = null
      glCanvas = null
      SPINE = (libs.AuraSpine && ver && libs.AuraSpine[ver]) || libs.SPINE
    }
  }
  if (!useGL) {
    patchSpineSeam(SPINE)
    ctx = canvas.getContext('2d', { willReadFrequently: false })
    assetManager = new SPINE.AssetManager(atlasUrl.replace(/[^/]*$/, ''))
  }
  console.warn('[pet-ov] 骨架版本', ver || '未知', '→ 运行时', useGL ? 'webgl ' + ver : (SPINE === libs.SPINE ? '4.3 canvas（兜底）' : ver + ' canvas'))
  // 贴图页预转 dataURL（绕开 Image+crossOrigin 对自定义协议的 CORS 拦截），失败走主进程兜底
  try {
    const atlasText = await (await fetch(atlasUrl)).text()
    const prefix = atlasUrl.replace(/[^/]*$/, '')
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
            if (i === 2 && window.aura.assetData) {
              dataUrl = await window.aura.assetData(diskDir + name).catch(() => null)
            } else {
              await new Promise((ok) => setTimeout(ok, 200))
            }
          }
        }
        if (!dataUrl) throw new Error('预载三次均失败')
        assetManager.downloader.rawDataUris[full] = dataUrl
        assetManager.downloader.rawDataUris[name] = dataUrl
      } catch (e) { console.warn('[pet-ov] 预载贴图失败', name, e.message) }
    }
  } catch (e) { console.warn('[pet-ov] atlas 预读失败', e.message) }
  assetManager.loadTextureAtlas(basename(decodeURIComponent(atlasUrl)))
  const skelName = basename(decodeURIComponent(skelUrl))
  if (/\.json$/i.test(skelName)) assetManager.loadText(skelName)
  else assetManager.loadBinary(skelName)
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
  const atlas = assetManager.require(basename(decodeURIComponent(atlasUrl)))
  const skelData = assetManager.require(skelName)
  let skeletonData
  if (/\.json$/i.test(skelName)) {
    skeletonData = new SPINE.SkeletonJson(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(skelData)
  } else {
    skeletonData = new SPINE.SkeletonBinary(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(skelData)
  }
  const skeleton = new SPINE.Skeleton(skeletonData)
  const skins = skeletonData.skins || []
  if (skins.length) {
    const pick = skins.find((s) => /default|base|normal/i.test(s.name)) || skins[skins.length - 1]
    skeleton.setSkin(skins.length > 1 ? pick : skins[0])
    skeleton.setSlotsToSetupPose()
  }
  // 所有 4.x 的 AnimationState 构造参数都是 AnimationStateData（不是 SkeletonData）
  const state = new SPINE.AnimationState(new SPINE.AnimationStateData(skeletonData))
  const anims = skeletonData.animations
  // idle 选择：优先全身待机，眉毛/脸部/特效类幅度太小放最后兜底
  const idle = anims.find((a) => /^motion_[A-Z]_\d+_idle$/i.test(a.name))
    || anims.find((a) => /motion.*idle/i.test(a.name))
    || anims.find((a) => /stand|wait|待机/i.test(a.name))
    || anims.find((a) => /idle|待机/i.test(a.name) && !/facial|face|effect/i.test(a.name))
    || anims.find((a) => /idle|待机/i.test(a.name))
    || anims[0]
  console.warn('[pet-ov] 加载成功 → 播放', idle && idle.name)
  if (idle) state.setAnimation(0, idle.name, true)
  // WebGL 路径：GPU 画 mesh，30fps 足够流畅且几乎不占主线程
  if (useGL) {
    const sceneRenderer = new GL.SceneRenderer(glCanvas, managedGl)
    // 显示画布用 2D 上下文接收离屏 GL 的 blit
    const ctx2d = canvas.getContext('2d', { willReadFrequently: false })
    const gl = managedGl.gl
    const offset = new SPINE.Vector2()
    const size = new SPINE.Vector2()
    // 相机锁定：包围盒按 setup pose 只算一次。
    // 动画（呼吸等）会持续改变包围盒，跟着重算会让角色看起来忽大忽小。
    // 必须先算一次世界变换再取包围盒——加载期骨架从未 updateWorldTransform，
    // 直接 getBounds 得到的是垃圾值 → zoom 错乱 → 角色碎片铺满画布（0.3.29 色块根因）
    // Physics.none：只按当前局部姿势（= setup pose）刷世界变换，不跑物理
    // （4.2 枚举是 none/reset/update/pose，没有 4.3 的 setup）
    skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.none : undefined)
    skeleton.getBounds(offset, size, [])
    const bw = size.x || 1
    const bh = size.y || 1
    const cam = sceneRenderer.camera
    cam.setViewport(canvas.width, canvas.height)
    cam.position.set(offset.x + bw / 2, offset.y + bh / 2, 0)
    let zoom = Math.max(bw / canvas.width, bh / canvas.height) / 0.95
    if (!isFinite(zoom) || zoom <= 0) zoom = 1
    cam.zoom = zoom
    /* ---- 视觉跟踪（参考 agentatelierR character_gaze.dart / chat_screen.dart） ----
     * 光标在骨架坐标里的方向，经指数平滑后平移 control_* 控制骨骼（IK 目标），
     * 在 state.apply 之后、updateWorldTransform 之前修改。*/
    const gnorm = (skeletonData.width || 1400) / 1400 // 参考项目的常量按其骨架宽度标定
    // 版本兼容：spine 4.3+ 才有 bone.pose（姿势对象），4.2 直接挂在 bone 上
    const POSE43 = !!(skeleton.bones && skeleton.bones.length && skeleton.bones[0].pose)
    const P = (b) => (POSE43 ? b.pose : b)
    const stage = document.getElementById('petStage')
    const aimHead = skeleton.findBone('control_aim_head')
    const aimBody = skeleton.findBone('control_aim_body')
    const rollHead = skeleton.findBone('control_roll_head')
    const rollNeck = skeleton.findBone('control_roll_neck')
    const rollBodyU = skeleton.findBone('control_roll_body_upper')
    const rollBodyL = skeleton.findBone('control_roll_body_lower')
    const aimEye = skeleton.findBone('control_aim_eye') || skeleton.findBone('control_eye') || skeleton.findBone('control_handle_eye')
    const eyes = ['eyeball_L', 'eyeball_R'].map((n) => skeleton.findBone(n)).filter(Boolean)
    for (const b of [aimHead, aimBody, rollHead, rollNeck, rollBodyU, rollBodyL, aimEye].concat(eyes)) {
      if (!b) continue
      b.__gx = P(b).x
      b.__gy = P(b).y
    }
    const gaze = { h: { x: 0, y: 0 }, b: { x: 0, y: 0 } }
    let gazeDbg = '-'
    // 薄纱取证：画布内容已证实干净而屏幕有薄纱 → 让程序自己枚举该区域的可见元素
    let veilScanned = false
    function scanVeil () {
      try {
        const r = stage.getBoundingClientRect()
        const probes = [[r.left + r.width / 2, r.top + 6], [r.left + 6, r.top + r.height / 2], [r.left + r.width / 2, r.top + r.height / 2]]
        const seen = new Set()
        const out = []
        for (const [x, y] of probes) {
          for (const el of document.elementsFromPoint(x, y)) {
            const cs = getComputedStyle(el)
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
            const key = (el.id || el.tagName + '.' + String(el.className).slice(0, 24)) +
              ' bg=' + cs.backgroundColor + ' op=' + cs.opacity +
              (cs.backdropFilter && cs.backdropFilter !== 'none' ? ' BACKDROP(' + cs.backdropFilter + ')' : '') +
              (el.id === 'petSpineCanvas' ? ' [显示画布]' : '')
            if (seen.has(key)) continue
            seen.add(key)
            out.push(key)
          }
        }
        console.warn('[pet-ov] 薄纱扫描:', out.join(' || ') || '(区域无可见元素)')
      } catch (e) { console.warn('[pet-ov] 薄纱扫描失败:', e.message) }
    }
    const _v = GL.Vector3 ? new GL.Vector3() : null
    function screenToSkeletonWorld (cssX, cssY) {
      if (!stage) return null
      const r = stage.getBoundingClientRect()
      if (!r.width || !r.height) return null
      // cssX/cssY 是窗口内坐标（触摸点击的 clientX/Y）；gaze 传全局光标前需先减 window.screenX/Y。
      // 正交相机：世界 delta = 屏幕 delta * zoom，骨架 y 向上需翻转屏幕 y。
      // 画布中心的世界坐标 = 相机位置（锁定时对准包围盒中心并绘制在画布中心）
      const zoom = (cam && cam.zoom) || 1
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const px = cam && cam.position ? cam.position.x : 0
      const py = cam && cam.position ? cam.position.y : 0
      if (_v) { _v.x = px + (cssX - cx) * zoom; _v.y = py - (cssY - cy) * zoom; _v.z = 0; return _v }
      return { x: px + (cssX - cx) * zoom, y: py - (cssY - cy) * zoom, z: 0 }
    }
    function resetGaze () {
      for (const b of [aimHead, aimBody, rollHead, rollNeck, rollBodyU, rollBodyL, aimEye].concat(eyes)) {
        if (!b) continue
        P(b).x = b.__gx
        P(b).y = b.__gy
      }
    }
    function stepGaze (dt) {
      const infl = gazeInfluence()
      if (infl <= 0) {
        if (gaze.h.x || gaze.h.y || gaze.b.x || gaze.b.y) { gaze.h.x = gaze.h.y = gaze.b.x = gaze.b.y = 0; resetGaze() }
        gazeDbg = 'infl=0'
        return
      }
      const face = skeleton.findBone('head')
      // cursorScreen 是全局屏幕坐标，先转窗口内坐标（多显示器可为负原点）
      const p = cursorScreen
        ? screenToSkeletonWorld(cursorScreen.x - (window.screenX || 0), cursorScreen.y - (window.screenY || 0))
        : null
      if (!face || !p) { gazeDbg = 'no-face-or-point'; return }
      const fx = P(face).worldX
      const fy = P(face).worldY
      // 参考 gazeControlOffset：方向保持，距离超过 maxDistance 后钳到 maxOffset=140
      const dx = p.x - fx
      const dy = p.y - fy
      const dist = Math.hypot(dx, dy) || 1
      const MAXD = 514.7 * gnorm
      const MAXOFF = 140 * gnorm
      const k = MAXOFF / Math.max(MAXD, dist)
      const off = { dx: dx * k, dy: dy * k }
      const c = Math.min(0.05, Math.max(0.001, dt))
      const kH = 1 - Math.exp(-c / 0.1)
      const kB = 1 - Math.exp(-c / 0.2)
      gaze.h.x += (off.dx - gaze.h.x) * kH
      gaze.h.y += (off.dy - gaze.h.y) * kH
      gaze.b.x += (off.dx - gaze.b.x) * kB
      gaze.b.y += (off.dy - gaze.b.y) * kB
      // 世界偏移 → 该骨骼父骨骼局部空间（参考 _applyEyeGaze 的 worldToLocal 差值法）。
      // 控制骨骼的父链可能带旋转/镜像/缩放，直接把世界方向加进局部坐标会看错方向；
      // 父骨骼缩放 <1 时局部位移会被放大 → 必须钳制（否则一动鼠标就扭成麻花）
      const toLocal = (bone, odx, ody, maxLocal) => {
        const parent = bone.parent
        if (!parent) return { x: odx, y: ody }
        const a = parent.worldToLocal({ x: fx, y: fy })
        const b = parent.worldToLocal({ x: fx + odx, y: fy + ody })
        let lx = b.x - a.x
        let ly = b.y - a.y
        const len = Math.hypot(lx, ly)
        if (maxLocal > 0 && len > maxLocal) { lx = lx / len * maxLocal; ly = ly / len * maxLocal }
        return { x: lx, y: ly }
      }
      gazeDbg = 'cursor=' + (cursorScreen ? Math.round(cursorScreen.x) + ',' + Math.round(cursorScreen.y) : '-') +
        ' win=' + Math.round(window.screenX || 0) + ',' + Math.round(window.screenY || 0) +
        ' zoom=' + ((cam && cam.zoom) || 0).toFixed(2) +
        ' head=' + Math.round(fx) + ',' + Math.round(fy) +
        ' off=' + Math.round(gaze.h.x) + ',' + Math.round(gaze.h.y) +
        ' infl=' + infl.toFixed(2)
      // 眼球：偏移量 * 0.2（参考 _applyEyeGaze）
      let eyesMoved = false
      for (const e of eyes) {
        if (!e.parent) continue
        const l = toLocal(e, gaze.h.x, gaze.h.y, 40)
        P(e).x = e.__gx + l.x * infl * 0.2
        P(e).y = e.__gy + l.y * infl * 0.2
        eyesMoved = true
      }
      if (!eyesMoved && aimEye) {
        const l = toLocal(aimEye, gaze.h.x, gaze.h.y, 140)
        P(aimEye).x = aimEye.__gx + l.x * infl
        P(aimEye).y = aimEye.__gy + l.y * infl
      }
      const s = infl
      let l
      if (aimHead) { l = toLocal(aimHead, gaze.h.x, gaze.h.y, 60); P(aimHead).x = aimHead.__gx + l.x * 0.34 * s; P(aimHead).y = aimHead.__gy + l.y * 0.24 * s }
      if (aimBody) { l = toLocal(aimBody, gaze.b.x, gaze.b.y, 90); P(aimBody).x = aimBody.__gx + l.x * 0.39 * s; P(aimBody).y = aimBody.__gy + l.y * 0.27 * s }
      if (rollHead) { l = toLocal(rollHead, gaze.h.x, gaze.h.y, 50); P(rollHead).x = rollHead.__gx + l.x * 0.29 * s }
      if (rollNeck) { l = toLocal(rollNeck, gaze.h.x, gaze.h.y, 30); P(rollNeck).x = rollNeck.__gx + l.x * 0.14 * s }
      if (rollBodyU) { l = toLocal(rollBodyU, gaze.b.x, gaze.b.y, 100); P(rollBodyU).x = rollBodyU.__gx + l.x * 0.57 * s }
      if (rollBodyL) { l = toLocal(rollBodyL, gaze.b.x, gaze.b.y, 45); P(rollBodyL).x = rollBodyL.__gx + l.x * 0.23 * s }
    }
    /* ---- 触摸反应（参考 tap_reaction.dart：BB_* 包围盒命中 → motion_touch 动作） ---- */
    const BB_PARTS = { BB_head: 'head', BB_body: 'body', BB_arm_L: 'arm_l', BB_arm_R: 'arm_r', BB_weast: 'weast', BB_breast: 'breast' }
    const TOUCH_REACTIONS = {
      head: ['motion_touch_A_001_active', 'motion_touch_A_002_active'],
      body: ['motion_touch_A_004_active'],
      breast: ['motion_touch_A_003_active'],
      arm_l: ['motion_touch_A_005_active'],
      arm_r: ['motion_touch_A_006_active'],
      weast: ['motion_touch_A_007_active']
    }
    function polygonContains (verts, x, y) {
      if (!verts || verts.length < 6) return false
      let inside = false
      for (let i = 0, j = verts.length - 2; i < verts.length; j = i, i += 2) {
        const xi = verts[i], yi = verts[i + 1], xj = verts[j], yj = verts[j + 1]
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside
      }
      return inside
    }
    function polygonArea (verts) {
      let a = 0
      for (let i = 0, j = verts.length - 2; i < verts.length; j = i, i += 2) a += verts[j] * verts[i + 1] - verts[i] * verts[j + 1]
      return Math.abs(a) / 2
    }
    onTapHook = (cssX, cssY) => {
      try {
        const p = screenToSkeletonWorld(cssX, cssY)
        if (!p) return
        const hits = []
        for (const slot of skeleton.slots) {
          const part = BB_PARTS[slot.data && slot.data.name]
          if (!part) continue
          const att = (slot.getAttachment ? slot.getAttachment() : slot.appliedPose.attachment)
          if (!att || !(att instanceof SPINE.BoundingBoxAttachment)) continue
          const verts = new Array(att.worldVerticesLength)
          // 签名兼容：4.3+ 首参是 skeleton，4.2 首参直接是 slot
          if (POSE43) att.computeWorldVertices(skeleton, slot, 0, att.worldVerticesLength, verts, 0, 2)
          else att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2)
          if (!polygonContains(verts, p.x, p.y)) continue
          hits.push({ part, area: polygonArea(verts) })
        }
        if (!hits.length) return
        hits.sort((a, b) => a.area - b.area)
        const cands = TOUCH_REACTIONS[hits[0].part] || []
        let animName = cands.find((n) => anims.some((x) => x.name === n))
        if (!animName) {
          const any = anims.find((x) => /motion_touch/i.test(x.name))
          animName = any && any.name
        }
        if (!animName) return
        state.setAnimation(0, animName, false)
        state.addAnimation(0, idle.name, true, 0)
        // 触摸语音反馈（对齐参考项目：不同部位对应反应语音）
        speakTouch(hits[0].part)
      } catch (e) { console.warn('[pet-ov] 触摸反应失败:', e.message) }
    }
    spineRuntime = {
      sig,
      render: true,
      step (dt) {
        if (skeleton.update) skeleton.update(dt)
        state.update(dt)
        // 关键：必须把动画姿势应用到骨架，否则画的永远是 setup pose 静止图
        state.apply(skeleton)
        stepGaze(dt) // 视线跟踪：动画之后、世界变换之前修改控制骨骼
        skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.update : undefined)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        sceneRenderer.begin()
        sceneRenderer.drawSkeleton(skeleton, true) // 贴图已预乘，PMA 混合 (ONE, ONE_MINUS_SRC_ALPHA)
        sceneRenderer.end()
        // 离屏 GL → 显示 2D canvas 的 blit：必须在同一任务内紧跟 end()（无 preserveDrawingBuffer）
        ctx2d.clearRect(0, 0, canvas.width, canvas.height)
        ctx2d.drawImage(glCanvas, 0, 0)
        // 取证 dump：2D 画布随时可读，紧跟 blit 保证是本帧内容
        if (spineRuntime && spineRuntime.dump) {
          spineRuntime.dump = false
          try { window.aura.logImage('pet-canvas-' + Date.now() + '.png', canvas.toDataURL('image/png')) } catch {}
        }
      },
      // 诊断：trackTime 是否推进 + 角像素是否透明（区分「GL 缓冲不透明」vs「合成不吃 alpha」）
      heartbeat () {
        if (!veilScanned) { veilScanned = true; scanVeil() }
        const cur = state.getCurrent(0)
        let px = ''
        try {
          const buf = new Uint8Array(4)
          const pts = [[2, 2], [canvas.width - 3, 2], [2, canvas.height - 3], [canvas.width - 3, canvas.height - 3], [Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)]]
          const parts = []
          for (let i = 0; i < 5; i++) {
            const x = pts[i][0]
            const y = pts[i][1]
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
            parts.push('a=' + buf[3] + (i === 4 ? ' rgb=' + buf[0] + ',' + buf[1] + ',' + buf[2] : ''))
          }
          px = ' 四角/中心:' + parts.join(' ')
        } catch (e) { px = ' 像素读取失败:' + e.message }
        return 'trackTime=' + (cur ? cur.trackTime.toFixed(2) : '-') +
          ' anim=' + (cur && cur.animation ? cur.animation.name : '-') +
          ' 画布=' + canvas.width + 'x' + canvas.height + px + liveness() +
          ' gaze[' + gazeDbg + ']'
      }
    }
  } else {
    // canvas 兜底路径（仅 4.0/4.1 皮肤）
    spineRuntime = {
      sig,
      render: true,
      step (dt) {
        state.update(dt)
        // 关键：必须把动画姿势应用到骨架，否则画的永远是 setup pose 静止图
        state.apply(skeleton)
        if (skeleton.update) skeleton.update(dt)
        skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.update : undefined)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        const offset = new SPINE.Vector2()
        const size = new SPINE.Vector2()
        skeleton.getBounds(offset, size, [])
        const s = Math.min(canvas.width / (size.x || 1), canvas.height / (size.y || 1)) * 0.95
        ctx.save()
        // spine 世界坐标 y 向上、canvas y 向下：必须翻转 y 并把 bounds 底边对到画布底
        ctx.translate((canvas.width - size.x * s) / 2 - offset.x * s, canvas.height - 6 + offset.y * s)
        ctx.scale(s, -s)
        const renderer = new SPINE.SkeletonRenderer(ctx)
        // 默认 drawImages 只画 Region 四边形、跳过 Mesh → 必须 triangleRendering
        renderer.triangleRendering = true
        renderer.__scale = s
        renderer.draw(skeleton)
        ctx.restore()
      },
      heartbeat () {
        const cur = state.getCurrent(0)
        return 'trackTime=' + (cur ? cur.trackTime.toFixed(2) : '-') + ' 画布=' + canvas.width + 'x' + canvas.height + liveness()
      }
    }
  }
  // 用 setInterval 驱动（rAF 已实测满帧率，但 40ms invalidate 兜底保留）。
  // dt 用真实间隔（0.3.26 前硬编码 1/60 而 interval 是 33ms，动画只有半速）
  if (!spineRafStarted) {
    spineRafStarted = true
    let errCount = 0
    let frames = 0
    let lastT = performance.now()
    setInterval(() => {
      if (spineRuntime && spineRuntime.render) {
        try {
          const now = performance.now()
          const dt = Math.min(0.1, (now - lastT) / 1000)
          lastT = now
          spineRuntime.step(dt)
          // 心跳：每 60 帧（约 2 秒）报一次动画推进状态
          if (++frames % 60 === 0 && spineRuntime.heartbeat) {
            console.warn('[pet-ov] 心跳#' + frames, spineRuntime.heartbeat())
            // 取证：canvas 位图 dump（desktopCapturer 拍不到透明窗口，弃用 petSnapshot）
            if (frames === 60 || frames === 420) {
              try { if (spineRuntime) spineRuntime.dump = true } catch {}
            }
          }
        } catch (e) { if (++errCount <= 3) console.warn('[pet-ov] step 异常:', e.message) }
      }
    }, 33)
  }
}

/* ---------------- VRM ---------------- */
async function showVrm (v) {
  const { THREE, GLTFLoader, THREEVRM } = window.AuraLibs
  const url = await assetUrl(v.vrm)
  if (vrmRuntime && vrmRuntime.sig === url) return
  disposeVrm()
  currentSig = url
  const canvas = $('petVrmCanvas')
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, canvas.clientWidth / canvas.clientHeight, 0.1, 20)
  camera.position.set(0, 1.35, -1.6)
  camera.lookAt(0, 1.25, 0)
  scene.add(new THREE.DirectionalLight(0xffffff, Math.PI))
  const gltf = await new Promise((resolve, reject) => { new GLTFLoader().load(url, resolve, undefined, reject) })
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

/* ---------------- 悬停聊天（气泡回复）+ 语音捕捉 ---------------- */
function setupChat () {
  const stage = $('petStage')
  const panel = $('petChat')
  const bubble = $('petBubble')
  const input = $('petChatInput')
  const mic = $('petMic')
  const sendBtn = $('petSendBtn')
  if (!panel || !input || !stage) return
  let hideTimer = null
  let generating = false
  let bubbleTimer = null

  // 面板定位：贴角色正下方（水平居中），超出屏幕则夹回；下方放不下翻到角色上方
  function positionChat () {
    if (panel.hidden) return
    const r = stage.getBoundingClientRect()
    const pw = panel.offsetWidth || 300
    const ph = panel.offsetHeight || 120
    let x = r.left + r.width / 2 - pw / 2
    x = Math.max(8, Math.min(window.innerWidth - pw - 8, x))
    let y = r.bottom + 8
    if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 8)
    panel.style.left = Math.round(x) + 'px'
    panel.style.top = Math.round(y) + 'px'
  }
  // 气泡定位：贴角色头顶（水平居中），强制夹屏；放不下时移到角色下方
  function positionBubble () {
    if (bubble.hidden) return
    const r = stage.getBoundingClientRect()
    const bw = bubble.offsetWidth || 260
    const bh = bubble.offsetHeight || 60
    let x = r.left + r.width / 2 - bw / 2
    x = Math.max(8, Math.min(window.innerWidth - bw - 8, x))
    let y = r.top - bh - 10
    if (y < 8) y = Math.min(window.innerHeight - bh - 8, r.bottom + 10)
    bubble.style.left = Math.round(x) + 'px'
    bubble.style.top = Math.round(y) + 'px'
  }
  // 气泡显示/更新（流式期间不淡出），完成后停留 8 秒淡出
  const BUBBLE_KEEP = 8000
  function bubbleShow (text) {
    clearTimeout(bubbleTimer)
    bubble.classList.remove('fading')
    bubble.hidden = false
    bubble.textContent = text
    requestAnimationFrame(positionBubble)
  }
  function bubbleKeep () {
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => {
      bubble.classList.add('fading')
      bubbleTimer = setTimeout(() => { bubble.hidden = true; bubble.classList.remove('fading') }, 400)
    }, BUBBLE_KEEP)
  }

  const show = () => {
    clearTimeout(hideTimer)
    panel.hidden = false
    // 面板贴角色正下方，强制夹在屏内（角色拖到边缘时也不会跑出屏幕）
    requestAnimationFrame(positionChat)
    // overlay 窗口 focusable:false（不抢焦点），输入时动态放开，键盘才能进 textarea
    try { window.aura.petChatFocus(true) } catch {}
  }
  const maybeHide = () => {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (document.activeElement !== input && !mic.classList.contains('on')) {
        panel.hidden = true
        try { window.aura.petChatFocus(false) } catch {}
      }
    }, 1800)
  }
  stage.addEventListener('pointerenter', show)
  stage.addEventListener('pointerleave', maybeHide)
  panel.addEventListener('pointerenter', show)
  panel.addEventListener('pointerleave', maybeHide)

  const send = () => {
    const t = input.value.trim()
    if (!t || generating) return
    input.value = ''
    input.style.height = 'auto'
    generating = true
    // 发送新消息即打断正在播的语音（对齐参考 _cancelSpeechPlayback）
    stopVoice()
    bubbleShow('…')
    window.aura.petChatSend(t)
  }
  sendBtn.addEventListener('click', send)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
  input.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(72, this.scrollHeight) + 'px' })

  let lastDeltaSeq = null
  window.aura.onPetDelta(({ seq, text }) => {
    // seq 变化 = 新一轮生成（含语言守卫纠正重生成）→ 气泡从空开始而不是追加
    if (seq !== lastDeltaSeq) { lastDeltaSeq = seq; bubbleShow(String(text || '')) ; return }
    // 同一轮流式追加到气泡（textContent 直接累加）
    bubbleShow((bubble.textContent === '…' ? '' : bubble.textContent) + text)
  })
  window.aura.onPetDone(({ content, audio }) => {
    generating = false
    bubbleShow(content || '（空回复）')
    bubbleKeep()
    // 语音回复：走全局单实例 playVoice（新语音自动打断上一条，杜绝重叠回声）
    if (audio && audio.url) playVoice(audio.url, audio.speed)
  })
  window.aura.onPetError(({ message, partial }) => {
    generating = false
    // 错误也用气泡显示，但压缩长度（LLM 报错的 JSON 很长）
    const msg = String(message || '出错了').replace(/\s+/g, ' ').slice(0, 140)
    bubbleShow((partial ? partial + ' ' : '') + '⚠ ' + msg)
    bubbleKeep()
  })
  window.addEventListener('resize', () => { requestAnimationFrame(() => { positionChat(); positionBubble() }) })

  /* ---- 语音捕捉：开了就持续捕捉（VAD 断句 → 识别 → 直接发送） ---- */
  let on = false
  let stream = null
  let analyser = null
  let audioCtx = null
  let vadTimer = null
  let recorder = null
  let chunks = []
  let speaking = false
  let silenceSince = 0
  const KEY = 'auraPetMicOn'

  const blobToB64 = (blob) => new Promise((ok, bad) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result).split(',')[1] || '')
    r.onerror = () => bad(new Error('read 失败'))
    r.readAsDataURL(blob)
  })

  async function flushRecording () {
    const rec = recorder
    recorder = null
    speaking = false
    if (!rec || rec.state === 'inactive') return
    await new Promise((ok) => { rec.onstop = ok; rec.stop() })
    const blob = new Blob(chunks, { type: 'audio/webm' })
    chunks = []
    if (blob.size < 2000) return // 太短，视为噪声
    try {
      const b64 = await blobToB64(blob)
      const r = await window.aura.petTranscribe(b64, 'audio/webm')
      if (r && r.ok && r.text) {
        generating = true
        bubbleShow('…')
        window.aura.petChatSend(r.text)
      } else if (r && r.message && !/未知|empty/i.test(r.message)) {
        bubbleShow('⚠ 语音识别失败：' + r.message)
        bubbleKeep()
      }
    } catch (e) { bubbleShow('⚠ 语音识别异常: ' + e.message); bubbleKeep() }
  }

  function startVad () {
    const buf = new Uint8Array(analyser.fftSize)
    vadTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / buf.length)
      const now = Date.now()
      if (rms > 0.045) {
        if (!speaking) {
          speaking = true
          chunks = []
          try {
            recorder = new MediaRecorder(stream)
            recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
            recorder.start()
          } catch { recorder = null; speaking = false }
        }
        silenceSince = now
      } else if (speaking && now - silenceSince > 1400) {
        flushRecording()
      }
    }, 120)
  }

  async function micOn () {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioCtx = new AudioContext()
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 1024
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      on = true
      mic.classList.add('on')
      show()
      startVad()
    } catch (e) {
      bubbleShow('⚠ 麦克风不可用: ' + (e.message || e.name))
      bubbleKeep()
      on = false
    }
  }
  function micOff () {
    on = false
    mic.classList.remove('on')
    clearInterval(vadTimer)
    vadTimer = null
    if (recorder && recorder.state === 'recording') { try { recorder.stop() } catch {} }
    recorder = null
    speaking = false
    if (stream) stream.getTracks().forEach((t) => t.stop())
    stream = null
    if (audioCtx) { try { audioCtx.close() } catch {} }
    audioCtx = null
  }
  mic.addEventListener('click', () => {
    if (on) { micOff(); localStorage.setItem(KEY, '0') } else { micOn(); localStorage.setItem(KEY, '1') }
  })
  // 上次开着 → 默认继续捕捉（用户要求：开了就默认捕捉）
  if (localStorage.getItem(KEY) === '1') setTimeout(micOn, 1500)
  return { hide: () => { panel.hidden = true } }
}
function setupDrag () {
  const el = $('petStage')
  let drag = null
  let down = null
  // 位置统一写 :root 的 --pet-right/--pet-bottom（px）：petstage 与 petchat 面板共用，拖动时面板跟随
  const applyPos = (right, bottom) => {
    document.documentElement.style.setProperty('--pet-right', right + 'px')
    document.documentElement.style.setProperty('--pet-bottom', bottom + 'px')
  }
  let petPos = null
  // 恢复上次位置（相对右/下边的像素偏移）
  try {
    const saved = JSON.parse(localStorage.getItem('auraPetPos') || 'null')
    if (saved && isFinite(saved.right) && isFinite(saved.bottom)) petPos = { right: saved.right, bottom: saved.bottom }
  } catch {}
  if (petPos) applyPos(petPos.right, petPos.bottom)
  el.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false }
    if (!petPos) {
      const cs = getComputedStyle(el)
      petPos = { right: parseFloat(cs.right) || 26, bottom: parseFloat(cs.bottom) || 102 }
    }
    drag = { x: e.clientX, y: e.clientY, right: petPos.right, bottom: petPos.bottom }
    // 拖动中冻结热区重算（setShape=SetWindowRgn 会裁视觉，每帧重设会裁掉角色一块）
    window.__petDragging = true
    el.setPointerCapture(e.pointerId)
    e.preventDefault()
  })
  el.addEventListener('pointermove', (e) => {
    if (!drag) return
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true
    // clamp 保证角色始终留在屏内（原来允许拖到几乎完全出屏 = 「拖动时消失一部分」）
    const right = Math.round(Math.max(40, Math.min(window.innerWidth - 40, drag.right + (drag.x - e.clientX))))
    const bottom = Math.round(Math.max(0, Math.min(window.innerHeight - 160, drag.bottom + (drag.y - e.clientY))))
    petPos = { right, bottom }
    applyPos(right, bottom)
    // 面板开着时跟随角色（positionChat 自带屏内夹取，不会跑出屏幕）
    if (!$('petChat').hidden) requestAnimationFrame(positionChat)
  })
  el.addEventListener('pointerup', (e) => {
    if (!drag) return
    drag = null
    window.__petDragging = false
    const wasTap = down && !down.moved && Date.now() - down.t < 500
    down = null
    // 轻点（几乎没移动）→ 触摸反应（摸头/戳身体等），不算拖动
    if (wasTap && onTapHook) { onTapHook(e.clientX, e.clientY); return }
    try {
      if (petPos) localStorage.setItem('auraPetPos', JSON.stringify(petPos))
    } catch {}
    // 通知热区系统重算（petStage 位置变了）
    window.dispatchEvent(new Event('resize'))
  })
  el.addEventListener('pointercancel', () => { drag = null; window.__petDragging = false })
}

/* ---------------- 启动 & 刷新 ---------------- */
;(async () => {
  const chat = setupChat()
  setupDrag()
  // 视觉跟踪光标（主进程 80ms 轮询广播）+ 角色大小配置
  window.aura.onCursor((p) => { cursorScreen = p; cursorMoveAt = performance.now() })
  window.aura.onPetConfig((c) => {
    if (c && c.scale != null) applyScale(c.scale, true)
    // 回复语言设置变化 → 触摸语音短语切语种
    if (c && c.replyLang) touchLang = c.replyLang
  })
  try {
    const s = await window.aura.petSettings()
    if (s && s.petScale != null) await applyScale(s.petScale, false)
  } catch {}
  const st = await window.aura.petState()
  if (st && st.visible && st.char) await showVisual(st.char)
  window.aura.onPetState(async (s) => {
    if (!s || !s.visible) { disposeSpine(); disposeVrm(); currentSig = ''; if (chat) chat.hide(); return }
    if (s.char) await showVisual(s.char)
  })
  // 兼容旧刷新频道（companion 侧角色保存）
  if (window.companion && window.companion.onPetRefresh) {
    window.companion.onPetRefresh(async ({ char }) => { if (char) await showVisual(char) })
  }
})().catch((err) => { console.error('[pet-ov boot]', err); $('petFallback').hidden = false })
})()
