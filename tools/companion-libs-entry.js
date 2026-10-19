// AI 伴侣渲染层第三方库打包入口：three + three-vrm + spine-canvas 多版本
// 由 tools/build-companion-libs.js 打成 IIFE，暴露 window.AuraLibs
// Spine 运行时严格锁版本（4.x 运行时读不了 4.y 导出的骨架），所以带上
// 4.0/4.1/4.2/4.3 四套，渲染层按骨架文件头部的版本号自动选择。
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREEVRM from '@pixiv/three-vrm'
import * as SPINE43 from '@esotericsoftware/spine-canvas'
import * as SPINE42 from 'spine-canvas-42'
import * as SPINE41 from 'spine-canvas-41'
import * as SPINE40 from 'spine-canvas-40'

window.AuraLibs = {
  THREE,
  GLTFLoader,
  THREEVRM,
  SPINE: SPINE43,
  AuraSpine: { '4.3': SPINE43, '4.2': SPINE42, '4.1': SPINE41, '4.0': SPINE40 }
}
