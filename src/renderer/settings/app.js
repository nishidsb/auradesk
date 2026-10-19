'use strict'
/* ============================================================
   AuraDesk 设置面板
   ============================================================ */

const api = window.auraSet

const PRESETS = [
  { id: 'sakura', name: '樱雾' },
  { id: 'twilight', name: '暮紫' },
  { id: 'abyss', name: '深海' },
  { id: 'noir', name: '极夜' },
  { id: 'paper', name: '素纸' }
]

let data = null
let view = { type: 'display', key: null }
let musicBusy = false
let smState = { open: false, items: [], sel: new Set(), q: '', busy: false }
let renameState = { open: false, id: null }

const $ = (s, root = document) => root.querySelector(s)
const $$ = (s, root = document) => [...root.querySelectorAll(s)]

function esc (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function cur () {
  return data.displays.find((d) => d.key === view.key) || data.displays[0]
}

/* ----------------------------------------------------------- 侧栏 */

function renderSide () {
  const list = $('#displayList')
  list.innerHTML = data.displays.map((d) => {
    const off = d.cfg.ui && d.cfg.ui.enabled === false
    return `
    <div class="disp-item ${view.type === 'display' && view.key === d.key ? 'active' : ''} ${off ? 'is-off' : ''}" data-key="${esc(d.key)}">
      <div class="mono" style="${d.cfg.wallpaper.type === 'image' ? 'background:url(' + esc(d.cfg.wallpaper.url || '') + ') center/cover;border-color:transparent' : ''}"></div>
      <div class="info">
        <div class="n">${esc(d.label)} ${d.primary && !d.label.includes('主屏') ? '<span class="badge-primary">主屏</span>' : ''}${off ? '<span class="badge-off">已隐藏</span>' : ''}</div>
        <div class="r">${d.width}×${d.height} · ${Math.round(d.scaleFactor * 100)}%</div>
      </div>
    </div>`
  }).join('')

  $$('.disp-item', list).forEach((item) => {
    item.addEventListener('click', () => {
      view = { type: 'display', key: item.dataset.key }
      renderSide(); renderMain()
    })
  })

  $$('#sideNav button').forEach((b) => {
    b.classList.toggle('active', view.type === b.dataset.view)
    b.onclick = () => { view = { type: b.dataset.view }; renderSide(); renderMain() }
  })
}

/* --------------------------------------------------------- 通用控件 */

function toggleRow (label, desc, checked, key) {
  return `<div class="row">
    <div><div class="t">${label}</div>${desc ? `<div class="d">${desc}</div>` : ''}</div>
    <label class="sw"><input type="checkbox" data-toggle="${key}" ${checked ? 'checked' : ''}><i></i></label>
  </div>`
}

function bindToggles (onDisplay) {
  $$('[data-toggle]').forEach((input) => {
    input.onchange = () => {
      const key = input.dataset.toggle
      const val = input.checked
      if (key.startsWith('__')) return onDisplay(key, val)
      if (!key.includes('.')) return onDisplay(key, val)
      const [group, field] = key.split('.')
      onDisplay(key, val, { [group]: { [field]: val } })
    }
  })
}

/* --------------------------------------------------------- 显示器面板 */

function renderDisplay () {
  const d = cur()
  if (!d) { $('#main').innerHTML = '<div class="empty-tip">没有检测到显示器</div>'; return }
  const cfg = d.cfg
  const wp = cfg.wallpaper
  const ui = cfg.ui
  const g = data.global

  const walls = `
    <div class="wall-chip ${wp.type === 'desktop' || wp.type === 'none' ? 'active' : ''}" data-preset="__desktop">
      <div class="thumb p-desktop"></div><div class="cap">跟随桌面</div>
    </div>` + PRESETS.map((p) => `
    <div class="wall-chip ${wp.type === 'preset' && wp.preset === p.id ? 'active' : ''}" data-preset="${p.id}">
      <div class="thumb p-${p.id}"></div><div class="cap">${p.name}</div>
    </div>`).join('') + `
    <div class="wall-chip custom ${wp.type === 'image' ? 'active' : ''}" data-preset="__custom">
      <div class="thumb" style="${wp.type === 'image' && wp.url ? `background-image:url(${esc(wp.url)})` : ''}">${wp.type === 'image' && wp.url ? '' : '＋'}</div>
      <div class="cap">本地图片</div>
    </div>`

  const isDesktopWall = wp.type === 'desktop' || wp.type === 'none'
  const railN = Number(ui.railRows) >= 3 ? Number(ui.railRows) : 4

  $('#main').innerHTML = `
    <h1>${esc(d.label)}${d.primary && !d.label.includes('主屏') ? ' · 主屏' : ''}</h1>
    <div class="sub">${d.width}×${d.height} · 缩放 ${Math.round(d.scaleFactor * 100)}% · 虚拟坐标 (${d.x}, ${d.y})<br>
      每块屏幕的组件和壁纸都是独立配置的，改完立刻生效。</div>

    <div class="card">
      <h2>在这块屏显示 <span class="hint">每块屏独立开关，主屏也能关掉</span></h2>
      ${toggleRow('显示 AuraDesk 桌面层', '关掉后这块屏完全不显示，连透明覆盖层都不建；想只在副屏用，就把主屏这个关掉', ui.enabled !== false, 'ui.enabled')}
      ${toggleRow('边缘任务条', '鼠标移到这块屏的上/下边缘滑出运行程序卡片（总开关与位置在「全局与快捷键」里）', ui.edgeBar !== false, 'ui.edgeBar')}
    </div>

    <div class="card">
      <h2>桌面层 <span class="hint">PS5 风格：左右两列常驻封面 + 内侧平台图标，点侧栏第一个图标铺开整页库</span></h2>
      ${toggleRow('侧边栏', '单侧图标条。副屏关掉这一项，就只在主屏出现', ui.showDock !== false, 'ui.showDock')}
      <div class="row">
        <div><div class="t">封面大小</div><div class="d">每栏几行，行数越少卡片越大（多的往下滚）</div></div>
        <div class="seg" id="railRows">
          <button data-rows="6" class="${railN === 6 ? 'on' : ''}">紧凑</button>
          <button data-rows="5" class="${railN === 5 ? 'on' : ''}">标准</button>
          <button data-rows="4" class="${railN === 4 ? 'on' : ''}">大</button>
        </div>
      </div>
      ${toggleRow('播放器（控制中心）', '显示 Listen1 当前曲目与进度', ui.showPlayer !== false, 'ui.showPlayer')}
      ${toggleRow('时钟', '右下角时间与日期', ui.showClock !== false, 'ui.showClock')}
      ${toggleRow('歌词', '本地 .lrc 优先，没有就按歌手 + 歌名联网找（Listen1 放的歌也有）', ui.showLyrics !== false, 'ui.showLyrics')}
      ${toggleRow('低配模式', '关掉模糊与动效，集显 / 多屏 4K 掉帧时打开', !!ui.lowFx, 'ui.lowFx')}
    </div>

    <div class="card">
      <h2>壁纸 <span class="hint">${isDesktopWall ? '当前不画壁纸，Wallpaper Engine 或系统壁纸原样透出' : '内置渐变不占显存，本地图片会按屏幕比例裁切'}</span></h2>
      <div class="walls" id="walls">${walls}</div>
      <div class="row"><div class="t">${isDesktopWall ? '边缘压暗' : '暗化程度'}<div class="d">${isDesktopWall ? '四周压暗、中间留亮，文字在任何壁纸上都读得清；拖到 0 就是完全不压，拖动时桌面立刻变化' : '整块壁纸压暗，提升前景对比'}</div></div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="range" id="sDim" min="0" max="0.6" step="0.02" value="${wp.dim}">
          <span class="val" id="vDim">${Math.round(wp.dim * 100)}%</span>
        </div>
      </div>
      <div class="row" style="display:${isDesktopWall ? 'none' : 'flex'}"><div class="t">模糊</div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="range" id="sBlur" min="0" max="24" step="1" value="${wp.blur || 0}">
          <span class="val" id="vBlur">${wp.blur || 0}px</span>
        </div>
      </div>
      <div class="row" style="display:${isDesktopWall ? 'none' : 'flex'}"><div class="t">放大裁切</div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="range" id="sScale" min="1" max="1.3" step="0.01" value="${wp.scale || 1.06}">
          <span class="val" id="vScale">${(wp.scale || 1.06).toFixed(2)}×</span>
        </div>
      </div>
      ${isDesktopWall ? '<div class="empty-tip" style="margin-top:8px">这一层是透明窗口，不挂 WorkerW、不接管桌面壁纸，所以和 Wallpaper Engine 的动态壁纸并存互不影响。</div>' : ''}
    </div>

    <div class="card">
      <h2>界面比例 <span class="hint">卡片、图标、播放器一起放大缩小，拖动即时生效；放大后侧栏放不下会自动滚动</span></h2>
      <div class="row"><div class="t">整体缩放<div class="d">以屏幕高度自动算出的比例为基准，再乘这个系数</div></div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="range" id="sUi" min="0.75" max="1.4" step="0.02" value="${ui.scale}">
          <span class="val" id="vUi">${Math.round(ui.scale * 100)}%</span>
        </div>
      </div>
    </div>
  `

  bindDisplay(d)
}

function bindDisplay (d) {
  const cfg = d.cfg
  const patch = (p, rerender) => api.patchDisplay(d.key, p).then(() => {
    Object.assign(cfg, p, {
      wallpaper: { ...cfg.wallpaper, ...(p.wallpaper || {}) },
      ui: { ...cfg.ui, ...(p.ui || {}) }
    })
    if (rerender) renderMain()
    // 侧栏的「已隐藏」标记要跟着本屏开关一起变
    if (p.ui && 'enabled' in p.ui) renderSide()
  })

  $$('#walls .wall-chip').forEach((chip) => {
    chip.onclick = async () => {
      const id = chip.dataset.preset
      if (id === '__desktop') {
        await patch({ wallpaper: { type: 'desktop', path: '' } }, true)
      } else if (id === '__custom') {
        const r = await api.pickWallpaper(d.key, 'image')
        if (r) { await refresh(); renderMain() }
      } else {
        await patch({ wallpaper: { type: 'preset', preset: id, path: '' } }, true)
      }
    }
  })

  $$('#railRows button').forEach((b) => {
    b.onclick = async () => {
      await patch({ ui: { railRows: Number(b.dataset.rows) } }, true)
    }
  })

  const slider = (id, vid, key, fmtFn) => {
    const s = $('#' + id)
    const v = $('#' + vid)
    if (!s) return
    s.oninput = () => {
      v.textContent = fmtFn(Number(s.value))
      const [group, field] = key.split('.')
      const payload = group === 'ui' ? { ui: { [field]: Number(s.value) } } : { wallpaper: { [field]: Number(s.value) } }
      clearTimeout(s._t)
      s._t = setTimeout(() => patch(payload), 60)
    }
  }
  slider('sDim', 'vDim', 'wallpaper.dim', (x) => Math.round(x * 100) + '%')
  slider('sBlur', 'vBlur', 'wallpaper.blur', (x) => x + 'px')
  slider('sScale', 'vScale', 'wallpaper.scale', (x) => x.toFixed(2) + '×')
  slider('sUi', 'vUi', 'ui.scale', (x) => Math.round(x * 100) + '%')

  bindToggles(async (key, val, payload) => {
    await patch(payload || { [key]: val })
  })
}

/* ----------------------------------------------------------- 资源库 */

function renderLibrary () {
  const lib = data.global.library
  const key = data.global.sgdbKey || ''
  const bySource = { steam: 0, epic: 0, startmenu: 0, other: 0 }
  for (const g of lib) {
    if (g.source === 'steam') bySource.steam++
    else if (g.source === 'epic') bySource.epic++
    else if (g.source === 'startmenu') bySource.startmenu++
    else bySource.other++
  }
  const missing = lib.filter((g) => !g.coverUrl).length

  $('#main').innerHTML = `
    <h1>资源库</h1>
    <div class="sub">不限平台：开始菜单里出现过的任何游戏（GOG / Ubisoft / EA / Battle.net / Riot / 米哈游 / 独立游戏）都能导入，Steam 与 Epic 另外做了深度扫描。</div>
    <div class="toolbar">
      <button class="btn primary" id="scanStart">从开始菜单导入…</button>
      <button class="btn" id="importSteam">导入 Steam 库</button>
      <button class="btn" id="importEpic">导入 Epic 库</button>
      <button class="btn" id="addExe">手动添加程序…</button>
      <button class="btn" id="scanDir">扫描游戏目录…</button>
      <span style="flex:1"></span>
      <span class="val" style="width:auto">${lib.length} 个 · 开始菜单 ${bySource.startmenu} / Steam ${bySource.steam} / Epic ${bySource.epic}</span>
    </div>

    <div class="card">
      <h2>封面 <span class="hint">先本地 Epic 缓存，再 Steam 商店，最后才用 SteamGridDB；前两条都不需要 Key</span></h2>
      <div class="row">
        <div>
          <div class="t">SteamGridDB API Key（可选）</div>
          <div class="d">只有前两条路都找不到时才用到。在 steamgriddb.com → Preferences → API 生成，只存本地</div>
        </div>
        <div style="display:flex;gap:6px">
          <input type="text" id="sgdbKey" placeholder="留空也能补大部分封面" value="${esc(key)}" style="width:220px">
          <button class="btn sm" id="saveKey">保存</button>
        </div>
      </div>
      <div class="toolbar" style="margin:12px 0 0">
        <button class="btn" id="fillCovers">补全 ${missing} 张缺失封面</button>
        <span class="val" id="importStatus" style="width:auto"></span>
      </div>
    </div>

    <div class="lib">
      ${lib.map((g) => {
        const cover = g.coverUrl
          ? `background-image:url(${esc(g.coverUrl)})`
          : `background:linear-gradient(150deg,hsl(${g.hue || 270} 62% 55%),hsl(${(g.hue || 270) + 40} 58% 32%))`
        const tag = g.source === 'steam' ? 'Steam' : g.source === 'epic' ? 'Epic' : g.source === 'startmenu' ? '开始菜单' : ''
        return `<div class="lib-row" data-id="${esc(g.id)}">
          <div class="lib-cover" style="${cover}">${g.coverUrl ? '' : esc((g.name || '?').slice(0, 1))}</div>
          <div class="lib-meta">
            <div class="lib-name">${esc(g.name)} ${tag ? `<span class="badge-primary">${tag}</span>` : ''}</div>
            <div class="lib-path">${esc(g.target)}</div>
          </div>
          <div class="lib-acts">
            <button class="btn sm" data-act="rename">改名</button>
            <button class="btn sm" data-act="cover">封面</button>
            <button class="btn sm danger" data-act="del">删除</button>
          </div>
        </div>`
      }).join('') || '<div class="empty-tip">还没有游戏</div>'}
    </div>

    ${smState.open ? startMenuModal() : ''}
    ${renameState.open ? renameModal() : ''}
  `

  const status = (t) => { const el = $('#importStatus'); if (el) el.textContent = t }

  $('#scanStart').onclick = openStartMenu
  $('#addExe').onclick = async () => {
    const added = await api.addGames()
    if (added) { await refresh(); renderMain() }
  }
  $('#scanDir').onclick = async () => {
    const added = await api.scanFolder()
    if (added) { await refresh(); renderMain() }
  }
  $('#importSteam').onclick = async () => {
    status('正在扫描 Steam 库…')
    const r = await api.importSteam()
    status(r.ok ? `Steam：扫描 ${r.scanned} 个，新增 ${r.added} 张` : 'Steam 导入失败：' + r.message)
    await refresh(); renderMain()
  }
  $('#importEpic').onclick = async () => {
    status('正在扫描 Epic…')
    const r = await api.importEpic()
    status(r.ok ? `Epic：扫描 ${r.scanned} 个，新增 ${r.added} 张（目录缓存 ${r.catalog} 条）` : 'Epic 导入失败：' + r.message)
    await refresh(); renderMain()
  }
  const keyInput = $('#sgdbKey')
  if (keyInput) $('#saveKey').onclick = async () => {
    await api.patchGlobal({ sgdbKey: keyInput.value.trim() })
    await refresh()
    status('Key 已保存')
  }
  $('#fillCovers').onclick = async () => {
    status('开始补全封面…')
    const r = await api.fillCovers()
    status(r.ok
      ? `封面：${r.filled}/${r.total}${r.noKey ? ` · 还有 ${r.total - r.filled} 张找不到，填 Key 可继续补` : ''}`
      : '失败：' + r.message)
    await refresh(); renderMain()
  }

  $$('#main .lib-row').forEach((row) => {
    const id = row.dataset.id
    $$('button', row).forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.act === 'del') {
          await api.removeGame(id); await refresh(); renderMain()
        } else if (b.dataset.act === 'cover') {
          const r = await api.setCover(id)
          if (r) { await refresh(); renderMain() }
        } else {
          openRename(id)
        }
      }
    })
  })

  if (smState.open) bindStartMenu()
  if (renameState.open) bindRename()
}

