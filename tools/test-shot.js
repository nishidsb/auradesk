'use strict'
/* assistant.ps1 shot 指令实测：scan 找一个可见窗口 -> PrintWindow 截图 -> 校验 PNG
   用法: node tools/test-shot.js */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const PS = path.join(__dirname, '..', 'src', 'main', 'resources', 'assistant.ps1')
const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS], { windowsHide: true })

let buf = ''
const waiters = [] // { match, resolve }
const queue = []
p.stdout.setEncoding('utf8')
p.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line.startsWith('{')) continue
    let msg = null
    try { msg = JSON.parse(line) } catch { continue }
    const w = waiters.find((x) => x.match(msg))
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg) } else queue.push(msg)
  }
})
p.stderr.on('data', (d) => console.error('[stderr]', String(d).trim()))

function ask (line, match) {
  return new Promise((resolve) => {
    const idx = queue.findIndex((m) => match(m))
    if (idx >= 0) { resolve(queue.splice(idx, 1)[0]); return }
    waiters.push({ match, resolve })
    p.stdin.write(line + '\n')
  })
}

async function main () {
  const scan = await ask('scan', (m) => m.type === 'windows')
  // 只挑足够大的可见窗口（太小的窗口 PNG 校验过不了）
  const win = scan.list.find((w) => !w.min && Array.isArray(w.r) && w.r[2] > 400 && w.r[3] > 300)
  if (!win) { console.log('SKIP 没有可见窗口'); p.stdin.write('quit\n'); return }
  console.log('目标窗口:', win.h, JSON.stringify(win.t).slice(0, 60))

  const out = path.join(os.tmpdir(), `auradesk-shot-test-${Date.now()}.png`)
  const shot = await ask(`shot ${win.h} ${out} req1`, (m) => m.type === 'shot' && m.id === 'req1')
  console.log('shot 回复:', JSON.stringify(shot).slice(0, 200))

  let ok = false
  if (shot.ok && shot.path) {
    const st = fs.statSync(shot.path)
    const head = fs.readFileSync(shot.path).slice(0, 8)
    ok = st.size > 1000 && head.slice(1, 4).toString() === 'PNG'
    console.log(`PNG 校验: size=${st.size} magic=${head.slice(1, 4).toString()}`)
    // 最小化预览缓存：每次成功 shot 都应同步留一份 last 帧
    const lastFile = path.join(path.dirname(shot.path), `last-w${win.h}.png`)
    const hasLast = fs.existsSync(lastFile) && fs.statSync(lastFile).size > 1000
    console.log('最后画面缓存:', hasLast ? 'OK' : '缺失')
    ok = ok && hasLast
    fs.rmSync(shot.path, { force: true })
    if (hasLast) fs.rmSync(lastFile, { force: true })
  }
  // 无效 hwnd 应返回 ok:false 而不是挂死
  const bad = await ask('shot 999999 C:\\Windows\\Temp\\aura-none.png req2', (m) => m.type === 'shot' && m.id === 'req2')
  console.log('无效 hwnd 回复:', JSON.stringify(bad))

  p.stdin.write('quit\n')
  if (!ok) process.exit(1)
  console.log('PASS')
}

main().catch((e) => { console.error('FAIL', e); p.kill(); process.exit(1) })
