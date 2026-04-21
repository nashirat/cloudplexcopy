import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import * as THREE from 'three'
import './IglooPage.css'

const IGLOO_PATH = '/igloo.drc'
const IGLOO_BASE_TEXTURE_PATH = '/igloo_color.ktx2'
const IGLOO_EXPLODED_TEXTURE_PATH = '/igloo_exploded_color.ktx2'
const DECODER_PATH = '/draco/'
const BASIS_PATH = '/basis/'

const DEFAULT_CAMERA = {
  x: 1.85,
  y: 1.15,
  z: 2.45,
  targetX: 0,
  targetY: 0.15,
  targetZ: 0,
  fov: 42,
}

const IGLOO_VERTEX_SHADER = `
  attribute float emission;

  varying vec2 vUv;
  varying vec3 vPos;
  varying float vDisplacement;
  varying float vBounce;
  varying float vEmission;

  uniform float uDisplacement;
  uniform float uBounce;

  void main() {
    vUv = uv;
    vEmission = emission;
    vDisplacement = uDisplacement;
    vBounce = uBounce;

    vec3 pos = (modelMatrix * vec4(position, 1.0)).xyz;
    vPos = pos;

    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`

const IGLOO_FRAGMENT_SHADER = `
  varying vec2 vUv;
  varying vec3 vPos;
  varying float vDisplacement;
  varying float vEmission;
  varying float vBounce;

  uniform sampler2D tMap;
  uniform sampler2D tMapExploded;
  uniform float uTime;
  uniform float uEmissionBoost;

  void main() {
    vec3 color = texture2D(tMap, vUv).rgb;
    vec3 exploded = texture2D(tMapExploded, vUv).rgb + 0.05;
    vec3 blue = vec3(0.5, 0.7, 1.0);

    float textureMix = clamp(5.0 * vDisplacement, 0.0, 1.0);
    color = mix(color, exploded, textureMix);

    color +=
      pow(vEmission, 2.0) *
      clamp(1.0 * vDisplacement, 0.0, 1.0) *
      blue *
      uEmissionBoost;

    vec3 powEmission = pow(vEmission, 8.0) * blue * 0.5 * uEmissionBoost;
    color += powEmission * (sin(vPos.x - uTime * 1.0 + 3.2) * 0.5 + 0.5);

    color += max(0.0, smoothstep(0.0, 2.0, vPos.x * 0.5 - vPos.z * 0.5)) * powEmission;

    color += (vPos.x * 0.1 + 0.4) * 0.3 * min(vPos.y + 0.5, 1.0) * 0.5;

    color = clamp(color, vec3(0.0), vec3(1.0));

    color += (1.0 - smoothstep(-1.5, 1.0, vPos.y)) * vBounce * vec3(0.8, 0.9, 1.0) * 0.25;

    gl_FragColor = vec4(color, 1.0);
  }
`

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
  const s = Math.sin(seed * 123.4567) * 43758.5453
  const x = s - Math.floor(s)
  const ySrc = Math.sin((seed + 1) * 678.9123) * 19642.349
  const y = ySrc - Math.floor(ySrc)
  const zSrc = Math.sin((seed + 2) * 345.6789) * 12345.678
  const z = zSrc - Math.floor(zSrc)
  return new THREE.Vector3(x, y, z)
}

const ensureEmissionAttribute = (geometry) => {
  if (geometry.getAttribute('emission')) return
  const count = geometry.getAttribute('position')?.count ?? 0
  const data = new Float32Array(count)
  geometry.setAttribute('emission', new THREE.BufferAttribute(data, 1))
}