/* ------------------------------------------------------- 重命名弹窗 */

/* Electron 不支持 window.prompt()（调用即抛异常），改名必须用自建弹窗 */
function openRename (id) {
  renameState = { open: true, id }
  renderMain()
}

function renameModal () {
  const g = data.global.library.find((x) => x.id === renameState.id)
  return `<div class="modal" id="rnModal">
    <div class="modal-card">
      <header><b>重命名</b><span style="flex:1"></span><button class="btn sm" id="rnCancel">取消</button></header>
      <input type="text" id="rnInput" value="${esc(g ? g.name : '')}" placeholder="新的名字…">
      <footer>
        <span class="hint">回车确认 · Esc 取消</span>
        <button class="btn primary" id="rnOk">确定</button>
      </footer>
    </div>
  </div>`
}

function bindRename () {
  const input = $('#rnInput')
  if (input) {
    input.focus()
    input.select()
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmRename() }
      if (e.key === 'Escape') { e.preventDefault(); closeRename() }
    }
  }
  const ok = $('#rnOk')
  if (ok) ok.onclick = confirmRename
  const cancel = $('#rnCancel')
  if (cancel) cancel.onclick = closeRename
}

function closeRename () {
  renameState = { open: false, id: null }
  renderMain()
}

async function confirmRename () {
  const input = $('#rnInput')
  const name = input ? input.value.trim() : ''
  if (!name || !renameState.id) { closeRename(); return }
  await api.renameGame(renameState.id, name)
  renameState = { open: false, id: null }
  await refresh()
  renderMain()
}

