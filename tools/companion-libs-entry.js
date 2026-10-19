// AI 伴侣渲染层第三方库打包入口：three + three-vrm + spine-canvas
// 由 tools/build-companion-libs.js 打成 IIFE，暴露 window.AuraLibs
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREEVRM from '@pixiv/three-vrm'
import * as SPINE from '@esotericsoftware/spine-canvas'

window.AuraLibs = { THREE, GLTFLoader, THREEVRM, SPINE }
