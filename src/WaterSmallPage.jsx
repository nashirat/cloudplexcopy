import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import './latestwater/LatestWaterPage.css'

// /watersmall — fully procedural ocean. No texture sampling, no tiled
// normal map. The look comes from a sum of Gerstner waves with deep-water
// dispersion (ω=√gk), randomized directions inside a wind cone, and an
// amplitude spectrum biased toward longer wavelengths (Phillips-ish). Fine
// chop is added with multi-octave value noise. The geometry actually
// displaces in the vertex shader so the silhouette breaks at the horizon.

const NUM_WAVES = 16            // total Gerstner waves used for normals
const NUM_BIG_WAVES_VS = 6      // subset used for vertex displacement
const PLANE_SIZE = 2000
const PLANE_SEGS = 384          // ~5m per cell — resolves big waves cleanly

const DEFAULTS = {
  // Body
  waterColorTop:   '#3d6a8a',
  waterColorDeep:  '#0a1f33',
  ambient:         0.42,
  diffuseStrength: 0.55,
  sssStrength:     0.25,
  // Sky / reflection
  skyTop:          '#9bb6cd',
  skyHorizon:      '#cfd9e0',
  reflStrength:    0.85,
  reflBase:        0.02,
  fresnelPower:    5.0,
  // Primary wind system (local wind sea)
  windAngle:       55,
  windStrength:    0.6,
  // Secondary wind system (cross-swell from a different storm).
  // Setting swellRatio=0 disables it entirely.
  windAngle2:      135,
  windStrength2:   0.45,
  swellRatio:      0.35,  // fraction of waves assigned to system 2
  // Spectrum + amplitude
  waveAmp:         1.0,
  waveSteepness:   0.45,
  waveMaxLen:      38.0,
  waveMinLen:      0.55,
  noiseStrength:   0.55,
  whitecapAmt:     0.12,
  // Sun
  sunAzimuth:      210,
  sunElevation:    32,
  sunColor:        '#ffe6b8',
  specStrength:    1.4,
  specRoughness:   0.085, // GGX α — small=tight glint, large=spread glitter
  sunDiskSize:     220,
  // Atmosphere / camera
  fogDensity:      0.0045,
  cameraHeight:    8,
  fov:             50,
  exposure:        1.0,
}

// ---- Vertex shader ---------------------------------------------------------
// Displaces only with the few biggest waves (cheap; small waves don't change
// silhouette enough to matter). Passes the un-displaced rest position so the
// fragment shader can recompute the same Gerstner sum analytically.
const VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uWindAngleRad;
  uniform float uWindStrength;
  uniform float uWindAngle2Rad;
  uniform float uWindStrength2;
  uniform float uSwellRatio;
  uniform float uWaveAmp;
  uniform float uWaveSteepness;
  uniform float uWaveMaxLen;
  uniform float uWaveMinLen;

  varying vec3 vWorldPos;
  varying vec3 vRestPos;

  vec2 hash21(float p) {
    return fract(sin(vec2(p * 127.1, p * 311.7)) * 43758.5453);
  }
  float hash11(float p) { return fract(sin(p * 78.233) * 43758.5453); }

  // Returns one Gerstner wave's parameters. Each wave is hash-assigned to
  // one of two wind systems (primary / swell) — running multiple wind
  // directions at once is what makes real cross-seas read as natural;
  // a single direction with cone spread always feels uniform.
  void waveParams(int i, out vec2 dir, out float k, out float a,
                  out float c, out float phase, out float Q) {
    float fi = float(i);
    vec2 r = hash21(fi * 1.137 + 7.31);

    float pick = hash11(fi * 9.91 + 3.7);
    bool isSwell = pick < uSwellRatio;
    float windAngle = isSwell ? uWindAngle2Rad : uWindAngleRad;
    float windStr   = isSwell ? uWindStrength2 : uWindStrength;
    float spread = mix(1.4, 0.45, windStr);
    float angle  = windAngle + (r.x * 2.0 - 1.0) * spread;
    dir = vec2(cos(angle), sin(angle));

    float u = (fi + r.y * 0.6) / float(${NUM_WAVES});
    float wavelength = mix(uWaveMaxLen, uWaveMinLen, pow(u, 0.65));
    if (isSwell) wavelength *= 1.6;        // swell skews longer
    k = 6.2831853 / wavelength;
    a = uWaveAmp * sqrt(wavelength) * 0.05 * (0.4 + 0.6 * windStr);
    c = sqrt(9.81 / k);
    phase = hash11(fi * 4.7 + 1.3) * 6.2831853;
    Q = min(uWaveSteepness / (a * k * float(${NUM_WAVES}) + 1e-3), 1.0);
  }

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 disp = vec3(0.0);
    for (int i = 0; i < ${NUM_BIG_WAVES_VS}; i++) {
      vec2 dir; float k, a, c, phase, Q;
      waveParams(i, dir, k, a, c, phase, Q);
      float f = k * dot(dir, wp.xz) - c * k * uTime + phase;
      float sf = sin(f), cf = cos(f);
      disp.x += Q * a * dir.x * cf;
      disp.z += Q * a * dir.y * cf;
      disp.y += a * sf;
    }
    vRestPos = wp.xyz;
    wp.xyz += disp;
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