/* ------------------------------------------- 开始菜单导入（弹层） */

function smFiltered () {
  const q = smState.q.toLowerCase()
  return smState.items.filter((g) => !q || g.name.toLowerCase().includes(q) || String(g.exe).toLowerCase().includes(q))
}

function smRowsHtml (list) {
  return list.map((g) => `
    <label class="sm-row ${smState.sel.has(g.id) ? 'on' : ''}" data-id="${esc(g.id)}">
      <input type="checkbox" ${smState.sel.has(g.id) ? 'checked' : ''}>
      <span class="sm-nm">${esc(g.name)}</span>
      <span class="sm-exe">${esc(String(g.exe).replace(/^.*\\/, ''))}</span>
    </label>`).join('')
}

/** 只刷新列表 + 计数 + 按钮态，绝不重建搜索框 —— 输入法组合期间替换/重聚焦输入框会把组字内容提交两次（字母翻倍 bug） */
function renderSmResults () {
  const listEl = $('#smList')
  if (listEl) {
    const list = smFiltered()
    listEl.innerHTML = list.length ? smRowsHtml(list) : '<div class="empty-tip" style="margin:16px">没有匹配项</div>'
    listEl.scrollTop = 0
  }
  const hint = $('#smHint')
  if (hint) hint.textContent = `${smState.items.length} 个可启动项 · 已选 ${smState.sel.size}`
  const imp = $('#smImport')
  if (imp) {
    imp.disabled = !smState.sel.size
    imp.textContent = `导入 ${smState.sel.size} 个`
  }
  bindSmRows()
}

