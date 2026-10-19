'use strict'
/* Git Data API 应急推送：代理 502 时用 REST API 重建远端 main + tag
   用法: node tools/api-push.js <tag> */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const TOKEN = process.env.GH_TOKEN || fs.readFileSync(process.env.GH_TOKEN_FILE || '/tmp/ghtoken.txt', 'utf8').trim()
const REPO = 'nishidsb/auradesk'
const TAG = process.argv[2] || 'v0.2.1'
const ROOT = path.join(__dirname, '..')

const api = (ep, method, body, raw) => {
  const res = execSync(
    `curl -s -X ${method} -H "Authorization: token ${TOKEN}" -H "Content-Type: application/json" ` +
    `${raw ? '-H "Accept: application/vnd.github.raw"' : ''} -d @- "https://api.github.com${ep}"`,
    { input: body ? JSON.stringify(body) : undefined, maxBuffer: 1024 * 1024 * 64 }
  )
  return raw ? res.toString() : JSON.parse(res.toString() || '{}')
}

async function main () {
  const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')
  console.log('files:', files.length)
  const tree = []
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ROOT, f))
    const blob = api('/repos/' + REPO + '/git/blobs', 'POST', {
      content: buf.toString('base64'), encoding: 'base64'
    })
    if (!blob.sha) throw new Error('blob 失败: ' + f)
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha })
    process.stdout.write('.')
  }
  console.log('\nblobs 完成')
  const t = api('/repos/' + REPO + '/git/trees', 'POST', { tree })
  if (!t.sha) throw new Error('tree 失败')
  const msg = execSync('git log -1 --pretty=%B', { cwd: ROOT, encoding: 'utf8' })
  const c = api('/repos/' + REPO + '/git/commits', 'POST', {
    message: msg.trim(), tree: t.sha
  })
  if (!c.sha) throw new Error('commit 失败')
  const r = api('/repos/' + REPO + '/git/refs/heads/main', 'PATCH', { sha: c.sha, force: true })
  if (!r.object) throw new Error('ref 失败: ' + JSON.stringify(r).slice(0, 200))
  console.log('main ->', c.sha)
  // tag ref（轻量 tag 指向 commit）
  const tr = api('/repos/' + REPO + '/git/refs', 'POST', { ref: 'refs/tags/' + TAG, sha: c.sha })
  if (tr.object) console.log(TAG + ' ->', tr.object.sha)
  else {
    // 已存在则强制更新
    const tr2 = api('/repos/' + REPO + '/git/refs/tags/' + TAG, 'PATCH', { sha: c.sha, force: true })
    console.log(TAG + ' (update) ->', tr2.object && tr2.object.sha)
  }
  console.log('DONE')
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
