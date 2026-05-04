import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import * as THREE from 'three'
import defaultIglooSceneControls from '../igloo-scene-controls.json'
import './IglooPage.css'

const IGLOO_PATH = '/igloo.drc'
const GROUND_PATH = '/ground.drc'
const MOUNTAIN_PATH = '/mountain.drc'
const IGLOO_BASE_TEXTURE_PATH = '/igloo_color.ktx2'
const IGLOO_EXPLODED_TEXTURE_PATH = '/igloo_exploded_color.ktx2'
const GROUND_COLOR_TEXTURE_PATH = '/ground_color.ktx2'
const GROUND_GLOW_TEXTURE_PATH = '/ground_glow.ktx2'
const MOUNTAIN_COLOR_TEXTURE_PATH = '/mountain_color.ktx2'
const DECODER_PATH = '/draco/'
const HOVER_DISTANCE_RATIO = 0.55
const HOVER_RADIUS_RATIO = 0.4
const BOTTOM_LOCK_HEIGHT_RATIO = 0.1
const GLOW_SCREEN_RADIUS_NDC = 0.32
const POINTER_CENTER_NDC_RADIUS = 0.64
const HOVER_WORLD_NEAR = 0.16
const HOVER_WORLD_FAR = 1.15
const HOVER_SCREEN_NEAR = 0.015
const HOVER_SCREEN_FAR = 0.11
const WELD_EPSILON_RATIO = 0
const INNER_LIGHT_BASE = 1.25
const INNER_LIGHT_BOOST = 3.5
const SHADER_GLOW_GAIN = 1.2
const STORAGE_KEY = 'igloo-scene-controls'
const GROUND_SCALE_MULTIPLIER = 2.6
const DEFAULT_TRANSFORM = {
  x: 0,
  y: 0,
  z: 0,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  scale: 1,
}
const DEFAULT_GROUND_TRANSFORM = {
  x: 0,
  y: 0,
  z: 0,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  scale: GROUND_SCALE_MULTIPLIER,
}
const DEFAULT_MOUNTAIN_TRANSFORM = {
  x: 0,
  y: -0.6,
  z: -18,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  scale: 10,
}
const DEFAULT_CAMERA = {
  x: 1.8,
  y: 1.2,
  z: 2.4,
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  fov: 42,
  swayX: 0.05,
  swayY: 0.03,
  swayLerp: 0.14,
}
const DEFAULT_INTERACTION = {
  pointerCenterNdcRadius: POINTER_CENTER_NDC_RADIUS,
  hoverWorldNear: HOVER_WORLD_NEAR,
  hoverWorldFar: HOVER_WORLD_FAR,
  hoverScreenNear: HOVER_SCREEN_NEAR,
  hoverScreenFar: HOVER_SCREEN_FAR,
  baseDisplacement: 0.26,
  hoverWorldBase: 0.46,
  hoverWorldAmp: 0.22,
  hoverScreenBase: 0.62,
  hoverScreenAmp: 0.28,
  displacementScale: 1,
  yMaskBase: 0.55,
  yMaskTop: 0.45,
}

const smoothstep = (edge0, edge1, x) => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

const fit = (x, inMin, inMax, outMin, outMax) => {
  if (inMax === inMin) return outMin
  const t = (x - inMin) / (inMax - inMin)
  return outMin + t * (outMax - outMin)
}

const lerpFps = (current, target, factor, delta) => {
  const clamped = THREE.MathUtils.clamp(factor, 0, 1)
  const alpha = 1 - Math.pow(1 - clamped, delta * 60)
  return THREE.MathUtils.lerp(current, target, alpha)
}

const seededVec3 = (seed) => {
  const sx = Math.sin(seed * 123.4567) * 43758.5453
  const sy = Math.sin((seed + 1) * 678.9123) * 19642.349
  const sz = Math.sin((seed + 2) * 345.6789) * 12345.678
  return new THREE.Vector3(
    sx - Math.floor(sx),
    sy - Math.floor(sy),
    sz - Math.floor(sz),
  )
}

const IGLOO_VERTEX_SHADER = `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const IGLOO_FRAGMENT_SHADER = `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  uniform sampler2D tMap;
  uniform sampler2D tMapExploded;
  uniform float uDisplacement;
  uniform float uGlowStrength;
  uniform float uTime;
  uniform vec3 uGlowColor;
  uniform vec3 uCenter;
  uniform vec3 uDoorCenter;
  uniform float uDoorBlend;
  uniform float uDebugTunnel;

  void main() {
    vec3 baseTex = texture2D(tMap, vUv).rgb;
    vec3 explodedTex = texture2D(tMapExploded, vUv).rgb;
    float baseLuma = dot(baseTex, vec3(0.299, 0.587, 0.114));
    float explodedLuma = dot(explodedTex, vec3(0.299, 0.587, 0.114));
    vec3 colorBase = mix(vec3(baseLuma), baseTex, 0.58) * 1.02;
    vec3 colorExploded = mix(vec3(explodedLuma), explodedTex, 0.58) * 1.02 + vec3(0.012);
    float textureMix = clamp(5.0 * uDisplacement, 0.0, 1.0);
    vec3 color = mix(colorBase, colorExploded, textureMix);

    vec3 local = vWorldPos - uCenter;
    vec3 centerDir = normalize(local);
    float nd = dot(normalize(vWorldNormal), centerDir);
    float insideToOutside = clamp((-nd * 0.5) + 0.5, 0.0, 1.0);
    float insideSmooth = smoothstep(0.0, 1.0, insideToOutside);
    float insideBias = pow(insideSmooth, 0.82);
    float pulse = 0.82 + 0.18 * sin(uTime * 1.5 + vWorldPos.x * 0.7 - vWorldPos.z * 0.4);
    float radial = length(local.xz);
    float radialFalloff = 1.0 - smoothstep(0.25, 1.7, radial);
    float radialFalloffWide = 1.0 - smoothstep(0.25, 2.9, radial);
    float radialMix = mix(radialFalloffWide, radialFalloff, insideSmooth);
    float verticalFalloff = smoothstep(-0.45, 1.4, local.y);
    float cavityBias = max(0.0, smoothstep(0.0, 2.0, local.x * 0.5 - local.z * 0.5));

    float orientationGlow = mix(0.42, 1.08, insideBias);
    float baseGlow = orientationGlow *
      (0.4 + 0.6 * radialMix) *
      (0.45 + 0.55 * verticalFalloff) *
      (0.75 + 0.25 * cavityBias);
    float glowMask = clamp(mix(0.35, 1.0, insideSmooth), 0.0, 1.0);
    float hoverBoost = smoothstep(0.08, 1.0, uGlowStrength) * 0.65;
    float hoverInsideMask = mix(0.2, 1.0, pow(insideSmooth, 1.25));
    float glow = (baseGlow + baseGlow * hoverBoost * hoverInsideMask) * pulse;
    float idleInner = glowMask * radialFalloffWide * 0.06;

    color += uGlowColor * idleInner;
    color += uGlowColor * glow * ${SHADER_GLOW_GAIN.toFixed(2)};

    if (uDebugTunnel > 0.5) {
      float tunnelMask = clamp(uDoorBlend, 0.0, 1.0);
      vec3 nonTunnel = color * 0.18;
      vec3 tunnelTint = mix(color, vec3(1.0, 0.35, 0.15), 0.75);
      color = mix(nonTunnel, tunnelTint, tunnelMask);
    }

    color = clamp(color, vec3(0.0), vec3(2.0));
    gl_FragColor = vec4(color, 1.0);
  }