function bindSmRows () {
  $$('#smList .sm-row').forEach((row) => {
    row.onclick = (e) => {
      e.preventDefault()
      const id = row.dataset.id
      if (smState.sel.has(id)) smState.sel.delete(id)
      else smState.sel.add(id)
      renderSmResults()
    }
  })
}

function startMenuModal () {
  const rows = smRowsHtml(smFiltered())

  return `<div class="modal" id="smModal">
    <div class="modal-card">
      <header>
        <b>从开始菜单导入</b>
        <span class="hint" id="smHint">${smState.items.length} 个可启动项 · 已选 ${smState.sel.size}</span>
        <span style="flex:1"></span>
        <button class="btn sm" id="smAll">全选</button>
        <button class="btn sm" id="smClose">取消</button>
      </header>
      <input type="text" id="smSearch" placeholder="搜索名字或 exe…" value="${esc(smState.q)}">
      <div class="sm-list" id="smList">${smState.busy ? '<div class="empty-tip" style="margin:16px">正在扫描开始菜单…</div>' : (rows || '<div class="empty-tip" style="margin:16px">没有匹配项</div>')}</div>
      <footer>
        <span class="hint">导入后会自动按名字去 Steam 商店和 Epic 缓存里找封面</span>
        <button class="btn primary" id="smImport" ${smState.sel.size ? '' : 'disabled'}>导入 ${smState.sel.size} 个</button>
      </footer>
    </div>
  </div>`
}

