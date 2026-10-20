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
  let assetManager
  let useGL = false
  if (GL) {
    try {
      managedGl = new GL.ManagedWebGLRenderingContext(canvas, { alpha: true, premultipliedAlpha: false, antialias: true })
      assetManager = new GL.AssetManager(managedGl, atlasUrl.replace(/[^/]*$/, ''))
      useGL = true
    } catch (e) {
      console.warn('[pet-ov] WebGL 初始化失败，降级 canvas:', e && e.message)
      GL = null
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
    const sceneRenderer = new GL.SceneRenderer(canvas, managedGl)
    const gl = managedGl.gl
    let boundsFrame = 0
    const offset = new SPINE.Vector2()
    const size = new SPINE.Vector2()
    spineRuntime = {
      sig,
      render: true,
      step () {
        const dt = 1 / 60
        state.update(dt)
        skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.update : undefined)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        // 相机适配骨架包围盒（每 20 帧重算一次，bounds 计算不便宜）
        if (boundsFrame++ % 20 === 0) {
          skeleton.getBounds(offset, size, [])
          const bw = size.x || 1
          const bh = size.y || 1
          const cam = sceneRenderer.camera
          cam.setViewport(canvas.width, canvas.height)
          cam.position.set(offset.x + bw / 2, offset.y + bh / 2, 0)
          let zoom = Math.max(bw / canvas.width, bh / canvas.height) / 0.95
          if (!isFinite(zoom) || zoom <= 0) zoom = 1
          cam.zoom = zoom
        }
        sceneRenderer.begin()
        sceneRenderer.drawSkeleton(skeleton, false)
        sceneRenderer.end()
      }
    }
  } else {
    // canvas 兜底路径（仅 4.0/4.1 皮肤）
    spineRuntime = {
      sig,
      render: true,
      step () {
        const dt = 1 / 60
        state.update(dt)
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
      }
    }
  }
  // 用 setInterval 驱动（rAF 的 BeginFrame 可能被窗口可见性调度暂停）
  if (!spineRafStarted) {
    spineRafStarted = true
    let errCount = 0
    setInterval(() => {
      if (spineRuntime && spineRuntime.render) {
        try { spineRuntime.step() } catch (e) { if (++errCount <= 3) console.warn('[pet-ov] step 异常:', e.message) }
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

/* ---------------- 拖动：按住角色拖到任意位置（参考 agentatelierR 的 startDrag） ---------------- */
function setupDrag () {
  const el = $('petStage')
  let drag = null
  // 恢复上次位置（相对右/下边的像素偏移）
  try {
    const saved = JSON.parse(localStorage.getItem('auraPetPos') || 'null')
    if (saved && isFinite(saved.right) && isFinite(saved.bottom)) {
      el.style.right = saved.right + 'px'
      el.style.bottom = saved.bottom + 'px'
    }
  } catch {}
  el.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, right: parseFloat(el.style.right) || 26, bottom: parseFloat(el.style.bottom) || 102 }
    el.setPointerCapture(e.pointerId)
    e.preventDefault()
  })
  el.addEventListener('pointermove', (e) => {
    if (!drag) return
    const right = Math.round(drag.right + (drag.x - e.clientX))
    const bottom = Math.round(drag.bottom + (drag.y - e.clientY))
    el.style.right = Math.max(-window.innerWidth + 120, Math.min(window.innerWidth - 120, right)) + 'px'
    el.style.bottom = Math.max(0, Math.min(window.innerHeight - 80, bottom)) + 'px'
  })
  el.addEventListener('pointerup', () => {
    if (!drag) return
    drag = null
    try {
      localStorage.setItem('auraPetPos', JSON.stringify({ right: parseFloat(el.style.right), bottom: parseFloat(el.style.bottom) }))
    } catch {}
    // 通知热区系统重算（petStage 位置变了）
    window.dispatchEvent(new Event('resize'))
  })
  el.addEventListener('pointercancel', () => { drag = null })
}

/* ---------------- 启动 & 刷新 ---------------- */
;(async () => {
  setupDrag()
  const st = await window.aura.petState()
  if (st && st.visible && st.char) await showVisual(st.char)
  window.aura.onPetState(async (s) => {
    if (!s || !s.visible) { disposeSpine(); disposeVrm(); currentSig = ''; return }
    if (s.char) await showVisual(s.char)
  })
  // 兼容旧刷新频道（companion 侧角色保存）
  if (window.companion && window.companion.onPetRefresh) {
    window.companion.onPetRefresh(async ({ char }) => { if (char) await showVisual(char) })
  }
})().catch((err) => { console.error('[pet-ov boot]', err); $('petFallback').hidden = false })
})()
