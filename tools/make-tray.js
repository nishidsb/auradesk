/**
 * 生成托盘 / 应用图标（纯 Node 手写 PNG，不依赖任何图像库）
 * node tools/make-tray.js
 *
 * 图案：圆角方形（紫渐变）+ 白色唱片环 + 中心点，16px 下也能认出是「播放/音乐」。
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG (w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const mix = (a, b, t) => a + (b - a) * t

function draw (size) {
  const S = size
  const buf = Buffer.alloc(S * S * 4)
  const radius = S * 0.235
  const inset = S * 0.045
  const ringR = S * 0.255
  const ringW = S * 0.072
  const dotR = S * 0.075
  const C = S / 2

  const roundedCoverage = (x, y) => {
    // 圆角方形的有符号距离，4×4 超采样做抗锯齿
    let hit = 0
    const N = 4
    for (let sy = 0; sy < N; sy++) {
      for (let sx = 0; sx < N; sx++) {
        const px = x + (sx + 0.5) / N
        const py = y + (sy + 0.5) / N
        const qx = Math.abs(px - C) - (S / 2 - inset - radius)
        const qy = Math.abs(py - C) - (S / 2 - inset - radius)
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
        if (d <= 0) hit++
      }
    }
    return hit / (N * N)
  }

  const circleCoverage = (x, y, cx, cy, r) => {
    let hit = 0
    const N = 4
    for (let sy = 0; sy < N; sy++) {
      for (let sx = 0; sx < N; sx++) {
        const px = x + (sx + 0.5) / N
        const py = y + (sy + 0.5) / N
        if (Math.hypot(px - cx, py - cy) <= r) hit++
      }
    }
    return hit / (N * N)
  }

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const base = roundedCoverage(x, y)
      if (base <= 0) continue

      const t = (x / S) * 0.35 + (y / S) * 0.65
      let r = mix(206, 108, t)
      let g = mix(168, 66, t)
      let b = mix(255, 214, t)

      // 唱片环
      const dRing = Math.abs(Math.hypot(x + 0.5 - C, y + 0.5 - C) - ringR)
      const ring = circleCoverage(x, y, C, C, ringR + ringW / 2) - circleCoverage(x, y, C, C, ringR - ringW / 2)
      const ringA = Math.max(0, Math.min(1, 1 - (dRing - ringW / 2) / 1.2)) * (ring > 0.1 ? 1 : ring * 10)
      const dot = circleCoverage(x, y, C, C, dotR)

      const white = Math.min(1, ringA * 0.95 + dot * 0.98)
      r = mix(r, 255, white)
      g = mix(g, 255, white)
      b = mix(b, 255, white)

      const i = (y * S + x) * 4
      buf[i] = Math.round(r)
      buf[i + 1] = Math.round(g)
      buf[i + 2] = Math.round(b)
      buf[i + 3] = Math.round(base * 255)
    }
  }
  return encodePNG(S, S, buf)
}

const outDir = path.resolve(__dirname, '..', 'src', 'main', 'resources')
fs.mkdirSync(outDir, { recursive: true })
for (const size of [16, 32, 64, 256]) {
  const file = path.join(outDir, size === 256 ? 'icon.png' : `tray-${size}.png`)
  fs.writeFileSync(file, draw(size))
  console.log('wrote', path.relative(process.cwd(), file), size + 'x' + size)
}