async function openStartMenu () {
  smState = { open: true, items: [], sel: new Set(), q: '', busy: true }
  renderMain()
  const modal = $('#smModal')
  if (modal) modal.classList.add('loading')
  const r = await api.scanStartMenu()
  if (!r.ok) {
    smState.open = false
    renderMain()
    const el = $('#importStatus')
    if (el) el.textContent = '扫描失败：' + r.message
    return
  }
  smState.items = r.items
  smState.busy = false
  renderMain()
}

function bindStartMenu () {
  const q = $('#smSearch')
  if (q) {
    q.oninput = () => {
      smState.q = q.value
      renderSmResults()
    }
  }
  bindSmRows()
  const all = $('#smAll')
  if (all) all.onclick = () => {
    const shown = smFiltered()
    const allOn = shown.length && shown.every((g) => smState.sel.has(g.id))
    for (const g of shown) {
      if (allOn) smState.sel.delete(g.id)
      else smState.sel.add(g.id)
    }
    renderSmResults()
  }
  const close = $('#smClose')
  if (close) close.onclick = () => { smState.open = false; renderMain() }
  const imp = $('#smImport')
  if (imp) imp.onclick = async () => {
    const ids = [...smState.sel]
    imp.disabled = true
    imp.textContent = '导入中…'
    const r = await api.importStartMenu(ids)
    smState.open = false
    await refresh()
    renderMain()
    const el = $('#importStatus')
    if (el) el.textContent = r.ok ? `已导入 ${r.added} 个，封面在后台慢慢补` : '导入失败：' + r.message
  }
}

/* ------------------------------------------------------------- 音乐 */

