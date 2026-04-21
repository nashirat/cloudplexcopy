import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { Water } from 'three/examples/jsm/objects/Water.js'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import './LatestWaterPage.css'

// /latestwater — Three.js Water class + cubemap sky + visible sun, with
// a live tuning panel. The Three.js Water shader gives us non-repeating
// surface ripples (single tileable normal map sampled at 4 scales/offsets
// and summed) plus a planar Reflector that picks up the cubemap.
//
// All UI-tunable parameters are stored in React state and pushed into the
// live Three.js scene from a separate effect. Three.js objects (renderer,
// scene, water material, sun disk, light) are created once in a setup
// effect and held in refs so the param-update effect can poke them.

// =============================================================================
// Defaults — tuned to roughly match waterpro's tropical look on first paint.
// =============================================================================
const DEFAULTS = {
  // Surface
  size:            1.0,
  distortionScale: 14.0,
  waveSpeed:       0.7,
  alpha:           1.0,
  // Layered water color (waterpro-style: shallow/deep/transmission + depth)
  shallowColor:    '#153c38',
  deepColor:       '#0a2426',
  transColor:      '#4cbdac',
  colorDepth:      2.4,    // Beer-Lambert path length scale; lower = darker faster
  waterAmbient:    0.6,    // baseline internal light on bodyCol (independent of sun)
  roughness:       0.35,   // 0 = mirror-sharp env, 1 = fully blurred sky glow
  // Sky (THREE.Sky Preetham atmospheric model)
  turbidity:       4.0,
  rayleigh:        1.0,
  mieCoefficient:  0.005,
  mieDirectional:  0.7,
  // Reflection (patched into the Water shader as new uniforms)
  reflStrength:   0.9,     // intensity of the reflected cubemap
  reflBase:       0.3,     // R0 — Schlick base reflectance (min reflection)
  reflAmbient:    0.0,     // flat grey added to reflection (causes "haze" at horizon)
  fresnelPower:   5.0,     // Fresnel falloff exponent
  scatterMix:     1.0,     // body-color scatter intensity
  // Sun
  sunAzimuth:    315,
  sunElevation:   38,
  sunColor:     '#fff5d8',
  sunDiskSize:    180,
  sunIntensity:   1.4,
  specStrength:   2.0,     // specular intensity
  specShininess:100.0,     // specular Phong exponent (smaller = bigger soft halo)
  // Camera
  cameraHeight:   8,
  fov:            45,
  // Renderer
  exposure:       0.95,
}

