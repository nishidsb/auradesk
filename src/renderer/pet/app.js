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
  // 切出该模式才释放；同模式刷新交给 showSpine/showVrm 内部的 sig 判断跳过
  if (mode !== 'spine') disposeSpine()
  if (mode !== 'vrm') disposeVrm()
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
  console.warn('[pet spine] 骨架版本', ver || '未知', '→ 运行时', SPINE === libs.SPINE ? '4.3（兜底）' : ver)
  const canvas = $('spineCanvas')
  const scale = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * scale
  canvas.height = canvas.clientHeight * scale
  const ctx = canvas.getContext('2d')
  // spine-canvas 4.3 构造签名是 (pathPrefix, downloader)——没有 ctx 参数
  const assetManager = new SPINE.AssetManager(atlasUrl.replace(/[^/]*$/, ''))
  // 贴图页预转 dataURL（绕开 Image+crossOrigin 对自定义协议的 CORS 拦截），同 companion 窗口
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
      } catch (e) { console.warn('[pet spine] 预载贴图失败', name, e.message) }
    }
  } catch (e) { console.warn('[pet spine] atlas 预读失败', e.message) }
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
  // 附件可能挂在命名皮肤里：default skin 为空 → 骨骼照常摆位但画不出任何东西
  const skins = skeletonData.skins || []
  console.warn('[pet spine] 皮肤列表:', skins.map((s) => s.name).join(',') || '(无)')
  if (skins.length) {
    const pick = skins.find((s) => /default|base|normal/i.test(s.name)) || skins[skins.length - 1]
    skeleton.setSkin(skins.length > 1 ? pick : skins[0])
    skeleton.setSlotsToSetupPose()
    console.warn('[pet spine] 使用皮肤:', pick.name)
  }
  console.warn('[pet spine] 槽位附件:', skeleton.slots.filter((sl) => sl.getAttachment()).length + '/' + skeleton.slots.length)
  // 所有 4.x 的 AnimationState 构造参数都是 AnimationStateData（不是 SkeletonData），
  // 传错会让 setAnimation 一调就报 Cannot read properties of undefined (reading 'findAnimation')
  const state = new SPINE.AnimationState(new SPINE.AnimationStateData(skeletonData))
  const idle = skeletonData.animations.find((a) => /idle|待机/i.test(a.name)) || skeletonData.animations[0]
  console.warn('[pet spine] 加载成功: 动画', skeletonData.animations.map((a) => a.name).join(','), '→ 播放', idle && idle.name)
  // 4.0/4.1/4.2 的 setAnimation 只认动画名字符串，统一传名字
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
      const offset = new SPINE.Vector2()
      const size = new SPINE.Vector2()
      skeleton.getBounds(offset, size, [])
      const s = Math.min(canvas.width / (size.x || 1), canvas.height / (size.y || 1)) * 0.95
      if (firstFrame) {
        firstFrame = false
        console.warn('[pet spine] 首帧: canvas', canvas.width + 'x' + canvas.height, 'bounds', Math.round(offset.x) + ',' + Math.round(offset.y), Math.round(size.x) + 'x' + Math.round(size.y), 'scale', s.toFixed(3))
        // 0.6s 后统计不透明像素 + dump 整帧到日志目录，判定 canvas 是否真有内容
        setTimeout(() => {
          try {
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            let n = 0
            for (let i = 3; i < img.length; i += 40) if (img[i] > 0) n++
            console.warn('[pet spine] 不透明像素抽样:', n, '/', Math.floor(img.length / 40))
            if (window.companion.logImage) window.companion.logImage('spine-pet.png', canvas.toDataURL('image/png'))
          } catch (e) { console.warn('[pet spine] dump 失败', e.message) }
        }, 600)
      }
      ctx.save()
      // spine 世界坐标 y 向上、canvas y 向下：必须 scale(s, -s) 翻转 y 并把 bounds
      // 底边对到画布底部——不翻转会整只画到画布上方之外（无异常但画面空白）
      ctx.translate((canvas.width - size.x * s) / 2 - offset.x * s, canvas.height - 6 + offset.y * s)
      ctx.scale(s, -s)
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
    // 不强制 dispose：sig 相同则 showSpine 直接跳过，避免整窗资源反复重载
    await showVisual(char)
  })
})().catch((err) => { $('stageFallback').hidden = false; console.error('[pet boot]', err) })

$('btnPetClose').addEventListener('click', () => window.companion.petWin('close'))