function renderMusic () {
  const g = data.global
  const src = g.musicSource || 'smtc'
  $('#main').innerHTML = `
    <h1>音乐</h1>
    <div class="sub">默认捕捉 Listen1：桌面层不自己发声，只把 Listen1 正在放的东西读出来显示。想换成本地文件也可以。</div>

    <div class="card">
      <h2>音源 <span class="hint">同时只有一个生效</span></h2>
      <div class="srcpick">
        <button class="src-opt ${src === 'smtc' ? 'on' : ''}" data-src="smtc">
          <b>Listen1（系统媒体会话）</b>
          <span>读当前曲目、封面、进度，播放/切歌/拖进度都转发给 Listen1。不需要插件，不会额外出声</span>
        </button>
        <button class="src-opt ${src === 'local' ? 'on' : ''}" data-src="local">
          <b>本地文件</b>
          <span>扫描目录自己播放，同名 .lrc 自动挂滚动歌词</span>
        </button>
      </div>
      <div class="row" style="display:${src === 'smtc' ? 'flex' : 'none'}" id="smtcRow">
        <div><div class="t">当前会话</div><div class="d" id="smtcNow">正在连接…</div></div>
        <span class="val" id="smtcState" style="width:auto"></span>
      </div>
    </div>

    ${src === 'local' ? `
    <div class="card">
      <h2>音乐目录</h2>
      ${g.musicFolders.map((f) => `<div class="row">
        <div><div class="t" style="font-size:12px">${esc(f)}</div></div>
        <button class="btn sm danger" data-folder="${esc(f)}">移除</button>
      </div>`).join('') || '<div class="empty-tip">还没有音乐目录</div>'}
      <div class="toolbar" style="margin-top:12px">
        <button class="btn primary" id="addMusic">添加目录…</button>
        <button class="btn" id="rescan" ${musicBusy ? 'disabled' : ''}>${musicBusy ? '扫描中…' : '重新扫描'}</button>
        <span class="val" id="musicProgress" style="width:auto">${g.tracks.length} 首</span>
      </div>
    </div>
    <div class="card">
      <h2>曲目 <span class="hint">先显示前 40 首</span></h2>
      <div class="lib">
        ${g.tracks.slice(0, 40).map((t) => `
          <div class="lib-row">
            <div class="lib-cover" style="${t.coverUrl ? `background-image:url(${esc(t.coverUrl)})` : 'background:linear-gradient(150deg,#6d5bd0,#332a52)'}"></div>
            <div class="lib-meta">
              <div class="lib-name">${esc(t.title)}</div>
              <div class="lib-path">${esc(t.artist || '未知艺术家')} · ${esc(t.album || '')}</div>
            </div>
            <div class="val" style="width:52px">${t.duration ? Math.floor(t.duration / 60) + ':' + String(t.duration % 60).padStart(2, '0') : '--:--'}</div>
          </div>`).join('') || '<div class="empty-tip">还没有扫描到曲目</div>'}
      </div>
    </div>` : `
    <div class="card">
      <h2>说明</h2>
      <div class="note">
        · 先打开 Listen1 并开始播放，桌面层会自动显示它当前的歌曲、封面和进度。<br>
        · 播放 / 上一首 / 下一首 / 拖动进度条都会转发给 Listen1 自己处理，不额外发声。<br>
        · 走的是 Windows 媒体会话（SMTC），同时开着浏览器看视频时优先选 Listen1 的会话。<br>
        · 副屏共用同一路数据，不会两屏同时出声。
      </div>
    </div>`}
  `

  const setSource = async (next) => {
    if (next === src) return
    await api.patchGlobal({ musicSource: next })
    await refresh()
    renderMain()
  }
  $$('.src-opt').forEach((b) => {
    b.onclick = () => setSource(b.dataset.src)
  })

  const addBtn = $('#addMusic')
  if (addBtn) {
    addBtn.onclick = async () => {
      const r = await api.addMusic()
      if (r) { await refresh(); renderMain(); $('#rescan').click() }
    }
    const rs = $('#rescan')
    rs.onclick = async () => {
      musicBusy = true
      renderMain()
      await api.scanMusic()
      musicBusy = false
      await refresh()
      renderMain()
    }
    $$('[data-folder]').forEach((b) => {
      b.onclick = async () => { await api.removeMusicFolder(b.dataset.folder); await refresh(); renderMain() }
    })
  }

  if (src === 'smtc') refreshSmtcStatus()
}

async function refreshSmtcStatus () {
  const st = await api.smtcStatus()
  const now = $('#smtcNow')
  const badge = $('#smtcState')
  if (!now) return
  if (st.error === 'winrt-unavailable') {
    now.textContent = '当前系统不支持 SMTC（需要 Windows 10 1809 以上）'
    if (badge) badge.textContent = ''
    return
  }
  if (!st.active) {
    now.textContent = st.ready ? '没有正在播放的会话，先在 Listen1 里放一首歌' : '正在连接媒体会话…'
    if (badge) badge.textContent = ''
    return
  }
  const app = String(st.appId || '').split('!')[0] || '未知应用'
  now.textContent = `${st.title}${st.artist ? ' · ' + st.artist : ''}`
  if (badge) badge.textContent = `${app} · ${st.playing ? '播放中' : '已暂停'}`
}

/* --------------------------------------------------------- 全局设置 */

function renderGlobal () {
  const g = data.global
  $('#main').innerHTML = `
    <h1>全局与快捷键</h1>
    <div class="sub">这些设置对所有屏幕生效。</div>
    <div class="card">
      <h2>启动与显示</h2>
      ${toggleRow('开机自动启动', '登录后静默启动覆盖层', g.autoLaunch, 'autoLaunch')}
      ${toggleRow('覆盖层强制置顶', '让 AuraDesk 盖在其它窗口之上（调试/直播时有用，平时建议关闭）', g.alwaysOnTop, 'alwaysOnTop')}
      ${toggleRow('边缘任务条', '总开关：鼠标移到屏幕边缘滑出所有运行中的窗口卡片，悬停预览、点击切换（每块屏的独立开关在「显示器」里）', g.edgeBarOn !== false, 'edgeBarOn')}
      ${toggleRow('边缘任务条在屏幕底部', '关闭时在屏幕顶部（默认）', !!g.edgeBarBottom, 'edgeBarBottom')}
      <div class="note">哪块屏显示 AuraDesk、哪块屏不显示，在左侧「显示器」里点进那块屏的「在这块屏显示」单独设置。</div>
    </div>
    <div class="card">
      <h2>快捷键</h2>
      <div class="row">
        <div><div class="t">显示 / 隐藏桌面层</div><div class="d">例如 <span class="kbd">Control+Alt+A</span></div></div>
        <div style="display:flex;gap:6px"><input type="text" id="hkToggle" value="${esc(g.hotkeyToggle)}"><button class="btn sm" data-hk="hotkeyToggle">保存</button></div>
      </div>
      <div class="row">
        <div><div class="t">打开设置</div><div class="d">例如 <span class="kbd">Control+Alt+S</span></div></div>
        <div style="display:flex;gap:6px"><input type="text" id="hkSettings" value="${esc(g.hotkeySettings)}"><button class="btn sm" data-hk="hotkeySettings">保存</button></div>
      </div>
    </div>
    <div class="card">
      <h2>行为说明</h2>
      <div class="note">
        · 覆盖层是一块无边框透明窗口，铺满整块屏幕，位于桌面图标之上、普通窗口之下。<br>
        · 空白处鼠标直接穿透到桌面，只有侧边栏 / 播放器 / 游戏库 / 时钟接收点击。<br>
        · 换分辨率、插拔显示器、切换缩放比例时会自动重建窗口，不需要重启。<br>
        · 退出：这里点「退出 AuraDesk」，或托盘右键退出。
      </div>
    </div>
  `

  bindToggles(async (key, val) => {
    await api.patchGlobal({ [key]: val })
    await refresh()
    renderMain()
  })
  $$('[data-hk]').forEach((b) => {
    b.onclick = async () => {
      const field = b.dataset.hk
      const val = $('#hk' + field.replace('hotkey', '')).value.trim()
      if (!val) return
      await api.patchGlobal({ [field]: val })
      await refresh()
      renderMain()
    }
  })
}