const buildPieces = (geometry) => {
  geometry.computeBoundingBox()
  const globalBox = geometry.boundingBox
  if (!globalBox) {
    return {
      pieces: [],
      scale: 1,
      emissionStats: {
        sourceHasEmission: false,
        hasEmissionData: false,
        vertexCount: 0,
        nonZeroCount: 0,
        nonZeroRatio: 0,
        min: 0,
        max: 0,
      },
    }
  }

  const globalCenter = new THREE.Vector3()
  const globalSize = new THREE.Vector3()
  globalBox.getCenter(globalCenter)
  globalBox.getSize(globalSize)

  const maxAxis = Math.max(globalSize.x, globalSize.y, globalSize.z)
  const scale = maxAxis > 0 ? 1.6 / maxAxis : 1

  const positionAttr = geometry.getAttribute('position')
  if (!positionAttr) {
    return {
      pieces: [],
      scale,
      emissionStats: {
        sourceHasEmission: false,
        hasEmissionData: false,
        vertexCount: 0,
        nonZeroCount: 0,
        nonZeroRatio: 0,
        min: 0,
        max: 0,
      },
    }
  }

  const indexAttr = geometry.getIndex()
  const positions = positionAttr.array
  const vertexCount = positionAttr.count
  const faceCount = indexAttr
    ? Math.floor(indexAttr.count / 3)
    : Math.floor(vertexCount / 3)

  const attributes = Object.entries(geometry.attributes)
    .map(([name, attr]) => {
      if (!attr?.array || typeof attr.itemSize !== 'number') return null
      return {
        name,
        array: attr.array,
        itemSize: attr.itemSize,
        normalized: attr.normalized ?? false,
      }
    })
    .filter(Boolean)

  const sourceHasEmission = attributes.some((attr) => attr.name === 'emission')

  const parent = new Int32Array(vertexCount)
  const rank = new Int8Array(vertexCount)
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i

  const find = (x) => {
    let node = x
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]]
      node = parent[node]
    }
    return node
  }

  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    if (rank[ra] < rank[rb]) {
      parent[ra] = rb
      return
    }
    if (rank[ra] > rank[rb]) {
      parent[rb] = ra
      return
    }
    parent[rb] = ra
    rank[ra] += 1
  }

  const indexArray = indexAttr ? indexAttr.array : null
  for (let i = 0; i < faceCount; i += 1) {
    const base = i * 3
    const a = indexArray ? indexArray[base] : base
    const b = indexArray ? indexArray[base + 1] : base + 1
    const c = indexArray ? indexArray[base + 2] : base + 2
    union(a, b)
    union(b, c)
    union(c, a)
  }

  const keyMap = new Map()
  for (let i = 0; i < vertexCount; i += 1) {
    const base = i * 3
    const key = `${positions[base]},${positions[base + 1]},${positions[base + 2]}`
    const existing = keyMap.get(key)
    if (existing !== undefined) {
      union(i, existing)
    } else {
      keyMap.set(key, i)
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

  const pieces = []
  const emissionStats = {
    sourceHasEmission,
    vertexCount: 0,
    nonZeroCount: 0,
    min: Infinity,
    max: -Infinity,
  }
  let pieceIndex = 0

  for (const entry of componentMap.values()) {
    const remap = new Map()
    const localPositions = []
    const localIndices = []
    const attributeData = {}
    attributes.forEach((attr) => {
      attributeData[attr.name] = []
    })

    for (let i = 0; i < entry.indices.length; i += 1) {
      const originalIndex = entry.indices[i]
      let nextIndex = remap.get(originalIndex)
      if (nextIndex === undefined) {
        nextIndex = localPositions.length / 3
        remap.set(originalIndex, nextIndex)
        const pBase = originalIndex * 3
        localPositions.push(
          positions[pBase],
          positions[pBase + 1],
          positions[pBase + 2],
        )
        attributes.forEach((attr) => {
          const aBase = originalIndex * attr.itemSize
          for (let j = 0; j < attr.itemSize; j += 1) {
            attributeData[attr.name].push(attr.array[aBase + j])
          }
        })
      }
      localIndices.push(nextIndex)
    }

    const pieceGeometry = new THREE.BufferGeometry()
    pieceGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(localPositions, 3),
    )
    attributes.forEach((attr) => {
      if (attr.name === 'position') return
      const TypedArray = attr.array.constructor
      pieceGeometry.setAttribute(
        attr.name,
        new THREE.BufferAttribute(
          new TypedArray(attributeData[attr.name]),
          attr.itemSize,
          attr.normalized,
        ),
      )
    })
    pieceGeometry.setIndex(localIndices)
    if (!pieceGeometry.getAttribute('normal')) {
      pieceGeometry.computeVertexNormals()
    }

    ensureEmissionAttribute(pieceGeometry)
    const emissionAttr = pieceGeometry.getAttribute('emission')
    if (emissionAttr?.array) {
      const emissionArray = emissionAttr.array
      emissionStats.vertexCount += emissionArray.length
      for (let i = 0; i < emissionArray.length; i += 1) {
        const value = emissionArray[i]
        if (value !== 0) emissionStats.nonZeroCount += 1
        if (value < emissionStats.min) emissionStats.min = value
        if (value > emissionStats.max) emissionStats.max = value
      }
    }

    pieceGeometry.computeBoundingBox()
    const localCenter = new THREE.Vector3()
    pieceGeometry.boundingBox?.getCenter(localCenter)

    const centrAttr = pieceGeometry.getAttribute('centr')
    const centroid = centrAttr
      ? new THREE.Vector3(
          centrAttr.getX(0) - globalCenter.x,
          centrAttr.getY(0) - globalCenter.y,
          centrAttr.getZ(0) - globalCenter.z,
        )
      : localCenter.clone().sub(globalCenter)

    pieceGeometry.translate(-localCenter.x, -localCenter.y, -localCenter.z)

    const randAttr = pieceGeometry.getAttribute('rand')
    const rand = randAttr
      ? new THREE.Vector3(randAttr.getX(0), randAttr.getY(0), randAttr.getZ(0))
      : seededVec3(pieceIndex + 1)

    pieces.push({
      id: pieceIndex,
      geometry: pieceGeometry,
      centroid,
      yNorm: 0,
      rand,
      position: centroid.clone(),
      quaternion: new THREE.Quaternion(),
      targetDisplacement1: 0,
      targetDisplacement2: 0,
      targetBounce1: 0,
      targetBounce2: 0,
      displacement: 0,
      bounce: 0,
    })
    pieceIndex += 1
  }

  if (pieces.length > 0) {
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < pieces.length; i += 1) {
      const y = pieces[i].centroid.y
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const span = Math.max(1e-5, maxY - minY)
    for (let i = 0; i < pieces.length; i += 1) {
      pieces[i].yNorm = THREE.MathUtils.clamp(
        (pieces[i].centroid.y - minY) / span,
        0,
        1,
      )
    }
  }

  const hasEmissionData =
    emissionStats.sourceHasEmission && emissionStats.nonZeroCount > 0

  return {
    pieces,
    scale,
    emissionStats: {
      ...emissionStats,
      hasEmissionData,
      min: Number.isFinite(emissionStats.min) ? emissionStats.min : 0,
      max: Number.isFinite(emissionStats.max) ? emissionStats.max : 0,
      nonZeroRatio:
        emissionStats.vertexCount > 0
          ? emissionStats.nonZeroCount / emissionStats.vertexCount
          : 0,
    },
  }
}

