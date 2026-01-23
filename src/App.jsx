import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree, extend } from '@react-three/fiber'
import { Center, Effects, Environment, useGLTF, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { UnrealBloomPass } from 'three-stdlib'
import settings from '../pocari-settings.json'
import './App.css'

extend({ UnrealBloomPass })

const DEFAULT_SCENE_SETTINGS = settings['pocari-scene-config']
const DEFAULT_LAYERS = settings['pocari-layer-config']

function useScreenSizeAtDepth(depth) {
  const { camera, size } = useThree()
  return useMemo(() => {
    const distance = Math.abs(camera.position.z - depth)
    const vFov = (camera.fov * Math.PI) / 180
    const height = 2 * Math.tan(vFov / 2) * distance
    const width = height * (size.width / size.height)
    return [width, height]
  }, [camera.fov, camera.position.z, depth, size.height, size.width])
}

function NumericInput({
  value,
  onChange,
  onKeyDown,
  step,
  min,
  max,
  type,
  ...rest
}) {
  const [text, setText] = useState(() => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
    return value ?? ''
  })

  useEffect(() => {
    const nextText =
      typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    setText(nextText)
  }, [value])

  const isPartial = (nextText) =>
    nextText === '' || nextText === '-' || nextText === '.' || nextText === '-.'

  const isValid = (nextText) => /^-?(?:\d+|\d*\.\d+)$/.test(nextText)

  const emitChange = (nextText) => {
    if (typeof onChange !== 'function') return
    onChange({ target: { value: nextText } })
  }

  const coerceNumber = (input, fallback) => {
    if (typeof input === 'number' && Number.isFinite(input)) return input
    const parsed = Number.parseFloat(String(input))
    return Number.isFinite(parsed) ? parsed : fallback
  }

  const handleStep = (direction) => {
    const stepValue = coerceNumber(step, 1)
    const baseValue = coerceNumber(text, coerceNumber(value, 0))
    const nextValue = baseValue + direction * stepValue
    const nextText = String(nextValue)
    setText(nextText)
    emitChange(nextText)
  }

  const handleChange = (event) => {
    const nextText = event.target.value
    setText(nextText)
  }

  const commitValue = (nextText) => {
    const trimmed = text.trim()
    const candidate = nextText !== undefined ? String(nextText).trim() : trimmed
    if (isPartial(candidate) || !isValid(candidate)) {
      const fallback =
        typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
      setText(fallback)
      return
    }
    const parsed = Number.parseFloat(candidate)
    const nextCommitted = Number.isFinite(parsed) ? String(parsed) : candidate
    setText(nextCommitted)
    emitChange(nextCommitted)
  }

  const handleBlur = () => {
    commitValue()
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitValue(event.target.value)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      const fallback =
        typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
      setText(fallback)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      handleStep(1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      handleStep(-1)
      return
    }
    if (typeof onKeyDown === 'function') {
      onKeyDown(event)
    }
  }

  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      value={text}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  )
}

function ImageLayer({ layer, onAutoFit, pivot = [0, 0, 0], lightDir }) {
  const texture = useTexture(layer.src)
  const [screenWidth, screenHeight] = useScreenSizeAtDepth(layer.z)
  const hasAutoFit = useRef(false)
  const meshRef = useRef(null)
  const driftTime = useRef(0)
  const scrollTime = useRef(0)
  const useCloudShading = layer.isCloud === true
  const useTextureWarp = layer.isCloud === true && layer.textureWarp !== false
  const materialRef = useRef(null)
  const shaderRef = useRef(null)

  useEffect(() => {
    if (!texture || !texture.isTexture) return
    const repeatX = layer.scrollRepeat ?? 1
    const shouldRepeat = repeatX > 1 || (layer.scrollSpeed ?? 0) !== 0
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = shouldRepeat
      ? THREE.RepeatWrapping
      : THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.repeat.set(repeatX, 1)
    texture.offset.set(layer.tileOffset ?? 0, 0)
    texture.needsUpdate = true
  }, [layer.scrollRepeat, layer.scrollSpeed, layer.tileOffset, texture])

  useEffect(() => {
    if (!shaderRef.current || !useCloudShading) return
    const texel = shaderRef.current.uniforms.uTexel?.value
    if (!texel || !texture?.image?.width || !texture?.image?.height) return
    texel.set(1 / texture.image.width, 1 / texture.image.height)
  }, [texture?.image?.height, texture?.image?.width, useCloudShading])

  const handleBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
    shader.uniforms.uLightDir = {
      value: new THREE.Vector3(
        lightDir?.[0] ?? 0,
        lightDir?.[1] ?? 0,
        lightDir?.[2] ?? 1,
      ),
    }
    shader.uniforms.uWrapAmount = { value: layer.wrapAmount ?? 0.35 }
    shader.uniforms.uWrapStrength = { value: layer.wrapStrength ?? 0.2 }
    shader.uniforms.uNormalStrength = { value: layer.normalStrength ?? 1.6 }
    const texel = new THREE.Vector2(1 / 512, 1 / 512)
    if (texture?.image?.width && texture?.image?.height) {
      texel.set(1 / texture.image.width, 1 / texture.image.height)
    }
    shader.uniforms.uTexel = { value: texel }

    if (useTextureWarp) {
      shader.uniforms.uWarpTime = { value: 0 }
      shader.uniforms.uWarpStrength = {
        value: layer.textureWarpStrength ?? 0.02,
      }
      shader.uniforms.uWarpScale = { value: layer.textureWarpScale ?? 1.6 }
      shader.uniforms.uWarpSpeed = { value: layer.textureWarpSpeed ?? 0.15 }
    }

    let fragment = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
uniform vec3 uLightDir;
uniform float uWrapAmount;
uniform float uWrapStrength;
uniform float uNormalStrength;
uniform vec2 uTexel;
${useTextureWarp ? `uniform float uWarpTime;
uniform float uWarpStrength;
uniform float uWarpScale;
uniform float uWarpSpeed;

float cloudHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float cloudNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = cloudHash(i);
  float b = cloudHash(i + vec2(1.0, 0.0));
  float c = cloudHash(i + vec2(0.0, 1.0));
  float d = cloudHash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float cloudFbm(vec2 p) {
  float v = 0.0;
  float a = 0.6;
  for (int i = 0; i < 4; i++) {
    v += a * cloudNoise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}
` : ''}
`,
    )

    if (useTextureWarp) {
      fragment = fragment.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  float t = uWarpTime * uWarpSpeed;
  vec2 cloudUv = vMapUv;
  vec2 p = cloudUv * uWarpScale;
  float bob = sin(t * 0.6);
  vec2 drift = vec2(0.0, bob * 0.5);
  float warpY = cloudFbm(p + drift + vec2(4.7, 9.2));
  vec2 warpOffset = vec2(0.0, (warpY - 0.5) * uWarpStrength);
  float edge = min(
    min(cloudUv.x, 1.0 - cloudUv.x),
    min(cloudUv.y, 1.0 - cloudUv.y)
  );
  float edgeMask = 1.0 - smoothstep(0.08, 0.3, edge);
  float edgeNoise = cloudFbm(p * 2.0 + vec2(12.3, t * 0.8));
  vec2 edgeOffset =
    vec2(0.0, (edgeNoise - 0.5) * uWarpStrength * 0.6) * edgeMask;
  cloudUv += warpOffset + edgeOffset;
  vec4 sampledDiffuseColor = texture2D( map, cloudUv );
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);
  #endif
  diffuseColor *= sampledDiffuseColor;
#endif
`,
      )
    } else {
      fragment = fragment.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec2 cloudUv = vMapUv;
  vec4 sampledDiffuseColor = texture2D( map, cloudUv );
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);
  #endif
  diffuseColor *= sampledDiffuseColor;