/* --------------------------------------------------------- AI 伴侣 */

async function renderCompanion () {
  let cs = {}
  try { cs = (await api.companionInit()).settings || {} } catch {}
  const inp = (id, label, desc, val, ph, type) => `
    <div class="row">
      <div><div class="t">${label}</div>${desc ? `<div class="d">${desc}</div>` : ''}</div>
      <input type="${type || 'text'}" id="${id}" value="${esc(val || '')}" placeholder="${esc(ph || '')}" style="width:300px">
    </div>`
  $('#main').innerHTML = `
    <h1>AI 伴侣</h1>
    <div class="sub">恋爱级 AI + 贾维斯式助手：聊天、执行桌面任务、语音对话。点 Dock 上的对话图标或托盘菜单打开。</div>
    <div class="card">
      <h2>AI 服务（OpenAI 兼容 API）</h2>
      ${inp('cpApiBase', 'API 地址', 'OpenAI 兼容端点；本地模型如 Ollama 填 http://127.0.0.1:11434/v1', cs.apiBaseUrl, 'https://api.example.com/v1')}
      ${inp('cpApiKey', 'API Key', '本地模型一般留空', cs.apiKey, 'sk-…', 'password')}
      <div class="row">
        <div><div class="t">模型</div><div class="d">可手动填写，或点「获取模型列表」自动拉取</div></div>
        <div style="display:flex;gap:6px">
          <input type="text" id="cpApiModel" value="${esc(cs.apiModel || '')}" placeholder="gpt-4o-mini / qwen2.5:7b" style="width:220px">
          <button class="btn sm" id="cpFetchModels">获取模型列表</button>
        </div>
      </div>
      <div class="row">
        <div><div class="t">允许 AI 截屏看桌面</div><div class="d">开启后 AI 可以用「看屏幕」工具截取桌面画面来回答（需支持视觉的模型，如 gpt-4o / qwen-vl / glm-4v；纯文本模型会失败）</div></div>
        <label class="sw"><input type="checkbox" id="cpVision" ${cs.visionOn !== false ? 'checked' : ''}><i></i></label>
      </div>
      <div class="note">配置好后 Dock 的 AI 伴侣就能聊天；它会用工具帮你看时间、切窗口、启动卡片里的程序、调音量，也能截屏看你的桌面。</div>
    </div>
    <div class="card">
      <h2>语音合成（TTS · 朗读 AI 回复）</h2>
      <div class="row">
        <div><div class="t">合成方式</div><div class="d">系统语音免费但较机械；API 模式可接云端或本地引擎</div></div>
        <select id="cpTtsMode" style="width:160px">
          <option value="browser" ${cs.ttsMode !== 'api' && cs.ttsMode !== 'off' ? 'selected' : ''}>系统语音</option>
          <option value="api" ${cs.ttsMode === 'api' ? 'selected' : ''}>API / 本地引擎</option>
          <option value="off" ${cs.ttsMode === 'off' ? 'selected' : ''}>关闭</option>
        </select>
      </div>
      <div class="row">
        <div><div class="t">引擎类型</div><div class="d">OpenAI 兼容：Fish Audio 云（api.fish.audio/v1，voice 填 reference_id）、本地 fish-speech / IndexTTS；GPT-SoVITS：本地 api_v2（默认端口 9880）</div></div>
        <select id="cpTtsProvider" style="width:160px">
          <option value="openai" ${(cs.ttsProvider || 'openai') === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
          <option value="gptsovits" ${cs.ttsProvider === 'gptsovits' ? 'selected' : ''}>GPT-SoVITS</option>
        </select>
      </div>
      ${inp('cpTtsBase', 'TTS 地址（可选）', '留空则复用上面的 API 地址；GPT-SoVITS 填 http://127.0.0.1:9880', cs.ttsBaseUrl, 'http://127.0.0.1:9880')}
      ${inp('cpTtsModel', 'TTS 模型', 'OpenAI 兼容端点用；Fish Audio 填 s1', cs.ttsModel, 'tts-1')}
      ${inp('cpTtsKey', 'TTS Key（可选）', '留空则复用上面的 API Key', cs.ttsApiKey, '', 'password')}
      ${inp('cpTtsRefAudio', '参考音频路径（GPT-SoVITS）', '服务端能访问到的 wav 路径，用于音色克隆', cs.ttsRefAudio, 'D:/tts/ref.wav')}
      ${inp('cpTtsTextLang', '文本语言（GPT-SoVITS）', '', cs.ttsTextLang || 'zh', 'zh')}
      ${inp('cpTtsPromptText', '参考音频文本（GPT-SoVITS）', '参考音频里说的话，提升克隆质量', cs.ttsPromptText, '')}
      ${inp('cpTtsPromptLang', '参考音频语言（GPT-SoVITS）', '', cs.ttsPromptLang || 'zh', 'zh')}
    </div>
    <div class="card">
      <h2>语音识别（ASR · 按住 🎙 说话）</h2>
      ${inp('cpAsrBase', '识别端点', 'Whisper 兼容 /audio/transcriptions（Groq、faster-whisper-server 等均可）', cs.asrBaseUrl, 'https://api.example.com/v1')}
      ${inp('cpAsrModel', 'ASR 模型', '', cs.asrModel, 'whisper-1')}
      ${inp('cpAsrKey', 'ASR Key（可选）', '留空则复用上面的 API Key', cs.asrApiKey, '', 'password')}
      <div class="note">角色立绘 / Spine / 3D 模型 / 世界书 / 人设，在 AI 伴侣窗口右上角「角色」里编辑。</div>
    </div>
  `
  const gather = () => ({
    apiBaseUrl: $('#cpApiBase').value.trim(),
    apiKey: $('#cpApiKey').value.trim(),
    apiModel: $('#cpApiModel').value.trim(),
    visionOn: $('#cpVision') ? $('#cpVision').checked : true,
    ttsMode: $('#cpTtsMode').value,
    ttsProvider: $('#cpTtsProvider').value,
    ttsBaseUrl: $('#cpTtsBase').value.trim(),
    ttsModel: $('#cpTtsModel').value.trim(),
    ttsApiKey: $('#cpTtsKey').value.trim(),
    ttsRefAudio: $('#cpTtsRefAudio').value.trim(),
    ttsTextLang: $('#cpTtsTextLang').value.trim() || 'zh',
    ttsPromptText: $('#cpTtsPromptText').value.trim(),
    ttsPromptLang: $('#cpTtsPromptLang').value.trim() || 'zh',
    asrBaseUrl: $('#cpAsrBase').value.trim(),
    asrModel: $('#cpAsrModel').value.trim(),
    asrApiKey: $('#cpAsrKey').value.trim()
  })
  const save = async () => { await api.companionPatch(gather()) }
  // 每次重渲染 #main 的 innerHTML 都会重建，监听挂在具体输入上避免叠加
  $$('#main input, #main select').forEach((el) => { el.onchange = save })
  $('#cpFetchModels').onclick = async () => {
    await save()
    const btn = $('#cpFetchModels')
    btn.textContent = '获取中…'
    let models = []
    try { models = await api.companionModels($('#cpApiBase').value.trim(), $('#cpApiKey').value.trim()) } catch {}
    const sel = $('#cpApiModel')
    if (Array.isArray(models) && models.length) {
      const cur = sel.value
      sel.innerHTML = models.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('')
      btn.textContent = '已载入 ' + models.length + ' 个'
    } else {
      btn.textContent = '拉取失败（检查地址/网络）'
    }
    setTimeout(() => { btn.textContent = '获取模型列表' }, 2500)
  }
}