// Patched copy of three.js Water's fragment shader. The stock version
// hardcodes Fresnel R0, Fresnel power, reflection multiplier, and the
// sunLight() shininess/strength values — we replace each with a uniform
// so the panel can drive them live.
const PATCHED_WATER_FS = /* glsl */`
  uniform sampler2D mirrorSampler;
  uniform samplerCube uEnvMap;
  uniform float uRoughness;
  uniform float uEnvMaxLod;
  uniform float alpha;
  uniform float time;
  uniform float size;
  uniform float distortionScale;
  uniform sampler2D normalSampler;
  uniform vec3 sunColor;
  uniform vec3 sunDirection;
  uniform vec3 eye;
  uniform vec3 waterColor;

  // Patched-in uniforms.
  uniform float uReflStrength;
  uniform float uReflBase;
  uniform float uReflAmbient;
  uniform float uFresnelPower;
  uniform float uScatterMix;
  uniform float uSpecStrength;
  uniform float uSpecShininess;
  uniform vec3  uShallowColor;
  uniform vec3  uDeepColor;
  uniform vec3  uTransColor;
  uniform float uColorDepth;
  uniform float uWaterAmbient;

  varying vec4 mirrorCoord;
  varying vec4 worldPosition;

  vec4 getNoise( vec2 uv ) {
    vec2 uv0 = ( uv / 103.0 ) + vec2(time / 17.0, time / 29.0);
    vec2 uv1 = uv / 107.0-vec2( time / -19.0, time / 31.0 );
    vec2 uv2 = uv / vec2( 8907.0, 9803.0 ) + vec2( time / 101.0, time / 97.0 );
    vec2 uv3 = uv / vec2( 1091.0, 1027.0 ) - vec2( time / 109.0, time / -113.0 );
    vec4 noise = texture2D( normalSampler, uv0 ) +
      texture2D( normalSampler, uv1 ) +
      texture2D( normalSampler, uv2 ) +
      texture2D( normalSampler, uv3 );
    return noise * 0.5 - 1.0;
  }

  void sunLight( const vec3 surfaceNormal, const vec3 eyeDirection, float shiny, float spec, float diffuse, inout vec3 diffuseColor, inout vec3 specularColor ) {
    vec3 reflection = normalize( reflect( -sunDirection, surfaceNormal ) );
    float direction = max( 0.0, dot( eyeDirection, reflection ) );
    specularColor += pow( direction, shiny ) * sunColor * spec;
    diffuseColor += max( dot( sunDirection, surfaceNormal ), 0.0 ) * sunColor * diffuse;
  }

  #include <common>
  #include <packing>
  #include <bsdfs>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    vec4 noise = getNoise( worldPosition.xz * size );
    vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );

    vec3 diffuseLight = vec3(0.0);
    vec3 specularLight = vec3(0.0);

    vec3 worldToEye = eye-worldPosition.xyz;
    vec3 eyeDirection = normalize( worldToEye );
    sunLight( surfaceNormal, eyeDirection, uSpecShininess, uSpecStrength, 0.5, diffuseLight, specularLight );

    float distance = length(worldToEye);

    // PBR-style cubemap reflection. Sample at a roughness-driven mip level:
    // higher roughness = blurrier reflection (clouds become diffuse glow).
    // The X-flip matches three.js's cubemap orientation for samplerCube.
    vec3 R = reflect( -eyeDirection, surfaceNormal );
    R.y = max( R.y, 0.02 ); // clamp below-horizon samples (no ground in cubemap)
    vec3 envDir = vec3( -R.x, R.y, R.z );
    vec3 reflectionSample = textureLod( uEnvMap, envDir, uRoughness * uEnvMaxLod ).rgb;

    float theta = max( dot( eyeDirection, surfaceNormal ), 0.0 );
    float rf0 = uReflBase;
    float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), uFresnelPower );

    // Layered water color via Beer-Lambert path-length proxy.
    // Softened so grazing angles don't crush to pure deep color.
    float ndv = max( theta, 0.05 );
    float pathLen = 1.0 + ( 1.0 - ndv ) * 2.0; // range 1..2.9 instead of 1..20
    float depthMix = 1.0 - exp( -pathLen / max( uColorDepth, 0.01 ) );
    vec3 bodyCol = mix( uShallowColor, uDeepColor, depthMix );
    vec3 transmission = uTransColor * ( 1.0 - depthMix );
    vec3 scatter = ( bodyCol + transmission * 0.35 ) * uScatterMix;

    vec3 bodyOut = ( bodyCol * ( diffuseLight * 0.6 + uWaterAmbient ) + scatter ) * getShadowMask()
                 + specularLight; // sun glints survive even when reflection is off
    vec3 reflOut = vec3( uReflAmbient ) + reflectionSample + reflectionSample * specularLight;
    float reflMix = reflectance * clamp( uReflStrength, 0.0, 1.0 );
    vec3 albedo = mix( bodyOut, reflOut, reflMix );
    vec3 outgoingLight = albedo;
    gl_FragColor = vec4( outgoingLight, alpha );

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`

// Convert spherical (az, el in degrees) → normalized direction vector.
function sphericalToDir(azDeg, elDeg) {
  const az = THREE.MathUtils.degToRad(azDeg)
  const el = THREE.MathUtils.degToRad(elDeg)
  return new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az),
  ).normalize()
}