// ---- Fragment shader -------------------------------------------------------
const FRAGMENT_SHADER = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform vec3  uCameraPos;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uWaterTop;
  uniform vec3  uWaterDeep;
  uniform vec3  uSkyTop;
  uniform vec3  uSkyHorizon;
  uniform float uAmbient;
  uniform float uDiffuse;
  uniform float uSSS;
  uniform float uReflStrength;
  uniform float uReflBase;
  uniform float uFresnelPower;
  uniform float uWindAngleRad;
  uniform float uWindStrength;
  uniform float uWindAngle2Rad;
  uniform float uWindStrength2;
  uniform float uSwellRatio;
  uniform float uWaveAmp;
  uniform float uWaveSteepness;
  uniform float uWaveMaxLen;
  uniform float uWaveMinLen;
  uniform float uNoiseStrength;
  uniform float uWhitecap;
  uniform float uSpecStrength;
  uniform float uSpecRoughness;
  uniform float uFogDensity;

  varying vec3 vWorldPos;
  varying vec3 vRestPos;

  vec2  hash21(float p) { return fract(sin(vec2(p * 127.1, p * 311.7)) * 43758.5453); }
  float hash11(float p) { return fract(sin(p * 78.233) * 43758.5453); }
  float hash12(vec2 p)  { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  // Same params as vertex shader — keep in sync.
  void waveParams(int i, out vec2 dir, out float k, out float a,
                  out float c, out float phase, out float Q) {
    float fi = float(i);
    vec2 r = hash21(fi * 1.137 + 7.31);

    float pick = hash11(fi * 9.91 + 3.7);
    bool isSwell = pick < uSwellRatio;
    float windAngle = isSwell ? uWindAngle2Rad : uWindAngleRad;
    float windStr   = isSwell ? uWindStrength2 : uWindStrength;
    float spread = mix(1.4, 0.45, windStr);
    float angle  = windAngle + (r.x * 2.0 - 1.0) * spread;
    dir = vec2(cos(angle), sin(angle));

    float u = (fi + r.y * 0.6) / float(${NUM_WAVES});
    float wavelength = mix(uWaveMaxLen, uWaveMinLen, pow(u, 0.65));
    if (isSwell) wavelength *= 1.6;
    k = 6.2831853 / wavelength;
    a = uWaveAmp * sqrt(wavelength) * 0.05 * (0.4 + 0.6 * windStr);
    c = sqrt(9.81 / k);
    phase = hash11(fi * 4.7 + 1.3) * 6.2831853;
    Q = min(uWaveSteepness / (a * k * float(${NUM_WAVES}) + 1e-3), 1.0);
  }

  // Value noise + analytical gradient via 4-octave fbm. Used only for
  // sub-meter chop on top of the Gerstner sum.
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
  }

  vec2 fbmGrad(vec2 p, float t) {
    vec2 wind = vec2(cos(uWindAngleRad), sin(uWindAngleRad));
    float e = 0.06;
    float v0 = 0.0, vx = 0.0, vz = 0.0;
    float amp = 1.0, freq = 1.0;
    for (int o = 0; o < 4; o++) {
      vec2 q = p * freq + wind * t * (0.18 + 0.07 * float(o));
      v0 += vnoise(q) * amp;
      vx += vnoise(q + vec2(e, 0.0)) * amp;
      vz += vnoise(q + vec2(0.0, e)) * amp;
      amp  *= 0.55;
      freq *= 2.07;            // slightly irrational ratio breaks any beating
    }
    return vec2((vx - v0) / e, (vz - v0) / e);
  }

  void main() {
    vec2 rest = vRestPos.xz;
    float t = uTime;

    // Recompute Gerstner sum analytically to derive the surface normal.
    // dPdx, dPdz are columns of the Jacobian of position wrt rest coords;
    // their cross product is the surface normal at the displaced point.
    // We track the BIG-wave subset separately — only big waves can break
    // and produce foam, so whitecaps must be driven by their slope/height
    // alone (else fine procedural noise paints foam everywhere).
    vec3 dPdx = vec3(1.0, 0.0, 0.0);
    vec3 dPdz = vec3(0.0, 0.0, 1.0);
    vec3 dPdxBig = vec3(1.0, 0.0, 0.0);
    vec3 dPdzBig = vec3(0.0, 0.0, 1.0);
    float bigCrest = 0.0;

    for (int i = 0; i < ${NUM_WAVES}; i++) {
      vec2 dir; float k, a, c, phase, Q;
      waveParams(i, dir, k, a, c, phase, Q);
      float f = k * dot(dir, rest) - c * k * t + phase;
      float sf = sin(f), cf = cos(f);
      float wa = k * a;
      vec3 ddx = vec3(-Q * wa * dir.x * dir.x * sf,
                            wa * dir.x * cf,
                      -Q * wa * dir.y * dir.x * sf);
      vec3 ddz = vec3(-Q * wa * dir.x * dir.y * sf,
                            wa * dir.y * cf,
                      -Q * wa * dir.y * dir.y * sf);
      dPdx += ddx;
      dPdz += ddz;
      if (i < ${NUM_BIG_WAVES_VS}) {
        dPdxBig += ddx;
        dPdzBig += ddz;
        bigCrest += max(a * sf, 0.0);
      }
    }

    vec3 N    = normalize(cross(dPdz, dPdx));
    vec3 Nbig = normalize(cross(dPdzBig, dPdxBig));
    float bigSlope = length(Nbig.xz);   // measured BEFORE noise; clean

    // Add fine chop, but fade with distance to avoid shimmer/aliasing.
    float dist = length(uCameraPos - vWorldPos);
    float detailLod = 1.0 / (1.0 + dist * dist * 0.0003);
    vec2 ng = fbmGrad(rest * 1.4, t) * uNoiseStrength * detailLod;
    N = normalize(N + vec3(-ng.x, 0.0, -ng.y));

    vec3 V = normalize(uCameraPos - vWorldPos);
    vec3 L = normalize(uSunDir);
    float NdotL = max(dot(N, L), 0.0);
    float NdotV = max(dot(N, V), 1e-3);
    float upDotV = max(dot(vec3(0.0, 1.0, 0.0), V), 1e-3);

    // Body color — view-angle blend (deeper at grazing).
    vec3 bodyCol = mix(uWaterDeep, uWaterTop, upDotV);

    // Subsurface scatter: light hitting the back of a wave glows toward the
    // viewer when the sun is roughly behind the camera-facing side.
    float sssTerm = pow(max(dot(L, -V) * 0.5 + 0.5, 0.0), 3.0);
    sssTerm *= clamp(bigCrest * 0.5, 0.0, 1.0);

    vec3 bodyOut = bodyCol * (uAmbient + NdotL * uDiffuse)
                 + uSunColor * sssTerm * uSSS;

    // Sky reflection — gradient with horizon haze, sampled by the reflected
    // view ray. Use the perturbed normal so it ripples convincingly.
    vec3 R = reflect(-V, N);
    float skyMix = clamp(R.y * 1.3 + 0.05, 0.0, 1.0);
    skyMix = pow(skyMix, 0.55);
    vec3 skyOut = mix(uSkyHorizon, uSkyTop, skyMix);

    // Schlick Fresnel on the actual surface normal — gives proper rim glow.
    float fresnel = uReflBase + (1.0 - uReflBase) * pow(1.0 - NdotV, uFresnelPower);
    fresnel *= uReflStrength;

    vec3 col = mix(bodyOut, skyOut, fresnel);

    // GGX specular highlight for the sun. Roughness is widened with
    // distance — each far-away pixel covers many waves, so we treat the
    // distribution as broader. Without this, single sub-pixel waves
    // momentarily aligning with the half-vector punch through as bright
    // white firework dots, especially when the camera is high.
    vec3 H = normalize(L + V);
    float NdotH = max(dot(N, H), 0.0);
    float effRough = uSpecRoughness + 0.28 * (1.0 - detailLod);
    float a2 = effRough * effRough; a2 *= a2;
    float denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * denom * denom + 1e-5);
    col += uSunColor * D * uSpecStrength * fresnel;

    // Whitecaps — driven only by big-wave slope/crest height (computed
    // BEFORE fine noise was added to N). This stops the procedural chop
    // from triggering foam on every tiny ripple. Real whitecaps appear
    // only where genuine wave fronts are steep enough to break.
    float foamMask = smoothstep(0.62, 0.92, bigSlope) *
                     smoothstep(0.45, 1.4, bigCrest);
    foamMask *= uWhitecap;
    foamMask *= detailLod;             // fade out at distance
    col = mix(col, vec3(0.92, 0.95, 0.97), foamMask);

    // Atmospheric fog toward horizon — colors distant water like the sky.
    float fog = 1.0 - exp(-dist * uFogDensity);
    col = mix(col, uSkyHorizon, clamp(fog, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
  }
`

function sphericalToDir(azDeg, elDeg) {
  const a = THREE.MathUtils.degToRad(azDeg), e = THREE.MathUtils.degToRad(elDeg)
  return new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).normalize()
}

function Slider({ label, value, min, max, step, onChange }) {
  return (
    <div className="row">
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step}
        value={Math.max(min, Math.min(max, value))}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
      <input type="number" step={step} value={value}
        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v) }}
        style={{ width: 50, fontSize: 11, background: 'rgba(0,0,0,0.3)', color: '#e8eef5',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '2px 4px',
          textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
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

export default function WaterSmallPage() {
  const containerRef = useRef(null)
  const STORAGE_KEY = 'watersmall-config-v2'
  const [params, setParams] = useState(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY)
      return s ? { ...DEFAULTS, ...JSON.parse(s) } : DEFAULTS
    } catch { return DEFAULTS }
  })
  const refs = useRef({})
  const saveConfig = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(params)) } catch (e) {} }
  const resetConfig = () => { localStorage.removeItem(STORAGE_KEY); setParams(DEFAULTS) }

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
    scene.background = new THREE.Color(DEFAULTS.skyHorizon)
    const aspect = container.clientWidth / container.clientHeight
    const camera = new THREE.PerspectiveCamera(DEFAULTS.fov, aspect, 0.5, 20000)
    camera.position.set(0, DEFAULTS.cameraHeight, 30)
    camera.lookAt(0, 1, 0)

    const initialSunDir = sphericalToDir(DEFAULTS.sunAzimuth, DEFAULTS.sunElevation)

    const sunDistance = 5000
    const sunDisk = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 32),
      new THREE.MeshBasicMaterial({ color: DEFAULTS.sunColor, toneMapped: false }),
    )
    sunDisk.scale.setScalar(DEFAULTS.sunDiskSize)
    sunDisk.position.copy(initialSunDir).multiplyScalar(sunDistance)
    scene.add(sunDisk)

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, PLANE_SEGS, PLANE_SEGS),
      new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms: {
          uTime:          { value: 0 },
          uCameraPos:     { value: camera.position.clone() },
          uSunDir:        { value: initialSunDir },
          uSunColor:      { value: new THREE.Color(DEFAULTS.sunColor) },
          uWaterTop:      { value: new THREE.Color(DEFAULTS.waterColorTop) },
          uWaterDeep:     { value: new THREE.Color(DEFAULTS.waterColorDeep) },
          uSkyTop:        { value: new THREE.Color(DEFAULTS.skyTop) },
          uSkyHorizon:    { value: new THREE.Color(DEFAULTS.skyHorizon) },
          uAmbient:       { value: DEFAULTS.ambient },
          uDiffuse:       { value: DEFAULTS.diffuseStrength },
          uSSS:           { value: DEFAULTS.sssStrength },
          uReflStrength:  { value: DEFAULTS.reflStrength },
          uReflBase:      { value: DEFAULTS.reflBase },
          uFresnelPower:  { value: DEFAULTS.fresnelPower },
          uWindAngleRad:  { value: THREE.MathUtils.degToRad(DEFAULTS.windAngle) },
          uWindStrength:  { value: DEFAULTS.windStrength },
          uWindAngle2Rad: { value: THREE.MathUtils.degToRad(DEFAULTS.windAngle2) },
          uWindStrength2: { value: DEFAULTS.windStrength2 },
          uSwellRatio:    { value: DEFAULTS.swellRatio },
          uWaveAmp:       { value: DEFAULTS.waveAmp },
          uWaveSteepness: { value: DEFAULTS.waveSteepness },
          uWaveMaxLen:    { value: DEFAULTS.waveMaxLen },
          uWaveMinLen:    { value: DEFAULTS.waveMinLen },
          uNoiseStrength: { value: DEFAULTS.noiseStrength },
          uWhitecap:      { value: DEFAULTS.whitecapAmt },
          uSpecStrength:  { value: DEFAULTS.specStrength },
          uSpecRoughness: { value: DEFAULTS.specRoughness },
          uFogDensity:    { value: DEFAULTS.fogDensity },
        },
      }),
    )
    water.rotation.x = -Math.PI / 2
    scene.add(water)

    refs.current = { renderer, camera, water, scene, sunDisk, sunDistance }

    const clock = new THREE.Clock()
    let raf = 0
    const tick = () => {
      water.material.uniforms.uTime.value += clock.getDelta()
      water.material.uniforms.uCameraPos.value.copy(camera.position)
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    const resize = () => {
      const w = container.clientWidth, h = container.clientHeight
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
      sunDisk.geometry.dispose()
      sunDisk.material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => {
    const r = refs.current
    if (!r.water) return
    const u = r.water.material.uniforms
    u.uWaterTop.value.set(params.waterColorTop)
    u.uWaterDeep.value.set(params.waterColorDeep)
    u.uSkyTop.value.set(params.skyTop)
    u.uSkyHorizon.value.set(params.skyHorizon)
    u.uSunColor.value.set(params.sunColor)
    u.uSunDir.value.copy(sphericalToDir(params.sunAzimuth, params.sunElevation))
    u.uAmbient.value       = params.ambient
    u.uDiffuse.value       = params.diffuseStrength
    u.uSSS.value           = params.sssStrength
    u.uReflStrength.value  = params.reflStrength
    u.uReflBase.value      = params.reflBase
    u.uFresnelPower.value  = params.fresnelPower
    u.uWindAngleRad.value  = THREE.MathUtils.degToRad(params.windAngle)
    u.uWindStrength.value  = params.windStrength
    u.uWindAngle2Rad.value = THREE.MathUtils.degToRad(params.windAngle2)
    u.uWindStrength2.value = params.windStrength2
    u.uSwellRatio.value    = params.swellRatio
    u.uWaveAmp.value       = params.waveAmp
    u.uWaveSteepness.value = params.waveSteepness
    u.uWaveMaxLen.value    = params.waveMaxLen
    u.uWaveMinLen.value    = params.waveMinLen
    u.uNoiseStrength.value = params.noiseStrength
    u.uWhitecap.value      = params.whitecapAmt
    u.uSpecStrength.value  = params.specStrength
    u.uSpecRoughness.value = params.specRoughness
    u.uFogDensity.value    = params.fogDensity
    if (r.sunDisk) {
      const d = sphericalToDir(params.sunAzimuth, params.sunElevation)
      r.sunDisk.position.copy(d).multiplyScalar(r.sunDistance)
      r.sunDisk.material.color.set(params.sunColor)
      r.sunDisk.scale.setScalar(params.sunDiskSize)
    }
    r.scene.background.set(params.skyHorizon)
    r.camera.position.y = params.cameraHeight
    r.camera.fov = params.fov
    r.camera.updateProjectionMatrix()
    r.renderer.toneMappingExposure = params.exposure
  }, [params])

  const set = (key) => (value) => setParams((p) => ({ ...p, [key]: value }))

  return (
    <div className="latestwater-page">
      <div className="latestwater-stage" ref={containerRef} />
      <div className="latestwater-panel">
        <div className="group">
          <h3>Body</h3>
          <ColorRow label="Top color"  value={params.waterColorTop}  onChange={set('waterColorTop')} />
          <ColorRow label="Deep color" value={params.waterColorDeep} onChange={set('waterColorDeep')} />
          <Slider label="Ambient" value={params.ambient}         min={0} max={2} step={0.01} onChange={set('ambient')} />
          <Slider label="Diffuse" value={params.diffuseStrength} min={0} max={2} step={0.01} onChange={set('diffuseStrength')} />
          <Slider label="SSS"     value={params.sssStrength}     min={0} max={2} step={0.01} onChange={set('sssStrength')} />
        </div>

        <div className="group">
          <h3>Sky / Reflection</h3>
          <ColorRow label="Sky top"     value={params.skyTop}     onChange={set('skyTop')} />
          <ColorRow label="Sky horizon" value={params.skyHorizon} onChange={set('skyHorizon')} />
          <Slider label="Refl str"   value={params.reflStrength} min={0} max={2} step={0.01} onChange={set('reflStrength')} />
          <Slider label="Refl base"  value={params.reflBase}     min={0} max={1} step={0.005} onChange={set('reflBase')} />
          <Slider label="Fresnel"    value={params.fresnelPower} min={0.5} max={12} step={0.1} onChange={set('fresnelPower')} />
        </div>

        <div className="group">
          <h3>Wind &amp; Waves</h3>
          <Slider label="Wind A dir" value={params.windAngle}     min={0} max={360} step={1}    onChange={set('windAngle')} />
          <Slider label="Wind A str" value={params.windStrength}  min={0} max={1}   step={0.01} onChange={set('windStrength')} />
          <Slider label="Wind B dir" value={params.windAngle2}    min={0} max={360} step={1}    onChange={set('windAngle2')} />
          <Slider label="Wind B str" value={params.windStrength2} min={0} max={1}   step={0.01} onChange={set('windStrength2')} />
          <Slider label="Swell mix"  value={params.swellRatio}    min={0} max={1}   step={0.01} onChange={set('swellRatio')} />
          <Slider label="Amplitude"  value={params.waveAmp}       min={0} max={3}   step={0.01} onChange={set('waveAmp')} />
          <Slider label="Steepness"  value={params.waveSteepness} min={0} max={1}   step={0.01} onChange={set('waveSteepness')} />
          <Slider label="Max λ"      value={params.waveMaxLen}    min={5} max={120} step={0.5}  onChange={set('waveMaxLen')} />
          <Slider label="Min λ"      value={params.waveMinLen}    min={0.1} max={5} step={0.05} onChange={set('waveMinLen')} />
          <Slider label="Fine chop"  value={params.noiseStrength} min={0} max={2}   step={0.01} onChange={set('noiseStrength')} />
          <Slider label="Whitecap"   value={params.whitecapAmt}   min={0} max={2}   step={0.01} onChange={set('whitecapAmt')} />
        </div>

        <div className="group">
          <h3>Sun</h3>
          <Slider label="Azimuth"    value={params.sunAzimuth}   min={0} max={360} step={1} onChange={set('sunAzimuth')} />
          <Slider label="Elevation"  value={params.sunElevation} min={-30} max={90} step={1} onChange={set('sunElevation')} />
          <Slider label="Spec str"   value={params.specStrength} min={0} max={5} step={0.05} onChange={set('specStrength')} />
          <Slider label="Roughness"  value={params.specRoughness} min={0.01} max={0.6} step={0.005} onChange={set('specRoughness')} />
          <Slider label="Disk size"  value={params.sunDiskSize}  min={20} max={1000} step={5} onChange={set('sunDiskSize')} />
          <ColorRow label="Color"    value={params.sunColor}     onChange={set('sunColor')} />
        </div>

        <div className="group">
          <h3>Atmosphere &amp; Camera</h3>
          <Slider label="Fog density" value={params.fogDensity}   min={0} max={0.05} step={0.0005} onChange={set('fogDensity')} />
          <Slider label="Height"      value={params.cameraHeight} min={1} max={50}   step={0.5}    onChange={set('cameraHeight')} />
          <Slider label="FOV"         value={params.fov}          min={20} max={100} step={1}      onChange={set('fov')} />
          <Slider label="Exposure"    value={params.exposure}     min={0.3} max={2}  step={0.05}   onChange={set('exposure')} />
        </div>

        <div className="group" style={{ display: 'flex', gap: 8 }}>
          <button onClick={saveConfig} style={{ flex: 1, padding: '6px 10px', background: '#2a4a6e', color: '#e8eef5', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>Save</button>
          <button onClick={resetConfig} style={{ flex: 1, padding: '6px 10px', background: '#3a2a2a', color: '#e8eef5', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>Reset</button>
        </div>
      </div>
    </div>
  )
}