function Igloo2Model({ onEmissionStats }) {
  const gl = useThree((state) => state.gl)
  const geometry = useLoader(DRACOLoader, IGLOO_PATH, (loader) => {
    loader.setDecoderPath(DECODER_PATH)
  })

  const [textures, setTextures] = useState(null)
  const groupRef = useRef(null)
  const meshRefs = useRef([])
  const pointerRef = useRef({ x: 0, y: 0, active: false })

  const plane = useMemo(() => new THREE.Plane(), [])
  const planeNormal = useMemo(() => new THREE.Vector3(), [])
  const pointerWorld = useMemo(() => new THREE.Vector3(), [])
  const worldCenter = useMemo(() => new THREE.Vector3(), [])
  const worldCenterNdc = useMemo(() => new THREE.Vector3(), [])
  const worldPiecePos = useMemo(() => new THREE.Vector3(), [])
  const ndcPos = useMemo(() => new THREE.Vector3(), [])
  const pointerNdc = useMemo(() => new THREE.Vector2(), [])
  const qTmp = useMemo(() => new THREE.Quaternion(), [])
  const axisX = useMemo(() => new THREE.Vector3(1, 0, 0), [])
  const axisY = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const axisZ = useMemo(() => new THREE.Vector3(0, 0, 1), [])

  const { pieces, scale, emissionStats } = useMemo(
    () => buildPieces(geometry),
    [geometry],
  )

  useEffect(() => {
    if (onEmissionStats) onEmissionStats(emissionStats)
    console.info('[igloo2] emission stats', emissionStats)
  }, [emissionStats, onEmissionStats])

  useEffect(() => {
    let cancelled = false
    const loader = new KTX2Loader()
    loader.setTranscoderPath(BASIS_PATH)
    loader.detectSupport(gl)

    Promise.all([
      loader.loadAsync(IGLOO_BASE_TEXTURE_PATH),
      loader.loadAsync(IGLOO_EXPLODED_TEXTURE_PATH),
    ])
      .then(([base, exploded]) => {
        if (cancelled) return
        base.colorSpace = THREE.SRGBColorSpace
        exploded.colorSpace = THREE.SRGBColorSpace
        base.needsUpdate = true
        exploded.needsUpdate = true
        setTextures({ base, exploded })
      })
      .catch((error) => {
        console.error('Failed to load igloo2 textures', error)
      })

    return () => {
      cancelled = true
      loader.dispose()
    }
  }, [gl])

  const materials = useMemo(() => {
    if (!textures) return []
    return pieces.map(() => {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          tMap: { value: textures.base },
          tMapExploded: { value: textures.exploded },
          uDisplacement: { value: 0 },
          uBounce: { value: 0 },
          uTime: { value: 0 },
          uEmissionBoost: { value: 10.0 },
        },
        vertexShader: IGLOO_VERTEX_SHADER,
        fragmentShader: IGLOO_FRAGMENT_SHADER,
      })
      return material
    })
  }, [pieces, textures])

  useEffect(
    () => () => {
      materials.forEach((material) => material.dispose())
    },
    [materials],
  )

  useEffect(() => {
    meshRefs.current.length = pieces.length
  }, [pieces.length])

  useEffect(() => {
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

    const onMove = (event) => updatePointer(event.clientX, event.clientY)
    const onLeave = () => {
      pointerRef.current.active = false
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerleave', onLeave)
    }
  }, [gl])

  useFrame((state, delta) => {
    const group = groupRef.current
    if (!group) return

    group.getWorldPosition(worldCenter)
    state.camera.getWorldDirection(planeNormal)
    plane.setFromNormalAndCoplanarPoint(planeNormal, worldCenter)
    pointerNdc.set(pointerRef.current.x, pointerRef.current.y)
    state.raycaster.setFromCamera(pointerNdc, state.camera)

    const hasPointer =
      pointerRef.current.active &&
      Boolean(state.raycaster.ray.intersectPlane(plane, pointerWorld))

    worldCenterNdc.copy(worldCenter).project(state.camera)
    const pointerToCenterNdc = Math.hypot(
      worldCenterNdc.x - pointerNdc.x,
      worldCenterNdc.y - pointerNdc.y,
    )
    const pointerNearModel = hasPointer && pointerToCenterNdc < 0.42
    const centerMask = 1.0 - smoothstep(0.2, 0.42, pointerToCenterNdc)

    for (let i = 0; i < meshRefs.current.length; i += 1) {
      const entry = meshRefs.current[i]
      if (!entry?.mesh || !entry.material) continue

      const piece = entry.piece
      const centroid = piece.centroid

      let displacement = 0.4
      displacement *= Math.sin(-state.clock.elapsedTime * 2 + centroid.x) * 0.5 + 0.5
      displacement *= Math.cos(-state.clock.elapsedTime) * 0.5 + 0.5
      displacement *= THREE.MathUtils.lerp(0.5, 2.0, piece.rand.z)
      displacement *= 0.5

      if (pointerNearModel) {
        entry.mesh.getWorldPosition(worldPiecePos)
        const worldDistance = worldPiecePos.distanceTo(pointerWorld)

        ndcPos.copy(worldPiecePos).project(state.camera)
        const ndcDistance = Math.hypot(
          ndcPos.x - pointerNdc.x,
          ndcPos.y - pointerNdc.y,
        )

        const c = Math.sin(state.clock.elapsedTime + piece.rand.x * 12.342) * piece.rand.y

        const hoverWorld = fit(
          smoothstep(0.22, 1.35, worldDistance),
          0,
          1,
          0.5 + 0.3 * c,
          0,
        )
        const hoverScreen = fit(
          smoothstep(0.02, 0.19, ndcDistance),
          0,
          1,
          0.65 + 0.35 * c,
          0,
        )

        const hover = Math.max(hoverWorld, hoverScreen) * centerMask
        displacement = Math.max(displacement, hover)
      }

      piece.targetBounce1 = displacement
      piece.targetBounce2 = lerpFps(piece.targetBounce2, piece.targetBounce1, 0.05, delta)
      piece.bounce = lerpFps(piece.bounce, piece.targetBounce2, 0.05, delta)

      const yMask = 0.55 + 0.45 * smoothstep(0.0, 0.45, piece.yNorm)
      displacement *= yMask
      displacement = Math.max(0, displacement)

      piece.targetDisplacement1 = displacement
      piece.targetDisplacement2 = lerpFps(
        piece.targetDisplacement2,
        piece.targetDisplacement1,
        0.06,
        delta,
      )
      piece.displacement = lerpFps(
        piece.displacement,
        piece.targetDisplacement2,
        0.06,
        delta,
      )

      piece.position.copy(centroid).addScaledVector(centroid, piece.displacement)

      const xRot =
        Math.cos(piece.displacement * 2 + piece.rand.y * 30) * piece.displacement * 0.5
      const yRot =
        Math.cos(piece.displacement * 2 + piece.rand.z * 30) * piece.displacement * 0.5
      const zRot =
        Math.cos(piece.displacement * 2 + piece.rand.x * 30) * piece.displacement * 0.5

      piece.quaternion.identity()
      qTmp.setFromAxisAngle(axisY, yRot)
      piece.quaternion.multiply(qTmp)
      qTmp.setFromAxisAngle(axisZ, zRot)
      piece.quaternion.multiply(qTmp)
      qTmp.setFromAxisAngle(axisX, xRot)
      piece.quaternion.multiply(qTmp)

      entry.mesh.position.copy(piece.position)
      entry.mesh.quaternion.copy(piece.quaternion)

      entry.material.uniforms.uDisplacement.value = piece.displacement
      entry.material.uniforms.uBounce.value = piece.bounce
      entry.material.uniforms.uTime.value = state.clock.elapsedTime
    }
  })

  return (
    <group ref={groupRef} scale={scale} position={[0, -0.1, 0]}>
      {pieces.map((piece) => (
        <mesh
          key={piece.id}
          geometry={piece.geometry}
          material={materials[piece.id]}
          position={piece.position}
          ref={(mesh) => {
            if (!mesh) {
              meshRefs.current[piece.id] = null
              return
            }
            mesh.position.copy(piece.position)
            meshRefs.current[piece.id] = {
              mesh,
              piece,
              material: materials[piece.id],
            }
          }}
        />
      ))}
    </group>
  )
}