// =============================================================================
// Slider row — one labelled range input that mirrors a numeric value.
// =============================================================================
function Slider({ label, value, min, max, step, onChange, fmt }) {
  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="v">{fmt ? fmt(value) : value}</span>
    </div>
  )
}

function ColorRow({ label, value, onChange }) {
  return (
    <div className="row">
      <label>{label}</label>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="v">{value}</span>
    </div>
  )
}

// =============================================================================
// Main page
// =============================================================================
export default function LatestWaterPage() {
  const containerRef = useRef(null)
  const [params, setParams] = useState(DEFAULTS)

  // Refs holding live Three.js objects so the params effect can update them.
  const refs = useRef({
    renderer: null,
    camera: null,
    water: null,
    sunDisk: null,
    dirLight: null,
    sunDistance: 5000,
  })

  // ------------------ Setup (runs once) ----------------------------------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(container.clientWidth, container.clientHeight, false)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = DEFAULTS.exposure
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const aspect = container.clientWidth / container.clientHeight
    const camera = new THREE.PerspectiveCamera(DEFAULTS.fov, aspect, 1, 20000)
    camera.position.set(0, DEFAULTS.cameraHeight, 60)
    camera.lookAt(0, 2, 0)

    // Sky cubemap — used as background AND auto-reflected by the Water's
    // internal Reflector pass.
    // Procedural Preetham sky — smooth atmospheric gradient, no baked clouds.
    const sky = new Sky()
    sky.scale.setScalar(10000)
    scene.add(sky)

    const skyUniforms = sky.material.uniforms
    skyUniforms.turbidity.value       = DEFAULTS.turbidity
    skyUniforms.rayleigh.value        = DEFAULTS.rayleigh
    skyUniforms.mieCoefficient.value  = DEFAULTS.mieCoefficient
    skyUniforms.mieDirectionalG.value = DEFAULTS.mieDirectional

    // CubeCamera captures the sky into a cube texture with mipmaps.
    // Water samples this as samplerCube — roughness drives LOD → soft reflection.
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    })
    const cubeCamera = new THREE.CubeCamera(1, 50000, cubeRT)
    scene.add(cubeCamera)

    // Re-capture sky cube whenever sun/sky params change.
    const bakeSky = () => {
      water.visible = false
      cubeCamera.update(renderer, scene)
      water.visible = true
      scene.environment = cubeRT.texture
    }

    refs.current.sky = sky
    refs.current.bakeSky = bakeSky

    // Sun direction from defaults — will be live-updated when sliders move.
    const initialSunDir = sphericalToDir(DEFAULTS.sunAzimuth, DEFAULTS.sunElevation)

    // Visible sun disk. Unlit so it stays bright through tone-mapping; the
    // sphere is small at this distance which gives a hard-edged disk.
    const sunDisk = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 32), // radius=1, scaled below
      new THREE.MeshBasicMaterial({ color: DEFAULTS.sunColor, toneMapped: false }),
    )
    sunDisk.scale.setScalar(DEFAULTS.sunDiskSize)
    sunDisk.position.copy(initialSunDir).multiplyScalar(refs.current.sunDistance)
    scene.add(sunDisk)

    // Directional light from the sun. Affects nothing in v1 (no objects)
    // but will be useful when we add boats/rocks later. Also: the Water
    // shader uses sunDirection independently for its specular calculation.
    const dirLight = new THREE.DirectionalLight(0xffffff, DEFAULTS.sunIntensity)
    dirLight.position.copy(initialSunDir).multiplyScalar(100)
    dirLight.target.position.set(0, 0, 0)
    scene.add(dirLight)
    scene.add(dirLight.target)
    scene.add(new THREE.AmbientLight(0x223344, 0.4))

    // Water — Three.js's Reflector + animated normal-map shader.
    const waterNormals = new THREE.TextureLoader().load(
      '/latestwater-cubemap/waternormals.jpg',
      (t) => {
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.RepeatWrapping
      },
    )
    const water = new Water(
      new THREE.PlaneGeometry(10000, 10000),
      {
        textureWidth: 512,
        textureHeight: 512,
        waterNormals,
        sunDirection: initialSunDir,
        sunColor: new THREE.Color(DEFAULTS.sunColor).getHex(),
        waterColor: new THREE.Color(DEFAULTS.deepColor).getHex(),
        distortionScale: DEFAULTS.distortionScale,
        alpha: DEFAULTS.alpha,
        fog: false,
      },
    )
    water.rotation.x = -Math.PI / 2
    water.material.uniforms.size.value = DEFAULTS.size

    // Patch the Water material with our extended fragment shader + new
    // uniforms. Done immediately after construction, before first render.
    water.material.uniforms.uReflStrength   = { value: DEFAULTS.reflStrength }
    water.material.uniforms.uReflBase       = { value: DEFAULTS.reflBase }
    water.material.uniforms.uReflAmbient    = { value: DEFAULTS.reflAmbient }
    water.material.uniforms.uFresnelPower   = { value: DEFAULTS.fresnelPower }
    water.material.uniforms.uScatterMix     = { value: DEFAULTS.scatterMix }
    water.material.uniforms.uSpecStrength   = { value: DEFAULTS.specStrength }
    water.material.uniforms.uSpecShininess  = { value: DEFAULTS.specShininess }
    water.material.uniforms.uShallowColor   = { value: new THREE.Color(DEFAULTS.shallowColor) }
    water.material.uniforms.uDeepColor      = { value: new THREE.Color(DEFAULTS.deepColor) }
    water.material.uniforms.uTransColor     = { value: new THREE.Color(DEFAULTS.transColor) }
    water.material.uniforms.uColorDepth     = { value: DEFAULTS.colorDepth }
    water.material.uniforms.uWaterAmbient   = { value: DEFAULTS.waterAmbient }
    water.material.uniforms.uEnvMap         = { value: cubeRT.texture } // filled by bakeSky()
    water.material.uniforms.uRoughness      = { value: DEFAULTS.roughness }
    water.material.uniforms.uEnvMaxLod      = { value: 8.0 }
    water.material.fragmentShader = PATCHED_WATER_FS
    water.material.needsUpdate = true

    scene.add(water)

    // Stash refs.
    refs.current.renderer = renderer
    refs.current.camera = camera
    refs.current.water = water
    refs.current.sunDisk = sunDisk
    refs.current.dirLight = dirLight
    refs.current.scene = scene

    // Bake sky after water is ready so uEnvMap gets filled.
    bakeSky()

    // Render loop.
    const clock = new THREE.Clock()
    let raf = 0
    const tick = () => {
      const delta = clock.getDelta()
      // Read latest waveSpeed from the live params via ref-style dance:
      // closure captures DEFAULTS; for live updates we read off the
      // material uniform we mutate directly in the params effect, so we
      // just use the constant 1.0 multiplier here and scale the time
      // delta by the React state in the params effect path. Simpler:
      // mutate water.material.userData.speed.
      const speed = water.material.userData.speed ?? DEFAULTS.waveSpeed
      water.material.uniforms.time.value += delta * speed
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    const resize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      water.material.dispose()
      water.geometry.dispose()
      waterNormals.dispose()
      cubeRT.dispose()
      sunDisk.geometry.dispose()
      sunDisk.material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------ Live updates from sliders --------------------------
  // Pushes whatever the panel state currently is into the live Three.js
  // objects. Cheaper than rebuilding the scene on every change.
  useEffect(() => {
    const r = refs.current
    if (!r.water || !r.camera || !r.renderer) return

    // Surface uniforms.
    r.water.material.uniforms.size.value = params.size
    r.water.material.uniforms.distortionScale.value = params.distortionScale
    r.water.material.uniforms.alpha.value = params.alpha
    r.water.material.uniforms.waterColor.value.set(params.deepColor)
    r.water.material.uniforms.sunColor.value.set(params.sunColor)
    r.water.material.uniforms.uShallowColor.value.set(params.shallowColor)
    r.water.material.uniforms.uDeepColor.value.set(params.deepColor)
    r.water.material.uniforms.uTransColor.value.set(params.transColor)
    r.water.material.uniforms.uColorDepth.value = params.colorDepth
    r.water.material.uniforms.uWaterAmbient.value = params.waterAmbient
    r.water.material.uniforms.uRoughness.value = params.roughness
    r.water.material.userData.speed = params.waveSpeed

    // Patched reflection / specular uniforms.
    r.water.material.uniforms.uReflStrength.value  = params.reflStrength
    r.water.material.uniforms.uReflBase.value      = params.reflBase
    r.water.material.uniforms.uReflAmbient.value   = params.reflAmbient
    r.water.material.uniforms.uFresnelPower.value  = params.fresnelPower
    r.water.material.uniforms.uScatterMix.value    = params.scatterMix
    r.water.material.uniforms.uSpecStrength.value  = params.specStrength
    r.water.material.uniforms.uSpecShininess.value = params.specShininess

    // Sun direction → updates Water's specular AND the visible disk + light.
    const dir = sphericalToDir(params.sunAzimuth, params.sunElevation)
    r.water.material.uniforms.sunDirection.value.copy(dir)
    r.sunDisk.position.copy(dir).multiplyScalar(r.sunDistance)
    r.sunDisk.material.color.set(params.sunColor)
    r.sunDisk.scale.setScalar(params.sunDiskSize)
    r.dirLight.position.copy(dir).multiplyScalar(100)
    r.dirLight.intensity = params.sunIntensity

    // Sky — update Preetham uniforms then rebake PMREM.
    if (r.sky) {
      const su = r.sky.material.uniforms
      su.turbidity.value       = params.turbidity
      su.rayleigh.value        = params.rayleigh
      su.mieCoefficient.value  = params.mieCoefficient
      su.mieDirectionalG.value = params.mieDirectional
      su.sunPosition.value.copy(dir)
      r.bakeSky()
    }

    // Camera + renderer.
    r.camera.position.y = params.cameraHeight
    r.camera.fov = params.fov
    r.camera.updateProjectionMatrix()
    r.renderer.toneMappingExposure = params.exposure
  }, [params])

  // Helper to update a single param without rewriting the whole object.
  const set = (key) => (value) => setParams((p) => ({ ...p, [key]: value }))

  return (
    <div className="latestwater-page">
      <div className="latestwater-stage" ref={containerRef} />
      <div className="latestwater-panel">
        <div className="group">
          <h3>Surface</h3>
          <Slider label="Size"        value={params.size}            min={0.3}  max={5}    step={0.05} onChange={set('size')}            fmt={(v) => v.toFixed(2)} />
          <Slider label="Distortion"  value={params.distortionScale} min={0}    max={10}   step={0.1}  onChange={set('distortionScale')} fmt={(v) => v.toFixed(1)} />
          <Slider label="Wave speed"  value={params.waveSpeed}       min={0}    max={3}    step={0.05} onChange={set('waveSpeed')}       fmt={(v) => v.toFixed(2)} />
          <Slider label="Alpha"       value={params.alpha}           min={0}    max={1}    step={0.01} onChange={set('alpha')}           fmt={(v) => v.toFixed(2)} />
          <Slider label="Body mix"    value={params.scatterMix}      min={0}    max={2}    step={0.05} onChange={set('scatterMix')}      fmt={(v) => v.toFixed(2)} />
        </div>

        <div className="group">
          <h3>Colors</h3>
          <ColorRow label="Shallow"   value={params.shallowColor}                                        onChange={set('shallowColor')} />
          <ColorRow label="Deep"      value={params.deepColor}                                           onChange={set('deepColor')} />
          <ColorRow label="Transmit"  value={params.transColor}                                          onChange={set('transColor')} />
          <Slider label="Color depth" value={params.colorDepth}      min={0.2}  max={10}   step={0.1}  onChange={set('colorDepth')}      fmt={(v) => v.toFixed(1)} />
          <Slider label="Ambient"     value={params.waterAmbient}    min={0}    max={2}    step={0.05} onChange={set('waterAmbient')}    fmt={(v) => v.toFixed(2)} />
        </div>

        <div className="group">
          <h3>Reflection</h3>
          <Slider label="Strength"    value={params.reflStrength}    min={0}    max={2}    step={0.02} onChange={set('reflStrength')}    fmt={(v) => v.toFixed(2)} />
          <Slider label="Min (R0)"    value={params.reflBase}        min={0}    max={1}    step={0.01} onChange={set('reflBase')}        fmt={(v) => v.toFixed(2)} />
          <Slider label="Ambient"     value={params.reflAmbient}     min={0}    max={0.4}  step={0.005} onChange={set('reflAmbient')}    fmt={(v) => v.toFixed(3)} />
          <Slider label="Fresnel pow" value={params.fresnelPower}    min={0.5}  max={12}   step={0.1}  onChange={set('fresnelPower')}    fmt={(v) => v.toFixed(1)} />
          <Slider label="Roughness"   value={params.roughness}       min={0}    max={1}    step={0.01} onChange={set('roughness')}       fmt={(v) => v.toFixed(2)} />
        </div>

        <div className="group">
          <h3>Sun</h3>
          <Slider label="Azimuth"     value={params.sunAzimuth}      min={0}    max={360}  step={1}    onChange={set('sunAzimuth')}      fmt={(v) => `${v.toFixed(0)}°`} />
          <Slider label="Elevation"   value={params.sunElevation}    min={0}    max={90}   step={1}    onChange={set('sunElevation')}    fmt={(v) => `${v.toFixed(0)}°`} />
          <Slider label="Disk size"   value={params.sunDiskSize}     min={20}   max={500}  step={5}    onChange={set('sunDiskSize')}     fmt={(v) => v.toFixed(0)} />
          <Slider label="Light"       value={params.sunIntensity}    min={0}    max={3}    step={0.05} onChange={set('sunIntensity')}    fmt={(v) => v.toFixed(2)} />
          <Slider label="Spec str"    value={params.specStrength}    min={0}    max={6}    step={0.05} onChange={set('specStrength')}    fmt={(v) => v.toFixed(2)} />
          <Slider label="Spec sharp"  value={params.specShininess}   min={5}    max={500}  step={5}    onChange={set('specShininess')}   fmt={(v) => v.toFixed(0)} />
          <ColorRow label="Color"     value={params.sunColor}                                            onChange={set('sunColor')} />
        </div>

        <div className="group">
          <h3>Sky</h3>
          <Slider label="Turbidity"   value={params.turbidity}       min={0}    max={20}   step={0.1}  onChange={set('turbidity')}       fmt={(v) => v.toFixed(1)} />
          <Slider label="Rayleigh"    value={params.rayleigh}        min={0}    max={4}    step={0.05} onChange={set('rayleigh')}        fmt={(v) => v.toFixed(2)} />
          <Slider label="Mie coeff"   value={params.mieCoefficient}  min={0}    max={0.1}  step={0.001} onChange={set('mieCoefficient')} fmt={(v) => v.toFixed(3)} />
          <Slider label="Mie dir"     value={params.mieDirectional}  min={0}    max={1}    step={0.01} onChange={set('mieDirectional')}  fmt={(v) => v.toFixed(2)} />
        </div>

        <div className="group">
          <h3>Camera & Render</h3>
          <Slider label="Cam height"  value={params.cameraHeight}    min={1}    max={30}   step={0.5}  onChange={set('cameraHeight')}    fmt={(v) => v.toFixed(1)} />
          <Slider label="FOV"         value={params.fov}             min={25}   max={90}   step={1}    onChange={set('fov')}             fmt={(v) => `${v.toFixed(0)}°`} />
          <Slider label="Exposure"    value={params.exposure}        min={0.3}  max={2}    step={0.05} onChange={set('exposure')}        fmt={(v) => v.toFixed(2)} />
        </div>
      </div>
    </div>
  )
}
