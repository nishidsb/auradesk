'use strict'
/* 打包 AI 伴侣渲染层用的第三方库（three + three-vrm + spine-canvas）
   产物 src/renderer/companion/libs.js（IIFE，暴露 window.AuraLibs）
   用法: node tools/build-companion-libs.js */
const esbuild = require('esbuild')
const path = require('path')

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'companion-libs-entry.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: true,
  outfile: path.join(__dirname, '..', 'src', 'renderer', 'companion', 'libs.js'),
  logLevel: 'info'
})