export default function Igloo2Page() {
  const [emissionStats, setEmissionStats] = useState(null)

  return (
    <div className="igloo-page">
      <div className="igloo-overlay">
        <div className="igloo-kicker">App3D Style</div>
        <div className="igloo-title">Igloo 2</div>
        <div className="igloo-subtitle">
          Emission shader + displacement interaction reimplemented in source.
        </div>
        <div className="igloo-hint">
          Move your cursor near the igloo to trigger piece displacement and reveal
          inner glow.
        </div>
        {emissionStats ? (
          <div className="igloo-hint">
            Emission attr: {emissionStats.sourceHasEmission ? 'yes' : 'no'} | Non-zero:{' '}
            {emissionStats.nonZeroCount}/{emissionStats.vertexCount} (
            {(emissionStats.nonZeroRatio * 100).toFixed(1)}%) | Range:{' '}
            {emissionStats.min.toFixed(4)} to {emissionStats.max.toFixed(4)}
          </div>
        ) : null}
      </div>
      <Canvas
        className="igloo-canvas"
        camera={{
          position: [DEFAULT_CAMERA.x, DEFAULT_CAMERA.y, DEFAULT_CAMERA.z],
          fov: DEFAULT_CAMERA.fov,
        }}
        onCreated={({ camera }) => {
          camera.lookAt(
            DEFAULT_CAMERA.targetX,
            DEFAULT_CAMERA.targetY,
            DEFAULT_CAMERA.targetZ,
          )
          camera.updateMatrixWorld()
        }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#e8eef6']} />
        <ambientLight color="#f2f7ff" intensity={0.8} />
        <directionalLight color="#ffffff" position={[3, 4, 2]} intensity={1.3} />
        <directionalLight color="#dce7f7" position={[-2, 1, -2]} intensity={0.5} />
        <axesHelper args={[2]} />
        <Suspense fallback={null}>
          <Igloo2Model onEmissionStats={setEmissionStats} />
        </Suspense>
      </Canvas>
    </div>
  )
}