`

const detectTunnelPieces = (components) => {
  if (!components.length) {
    return {
      tunnelIds: new Set(),
      innerCenter: new THREE.Vector3(0, 0, 0),
    }
  }

  const radial = components.map((component) =>
    Math.hypot(component.position.x, component.position.z),
  )
  const ys = components.map((component) => component.position.y).sort((a, b) => a - b)
  const q = (arr, t) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * t)))]
  const radialSorted = [...radial].sort((a, b) => a - b)
  const radialMedian = q(radialSorted, 0.5)
  const radialQ65 = q(radialSorted, 0.65)
  const yQ9 = q(ys, 0.9)

  const candidates = components
    .map((component, index) => ({ component, index }))
    .filter(({ component, index }) => radial[index] >= radialQ65 && component.position.y <= yQ9)
  const seed = candidates.length
    ? candidates
    : components
        .map((component, index) => ({ component, index }))
        .sort((a, b) => radial[b.index] - radial[a.index])
        .slice(0, Math.min(10, components.length))

  const axis = new THREE.Vector3()
  seed.forEach(({ component, index }) => {
    const weight = Math.max(0.001, radial[index] - radialMedian + 0.001)
    axis.x += component.position.x * weight
    axis.z += component.position.z * weight
  })
  axis.y = 0
  if (axis.lengthSq() < 1e-7) {
    const maxIndex = radial.indexOf(Math.max(...radial))
    axis.set(components[maxIndex].position.x, 0, components[maxIndex].position.z)
  }
  if (axis.lengthSq() < 1e-7) {
    axis.set(0, 0, 1)
  } else {
    axis.normalize()
  }

  const perp = new THREE.Vector3(-axis.z, 0, axis.x)
  const scored = components
    .map((component, index) => {
      const v = new THREE.Vector3(component.position.x, 0, component.position.z)
      const len = Math.max(1e-7, v.length())
      const nx = v.x / len
      const nz = v.z / len
      const frontDot = nx * axis.x + nz * axis.z
      const sideDot = Math.abs(nx * perp.x + nz * perp.z)
      const radialNorm = THREE.MathUtils.clamp((radial[index] - radialMedian) / Math.max(1e-5, radialQ65 - radialMedian + 1e-5), 0, 2)
      const yPenalty = THREE.MathUtils.clamp((component.position.y - ys[0]) / Math.max(1e-5, yQ9 - ys[0]), 0, 1)
      const score = frontDot * 1.2 + radialNorm * 0.75 - sideDot * 0.45 - yPenalty * 0.35
      return { component, score, frontDot }
    })
    .filter((entry) => entry.frontDot > 0.2)
    .sort((a, b) => b.score - a.score)

  const tunnelTargetCount = Math.min(6, scored.length)
  const tunnelPieces = scored.slice(0, tunnelTargetCount).map((entry) => entry.component)

  const center = new THREE.Vector3()
  if (tunnelPieces.length > 0) {
    tunnelPieces.forEach((component) => center.add(component.position))
    center.multiplyScalar(1 / tunnelPieces.length)
  }
  const innerCenter = center.clone().multiplyScalar(0.62)

  return {
    tunnelIds: new Set(tunnelPieces.map((component) => component.id)),
    innerCenter,
  }
}

const sanitizeTransform = (input, defaults = DEFAULT_TRANSFORM) => {
  const source = input && typeof input === 'object' ? input : {}
  const readNumber = (value, fallback) => {
    const next = Number(value)
    return Number.isFinite(next) ? next : fallback
  }
  return {
    x: readNumber(source.x, defaults.x),
    y: readNumber(source.y, defaults.y),
    z: readNumber(source.z, defaults.z),
    rotX: readNumber(source.rotX, defaults.rotX),
    rotY: readNumber(source.rotY, defaults.rotY),
    rotZ: readNumber(source.rotZ, defaults.rotZ),
    scale: readNumber(source.scale, defaults.scale),
  }
}

const sanitizeCamera = (input) => {
  const source = input && typeof input === 'object' ? input : {}
  const readNumber = (value, fallback) => {
    const next = Number(value)
    return Number.isFinite(next) ? next : fallback
  }
  return {
    x: readNumber(source.x, DEFAULT_CAMERA.x),
    y: readNumber(source.y, DEFAULT_CAMERA.y),
    z: readNumber(source.z, DEFAULT_CAMERA.z),
    targetX: readNumber(source.targetX, DEFAULT_CAMERA.targetX),
    targetY: readNumber(source.targetY, DEFAULT_CAMERA.targetY),
    targetZ: readNumber(source.targetZ, DEFAULT_CAMERA.targetZ),
    fov: readNumber(source.fov, DEFAULT_CAMERA.fov),
    swayX: readNumber(source.swayX, DEFAULT_CAMERA.swayX),
    swayY: readNumber(source.swayY, DEFAULT_CAMERA.swayY),
    swayLerp: readNumber(source.swayLerp, DEFAULT_CAMERA.swayLerp),
  }
}

const sanitizeInteraction = (input) => {
  const source = input && typeof input === 'object' ? input : {}
  const readNumber = (value, fallback) => {
    const next = Number(value)
    return Number.isFinite(next) ? next : fallback
  }
  return {
    pointerCenterNdcRadius: readNumber(
      source.pointerCenterNdcRadius,
      DEFAULT_INTERACTION.pointerCenterNdcRadius,
    ),
    hoverWorldNear: readNumber(
      source.hoverWorldNear,
      DEFAULT_INTERACTION.hoverWorldNear,
    ),
    hoverWorldFar: readNumber(
      source.hoverWorldFar,
      DEFAULT_INTERACTION.hoverWorldFar,
    ),
    hoverScreenNear: readNumber(
      source.hoverScreenNear,
      DEFAULT_INTERACTION.hoverScreenNear,
    ),
    hoverScreenFar: readNumber(
      source.hoverScreenFar,
      DEFAULT_INTERACTION.hoverScreenFar,
    ),
    baseDisplacement: readNumber(
      source.baseDisplacement,
      DEFAULT_INTERACTION.baseDisplacement,
    ),
    hoverWorldBase: readNumber(
      source.hoverWorldBase,
      DEFAULT_INTERACTION.hoverWorldBase,
    ),
    hoverWorldAmp: readNumber(
      source.hoverWorldAmp,
      DEFAULT_INTERACTION.hoverWorldAmp,
    ),
    hoverScreenBase: readNumber(
      source.hoverScreenBase,
      DEFAULT_INTERACTION.hoverScreenBase,
    ),
    hoverScreenAmp: readNumber(
      source.hoverScreenAmp,
      DEFAULT_INTERACTION.hoverScreenAmp,
    ),
    displacementScale: readNumber(
      source.displacementScale,
      DEFAULT_INTERACTION.displacementScale,
    ),
    yMaskBase: readNumber(source.yMaskBase, DEFAULT_INTERACTION.yMaskBase),
    yMaskTop: readNumber(source.yMaskTop, DEFAULT_INTERACTION.yMaskTop),
  }
}

const getDefaultTransforms = () => ({
  igloo: sanitizeTransform(defaultIglooSceneControls?.igloo),
  ground: sanitizeTransform(
    defaultIglooSceneControls?.ground,
    DEFAULT_GROUND_TRANSFORM,
  ),
  mountain: sanitizeTransform(
    defaultIglooSceneControls?.mountain,
    DEFAULT_MOUNTAIN_TRANSFORM,
  ),
  camera: sanitizeCamera(defaultIglooSceneControls?.camera),
  interaction: sanitizeInteraction(defaultIglooSceneControls?.interaction),
})

const getStoredTransforms = () => {
  if (typeof window === 'undefined') {
    return getDefaultTransforms()
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return getDefaultTransforms()
    }
    const parsed = JSON.parse(raw)
    return {
      igloo: sanitizeTransform(parsed?.igloo),
      ground: sanitizeTransform(parsed?.ground, DEFAULT_GROUND_TRANSFORM),
      mountain: sanitizeTransform(parsed?.mountain, DEFAULT_MOUNTAIN_TRANSFORM),
      camera: sanitizeCamera(parsed?.camera),
      interaction: sanitizeInteraction(parsed?.interaction),
    }
  } catch {
    return getDefaultTransforms()
  }
}

const buildComponents = (geometry) => {
  geometry.computeBoundingBox()
  const globalBox = geometry.boundingBox
  if (!globalBox) {
    return {
      components: [],
      scale: 1,
      hoverRadius: 0,
      bounds: { minY: 0, maxY: 0, centerY: 0 },
      stats: { vertexCount: 0, triangleCount: 0 },
    }
  }

  const globalCenter = new THREE.Vector3()
  const globalSize = new THREE.Vector3()
  globalBox.getCenter(globalCenter)
  globalBox.getSize(globalSize)

  const maxAxis = Math.max(globalSize.x, globalSize.y, globalSize.z)
  const scale = maxAxis > 0 ? 1.6 / maxAxis : 1

  const positionAttr = geometry.attributes.position
  const vertexCount = positionAttr?.count ?? 0
  if (!positionAttr) {
    return {
      components: [],
      scale,
      hoverRadius: 0,
      bounds: {
        minY: globalBox.min.y,
        maxY: globalBox.max.y,
        centerY: globalCenter.y,
      },
      stats: { vertexCount: 0, triangleCount: 0 },
    }
  }
  const positionsArray = positionAttr.array
  const attributeList = Object.entries(geometry.attributes)
    .map(([name, attribute]) => {
      if (!attribute?.array || typeof attribute.itemSize !== 'number') {
        return null
      }
      return {
        name,
        array: attribute.array,
        itemSize: attribute.itemSize,
        normalized: attribute.normalized ?? false,
      }
    })
    .filter(Boolean)
  const indexArray = geometry.index ? geometry.index.array : null
  const faceCount = indexArray
    ? Math.floor(indexArray.length / 3)
    : Math.floor(vertexCount / 3)
  const hoverRadius = maxAxis * HOVER_RADIUS_RATIO

  const parent = new Int32Array(vertexCount)
  const rank = new Int8Array(vertexCount)
  for (let i = 0; i < vertexCount; i += 1) {
    parent[i] = i
  }

  const find = (x) => {
    let node = x
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]]
      node = parent[node]
    }
    return node
  }

  const union = (a, b) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA === rootB) return
    if (rank[rootA] < rank[rootB]) {
      parent[rootA] = rootB
      return
    }
    if (rank[rootA] > rank[rootB]) {
      parent[rootB] = rootA
      return
    }
    parent[rootB] = rootA
    rank[rootA] += 1
  }

  for (let i = 0; i < faceCount; i += 1) {
    const base = i * 3
    const a = indexArray ? indexArray[base] : base
    const b = indexArray ? indexArray[base + 1] : base + 1
    const c = indexArray ? indexArray[base + 2] : base + 2
    union(a, b)
    union(b, c)
    union(c, a)
  }

  const weldEpsilon = maxAxis * WELD_EPSILON_RATIO
  const useExactWeld = WELD_EPSILON_RATIO === 0
  if (weldEpsilon > 0 || useExactWeld) {
    const invEpsilon = weldEpsilon > 0 ? 1 / weldEpsilon : 0
    const keyMap = new Map()

    for (let i = 0; i < vertexCount; i += 1) {
      const base = i * 3
      const key = useExactWeld
        ? `${positionsArray[base]},${positionsArray[base + 1]},${
            positionsArray[base + 2]
          }`
        : `${Math.round(positionsArray[base] * invEpsilon)},${Math.round(
            positionsArray[base + 1] * invEpsilon,
          )},${Math.round(positionsArray[base + 2] * invEpsilon)}`
      const existing = keyMap.get(key)
      if (existing !== undefined) {
        union(i, existing)
      } else {
        keyMap.set(key, i)
      }
    }
  }

  const componentMap = new Map()
  for (let i = 0; i < faceCount; i += 1) {
    const base = i * 3
    const a = indexArray ? indexArray[base] : base
    const b = indexArray ? indexArray[base + 1] : base + 1
    const c = indexArray ? indexArray[base + 2] : base + 2
    const root = find(a)
    const entry = componentMap.get(root) ?? { indices: [] }
    entry.indices.push(a, b, c)
    componentMap.set(root, entry)
  }

  const components = []
  let componentIndex = 0

  for (const entry of componentMap.values()) {
    const remap = new Map()
    const positions = []
    const indices = []
    const attributeData = {}
    attributeList.forEach((attr) => {
      attributeData[attr.name] = []
    })

    for (let i = 0; i < entry.indices.length; i += 1) {
      const originalIndex = entry.indices[i]
      let nextIndex = remap.get(originalIndex)
      if (nextIndex === undefined) {
        nextIndex = positions.length / 3
        remap.set(originalIndex, nextIndex)
        const base = originalIndex * 3
        positions.push(
          positionsArray[base],
          positionsArray[base + 1],
          positionsArray[base + 2],
        )
        attributeList.forEach((attr) => {
          const attrBase = originalIndex * attr.itemSize
          for (let j = 0; j < attr.itemSize; j += 1) {
            attributeData[attr.name].push(attr.array[attrBase + j])
          }
        })
      }
      indices.push(nextIndex)
    }

    const componentGeometry = new THREE.BufferGeometry()
    componentGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    )
    attributeList.forEach((attr) => {
      if (attr.name === 'position') return
      const TypedArray = attr.array.constructor
      const data = new TypedArray(attributeData[attr.name])
      componentGeometry.setAttribute(
        attr.name,
        new THREE.BufferAttribute(data, attr.itemSize, attr.normalized),
      )
    })
    componentGeometry.setIndex(indices)
    if (!componentGeometry.attributes.normal) {
      componentGeometry.computeVertexNormals()
    }
    componentGeometry.computeBoundingBox()

    const localCenter = new THREE.Vector3()
    componentGeometry.boundingBox?.getCenter(localCenter)
    componentGeometry.translate(-localCenter.x, -localCenter.y, -localCenter.z)

    const centeredPosition = localCenter.clone().sub(globalCenter)
    const direction = centeredPosition.clone()
    const radius = direction.length()
    if (radius > 0) {
      direction.multiplyScalar(1 / radius)
    } else {
      direction.set(0, 1, 0)
    }
    components.push({
      id: componentIndex,
      geometry: componentGeometry,
      position: centeredPosition,
      direction,
      hoverAmplitude: radius * HOVER_DISTANCE_RATIO,
    })

    componentIndex += 1
  }

  const triangleCount = indexArray
    ? Math.floor(indexArray.length / 3)
    : Math.floor(vertexCount / 3)

  return {
    components,
    scale,
    hoverRadius,
    bounds: {
      minY: globalBox.min.y,
      maxY: globalBox.max.y,
      centerY: globalCenter.y,
    },
    stats: { vertexCount, triangleCount },
  }
}

function DracoMesh({
  path,
  color,
  hoverEnabled = true,
  debugTunnel = false,
  align = 'center',
  scaleOverride = 1,
  position = { x: 0, y: 0, z: 0 },
  rotation = { x: 0, y: 0, z: 0 },
  materialProps = {},
  material,
  interaction = DEFAULT_INTERACTION,
  hoverStrengthRef,
  children,
}) {
  const geometry = useLoader(DRACOLoader, path, (loader) => {
    loader.setDecoderPath(DECODER_PATH)
  })

  const { components, scale, bounds } = useMemo(
    () => buildComponents(geometry),
    [geometry],
  )
  const materials = useMemo(() => {
    if (!material) return []
    return components.map(() => material.clone())
  }, [components, material])
  const tunnelData = useMemo(() => detectTunnelPieces(components), [components])
  const bottomLockedIds = useMemo(() => {
    if (!components.length) return new Set()
    let minY = Infinity
    let maxY = -Infinity
    for (const component of components) {
      if (tunnelData.tunnelIds.has(component.id)) continue
      const y = component.position.y
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return new Set()
    const span = Math.max(1e-5, maxY - minY)
    const threshold = minY + span * BOTTOM_LOCK_HEIGHT_RATIO
    return new Set(
      components
        .filter(
          (component) =>
            !tunnelData.tunnelIds.has(component.id) &&
            component.position.y <= threshold,
        )
        .map((component) => component.id),
    )
  }, [components, tunnelData.tunnelIds])

  const gl = useThree((state) => state.gl)
  const groupRef = useRef(null)
  const meshRefs = useRef([])
  const motionRef = useRef(new Map())
  const pointerRef = useRef({ x: 0, y: 0, active: false })
  const rayState = useMemo(
    () => ({
      centerWorld: new THREE.Vector3(),
      centerNdc: new THREE.Vector3(),
      toCenter: new THREE.Vector3(),
      closestWorld: new THREE.Vector3(),
      localPoint: new THREE.Vector3(),
      componentWorld: new THREE.Vector3(),
      componentNdc: new THREE.Vector3(),
      doorWorld: new THREE.Vector3(),
      pointerWorld: new THREE.Vector3(),
      pointerNdc: new THREE.Vector2(),
      planeNormal: new THREE.Vector3(),
      plane: new THREE.Plane(),
      axisX: new THREE.Vector3(1, 0, 0),
      axisY: new THREE.Vector3(0, 1, 0),
      axisZ: new THREE.Vector3(0, 0, 1),
      qTmp: new THREE.Quaternion(),
    }),
    [],
  )
  const combinedScale = scale * scaleOverride
  const groupPosition = useMemo(() => {
    const { x, y, z } = position
    if (!bounds) {
      return new THREE.Vector3(x, y, z)
    }
    let alignOffset = 0
    if (align === 'bottom') {
      alignOffset = (bounds.centerY - bounds.minY) * combinedScale
    } else if (align === 'top') {
      alignOffset = (bounds.centerY - bounds.maxY) * combinedScale
    }
    return new THREE.Vector3(x, y + alignOffset, z)
  }, [align, bounds, combinedScale, position])

  const groupRotation = useMemo(
    () =>
      new THREE.Euler(
        THREE.MathUtils.degToRad(rotation.x),
        THREE.MathUtils.degToRad(rotation.y),
        THREE.MathUtils.degToRad(rotation.z),
      ),
    [rotation.x, rotation.y, rotation.z],
  )

  const yRange = useMemo(() => {
    if (!components.length) return { minY: 0, span: 1 }
    let minY = Infinity
    let maxY = -Infinity
    for (const component of components) {
      minY = Math.min(minY, component.position.y)
      maxY = Math.max(maxY, component.position.y)
    }
    return {
      minY,
      span: Math.max(1e-5, maxY - minY),
    }
  }, [components])

  useEffect(() => {
    meshRefs.current.length = components.length
    motionRef.current.clear()
  }, [components.length])

  useEffect(() => {
    if (!hoverEnabled) return undefined
    const dom = gl?.domElement
    if (!dom) return undefined

    const updatePointer = (clientX, clientY) => {
      const rect = dom.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        pointerRef.current.active = false
        return
      }
      const inside =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      pointerRef.current.active = inside
      if (!inside) return
      const x = ((clientX - rect.left) / rect.width) * 2 - 1
      const y = -((clientY - rect.top) / rect.height) * 2 + 1
      pointerRef.current.x = THREE.MathUtils.clamp(x, -1, 1)
      pointerRef.current.y = THREE.MathUtils.clamp(y, -1, 1)
    }

    const handlePointerMove = (event) => {
      updatePointer(event.clientX, event.clientY)
    }

    const handlePointerLeave = () => {
      pointerRef.current.active = false
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerleave', handlePointerLeave)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerleave', handlePointerLeave)
    }
  }, [gl, hoverEnabled])

  /* eslint-disable react-hooks/immutability */
  useFrame((state, delta) => {
    if (!hoverEnabled) return
    const group = groupRef.current
    if (!group) return
    group.getWorldPosition(rayState.centerWorld)
    rayState.doorWorld.copy(tunnelData.innerCenter)
    group.localToWorld(rayState.doorWorld)
    state.camera.getWorldDirection(rayState.planeNormal)
    rayState.plane.setFromNormalAndCoplanarPoint(
      rayState.planeNormal,
      rayState.centerWorld,
    )
    rayState.pointerNdc.set(pointerRef.current.x, pointerRef.current.y)
    state.raycaster.setFromCamera(rayState.pointerNdc, state.camera)

    const hasPointer =
      pointerRef.current.active &&
      Boolean(state.raycaster.ray.intersectPlane(rayState.plane, rayState.pointerWorld))

    rayState.centerNdc.copy(rayState.centerWorld).project(state.camera)
    const pointerToCenterNdc = Math.hypot(
      rayState.centerNdc.x - rayState.pointerNdc.x,
      rayState.centerNdc.y - rayState.pointerNdc.y,
    )
    const pointerNearModel =
      hasPointer && pointerToCenterNdc < interaction.pointerCenterNdcRadius
    const centerInner = Math.max(
      0.05,
      interaction.pointerCenterNdcRadius * 0.38,
    )
    const centerMask =
      1.0 -
      smoothstep(
        centerInner,
        interaction.pointerCenterNdcRadius,
        pointerToCenterNdc,
      )

    let maxHoverRatio = 0
    for (const entry of meshRefs.current) {
      if (!entry?.mesh) continue
      const meshMaterial = entry.mesh.material
      const motion =
        motionRef.current.get(entry.id) ?? {
          targetDisplacement1: 0,
          targetDisplacement2: 0,
          targetBounce1: 0,
          targetBounce2: 0,
          displacement: 0,
          bounce: 0,
        }
      const centroid = entry.basePosition
      let displacement = interaction.baseDisplacement
      displacement *= Math.sin(-state.clock.elapsedTime * 2 + centroid.x) * 0.5 + 0.5
      displacement *= Math.cos(-state.clock.elapsedTime) * 0.5 + 0.5
      displacement *= THREE.MathUtils.lerp(0.5, 2.0, entry.rand.z)
      displacement *= 0.5

      if (pointerNearModel && !entry.lockedBottom) {
        entry.mesh.getWorldPosition(rayState.componentWorld)
        const worldDistance = rayState.componentWorld.distanceTo(
          rayState.pointerWorld,
        )
        rayState.componentNdc.copy(rayState.componentWorld).project(state.camera)
        const ndcDistance = Math.hypot(
          rayState.componentNdc.x - rayState.pointerNdc.x,
          rayState.componentNdc.y - rayState.pointerNdc.y,
        )
        const c =
          Math.sin(state.clock.elapsedTime + entry.rand.x * 12.342) * entry.rand.y
        const hoverWorld = fit(
          smoothstep(
            interaction.hoverWorldNear,
            interaction.hoverWorldFar,
            worldDistance,
          ),
          0,
          1,
          interaction.hoverWorldBase + interaction.hoverWorldAmp * c,
          0,
        )
        const hoverScreen = fit(
          smoothstep(
            interaction.hoverScreenNear,
            interaction.hoverScreenFar,
            ndcDistance,
          ),
          0,
          1,
          interaction.hoverScreenBase + interaction.hoverScreenAmp * c,
          0,
        )
        displacement = Math.max(displacement, Math.max(hoverWorld, hoverScreen) * centerMask)
      }

      if (entry.lockedBottom) {
        displacement = 0
      }

      motion.targetBounce1 = displacement
      motion.targetBounce2 = lerpFps(
        motion.targetBounce2,
        motion.targetBounce1,
        0.05,
        delta,
      )
      motion.bounce = lerpFps(motion.bounce, motion.targetBounce2, 0.05, delta)

      const yMask =
        interaction.yMaskBase +
        interaction.yMaskTop * smoothstep(0.0, 0.45, entry.yNorm)
      displacement *= yMask
      displacement = Math.max(0, displacement)

      motion.targetDisplacement1 = displacement
      motion.targetDisplacement2 = lerpFps(
        motion.targetDisplacement2,
        motion.targetDisplacement1,
        0.06,
        delta,
      )
      motion.displacement = lerpFps(
        motion.displacement,
        motion.targetDisplacement2,
        0.06,
        delta,
      )

      motionRef.current.set(entry.id, motion)

      const finalDisplacement = motion.displacement * interaction.displacementScale
      const displacementRatio = THREE.MathUtils.clamp(finalDisplacement, 0, 1)
      maxHoverRatio = Math.max(maxHoverRatio, displacementRatio)
      if (meshMaterial?.uniforms?.uDisplacement) {
        meshMaterial.uniforms.uDisplacement.value = displacementRatio
      }

      entry.mesh.getWorldPosition(rayState.componentWorld)
      rayState.componentNdc.copy(rayState.componentWorld).project(state.camera)
      const ndcDx = rayState.componentNdc.x - rayState.pointerNdc.x
      const ndcDy = rayState.componentNdc.y - rayState.pointerNdc.y
      const ndcDistance = Math.sqrt(ndcDx * ndcDx + ndcDy * ndcDy)
      const targetGlow =
        pointerRef.current.active && ndcDistance <= GLOW_SCREEN_RADIUS_NDC
          ? 1 - ndcDistance / GLOW_SCREEN_RADIUS_NDC
          : 0
      entry.currentGlow = THREE.MathUtils.damp(
        entry.currentGlow ?? 0,
        targetGlow,
        10,
        delta,
      )
      if (meshMaterial?.uniforms?.uGlowStrength) {
        meshMaterial.uniforms.uGlowStrength.value = Math.max(
          entry.currentGlow,
          displacementRatio,
        )
      }
      if (meshMaterial?.uniforms?.uTime) {
        meshMaterial.uniforms.uTime.value = state.clock.elapsedTime
      }
      if (meshMaterial?.uniforms?.uCenter) {
        meshMaterial.uniforms.uCenter.value.copy(rayState.centerWorld)
      }
      if (meshMaterial?.uniforms?.uDoorCenter) {
        meshMaterial.uniforms.uDoorCenter.value.copy(rayState.doorWorld)
      }
      if (meshMaterial?.uniforms?.uDoorBlend) {
        meshMaterial.uniforms.uDoorBlend.value = entry.isDoor ? 1 : 0
      }
      if (meshMaterial?.uniforms?.uDebugTunnel) {
        meshMaterial.uniforms.uDebugTunnel.value = debugTunnel ? 1 : 0
      }

      entry.mesh.position.copy(entry.basePosition).addScaledVector(
        entry.direction,
        finalDisplacement,
      )

      if (!entry.lockedBottom) {
        const xRot =
          Math.cos(finalDisplacement * 2 + entry.rand.y * 30) *
          finalDisplacement *
          0.5
        const yRot =
          Math.cos(finalDisplacement * 2 + entry.rand.z * 30) *
          finalDisplacement *
          0.5
        const zRot =
          Math.cos(finalDisplacement * 2 + entry.rand.x * 30) *
          finalDisplacement *
          0.5
        entry.quaternion.identity()
        rayState.qTmp.setFromAxisAngle(rayState.axisY, yRot)
        entry.quaternion.multiply(rayState.qTmp)
        rayState.qTmp.setFromAxisAngle(rayState.axisZ, zRot)
        entry.quaternion.multiply(rayState.qTmp)
        rayState.qTmp.setFromAxisAngle(rayState.axisX, xRot)
        entry.quaternion.multiply(rayState.qTmp)
      } else {
        entry.quaternion.identity()
      }

      entry.mesh.quaternion.copy(entry.quaternion)
    }
    if (hoverStrengthRef) {
      hoverStrengthRef.current = THREE.MathUtils.damp(
        hoverStrengthRef.current ?? 0,
        maxHoverRatio,
        7,
        delta,
      )
    }
  })
  /* eslint-enable react-hooks/immutability */

  return (
    <group
      ref={groupRef}
      scale={combinedScale}
      position={groupPosition}
      rotation={groupRotation}
    >
      {components.map((component) => (
        <mesh
          key={component.id}
          geometry={component.geometry}
          position={component.position}
          material={material ? materials[component.id] : undefined}
          ref={(mesh) => {
            if (!mesh) {
              meshRefs.current[component.id] = null
              return
            }
            mesh.position.copy(component.position)
            mesh.quaternion.identity()
            const rand =
              meshRefs.current[component.id]?.rand ??
              seededVec3(component.id + 1)
            const yNorm = THREE.MathUtils.clamp(
              (component.position.y - yRange.minY) / yRange.span,
              0,
              1,
            )
            meshRefs.current[component.id] = {
              mesh,
              id: component.id,
              basePosition: component.position,
              direction: component.direction,
              hoverAmplitude: component.hoverAmplitude,
              currentGlow: meshRefs.current[component.id]?.currentGlow ?? 0,
              lockedBottom: bottomLockedIds.has(component.id),
              isDoor: tunnelData.tunnelIds.has(component.id),
              rand,
              yNorm,
              quaternion:
                meshRefs.current[component.id]?.quaternion ??
                new THREE.Quaternion(),
            }
          }}
        >
          {!material ? (
            <meshStandardMaterial
              color={color}
              metalness={0.1}
              roughness={0.5}
              {...materialProps}
            />
          ) : null}
        </mesh>
      ))}
      {children}
    </group>
  )
}

function IglooModel(props) {
  const gl = useThree((state) => state.gl)
  const [textures, setTextures] = useState(null)
  const hoverStrengthRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const loader = new KTX2Loader()
    loader.setTranscoderPath('/basis/')
    loader.detectSupport(gl)

    Promise.all([
      loader.loadAsync(IGLOO_BASE_TEXTURE_PATH),
      loader.loadAsync(IGLOO_EXPLODED_TEXTURE_PATH),
    ])
      .then(([baseTexture, explodedTexture]) => {
        if (cancelled) return
        baseTexture.colorSpace = THREE.SRGBColorSpace
        explodedTexture.colorSpace = THREE.SRGBColorSpace
        baseTexture.needsUpdate = true
        explodedTexture.needsUpdate = true
        setTextures({
          baseTexture,
          explodedTexture,
        })
      })
      .catch((error) => {
        console.error('Failed to load igloo textures', error)
      })

    return () => {
      cancelled = true
      loader.dispose()
    }
  }, [gl])

  const material = useMemo(() => {
    if (!textures) return null
    const shader = new THREE.ShaderMaterial({
      uniforms: {
        tMap: { value: textures.baseTexture },
        tMapExploded: { value: textures.explodedTexture },
        uDisplacement: { value: 0 },
        uGlowStrength: { value: 0 },
        uTime: { value: 0 },
        uGlowColor: { value: new THREE.Color(0.9, 0.94, 0.98) },
        uCenter: { value: new THREE.Vector3(0, 0, 0) },
        uDoorCenter: { value: new THREE.Vector3(0, 0, 0) },
        uDoorBlend: { value: 0 },
        uDebugTunnel: { value: 0 },
      },
      vertexShader: IGLOO_VERTEX_SHADER,
      fragmentShader: IGLOO_FRAGMENT_SHADER,
    })
    return shader
  }, [textures])

  useEffect(
    () => () => {
      if (material) material.dispose()
    },
    [material],
  )

  const innerGlowColor = useMemo(() => new THREE.Color(0.9, 0.94, 0.98), [])

  return (
    <DracoMesh
      {...props}
      material={material ?? undefined}
      materialProps={!material ? { color: '#ffffff' } : {}}
      hoverStrengthRef={hoverStrengthRef}
    >
      <InnerGlowLight
        hoverStrengthRef={hoverStrengthRef}
        color={innerGlowColor}
      />
    </DracoMesh>
  )
}

function GroundModel(props) {
  const gl = useThree((state) => state.gl)
  const [textures, setTextures] = useState(null)

  useEffect(() => {
    let cancelled = false
    let loadedColorTexture = null
    let loadedGlowTexture = null
    const loader = new KTX2Loader()
    loader.setTranscoderPath('/basis/')
    loader.detectSupport(gl)

    Promise.all([
      loader.loadAsync(GROUND_COLOR_TEXTURE_PATH),
      loader.loadAsync(GROUND_GLOW_TEXTURE_PATH),
    ])
      .then(([colorTexture, glowTexture]) => {
        loadedColorTexture = colorTexture
        loadedGlowTexture = glowTexture
        if (cancelled) return
        colorTexture.colorSpace = THREE.SRGBColorSpace
        glowTexture.colorSpace = THREE.SRGBColorSpace
        colorTexture.needsUpdate = true
        glowTexture.needsUpdate = true
        setTextures({
          colorTexture,
          glowTexture,
        })
      })
      .catch((error) => {
        console.error('Failed to load ground textures', error)
      })

    return () => {
      cancelled = true
      loader.dispose()
      if (loadedColorTexture) loadedColorTexture.dispose()
      if (loadedGlowTexture) loadedGlowTexture.dispose()
    }
  }, [gl])

  const material = useMemo(() => {
    if (!textures) return null
    return new THREE.MeshStandardMaterial({
      color: '#ffffff',
      map: textures.colorTexture,
      emissive: new THREE.Color(0.8, 0.9, 1.0),
      emissiveMap: textures.glowTexture,
      emissiveIntensity: 0.4,
      roughness: 0.9,
      metalness: 0.02,
    })
  }, [textures])

  useEffect(
    () => () => {
      if (material) material.dispose()
    },
    [material],
  )

  return (
    <DracoMesh
      {...props}
      hoverEnabled={false}
      material={material ?? undefined}
      materialProps={{
        color: '#dfe8f3',
        roughness: 0.9,
        metalness: 0.02,
      }}
    />
  )
}

function MountainModel(props) {
  const gl = useThree((state) => state.gl)
  const [texture, setTexture] = useState(null)

  useEffect(() => {
    let cancelled = false
    let loadedTexture = null
    const loader = new KTX2Loader()
    loader.setTranscoderPath('/basis/')
    loader.detectSupport(gl)

    loader
      .loadAsync(MOUNTAIN_COLOR_TEXTURE_PATH)
      .then((mountainTexture) => {
        loadedTexture = mountainTexture
        if (cancelled) return
        mountainTexture.colorSpace = THREE.SRGBColorSpace
        mountainTexture.needsUpdate = true
        setTexture(mountainTexture)
      })
      .catch((error) => {
        console.error('Failed to load mountain texture', error)
      })

    return () => {
      cancelled = true
      loader.dispose()
      if (loadedTexture) loadedTexture.dispose()
    }
  }, [gl])

  const material = useMemo(() => {
    if (!texture) return null
    return new THREE.MeshStandardMaterial({
      color: '#e5ecf6',
      map: texture,
      roughness: 0.95,
      metalness: 0.0,
    })
  }, [texture])

  useEffect(
    () => () => {
      if (material) material.dispose()
    },
    [material],
  )

  return (
    <DracoMesh
      {...props}
      hoverEnabled={false}
      material={material ?? undefined}
      materialProps={{
        color: '#e5ecf6',
        roughness: 0.95,
        metalness: 0.0,
      }}
    />
  )
}

function InnerGlowLight({ hoverStrengthRef, color }) {
  const lightRef = useRef(null)

  useFrame((state, delta) => {
    const strength = hoverStrengthRef.current ?? 0
    const pulse = 0.88 + 0.12 * Math.sin(state.clock.elapsedTime * 2.0)
    const target = (INNER_LIGHT_BASE + strength * INNER_LIGHT_BOOST) * pulse
    if (lightRef.current) {
      lightRef.current.intensity = THREE.MathUtils.damp(
        lightRef.current.intensity,
        THREE.MathUtils.clamp(target, 0.8, 7.5),
        8,
        delta,
      )
    }
  })

  return (
    <group position={[0, 0.12, 0]}>
      <pointLight
        ref={lightRef}
        color={color}
        intensity={INNER_LIGHT_BASE}
        distance={4.4}
        decay={1.9}
      />
    </group>
  )
}

function CameraRig({ settings }) {
  const { camera, gl } = useThree()
  const pointerRef = useRef({ x: 0, y: 0, active: false })
  const smoothPointerRef = useRef(new THREE.Vector2(0, 0))
  const targetRef = useRef(new THREE.Vector3())
  const offsetRef = useRef(new THREE.Vector3())
  const positionRef = useRef(new THREE.Vector3())
  const sphericalRef = useRef(new THREE.Spherical())

  useEffect(() => {
    const element = gl.domElement
    if (!element) return undefined

    const handlePointerMove = (event) => {
      const rect = element.getBoundingClientRect()
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom

      pointerRef.current.active = inside
      if (!inside) return

      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
      pointerRef.current.x = THREE.MathUtils.clamp(x, -1, 1)
      pointerRef.current.y = THREE.MathUtils.clamp(y, -1, 1)
    }

    const handlePointerLeave = () => {
      pointerRef.current.active = false
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerleave', handlePointerLeave)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerleave', handlePointerLeave)
    }
  }, [gl])

  useEffect(() => {
    camera.updateProjectionMatrix()
  }, [camera, settings.fov])

  useFrame((state, delta) => {
    const target = targetRef.current
    target.set(settings.targetX, settings.targetY, settings.targetZ)

    const offset = offsetRef.current
    offset.set(settings.x - target.x, settings.y - target.y, settings.z - target.z)
    const radius = Math.max(offset.length(), 0.001)

    const pointerTargetX = pointerRef.current.active ? pointerRef.current.x : 0
    const pointerTargetY = pointerRef.current.active ? pointerRef.current.y : 0
    smoothPointerRef.current.x = lerpFps(
      smoothPointerRef.current.x,
      pointerTargetX,
      THREE.MathUtils.clamp(settings.swayLerp, 0, 1),
      delta,
    )
    smoothPointerRef.current.y = lerpFps(
      smoothPointerRef.current.y,
      pointerTargetY,
      THREE.MathUtils.clamp(settings.swayLerp, 0, 1),
      delta,
    )

    const spherical = sphericalRef.current
    spherical.setFromVector3(offset)
    spherical.theta += smoothPointerRef.current.x * settings.swayX
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi - smoothPointerRef.current.y * settings.swayY,
      0.05,
      Math.PI - 0.05,
    )
    spherical.radius = radius

    const position = positionRef.current
    position.setFromSpherical(spherical).add(target)

    camera.position.copy(position)
    camera.lookAt(target)
    camera.updateMatrixWorld()
  })

  return null
}

export default function IglooPage() {
  const storedTransforms = useMemo(() => getStoredTransforms(), [])
  const [iglooTransform, setIglooTransform] = useState(
    () => storedTransforms.igloo,
  )
  const [groundTransform, setGroundTransform] = useState(
    () => storedTransforms.ground,
  )
  const [mountainTransform, setMountainTransform] = useState(
    () => storedTransforms.mountain,
  )
  const [cameraTransform, setCameraTransform] = useState(
    () => storedTransforms.camera,
  )
  const [interactionSettings, setInteractionSettings] = useState(
    () => storedTransforms.interaction,
  )
  const [debugTunnel, setDebugTunnel] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        igloo: iglooTransform,
        ground: groundTransform,
        mountain: mountainTransform,
        camera: cameraTransform,
        interaction: interactionSettings,
      }),
    )
  }, [
    iglooTransform,
    groundTransform,
    mountainTransform,
    cameraTransform,
    interactionSettings,
  ])

  const handleTransformChange = (setter, key) => (event) => {
    const nextValue = Number(event.target.value)
    if (!Number.isFinite(nextValue)) return
    setter((prev) => ({ ...prev, [key]: nextValue }))
  }

  const resetSettings = () => {
    const defaults = getDefaultTransforms()
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY)
    }
    setIglooTransform(defaults.igloo)
    setGroundTransform(defaults.ground)
    setMountainTransform(defaults.mountain)
    setCameraTransform(defaults.camera)
    setInteractionSettings(defaults.interaction)
  }

  const exportSettings = () => {
    const data = {
      igloo: iglooTransform,
      ground: groundTransform,
      mountain: mountainTransform,
      camera: cameraTransform,
      interaction: interactionSettings,
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'igloo-scene-controls.json'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="igloo-page">
      <div className="igloo-controls">
        <div className="igloo-controls__actions">
          <button className="igloo-controls__button" onClick={exportSettings}>
            Export Settings JSON
          </button>
          <button className="igloo-controls__button" onClick={resetSettings}>
            Reset Local Settings
          </button>
        </div>
        <details className="igloo-controls__section" open>
          <summary className="igloo-controls__summary">Igloo</summary>
          <div className="igloo-controls__grid">
            <label>
              Pos X
              <input
                type="number"
                step="0.05"
                value={iglooTransform.x}
                onChange={handleTransformChange(setIglooTransform, 'x')}
              />
            </label>
            <label>
              Pos Y
              <input
                type="number"
                step="0.05"
                value={iglooTransform.y}
                onChange={handleTransformChange(setIglooTransform, 'y')}
              />
            </label>
            <label>
              Pos Z
              <input
                type="number"
                step="0.05"
                value={iglooTransform.z}
                onChange={handleTransformChange(setIglooTransform, 'z')}
              />
            </label>
            <label>
              Scale
              <input
                type="number"
                step="0.05"
                min="0.1"
                value={iglooTransform.scale}
                onChange={handleTransformChange(setIglooTransform, 'scale')}
              />
            </label>
            <label>
              Rot X
              <input
                type="number"
                step="1"
                value={iglooTransform.rotX}
                onChange={handleTransformChange(setIglooTransform, 'rotX')}
              />
            </label>
            <label>
              Rot Y
              <input
                type="number"
                step="1"
                value={iglooTransform.rotY}
                onChange={handleTransformChange(setIglooTransform, 'rotY')}
              />
            </label>
            <label>
              Rot Z
              <input
                type="number"
                step="1"
                value={iglooTransform.rotZ}
                onChange={handleTransformChange(setIglooTransform, 'rotZ')}
              />
            </label>
          </div>
        </details>
        <details className="igloo-controls__section" open>
          <summary className="igloo-controls__summary">Ground</summary>
          <div className="igloo-controls__grid">
            <label>
              Pos X
              <input
                type="number"
                step="0.05"
                value={groundTransform.x}
                onChange={handleTransformChange(setGroundTransform, 'x')}
              />
            </label>
            <label>
              Pos Y
              <input
                type="number"
                step="0.05"
                value={groundTransform.y}
                onChange={handleTransformChange(setGroundTransform, 'y')}
              />
            </label>
            <label>
              Pos Z
              <input
                type="number"
                step="0.05"
                value={groundTransform.z}
                onChange={handleTransformChange(setGroundTransform, 'z')}
              />
            </label>
            <label>
              Scale
              <input
                type="number"
                step="0.05"
                min="0.1"
                value={groundTransform.scale}
                onChange={handleTransformChange(setGroundTransform, 'scale')}
              />
            </label>
            <label>
              Rot X
              <input
                type="number"
                step="1"
                value={groundTransform.rotX}
                onChange={handleTransformChange(setGroundTransform, 'rotX')}
              />
            </label>
            <label>
              Rot Y
              <input
                type="number"
                step="1"
                value={groundTransform.rotY}
                onChange={handleTransformChange(setGroundTransform, 'rotY')}
              />
            </label>
            <label>
              Rot Z
              <input
                type="number"
                step="1"
                value={groundTransform.rotZ}
                onChange={handleTransformChange(setGroundTransform, 'rotZ')}
              />
            </label>
          </div>
        </details>
        <details className="igloo-controls__section" open>
          <summary className="igloo-controls__summary">Mountain</summary>
          <div className="igloo-controls__grid">
            <label>
              Pos X
              <input
                type="number"
                step="0.05"
                value={mountainTransform.x}
                onChange={handleTransformChange(setMountainTransform, 'x')}
              />
            </label>
            <label>
              Pos Y
              <input
                type="number"
                step="0.05"
                value={mountainTransform.y}
                onChange={handleTransformChange(setMountainTransform, 'y')}
              />
            </label>
            <label>
              Pos Z
              <input
                type="number"
                step="0.05"
                value={mountainTransform.z}
                onChange={handleTransformChange(setMountainTransform, 'z')}
              />
            </label>
            <label>
              Scale
              <input
                type="number"
                step="0.05"
                min="0.1"
                value={mountainTransform.scale}
                onChange={handleTransformChange(setMountainTransform, 'scale')}
              />
            </label>
            <label>
              Rot X
              <input
                type="number"
                step="1"
                value={mountainTransform.rotX}
                onChange={handleTransformChange(setMountainTransform, 'rotX')}
              />
            </label>
            <label>
              Rot Y
              <input
                type="number"
                step="1"
                value={mountainTransform.rotY}
                onChange={handleTransformChange(setMountainTransform, 'rotY')}
              />
            </label>
            <label>
              Rot Z
              <input
                type="number"
                step="1"
                value={mountainTransform.rotZ}
                onChange={handleTransformChange(setMountainTransform, 'rotZ')}
              />
            </label>
          </div>
        </details>
        <details className="igloo-controls__section" open>
          <summary className="igloo-controls__summary">Camera</summary>
          <div className="igloo-controls__grid">
            <label>
              Cam X
              <input
                type="number"
                step="0.05"
                value={cameraTransform.x}
                onChange={handleTransformChange(setCameraTransform, 'x')}
              />
            </label>
            <label>
              Cam Y
              <input
                type="number"
                step="0.05"
                value={cameraTransform.y}
                onChange={handleTransformChange(setCameraTransform, 'y')}
              />
            </label>
            <label>
              Cam Z
              <input
                type="number"
                step="0.05"
                value={cameraTransform.z}
                onChange={handleTransformChange(setCameraTransform, 'z')}
              />
            </label>
            <label>
              Target X
              <input
                type="number"
                step="0.05"
                value={cameraTransform.targetX}
                onChange={handleTransformChange(setCameraTransform, 'targetX')}
              />
            </label>
            <label>
              Target Y
              <input
                type="number"
                step="0.05"
                value={cameraTransform.targetY}
                onChange={handleTransformChange(setCameraTransform, 'targetY')}
              />
            </label>
            <label>
              Target Z
              <input
                type="number"
                step="0.05"
                value={cameraTransform.targetZ}
                onChange={handleTransformChange(setCameraTransform, 'targetZ')}
              />
            </label>
            <label>
              Fov
              <input
                type="number"
                step="1"
                min="10"
                max="120"
                value={cameraTransform.fov}
                onChange={handleTransformChange(setCameraTransform, 'fov')}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Mouse Sway Horizontal</span>
              <span className="igloo-controls__sub">
                Left-right camera drift from pointer movement.
              </span>
              <input
                type="number"
                step="0.005"
                value={cameraTransform.swayX}
                onChange={handleTransformChange(setCameraTransform, 'swayX')}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Mouse Sway Vertical</span>
              <span className="igloo-controls__sub">
                Up-down camera drift from pointer movement.
              </span>
              <input
                type="number"
                step="0.005"
                value={cameraTransform.swayY}
                onChange={handleTransformChange(setCameraTransform, 'swayY')}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Sway Smoothing</span>
              <span className="igloo-controls__sub">
                Higher values react faster, lower values feel heavier.
              </span>
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={cameraTransform.swayLerp}
                onChange={handleTransformChange(setCameraTransform, 'swayLerp')}
              />
            </label>
          </div>
        </details>
        <details className="igloo-controls__section" open>
          <summary className="igloo-controls__summary">Interaction</summary>
          <div className="igloo-controls__grid">
            <label>
              <span className="igloo-controls__label">Activation Radius</span>
              <span className="igloo-controls__sub">
                Starts hover before cursor touches the model.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.pointerCenterNdcRadius}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'pointerCenterNdcRadius',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">3D Distance Near</span>
              <span className="igloo-controls__sub">
                Full 3D hover effect inside this distance.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.hoverWorldNear}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'hoverWorldNear',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">3D Distance Far</span>
              <span className="igloo-controls__sub">
                3D hover fades to zero by this distance.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.hoverWorldFar}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'hoverWorldFar',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Screen Distance Near</span>
              <span className="igloo-controls__sub">
                Full effect for blocks very close to cursor on screen.
              </span>
              <input
                type="number"
                step="0.005"
                value={interactionSettings.hoverScreenNear}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'hoverScreenNear',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Screen Distance Far</span>
              <span className="igloo-controls__sub">
                Screen-space hover radius around cursor.
              </span>
              <input
                type="number"
                step="0.005"
                value={interactionSettings.hoverScreenFar}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'hoverScreenFar',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Base Displacement</span>
              <span className="igloo-controls__sub">
                Idle movement amount even without hover.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.baseDisplacement}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'baseDisplacement',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Hover Strength (3D)</span>
              <span className="igloo-controls__sub">
                Base strength from world-distance hover.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.hoverWorldBase}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'hoverWorldBase',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Hover Variation (3D)</span>
              <span className="igloo-controls__sub">
                Randomized per-block variation for 3D hover.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.hoverWorldAmp}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'hoverWorldAmp',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Hover Strength (Screen)</span>
              <span className="igloo-controls__sub">
                Base strength from screen-distance hover.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.hoverScreenBase}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'hoverScreenBase',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Hover Variation (Screen)</span>
              <span className="igloo-controls__sub">
                Randomized per-block variation for screen hover.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.hoverScreenAmp}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'hoverScreenAmp',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Displacement Scale</span>
              <span className="igloo-controls__sub">
                Global multiplier for final movement.
              </span>
              <input
                type="number"
                step="0.05"
                min="0"
                value={interactionSettings.displacementScale}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'displacementScale',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Lower Layer Movement</span>
              <span className="igloo-controls__sub">
                Movement retained by lower blocks.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.yMaskBase}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'yMaskBase',
                )}
              />
            </label>
            <label>
              <span className="igloo-controls__label">Upper Layer Boost</span>
              <span className="igloo-controls__sub">
                Extra movement added toward upper blocks.
              </span>
              <input
                type="number"
                step="0.01"
                value={interactionSettings.yMaskTop}
                onChange={handleTransformChange(
                  setInteractionSettings,
                  'yMaskTop',
                )}
              />
            </label>
          </div>
        </details>
        <div className="igloo-controls__hint">
          Use camera values for base framing, then tweak mouse sway below.
        </div>
        <details className="igloo-controls__section" open>
          <summary className="igloo-controls__summary">Debug</summary>
          <div className="igloo-controls__grid">
            <label className="igloo-controls__checkbox">
              <input
                type="checkbox"
                checked={debugTunnel}
                onChange={(event) => setDebugTunnel(event.target.checked)}
              />
              Show tunnel blocks
            </label>
          </div>
        </details>
      </div>
      <Canvas
        className="igloo-canvas"
        camera={{
          position: [cameraTransform.x, cameraTransform.y, cameraTransform.z],
          fov: cameraTransform.fov,
        }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#e6edf7']} />
        <ambientLight color="#eef5ff" intensity={0.64} />
        <directionalLight color="#f2f7ff" position={[3, 4, 2]} intensity={1.45} />
        <directionalLight color="#e4eeff" position={[-2, 1, -3]} intensity={0.64} />
        <axesHelper args={[2]} />
        <CameraRig settings={cameraTransform} />
        <Suspense fallback={null}>
          <MountainModel
            path={MOUNTAIN_PATH}
            align="bottom"
            scaleOverride={mountainTransform.scale}
            position={{
              x: mountainTransform.x,
              y: mountainTransform.y,
              z: mountainTransform.z,
            }}
            rotation={{
              x: mountainTransform.rotX,
              y: mountainTransform.rotY,
              z: mountainTransform.rotZ,
            }}
          />
          <GroundModel
            path={GROUND_PATH}
            align="top"
            scaleOverride={groundTransform.scale}
            position={{
              x: groundTransform.x,
              y: groundTransform.y,
              z: groundTransform.z,
            }}
            rotation={{
              x: groundTransform.rotX,
              y: groundTransform.rotY,
              z: groundTransform.rotZ,
            }}
          />
          <IglooModel
            path={IGLOO_PATH}
            color="#ffffff"
            debugTunnel={debugTunnel}
            interaction={interactionSettings}
            align="bottom"
            scaleOverride={iglooTransform.scale}
            position={{
              x: iglooTransform.x,
              y: iglooTransform.y,
              z: iglooTransform.z,
            }}
            rotation={{
              x: iglooTransform.rotX,
              y: iglooTransform.rotY,
              z: iglooTransform.rotZ,
            }}
          />
        </Suspense>
      </Canvas>
    </div>
  )
}