/* ------------------------------------------------------------- 渲染 */

function renderMain () {
  if (!data) return
  if (view.type === 'display') renderDisplay()
  else if (view.type === 'library') renderLibrary()
  else if (view.type === 'music') renderMusic()
  else if (view.type === 'companion') renderCompanion()
  else renderGlobal()
}

async function refresh () {
  const k = view.key
  data = await api.init()
  if (!data.displays.find((d) => d.key === k)) {
    view.key = (data.displays.find((d) => d.primary) || data.displays[0] || {}).key || null
  }
  renderSide()
}

/* ------------------------------------------------------------- 启动 */

async function boot () {
  await refresh()
  if (!view.key) view.key = (data.displays.find((d) => d.primary) || data.displays[0] || {}).key
  renderSide()
  renderMain()

  $('#minBtn').onclick = () => api.window('min')
  $('#closeBtn').onclick = () => api.window('close')
  $('#openData').onclick = () => api.openUserData()
  $('#quitBtn').onclick = () => api.quit()

  api.onRefresh(() => { refresh().then(renderMain) })
  api.onMusicProgress((p) => {
    const el = $('#musicProgress')
    if (el) el.textContent = `扫描 ${p.done}/${p.total}`
  })
  api.onImportProgress((p) => {
    const el = $('#importStatus')
    if (!el) return
    if (p.kind === 'steam') el.textContent = `Steam 封面 ${p.done}/${p.total} · ${p.name}`
    else if (p.kind === 'covers') el.textContent = `封面 ${p.done}/${p.total} · ${p.name}`
  })
  api.onSmtc(() => {
    if (view.type === 'music') refreshSmtcStatus()
  })
}

boot()
