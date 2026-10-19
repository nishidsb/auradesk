'use strict'
/* 桌面角色渲染层：加载当前角色的立绘 / Spine / VRM 并持续播放，角色更新时自动重载 */
const $ = (id) => document.getElementById(id)
const basename = (p) => String(p || '').replace(/\\/g, '/').split('/').pop()

let vrmRuntime = null
let spineRuntime = null

async function assetUrl (p) { return p ? window.companion.assetUrl(p) : '' }

function disposeSpine () {
  if (spineRuntime) { spineRuntime.render = false; spineRuntime = null }
}
function disposeVrm () {
  if (vrmRuntime) { vrmRuntime.alive = false; vrmRuntime = null }
}

async function showVisual (char) {
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
    console.error('[pet visual]', err)
    $('stageFallback').hidden = false
  }
}

/* ---------------- Spine ---------------- */
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
  // spine-canvas 4.3 构造签名是 (pathPrefix, downloader)——没有 ctx 参数
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
  const atlas = assetManager.requireAtlas(basename(decodeURIComponent(atlasUrl)))
  let skeletonData
  if (/\.json$/i.test(skelName)) {
    const data = assetManager.requireText(skelName)
    skeletonData = new SPINE.SkeletonJson(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(data)
  } else {
    const data = assetManager.requireBinary(skelName)
    skeletonData = new SPINE.SkeletonBinary(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(data)
  }
  const skeleton = new SPINE.Skeleton(skeletonData)
  const state = new SPINE.AnimationState(skeletonData)
  const idle = skeletonData.animations.find((a) => /idle|待机/i.test(a.name)) || skeletonData.animations[0]
  console.warn('[pet spine] 加载成功: 动画', skeletonData.animations.map((a) => a.name).join(','), '→ 播放', idle && idle.name)
  if (idle) state.setAnimation(0, idle, true)
  spineRuntime = {
    sig: atlasUrl + skelUrl,
    render: true,
    step () {
      const dt = 1 / 60
      state.update(dt)
      skeleton.updateWorldTransform(SPINE.Physics.update)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const offset = new SPINE.Vector2()
      const size = new SPINE.Vector2()
      skeleton.getBounds(offset, size, [])
      const s = Math.min(canvas.width / (size.x || 1), canvas.height / (size.y || 1)) * 0.95
      ctx.save()
      ctx.translate((canvas.width - (size.x || 0) * s) / 2 - (offset.x || 0) * s, canvas.height - 6)
      ctx.scale(s, s)
      const renderer = new SPINE.SkeletonRenderer(ctx)
      renderer.draw(skeleton)
      ctx.restore()
    }
  }
  if (!spineRuntime.raf) {
    const loop = () => { if (spineRuntime && spineRuntime.render) spineRuntime.step(); requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  }
}

/* ---------------- three.js + VRM（带轨道视角：拖动转视角、滚轮缩放） ---------------- */
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
  let yaw = 0
  let pitch = 0.12
  let dist = 2.1
  const targetY = 1.05
  function applyCam () {
    camera.position.set(
      dist * Math.sin(yaw) * Math.cos(pitch),
      targetY + dist * Math.sin(pitch),
      -dist * Math.cos(yaw) * Math.cos(pitch)
    )
    camera.lookAt(0, targetY, 0)
  }
  applyCam()
  scene.add(new THREE.DirectionalLight(0xffffff, Math.PI))
  // 视角捕捉：左键拖动转视角（不与窗口拖动冲突——canvas 上禁用 app-region）
  let drag = null
  canvas.style.webkitAppRegion = 'no-drag'
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId) })
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return
    yaw -= (e.clientX - drag.x) * 0.008
    pitch = Math.max(-0.4, Math.min(0.9, pitch + (e.clientY - drag.y) * 0.005))
    drag = { x: e.clientX, y: e.clientY }
    applyCam()
  })
  canvas.addEventListener('pointerup', () => { drag = null })
  canvas.addEventListener('wheel', (e) => {
    dist = Math.max(0.9, Math.min(4.5, dist + e.deltaY * 0.002))
    applyCam()
  }, { passive: true })
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
    vrm.update(clock.getDelta())
    renderer.render(scene, camera)
  }
  loop()
}

/* ---------------- 启动 ---------------- */
;(async () => {
  const init = await window.companion.init()
  await showVisual(init.characters[0])
  window.companion.onPetRefresh(async ({ char }) => {
    disposeSpine(); disposeVrm()
    await showVisual(char)
  })
})().catch((err) => { $('stageFallback').hidden = false; console.error('[pet boot]', err) })

$('btnPetClose').addEventListener('click', () => window.companion.petWin('close'))
