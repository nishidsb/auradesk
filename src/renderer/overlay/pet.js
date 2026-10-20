'use strict'
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
  const SPINE = (libs.AuraSpine && ver && libs.AuraSpine[ver]) || libs.SPINE
  patchSpineSeam(SPINE)
  console.warn('[pet-ov] 骨架版本', ver || '未知', '→ 运行时', SPINE === libs.SPINE ? '4.3（兜底）' : ver)
  const canvas = $('petSpineCanvas')
  const scale = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * scale
  canvas.height = canvas.clientHeight * scale
  const ctx = canvas.getContext('2d')
  const assetManager = new SPINE.AssetManager(atlasUrl.replace(/[^/]*$/, ''))
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
  // 用 setInterval 驱动（rAF 的 BeginFrame 可能被窗口可见性调度暂停）
  if (!spineRafStarted) {
    spineRafStarted = true
    let errCount = 0
    setInterval(() => {
      if (spineRuntime && spineRuntime.render) {
        try { spineRuntime.step() } catch (e) { if (++errCount <= 3) console.warn('[pet-ov] step 异常:', e.message) }
      }
    }, 16)
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

/* ---------------- 启动 & 刷新 ---------------- */
;(async () => {
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