#endif
`,
      )
    }

    fragment = fragment.replace(
      '#include <output_fragment>',
      `#ifdef USE_MAP
  vec2 normalUv = cloudUv;
  float a = texture2D( map, normalUv ).a;
  float ax = texture2D( map, normalUv + vec2(uTexel.x, 0.0) ).a - texture2D( map, normalUv - vec2(uTexel.x, 0.0) ).a;
  float ay = texture2D( map, normalUv + vec2(0.0, uTexel.y) ).a - texture2D( map, normalUv - vec2(0.0, uTexel.y) ).a;
  vec3 n = normalize(vec3(-ax * uNormalStrength, -ay * uNormalStrength, 1.0));
  float ndotl = dot(n, normalize(uLightDir));
  float wrap = clamp((ndotl + uWrapAmount) / (1.0 + uWrapAmount), 0.0, 1.0);
  outgoingLight += diffuseColor.rgb * wrap * uWrapStrength;
#endif
  #include <output_fragment>
`,
    )

    shader.fragmentShader = fragment
    shaderRef.current = shader
  }

  useEffect(() => {
    if (materialRef.current && useCloudShading) {
      materialRef.current.onBeforeCompile = handleBeforeCompile
      materialRef.current.customProgramCacheKey = () =>
        `cloud-${useTextureWarp ? 'warp' : 'base'}`
      materialRef.current.needsUpdate = true
    }
  }, [useCloudShading, useTextureWarp])


  useEffect(() => {
    if (!layer.autoFit || hasAutoFit.current) return
    const image = texture.image
    if (!image || !image.width || !image.height) return
    const aspect = image.width / image.height
    let width = screenWidth
    let height = width / aspect

    if (layer.autoFit === 'cover') {
      const coverHeight = screenHeight
      const coverWidth = coverHeight * aspect
      if (coverWidth < screenWidth) {
        width = screenWidth
        height = width / aspect
      } else {
        width = coverWidth
        height = coverHeight
      }
    }

    onAutoFit(layer.id, {
      width,
      height,
      autoFit: null,
    })
    hasAutoFit.current = true
  }, [layer.autoFit, layer.id, onAutoFit, screenHeight, screenWidth, texture.image])

  useEffect(() => {
    if (!meshRef.current) return
    meshRef.current.position.set(
      layer.x - pivot[0],
      layer.y - pivot[1],
      layer.z - pivot[2],
    )
  }, [layer.x, layer.y, layer.z, pivot])

  useFrame((_, delta) => {
    const speed = layer.driftSpeed ?? 0
    const range = layer.driftRange ?? 0
    driftTime.current += delta
    const scrollSpeed = layer.scrollSpeed ?? 0
    if (
      meshRef.current &&
      speed !== 0 &&
      range !== 0 &&
      scrollSpeed === 0
    ) {
      const offset =
        Math.sin(driftTime.current * speed * Math.PI * 2) * range
      meshRef.current.position.x = layer.x - pivot[0] + offset
    }

    if (texture && texture.isTexture && scrollSpeed !== 0) {
      scrollTime.current += delta
      const baseOffset = layer.tileOffset ?? 0
      const nextOffset = baseOffset + scrollTime.current * scrollSpeed
      texture.offset.x = ((nextOffset % 1) + 1) % 1
    }
    if (useCloudShading && shaderRef.current) {
      const shader = shaderRef.current
      if (shader.uniforms.uLightDir?.value && lightDir) {
        shader.uniforms.uLightDir.value.set(
          lightDir[0] ?? 0,
          lightDir[1] ?? 0,
          lightDir[2] ?? 1,
        )
      }
      shader.uniforms.uWrapAmount.value = layer.wrapAmount ?? 0.35
      shader.uniforms.uWrapStrength.value = layer.wrapStrength ?? 0.2
      shader.uniforms.uNormalStrength.value = layer.normalStrength ?? 1.6
      if (useTextureWarp) {
        shader.uniforms.uWarpTime.value += delta
        shader.uniforms.uWarpStrength.value =
          layer.textureWarpStrength ?? 0.02
        shader.uniforms.uWarpScale.value = layer.textureWarpScale ?? 1.6
        shader.uniforms.uWarpSpeed.value = layer.textureWarpSpeed ?? 0.15
      }
    }
  })

  const blendMode =
    layer.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending

  return (
    <group
      ref={meshRef}
      position={[
        layer.x - pivot[0],
        layer.y - pivot[1],
        layer.z - pivot[2],
      ]}
    >
      <mesh
        scale={[layer.width, layer.height, 1]}
        renderOrder={layer.renderOrder ?? 0}
      >
        <planeGeometry args={[1, 1]} />
        {layer.lit ? (
          <meshStandardMaterial
            ref={materialRef}
            map={texture}
            transparent={layer.transparent}
            opacity={layer.opacity}
            depthWrite={layer.depthWrite}
            alphaTest={layer.alphaTest}
            blending={blendMode}
            toneMapped={layer.toneMapped ?? true}
            emissive="#ffffff"
            emissiveIntensity={0.2}
            color="#ffffff"
            onBeforeCompile={useCloudShading ? handleBeforeCompile : undefined}
          />
        ) : (
          <meshBasicMaterial
            ref={materialRef}
            map={texture}
            transparent={layer.transparent}
            opacity={layer.opacity}
            depthWrite={layer.depthWrite}
            alphaTest={layer.alphaTest}
            blending={blendMode}
            toneMapped={layer.toneMapped ?? false}
            color="#ffffff"
            onBeforeCompile={useCloudShading ? handleBeforeCompile : undefined}
          />
        )}
      </mesh>
    </group>
  )
}

function FogLayer({ layer, pivot = [0, 0, 0] }) {
  const uniforms = useRef({
    uTime: { value: 0 },
    uColor: { value: new THREE.Color('#ffffff') },
    uOpacity: { value: 0.5 },
    uScale: { value: 3 },
    uSpeed: { value: 0.03 },
    uMorph: { value: 1 },
    uClump: { value: 0 },
    uEdgeInset: { value: 0 },
  })

  useEffect(() => {
    uniforms.current.uColor.value.set(layer.fogColor ?? '#ffffff')
    uniforms.current.uOpacity.value = layer.opacity ?? 0.5
    uniforms.current.uScale.value = layer.fogScale ?? 3
    uniforms.current.uSpeed.value = layer.fogSpeed ?? 0.03
    uniforms.current.uMorph.value = layer.fogMorph ?? 1
    uniforms.current.uClump.value = layer.fogClump ?? 0
    uniforms.current.uEdgeInset.value = layer.fogEdgeInset ?? 0
  }, [
    layer.fogColor,
    layer.fogScale,
    layer.fogSpeed,
    layer.fogMorph,
    layer.opacity,
    layer.fogClump,
    layer.fogEdgeInset,
  ])

  useFrame((_, delta) => {
    uniforms.current.uTime.value += delta
  })

  return (
    <mesh
      position={[
        layer.x - pivot[0],
        layer.y - pivot[1],
        layer.z - pivot[2],
      ]}
      scale={[layer.width, layer.height, 1]}
      renderOrder={layer.renderOrder ?? 0}
    >
      <planeGeometry args={[1, 1]} />
      <shaderMaterial
        transparent
        depthWrite={false}
        uniforms={uniforms.current}
        vertexShader={`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          varying vec2 vUv;
          uniform float uTime;
          uniform vec3 uColor;
          uniform float uOpacity;
          uniform float uScale;
          uniform float uSpeed;
          uniform float uMorph;
          uniform float uClump;
          uniform float uEdgeInset;

          float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
          }

          float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
          }

          float fbm(vec2 p) {
            float v = 0.0;
            float a = 0.55;
            for (int i = 0; i < 5; i++) {
              v += a * noise(p);
              p *= 1.9;
              a *= 0.52;
            }
            return v;
          }

          float worley(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            float d = 1.0;
            for (int y = -1; y <= 1; y++) {
              for (int x = -1; x <= 1; x++) {
                vec2 neighbor = vec2(float(x), float(y));
                vec2 point = vec2(
                  hash(i + neighbor),
                  hash(i + neighbor + 13.37)
                );
                vec2 diff = neighbor + point - f;
                d = min(d, length(diff));
              }
            }
            return d;
          }

          float multiWorley(vec2 p) {
            float c1 = worley(p);
            float c2 = worley(p * 0.6 + 4.2);
            float c3 = worley(p * 1.1 - 2.1);
            float m1 = 1.0 - smoothstep(0.4, 0.95, c1);
            float m2 = 1.0 - smoothstep(0.45, 0.95, c2);
            float m3 = 1.0 - smoothstep(0.45, 0.9, c3);
            return (m1 * 0.7) + (m2 * 0.4) + (m3 * 0.2);
          }

          void main() {
            float t = uTime * uSpeed;
            float m = uTime * uMorph;
            vec2 uv = vUv * uScale;
            uv.x -= t * 0.35;
            vec2 warp = vec2(
              fbm(uv * 0.25 + vec2(m * 0.25, -m * 0.18)),
              fbm(uv * 0.25 + vec2(-m * 0.18, m * 0.22))
            );
            uv += (warp - 0.5) * 0.8;
            float clumpScale = mix(1.0, 0.55, uClump);
            vec2 clumpUv = uv * clumpScale;
            float blobs = multiWorley(clumpUv * 0.55 + m * 0.08);
            float puff = smoothstep(0.2, 0.9, fbm(clumpUv * 0.4 - m * 0.12));
            float threshold = mix(0.12, 0.2, uClump);
            float cloud = smoothstep(threshold, 0.95, blobs * puff);
            float column = fbm(vec2(vUv.x * 0.7 + m * 0.05, 0.0));
            float height = mix(0.5, 0.8, column);
            float columnMask = 1.0 - smoothstep(height - 0.08, height + 0.08, vUv.y);
            float edgeSoftness = 0.08;
            float edgeX =
              smoothstep(uEdgeInset, uEdgeInset + edgeSoftness, vUv.x) *
              smoothstep(uEdgeInset, uEdgeInset + edgeSoftness, 1.0 - vUv.x);
            float edgeY =
              smoothstep(uEdgeInset, uEdgeInset + edgeSoftness, vUv.y) *
              smoothstep(uEdgeInset, uEdgeInset + edgeSoftness, 1.0 - vUv.y);
            float insetEnabled = step(0.001, uEdgeInset);
            float edgeFade = mix(edgeY, edgeX * edgeY, insetEnabled);
            vec2 centered = vUv - 0.5;
            vec2 aspect = vec2(1.0, 0.9);
            float dist = length(centered / aspect);
            float radius = 0.5 - uEdgeInset;
            float roundMask = 1.0 - smoothstep(radius - 0.07, radius + 0.07, dist);
            float clumpMask = mix(1.0, roundMask, uClump);
            float alpha = cloud * uOpacity * edgeFade * columnMask * clumpMask;
            gl_FragColor = vec4(uColor, alpha);
          }
        `}
      />
    </mesh>
  )
}

function ModelLayer({ layer, pivot = [0, 0, 0] }) {
  const { scene } = useGLTF(layer.src)
  const rotation = useMemo(() => {
    const rotX = THREE.MathUtils.degToRad(layer.rotX ?? 0)
    const rotY = THREE.MathUtils.degToRad(layer.rotY ?? 0)
    const rotZ = THREE.MathUtils.degToRad(layer.rotZ ?? 0)
    return [rotX, rotY, rotZ]
  }, [layer.rotX, layer.rotY, layer.rotZ])

  useEffect(() => {
    const intensity =
      typeof layer.envIntensity === 'number' ? layer.envIntensity : 1
    scene.traverse((child) => {
      if (!child.isMesh || !child.material) return
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material]
      materials.forEach((material) => {
        if (
          material.isMeshStandardMaterial ||
          material.isMeshPhysicalMaterial
        ) {
          material.envMapIntensity = intensity
        }
      })
    })
  }, [layer.envIntensity, scene])

  return (
    <group
      position={[
        layer.x - pivot[0],
        layer.y - pivot[1],
        layer.z - pivot[2],
      ]}
      scale={[layer.scale, layer.scale, layer.scale]}
      rotation={rotation}
      renderOrder={layer.renderOrder ?? 0}
    >
      <Center>
        <primitive object={scene} />
      </Center>
    </group>
  )
}

function LayerItem({ layer, onAutoFit, pivot = [0, 0, 0], lightDir }) {
  if (layer.kind === 'model') {
    return <ModelLayer layer={layer} pivot={pivot} />
  }
  if (layer.kind === 'fog') {
    return <FogLayer layer={layer} pivot={pivot} />
  }
  return (
    <ImageLayer
      layer={layer}
      onAutoFit={onAutoFit}
      pivot={pivot}
      lightDir={lightDir}
    />
  )
}

function CameraRig({ position, rotationDeg, fov }) {
  const { camera } = useThree()
  const rotation = useMemo(
    () => rotationDeg.map((value) => THREE.MathUtils.degToRad(value)),
    [rotationDeg],
  )

  useEffect(() => {
    camera.position.set(position[0], position[1], position[2])
    camera.rotation.set(rotation[0], rotation[1], rotation[2])
    camera.fov = fov
    camera.updateProjectionMatrix()
  }, [camera, fov, position, rotation])

  return null
}

function SceneRig({ pivot, maxYawDeg, maxPitchDeg, enabled, children }) {
  const groupRef = useRef(null)
  const { pointer } = useThree()
  const maxYaw = THREE.MathUtils.degToRad(maxYawDeg)
  const maxPitch = THREE.MathUtils.degToRad(maxPitchDeg)

  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.rotation.set(0, 0, 0)
    }
  }, [])

  useFrame((_, delta) => {
    if (!groupRef.current) return
    const targetY = enabled
      ? THREE.MathUtils.clamp(pointer.x, -1, 1) * maxYaw
      : 0
    const targetX = enabled
      ? THREE.MathUtils.clamp(-pointer.y, -1, 1) * maxPitch
      : 0
    const lerpFactor = 1 - Math.exp(-delta * 5)
    groupRef.current.rotation.y = THREE.MathUtils.lerp(
      groupRef.current.rotation.y,
      targetY,
      lerpFactor,
    )
    groupRef.current.rotation.x = THREE.MathUtils.lerp(
      groupRef.current.rotation.x,
      targetX,
      lerpFactor,
    )
  })

  return (
    <group ref={groupRef} position={pivot}>
      {children}
    </group>
  )
}

function LightMarker({ position, color, size }) {
  return (
    <mesh position={position} renderOrder={1000}>
      <sphereGeometry args={[size, 32, 32]} />
      <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
  )
}

function DirectionalLightRig({ settings, target }) {
  const targetObject = useMemo(() => new THREE.Object3D(), [])

  return (
    <>
      <directionalLight
        position={[settings.lightX, settings.lightY, settings.lightZ]}
        intensity={settings.lightIntensity}
        color={settings.lightColor}
        target={targetObject}
      />
      <primitive object={targetObject} position={target} />
      {settings.showLightMarker ? (
        <LightMarker
          position={[settings.lightX, settings.lightY, settings.lightZ]}
          color={settings.lightColor}
          size={settings.lightMarkerSize}
        />
      ) : null}
    </>
  )
}

function SpotLightRig({ settings }) {
  const targetObject = useMemo(() => new THREE.Object3D(), [])

  return (
    <>
      <spotLight
        position={[settings.spotX, settings.spotY, settings.spotZ]}
        intensity={settings.spotIntensity}
        color={settings.spotColor}
        angle={THREE.MathUtils.degToRad(settings.spotAngle)}
        penumbra={settings.spotPenumbra}
        target={targetObject}
      />
      <primitive
        object={targetObject}
        position={[
          settings.spotTargetX,
          settings.spotTargetY,
          settings.spotTargetZ,
        ]}
      />
      {settings.showSpotMarker ? (
        <LightMarker
          position={[settings.spotX, settings.spotY, settings.spotZ]}
          color={settings.spotColor}
          size={settings.spotMarkerSize}
        />
      ) : null}
    </>
  )
}

function SubtleBloom({ settings }) {
  const { size } = useThree()
  const bloomActive = settings.bloomEnabled && settings.bloomStrength > 0
  const resolution = useMemo(
    () => new THREE.Vector2(size.width, size.height),
    [size.height, size.width],
  )

  if (!bloomActive) return null

  return (
    <Effects disableGamma>
      <unrealBloomPass
        args={[
          resolution,
          settings.bloomStrength,
          settings.bloomRadius,
          settings.bloomThreshold,
        ]}
        key={`bloom-${size.width}-${size.height}-${settings.bloomStrength}-${settings.bloomRadius}-${settings.bloomThreshold}`}
      />
    </Effects>
  )
}

function App() {
  const [controlsOpen, setControlsOpen] = useState(true)
  const showControls = false
  const [layers, setLayers] = useState(() =>
    DEFAULT_LAYERS.map((layer) => ({ ...layer })),
  )

  const updateLayer = (id, key, value) => {
    setLayers((prevLayers) =>
      prevLayers.map((layer) =>
        layer.id === id ? { ...layer, [key]: value } : layer,
      ),
    )
  }

  const updateLayerValues = (id, updates) => {
    setLayers((prevLayers) =>
      prevLayers.map((layer) =>
        layer.id === id ? { ...layer, ...updates } : layer,
      ),
    )
  }

  const getLayerAspect = (layer) => {
    const width = Number(layer.width ?? 1)
    const height = Number(layer.height ?? 1)
    if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) {
      return 1
    }
    return width / height
  }

  const [sceneSettings, setSceneSettings] = useState(() => ({
    ...DEFAULT_SCENE_SETTINGS,
  }))

  const handleAutoFit = (id, updates) => {
    setLayers((prevLayers) =>
      prevLayers.map((layer) =>
        layer.id === id ? { ...layer, ...updates } : layer,
      ),
    )
  }

  const autoPivotZ = useMemo(() => {
    if (!layers.length) return 0
    const zs = layers.map((layer) => layer.z)
    return (Math.min(...zs) + Math.max(...zs)) / 2
  }, [layers])

  const pivot = useMemo(() => {
    if (!sceneSettings.pivotAuto) {
      return [sceneSettings.pivotX, sceneSettings.pivotY, sceneSettings.pivotZ]
    }
    return [0, 0, autoPivotZ]
  }, [
    autoPivotZ,
    sceneSettings.pivotAuto,
    sceneSettings.pivotX,
    sceneSettings.pivotY,
    sceneSettings.pivotZ,
  ])

  const buildingTarget = useMemo(() => {
    const building = layers.find((layer) => layer.id === 'building')
    if (!building) return [0, -1.4, -4.6]
    return [building.x, building.y, building.z]
  }, [layers])

  const lightDir = useMemo(() => {
    const target = new THREE.Vector3(
      buildingTarget[0],
      buildingTarget[1],
      buildingTarget[2],
    )
    const dir = new THREE.Vector3(
      sceneSettings.lightX,
      sceneSettings.lightY,
      sceneSettings.lightZ,
    )
      .sub(target)
      .normalize()
    return [dir.x, dir.y, dir.z]
  }, [
    buildingTarget,
    sceneSettings.lightX,
    sceneSettings.lightY,
    sceneSettings.lightZ,
  ])

  const tiltingLayers = useMemo(
    () => layers.filter((layer) => layer.tiltEnabled !== false),
    [layers],
  )

  const staticLayers = useMemo(
    () => layers.filter((layer) => layer.tiltEnabled === false),
    [layers],
  )

  return (
    <div className="app">
      {showControls ? (
        <>
      <button
        type="button"
        className="controls-toggle"
        onClick={() => setControlsOpen((prev) => !prev)}
      >
        {controlsOpen ? 'Hide settings' : 'Show settings'}
      </button>
      <div className={`controls${controlsOpen ? '' : ' controls--hidden'}`}>
        <details className="control-group">
          <summary>
            <span className="control-title">Storage</span>
            <span className="control-subtitle">export</span>
          </summary>
          <div className="control-fields">
            <button
              type="button"
              className="control-button"
              onClick={handleExportSettings}
            >
              Export settings
            </button>
          </div>
        </details>
        <details className="control-group">
          <summary>
            <span className="control-title">Scene</span>
            <span className="control-subtitle">tilt limits</span>
          </summary>
          <div className="control-fields">
            <button
              type="button"
              className="control-button"
              onClick={() =>
                setSceneSettings((prev) => ({
                  ...prev,
                  enabled: !prev.enabled,
                }))
              }
            >
              {sceneSettings.enabled ? 'Disable movement' : 'Enable movement'}
            </button>
            <label>
              Max Yaw (deg)
              <NumericInput
                type="number"
                step="0.1"
                min="0"
                value={sceneSettings.maxYawDeg}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    maxYawDeg: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Max Pitch (deg)
              <NumericInput
                type="number"
                step="0.1"
                min="0"
                value={sceneSettings.maxPitchDeg}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    maxPitchDeg: Number(event.target.value),
                  }))
                }
              />
            </label>
            <button
              type="button"
              className="control-button"
              onClick={() =>
                setSceneSettings((prev) => ({
                  ...prev,
                  pivotAuto: !prev.pivotAuto,
                }))
              }
            >
              {sceneSettings.pivotAuto ? 'Use manual pivot' : 'Use auto pivot'}
            </button>
            <label>
              Pivot X
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.pivotX}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    pivotX: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Pivot Y
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.pivotY}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    pivotY: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Pivot Z
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.pivotZ}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    pivotZ: Number(event.target.value),
                  }))
                }
              />
            </label>
          </div>
        </details>
        <details className="control-group">
          <summary>
            <span className="control-title">Camera</span>
            <span className="control-subtitle">position</span>
          </summary>
          <div className="control-fields">
            <label>
              X
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.camX}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    camX: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Y
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.camY}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    camY: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Z
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.camZ}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    camZ: Number(event.target.value),
                  }))
                }
              />
            </label>
            <div className="control-divider">Rotation</div>
            <label>
              Rot X (deg)
              <NumericInput
                type="number"
                step="1"
                value={sceneSettings.camRotX}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    camRotX: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Rot Y (deg)
              <NumericInput
                type="number"
                step="1"
                value={sceneSettings.camRotY}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    camRotY: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Rot Z (deg)
              <NumericInput
                type="number"
                step="1"
                value={sceneSettings.camRotZ}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    camRotZ: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              FOV
              <NumericInput
                type="number"
                step="1"
                min="10"
                max="120"
                value={sceneSettings.camFov}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    camFov: Number(event.target.value),
                  }))
                }
              />
            </label>
          </div>
        </details>
        <details className="control-group">
          <summary>
            <span className="control-title">Directional Light</span>
            <span className="control-subtitle">single</span>
          </summary>
          <div className="control-fields">
            <label>
              Ambient Intensity
              <NumericInput
                type="number"
                step="0.05"
                min="0"
                value={sceneSettings.ambientIntensity}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    ambientIntensity: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Intensity
              <NumericInput
                type="number"
                step="0.05"
                min="0"
                value={sceneSettings.lightIntensity}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    lightIntensity: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Color
              <input
                type="color"
                value={sceneSettings.lightColor}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    lightColor: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              X
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.lightX}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    lightX: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Y
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.lightY}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    lightY: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Z
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.lightZ}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    lightZ: Number(event.target.value),
                  }))
                }
              />
            </label>
            <button
              type="button"
              className="control-button"
              onClick={() =>
                setSceneSettings((prev) => ({
                  ...prev,
                  showLightMarker: !prev.showLightMarker,
                }))
              }
            >
              {sceneSettings.showLightMarker
                ? 'Hide light marker'
                : 'Show light marker'}
            </button>
            <label>
              Marker Size
              <NumericInput
                type="number"
                step="0.05"
                min="0.05"
                value={sceneSettings.lightMarkerSize}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    lightMarkerSize: Number(event.target.value),
                  }))
                }
              />
            </label>
          </div>
        </details>
        <details className="control-group">
          <summary>
            <span className="control-title">Spotlight</span>
            <span className="control-subtitle">focus</span>
          </summary>
          <div className="control-fields">
            <label>
              Intensity
              <NumericInput
                type="number"
                step="0.1"
                min="0"
                value={sceneSettings.spotIntensity}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotIntensity: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Color
              <input
                type="color"
                value={sceneSettings.spotColor}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotColor: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              X
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.spotX}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotX: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Y
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.spotY}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotY: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Z
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.spotZ}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotZ: Number(event.target.value),
                  }))
                }
              />
            </label>
            <div className="control-divider">Target</div>
            <label>
              Target X
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.spotTargetX}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotTargetX: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Target Y
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.spotTargetY}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotTargetY: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Target Z
              <NumericInput
                type="number"
                step="0.1"
                value={sceneSettings.spotTargetZ}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotTargetZ: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Angle (deg)
              <NumericInput
                type="number"
                step="1"
                min="1"
                max="80"
                value={sceneSettings.spotAngle}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotAngle: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Penumbra
              <NumericInput
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={sceneSettings.spotPenumbra}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotPenumbra: Number(event.target.value),
                  }))
                }
              />
            </label>
            <button
              type="button"
              className="control-button"
              onClick={() =>
                setSceneSettings((prev) => ({
                  ...prev,
                  showSpotMarker: !prev.showSpotMarker,
                }))
              }
            >
              {sceneSettings.showSpotMarker
                ? 'Hide spot marker'
                : 'Show spot marker'}
            </button>
            <label>
              Marker Size
              <NumericInput
                type="number"
                step="0.05"
                min="0.05"
                value={sceneSettings.spotMarkerSize}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    spotMarkerSize: Number(event.target.value),
                  }))
                }
              />
            </label>
          </div>
        </details>
        <details className="control-group">
          <summary>
            <span className="control-title">Bloom</span>
            <span className="control-subtitle">subtle</span>
          </summary>
          <div className="control-fields">
            <button
              type="button"
              className="control-button"
              onClick={() =>
                setSceneSettings((prev) => ({
                  ...prev,
                  bloomEnabled: !prev.bloomEnabled,
                }))
              }
            >
              {sceneSettings.bloomEnabled ? 'Disable bloom' : 'Enable bloom'}
            </button>
            <label>
              Strength
              <NumericInput
                type="number"
                step="0.001"
                value={sceneSettings.bloomStrength}
                disabled={!sceneSettings.bloomEnabled}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    bloomStrength: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Radius
              <NumericInput
                type="number"
                step="0.001"
                value={sceneSettings.bloomRadius}
                disabled={!sceneSettings.bloomEnabled}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    bloomRadius: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Threshold
              <NumericInput
                type="number"
                step="0.001"
                value={sceneSettings.bloomThreshold}
                disabled={!sceneSettings.bloomEnabled}
                onChange={(event) =>
                  setSceneSettings((prev) => ({
                    ...prev,
                    bloomThreshold: Number(event.target.value),
                  }))
                }
              />
            </label>
          </div>
        </details>
        {layers.map((layer) => (
          <details key={layer.id} className="control-group">
            <summary>
              <span className="control-title">{layer.label}</span>
              <span className="control-subtitle">
                z {layer.z.toFixed(1)}
                {layer.kind === 'model' ? ' • 3D' : ''}
              </span>
            </summary>
            <div className="control-fields">
              <button
                type="button"
                className="control-button"
                onClick={() =>
                  updateLayer(
                    layer.id,
                    'tiltEnabled',
                    layer.tiltEnabled === false,
                  )
                }
              >
                {layer.tiltEnabled === false ? 'Enable tilt' : 'Disable tilt'}
              </button>
              <label>
                X
                <NumericInput
                  type="number"
                  step="0.1"
                  value={layer.x}
                  onChange={(event) =>
                    updateLayer(layer.id, 'x', Number(event.target.value))
                  }
                />
              </label>
              <label>
                Y
                <NumericInput
                  type="number"
                  step="0.1"
                  value={layer.y}
                  onChange={(event) =>
                    updateLayer(layer.id, 'y', Number(event.target.value))
                  }
                />
              </label>
              <label>
                Z
                <NumericInput
                  type="number"
                  step="0.1"
                  value={layer.z}
                  onChange={(event) =>
                    updateLayer(layer.id, 'z', Number(event.target.value))
                  }
                />
              </label>
              {layer.kind === 'model' ? (
                <>
                  <label>
                    Scale
                    <NumericInput
                      type="number"
                      step="0.05"
                      min="0.01"
                      value={layer.scale ?? 1}
                      onChange={(event) =>
                        updateLayer(layer.id, 'scale', Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    Env Intensity
                    <NumericInput
                      type="number"
                      step="0.1"
                      min="0"
                      value={layer.envIntensity ?? 1}
                      onChange={(event) =>
                        updateLayer(
                          layer.id,
                          'envIntensity',
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    Rot X (deg)
                    <NumericInput
                      type="number"
                      step="1"
                      value={layer.rotX ?? 0}
                      onChange={(event) =>
                        updateLayer(layer.id, 'rotX', Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    Rot Y (deg)
                    <NumericInput
                      type="number"
                      step="1"
                      value={layer.rotY ?? 0}
                      onChange={(event) =>
                        updateLayer(layer.id, 'rotY', Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    Rot Z (deg)
                    <NumericInput
                      type="number"
                      step="1"
                      value={layer.rotZ ?? 0}
                      onChange={(event) =>
                        updateLayer(layer.id, 'rotZ', Number(event.target.value))
                      }
                    />
                  </label>
                </>
              ) : layer.kind === 'fog' ? (
                <>
                  <button
                    type="button"
                    className="control-button"
                    onClick={() => {
                      const nextLock = !layer.lockAspect
                      if (!nextLock) {
                        updateLayerValues(layer.id, {
                          lockAspect: false,
                          aspect: undefined,
                        })
                        return
                      }
                      const aspect = getLayerAspect(layer)
                      updateLayerValues(layer.id, {
                        lockAspect: true,
                        aspect,
                      })
                    }}
                  >
                    {layer.lockAspect ? 'Unlock aspect' : 'Lock aspect'}
                  </button>
                  <label>
                    Width
                    <NumericInput
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={layer.width}
                      onChange={(event) => {
                        const nextWidth = Number(event.target.value)
                        if (layer.lockAspect) {
                          const aspect = layer.aspect ?? getLayerAspect(layer)
                          updateLayerValues(layer.id, {
                            width: nextWidth,
                            height: aspect ? nextWidth / aspect : layer.height,
                            aspect,
                          })
                          return
                        }
                        updateLayerValues(layer.id, { width: nextWidth })
                      }}
                    />
                  </label>
                  <label>
                    Height
                    <NumericInput
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={layer.height}
                      onChange={(event) => {
                        const nextHeight = Number(event.target.value)
                        if (layer.lockAspect) {
                          const aspect = layer.aspect ?? getLayerAspect(layer)
                          updateLayerValues(layer.id, {
                            height: nextHeight,
                            width: aspect ? nextHeight * aspect : layer.width,
                            aspect,
                          })
                          return
                        }
                        updateLayerValues(layer.id, { height: nextHeight })
                      }}
                    />
                  </label>
                  <label>
                    Color
                    <input
                      type="color"
                      value={layer.fogColor ?? '#ffffff'}
                      onChange={(event) =>
                        updateLayer(layer.id, 'fogColor', event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Opacity
                    <NumericInput
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={layer.opacity ?? 0.5}
                      onChange={(event) =>
                        updateLayer(layer.id, 'opacity', Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    Noise Scale
                    <NumericInput
                      type="number"
                      step="0.1"
                      min="0.5"
                      value={layer.fogScale ?? 3}
                      onChange={(event) =>
                        updateLayer(
                          layer.id,
                          'fogScale',
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    Speed
                    <NumericInput
                      type="number"
                      step="0.005"
                      value={layer.fogSpeed ?? 0.03}
                      onChange={(event) =>
                        updateLayer(
                          layer.id,
                          'fogSpeed',
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    Morph Speed
                    <NumericInput
                      type="number"
                      step="0.1"
                      min="0"
                      value={layer.fogMorph ?? 1}
                      onChange={(event) =>
                        updateLayer(
                          layer.id,
                          'fogMorph',
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="control-button"
                    onClick={() => {
                      const nextLock = !layer.lockAspect
                      if (!nextLock) {
                        updateLayerValues(layer.id, {
                          lockAspect: false,
                          aspect: undefined,
                        })
                        return
                      }
                      const aspect = getLayerAspect(layer)
                      updateLayerValues(layer.id, {
                        lockAspect: true,
                        aspect,
                      })
                    }}
                  >
                    {layer.lockAspect ? 'Unlock aspect' : 'Lock aspect'}
                  </button>
                  <label>
                    Width
                    <NumericInput
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={layer.width}
                      onChange={(event) => {
                        const nextWidth = Number(event.target.value)
                        if (layer.lockAspect) {
                          const aspect = layer.aspect ?? getLayerAspect(layer)
                          updateLayerValues(layer.id, {
                            width: nextWidth,
                            height: aspect ? nextWidth / aspect : layer.height,
                            aspect,
                          })
                          return
                        }
                        updateLayerValues(layer.id, { width: nextWidth })
                      }}
                    />
                  </label>
                  <label>
                    Height
                    <NumericInput
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={layer.height}
                      onChange={(event) => {
                        const nextHeight = Number(event.target.value)
                        if (layer.lockAspect) {
                          const aspect = layer.aspect ?? getLayerAspect(layer)
                          updateLayerValues(layer.id, {
                            height: nextHeight,
                            width: aspect ? nextHeight * aspect : layer.width,
                            aspect,
                          })
                          return
                        }
                        updateLayerValues(layer.id, { height: nextHeight })
                      }}
                    />
                  </label>
                  <label>
                    Opacity
                    <NumericInput
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={layer.opacity ?? 1}
                      onChange={(event) =>
                        updateLayer(
                          layer.id,
                          'opacity',
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  {layer.isCloud ? (
                    <>
                      <label>
                        Wrap Amount
                        <NumericInput
                          type="number"
                          step="0.05"
                          min="0"
                          max="1"
                          value={layer.wrapAmount ?? 0.35}
                          onChange={(event) =>
                            updateLayer(
                              layer.id,
                              'wrapAmount',
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        Wrap Strength
                        <NumericInput
                          type="number"
                          step="0.05"
                          min="0"
                          max="1"
                          value={layer.wrapStrength ?? 0.2}
                          onChange={(event) =>
                            updateLayer(
                              layer.id,
                              'wrapStrength',
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        Normal Strength
                        <NumericInput
                          type="number"
                          step="0.1"
                          min="0"
                          value={layer.normalStrength ?? 1.6}
                          onChange={(event) =>
                            updateLayer(
                              layer.id,
                              'normalStrength',
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        Warp Strength
                        <NumericInput
                          type="number"
                          step="0.005"
                          min="0"
                          value={layer.textureWarpStrength ?? 0.02}
                          onChange={(event) =>
                            updateLayer(
                              layer.id,
                              'textureWarpStrength',
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        Warp Speed
                        <NumericInput
                          type="number"
                          step="0.05"
                          min="0"
                          value={layer.textureWarpSpeed ?? 0.15}
                          onChange={(event) =>
                            updateLayer(
                              layer.id,
                              'textureWarpSpeed',
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        Warp Scale
                        <NumericInput
                          type="number"
                          step="0.1"
                          min="0.1"
                          value={layer.textureWarpScale ?? 1.6}
                          onChange={(event) =>
                            updateLayer(
                              layer.id,
                              'textureWarpScale',
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                    </>
                  ) : null}
                  <label>
                    Scroll Speed
                    <NumericInput
                      type="number"
                      step="0.005"
                      value={layer.scrollSpeed ?? 0}
                      onChange={(event) =>
                        updateLayer(
                          layer.id,
                          'scrollSpeed',
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    Scroll Repeat
                    <NumericInput
                      type="number"
                      step="0.5"
                      min="1"
                      value={layer.scrollRepeat ?? 1}
                      onChange={(event) =>
                        updateLayer(
                          layer.id,
                          'scrollRepeat',
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    Tile Offset
                    <NumericInput
                      type="number"
                      step="0.01"
                      value={layer.tileOffset ?? 0}
                      onChange={(event) =>
                        updateLayer(
                          layer.id,
                          'tileOffset',
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                </>
              )}
            </div>
          </details>
        ))}
      </div>
        </>
      ) : null}
      <Canvas
        camera={{
          position: [sceneSettings.camX, sceneSettings.camY, sceneSettings.camZ],
          fov: sceneSettings.camFov,
        }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#cfe6f5']} />
        <ambientLight intensity={sceneSettings.ambientIntensity} />
        <DirectionalLightRig settings={sceneSettings} target={buildingTarget} />
        <SpotLightRig settings={sceneSettings} />
        <Suspense fallback={null}>
          <Environment files="/lv/envmap.hdr" />
          <SceneRig
            pivot={pivot}
            maxYawDeg={sceneSettings.maxYawDeg}
            maxPitchDeg={sceneSettings.maxPitchDeg}
            enabled={sceneSettings.enabled}
          >
            {tiltingLayers.map((layer) => (
              <LayerItem
                key={layer.id}
                layer={layer}
                pivot={pivot}
                onAutoFit={handleAutoFit}
                lightDir={lightDir}
              />
            ))}
          </SceneRig>
          {staticLayers.map((layer) => (
            <LayerItem
              key={layer.id}
              layer={layer}
              pivot={[0, 0, 0]}
              onAutoFit={handleAutoFit}
              lightDir={lightDir}
            />
          ))}
        </Suspense>
        <CameraRig
          position={[sceneSettings.camX, sceneSettings.camY, sceneSettings.camZ]}
          rotationDeg={[
            sceneSettings.camRotX,
            sceneSettings.camRotY,
            sceneSettings.camRotZ,
          ]}
          fov={sceneSettings.camFov}
        />
        <SubtleBloom settings={sceneSettings} />
      </Canvas>
    </div>
  )
}

export default App
