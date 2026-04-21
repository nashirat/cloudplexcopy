import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { Water } from 'three/examples/jsm/objects/Water.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import './latestwater/LatestWaterPage.css'

const ChromaticAberrationShader = {
  uniforms: { tDiffuse: { value: null }, uStrength: { value: 0.0015 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uStrength; varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float r = texture2D(tDiffuse, vUv + dir * uStrength).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - dir * uStrength).b;
      gl_FragColor = vec4(r, g, b, 1.0);
    }`,
}

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
  size:            3,
  distortionScale: 3,
  waveSpeed:       0.35,
  waveHeight:      0.3,
  waveScaleVS:     0.04,
  reflBlur:        0.145,
  capillaryScale:    95,
  capillaryStrength: 0.14,
  capillaryDrift:    0.11,
  // Ripple (concentric rings from a point — placeholder for object impact)
  rippleX:         0,
  rippleZ:        20,
  rippleStrength:  0,
  rippleFreq:      1.2,
  rippleSpeed:     6,
  rippleDecay:     0.03,
  rippleRadius:    80,
  centerPeakHeight:    0,
  centerPeakSharpness: 0.15,
  sphereRadius:    1.5,
  sphereColor:     '#a8cce0',
  // Fine grain (tiny freckle-like ripples overlay)
  grainScale:      16,
  grainStrength:   0.3,
  // Dimples (very fine tight bump structure)
  dimpleScale:     40,
  dimpleStrength:  0.5,
  // Crest highlights (small whitecaps covering the surface)
  crestStrength:   0.35,
  crestThreshold:  0.35,
  crestSharpness:  0.25,
  crestColor:      '#d8e5ec',
  alpha:           1,
  // Layered water color
  shallowColor:    '#5c7a8a',
  deepColor:       '#2a4050',
  transColor:      '#8aa8b8',
  colorDepth:      1.4,
  waterAmbient:    0.75,
  // Reflection
  reflStrength:   0.74,
  reflBase:       0.33,
  reflAmbient:    0,
  fresnelPower:   7,
  scatterMix:     1,
  // Sun
  sunAzimuth:    246,
  sunElevation:   6,
  sunColor:     '#fff5d8',
  sunDiskSize:    105,
  sunIntensity:   0.85,
  specStrength:   0.45,
  specShininess:  85,
  // Camera
  cameraHeight:   6.5,
  fov:            45,
  // Renderer
  exposure:       0.95,
  // Post FX
  bloomStrength:  0.6,
  bloomRadius:    0.5,
  bloomThreshold: 0.85,
  caStrength:     0.0015,
}

// Patched vertex shader — actually displaces the water surface up/down based on
// noise so the plane has real wave geometry. Without this, the surface is flat
// and only normal-mapped, which always reads as "just a textured plane".
const PATCHED_WATER_VS = /* glsl */`
  uniform mat4 textureMatrix;
  uniform float time;
  uniform float uWaveHeight;
  uniform float uWaveScaleVS;
  uniform sampler2D normalSampler;

  varying vec4 mirrorCoord;
  varying vec4 worldPosition;
  varying float vWaveHeight;

  #include <common>
  #include <fog_pars_vertex>
  #include <shadowmap_pars_vertex>
  #include <logdepthbuf_pars_vertex>

  // Same 4-octave noise as the FS, but uses .w channel for height.
  float waveHeight( vec2 uv ) {
    vec2 uv0 = ( uv / 103.0 ) + vec2(time / 17.0, time / 29.0);
    vec2 uv1 = uv / 107.0 - vec2( time / -19.0, time / 31.0 );
    vec2 uv2 = uv / vec2( 8907.0, 9803.0 ) + vec2( time / 101.0, time / 97.0 );
    vec2 uv3 = uv / vec2( 1091.0, 1027.0 ) - vec2( time / 109.0, time / -113.0 );
    float h = texture2D( normalSampler, uv0 ).w
            + texture2D( normalSampler, uv1 ).w
            + texture2D( normalSampler, uv2 ).w
            + texture2D( normalSampler, uv3 ).w;
    return h * 0.25 - 0.5; // centre around 0, range roughly [-0.5, 0.5]
  }

  void main() {
    // World position before displacement (for sampling).
    vec4 worldPos = modelMatrix * vec4( position, 1.0 );
    float h = waveHeight( worldPos.xz * uWaveScaleVS );
    worldPos.y += h * uWaveHeight;
    vWaveHeight = h; // raw noise height in roughly [-0.5, 0.5]

    worldPosition = worldPos;
    mirrorCoord = textureMatrix * worldPos;
    gl_Position = projectionMatrix * viewMatrix * worldPos;

    #include <beginnormal_vertex>
    #include <defaultnormal_vertex>
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
    #include <shadowmap_vertex>
  }
`

// Patched copy of three.js Water's fragment shader. The stock version
// hardcodes Fresnel R0, Fresnel power, reflection multiplier, and the
// sunLight() shininess/strength values — we replace each with a uniform
// so the panel can drive them live.
const PATCHED_WATER_FS = /* glsl */`
  uniform sampler2D mirrorSampler;
  uniform samplerCube uEnvMap;
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
  uniform float uReflBlur;
  uniform vec3  uRippleOrigin;
  uniform float uRippleStrength;
  uniform float uRippleFreq;
  uniform float uRippleSpeed;
  uniform float uRippleDecay;
  uniform float uRippleRadius;
  uniform float uCenterPeakHeight;
  uniform float uCenterPeakSharpness;
  uniform float uGrainScale;
  uniform float uGrainStrength;
  uniform float uDimpleScale;
  uniform float uDimpleStrength;
  uniform float uCrestStrength;
  uniform float uCrestThreshold;
  uniform float uCrestSharpness;
  uniform vec3  uCrestColor;
  uniform float uCapillaryScale;
  uniform float uCapillaryStrength;
  uniform float uCapillaryDrift;

  varying vec4 mirrorCoord;
  varying vec4 worldPosition;
  varying float vWaveHeight;

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

    // Fine grain — extra high-frequency noise layer on top of the base waves
    // to give the "freckled" small ripple texture visible in calm water refs.
    vec4 grainN = getNoise( worldPosition.xz * size * uGrainScale );
    surfaceNormal = normalize( surfaceNormal + grainN.xzy * vec3( uGrainStrength, 0.0, uGrainStrength ) );
    // Dimples — very fine-scale normal perturbation creating tight bump structure.
    vec4 dimpleN = getNoise( worldPosition.xz * size * uDimpleScale );
    surfaceNormal = normalize( surfaceNormal + dimpleN.xzy * vec3( uDimpleStrength, 0.0, uDimpleStrength ) );

    // Capillary chaos — 4 rotated noise samples each drifting in their own
    // direction with their own scale. Result: turbulent multi-directional
    // wave field that reads as real wind-driven chop, not striped/linear.
    vec2 capUv = worldPosition.xz * size * uCapillaryScale * 0.01;
    float capT = time * uCapillaryDrift;
    vec3 capNormal = vec3( 0.0 );
    // Sample 1 — 0° rotation, drifts +X+Y
    vec4 capA = getNoise( capUv * 8.0       + vec2(  capT * 31.0,  capT * 17.0 ) );
    // Sample 2 — 60° rotation, drifts -X+Y
    vec2 ca = vec2(  0.5,   0.866 ), sa = vec2( -0.866, 0.5 );
    vec4 capB = getNoise( vec2( dot( capUv, ca ), dot( capUv, sa ) ) * 12.0 + vec2( -capT * 23.0,  capT * 29.0 ) );
    // Sample 3 — 120° rotation, drifts +X-Y
    vec2 cb = vec2( -0.5,   0.866 ), sb = vec2( -0.866,-0.5  );
    vec4 capC = getNoise( vec2( dot( capUv, cb ), dot( capUv, sb ) ) * 16.0 + vec2(  capT * 19.0, -capT * 34.0 ) );
    // Sample 4 — 30°, larger scale, drifts -X-Y
    vec2 cc = vec2(  0.866, 0.5  ), sc = vec2( -0.5,    0.866);
    vec4 capD = getNoise( vec2( dot( capUv, cc ), dot( capUv, sc ) ) * 5.0  + vec2( -capT * 27.0, -capT * 21.0 ) );
    capNormal = ( capA.xzy + capB.xzy + capC.xzy + capD.xzy ) * 0.25;

    surfaceNormal = normalize( surfaceNormal + capNormal * vec3( uCapillaryStrength, 0.0, uCapillaryStrength ) );

    // Crest mask — wherever the combined normal tilts sharply (steep local
    // slope), treat it as a tiny wave crest. This paints subtle bright edges
    // on the many small crests covering calm arctic water in the reference.
    float slope = length( surfaceNormal.xz );
    float crestMask = smoothstep( uCrestThreshold, uCrestThreshold + uCrestSharpness, slope );

    // Circular ripple — perturbs the normal in a concentric pattern emanating
    // from uRippleOrigin (XZ world position). Falls off with distance via
    // exponential decay; sin gives the wave rings; spatial gradient of the
    // wave gives the normal tilt direction (radial outward).
    vec2 rdv = worldPosition.xz - uRippleOrigin.xz;
    float rdist = length( rdv );
    float rEnvelope = smoothstep( uRippleRadius, 0.0, rdist );
    float rPhase = rdist * uRippleFreq - time * uRippleSpeed;
    float rDamp = exp( -rdist * uRippleDecay ) * rEnvelope;
    // Derivative: d/dx of sin(rdist * f) gives cos(...) * f * (rdv / rdist)
    vec2 rDir = rdist > 0.001 ? rdv / rdist : vec2( 0.0 );
    float rSlope = cos( rPhase ) * uRippleFreq * uRippleStrength * rDamp;
    // Central peak — gaussian bump; slope = 2*k*r*gauss*h, tilts normal outward.
    float centerGauss = exp( -rdist * rdist * uCenterPeakSharpness );
    float centerSlope = 2.0 * uCenterPeakSharpness * rdist * centerGauss * uCenterPeakHeight;
    float totalSlope = rSlope + centerSlope;
    surfaceNormal = normalize( surfaceNormal + vec3( rDir.x * totalSlope, 0.0, rDir.y * totalSlope ) );

    vec3 diffuseLight = vec3(0.0);
    vec3 specularLight = vec3(0.0);

    vec3 worldToEye = eye-worldPosition.xyz;
    vec3 eyeDirection = normalize( worldToEye );
    sunLight( surfaceNormal, eyeDirection, uSpecShininess, uSpecStrength, 0.5, diffuseLight, specularLight );

    float distance = length(worldToEye);

    // Cubemap reflection — use a TAMED normal so R doesn't wobble wildly per
    // pixel. Wild R variance = oily blobs because each pixel samples a very
    // different cubemap color. Damping XZ keeps the sample smooth across waves
    // while still letting the perturbed normal drive sun specular sharply.
    // Damp the BIG wave normal (no oily blobs from large tilts), but pass the
    // capillary chaos through full strength so reflection breaks up like real
    // wind-disturbed water.
    vec3 reflTilt = surfaceNormal - capNormal * vec3( uCapillaryStrength, 0.0, uCapillaryStrength ); // base wave only
    vec3 reflNormal = normalize(
      vec3( reflTilt.x * 0.12, reflTilt.y, reflTilt.z * 0.12 )
      + capNormal * vec3( uCapillaryStrength, 0.0, uCapillaryStrength )
    );
    vec3 R = reflect( -eyeDirection, reflNormal );
    R.y = max( R.y, 0.02 );
    vec3 envDir = vec3( -R.x, R.y, R.z );
    // Multi-tap blur — average 5 jittered samples around R for soft reflection.
    float b = uReflBlur;
    vec3 reflectionSample = (
      texture( uEnvMap, envDir ).rgb +
      texture( uEnvMap, normalize( envDir + vec3(  b, 0.0, 0.0 ) ) ).rgb +
      texture( uEnvMap, normalize( envDir + vec3( -b, 0.0, 0.0 ) ) ).rgb +
      texture( uEnvMap, normalize( envDir + vec3( 0.0, 0.0,  b ) ) ).rgb +
      texture( uEnvMap, normalize( envDir + vec3( 0.0, 0.0, -b ) ) ).rgb
    ) * 0.2;

    float theta = max( dot( eyeDirection, surfaceNormal ), 0.0 );
    // Fresnel on the FLAT surface angle — smooth horizon gradient, no oily blobs
    // from wave normals randomly spiking reflectance near camera.
    float flatNdV = max( dot( eyeDirection, vec3( 0.0, 1.0, 0.0 ) ), 0.001 );
    float rf0 = uReflBase;
    float reflectance = rf0 + ( 1.0 - rf0 ) * pow( 1.0 - flatNdV, uFresnelPower );

    // Layered water color — Beer-Lambert based on actual view DISTANCE through
    // the water column. Close pixels = short path = transmission/shallow shows
    // through ("see ~5m of clarity"); far pixels = long path = deep color.
    float pathLen = distance / max( uColorDepth * 8.0, 0.1 );
    float depthMix = 1.0 - exp( -pathLen );
    vec3 bodyCol = mix( uShallowColor, uDeepColor, depthMix );
    vec3 transmission = uTransColor * ( 1.0 - depthMix );
    vec3 scatter = ( bodyCol + transmission * 0.7 ) * uScatterMix;

    vec3 bodyOut = ( bodyCol * uWaterAmbient + scatter ) * getShadowMask();
    vec3 reflOut = vec3( uReflAmbient ) + reflectionSample;
    float reflMix = reflectance * clamp( uReflStrength, 0.0, 1.0 );
    // Specular fades near camera (flatNdV≈1) and concentrates toward horizon —
    // that's where sun glitter physically lives on real water.
    float specScale = pow( 1.0 - flatNdV, 1.5 );
    vec3 albedo = mix( bodyOut, reflOut, reflMix ) + specularLight * specScale;
    // Crest highlights — tint toward crest colour where the surface is steep.
    albedo = mix( albedo, uCrestColor, crestMask * uCrestStrength );
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
  // Slider is bounded by min/max for convenience, but the number input lets
  // you type any value (including negative or beyond max).
  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.max(min, Math.min(max, value))}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!isNaN(v)) onChange(v)
        }}
        style={{
          width: 50, fontSize: 11, background: 'rgba(0,0,0,0.3)',
          color: '#e8eef5', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 3, padding: '2px 4px', textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      />
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
export default function WaterDone1Page() {
  const containerRef = useRef(null)
  const STORAGE_KEY = 'waterdone1-config'
  const [params, setParams] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? { ...DEFAULTS, ...JSON.parse(saved) } : DEFAULTS
    } catch { return DEFAULTS }
  })
  const saveConfig = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(params)) }
    catch (e) { console.warn('save failed', e) }
  }
  const resetConfig = () => {
    localStorage.removeItem(STORAGE_KEY)
    setParams(DEFAULTS)
  }
  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `waterdone1-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

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
    const skyMap = new THREE.CubeTextureLoader()
      .setPath('/latestwater-cubemap/')
      .load(['px.jpg', 'nx.jpg', 'py.jpg', 'ny.jpg', 'pz.jpg', 'nz.jpg'])
    skyMap.colorSpace = THREE.SRGBColorSpace
    skyMap.generateMipmaps = true
    skyMap.minFilter = THREE.LinearMipmapLinearFilter
    skyMap.magFilter = THREE.LinearFilter
    scene.background = skyMap
    scene.environment = skyMap

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
      new THREE.PlaneGeometry(2000, 2000, 400, 400),
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
    water.material.uniforms.uEnvMap         = { value: skyMap }
    water.material.uniforms.uWaveHeight     = { value: DEFAULTS.waveHeight }
    water.material.uniforms.uWaveScaleVS    = { value: DEFAULTS.waveScaleVS }
    water.material.uniforms.uReflBlur       = { value: DEFAULTS.reflBlur }
    water.material.uniforms.uCapillaryScale    = { value: DEFAULTS.capillaryScale }
    water.material.uniforms.uCapillaryStrength = { value: DEFAULTS.capillaryStrength }
    water.material.uniforms.uCapillaryDrift    = { value: DEFAULTS.capillaryDrift }
    water.material.uniforms.uRippleOrigin   = { value: new THREE.Vector3(DEFAULTS.rippleX, 0, DEFAULTS.rippleZ) }
    water.material.uniforms.uRippleStrength = { value: DEFAULTS.rippleStrength }
    water.material.uniforms.uRippleFreq     = { value: DEFAULTS.rippleFreq }
    water.material.uniforms.uRippleSpeed    = { value: DEFAULTS.rippleSpeed }
    water.material.uniforms.uRippleDecay    = { value: DEFAULTS.rippleDecay }
    water.material.uniforms.uRippleRadius   = { value: DEFAULTS.rippleRadius }
    water.material.uniforms.uCenterPeakHeight    = { value: DEFAULTS.centerPeakHeight }
    water.material.uniforms.uCenterPeakSharpness = { value: DEFAULTS.centerPeakSharpness }
    water.material.uniforms.uGrainScale     = { value: DEFAULTS.grainScale }
    water.material.uniforms.uGrainStrength  = { value: DEFAULTS.grainStrength }
    water.material.uniforms.uDimpleScale    = { value: DEFAULTS.dimpleScale }
    water.material.uniforms.uDimpleStrength = { value: DEFAULTS.dimpleStrength }
    water.material.uniforms.uCrestStrength  = { value: DEFAULTS.crestStrength }
    water.material.uniforms.uCrestThreshold = { value: DEFAULTS.crestThreshold }
    water.material.uniforms.uCrestSharpness = { value: DEFAULTS.crestSharpness }
    water.material.uniforms.uCrestColor     = { value: new THREE.Color(DEFAULTS.crestColor) }
    water.material.vertexShader = PATCHED_WATER_VS
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

    // Post-processing.
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      DEFAULTS.bloomStrength, DEFAULTS.bloomRadius, DEFAULTS.bloomThreshold,
    )
    composer.addPass(bloomPass)
    const caPass = new ShaderPass(ChromaticAberrationShader)
    caPass.uniforms.uStrength.value = DEFAULTS.caStrength
    composer.addPass(caPass)
    composer.addPass(new OutputPass())
    refs.current.composer = composer
    refs.current.bloomPass = bloomPass
    refs.current.caPass = caPass

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
      composer.render()
      raf = requestAnimationFrame(tick)
    }
    tick()

    const resize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      composer.setSize(w, h)
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
      skyMap.dispose()
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
    r.water.material.uniforms.uWaveHeight.value = params.waveHeight
    r.water.material.uniforms.uWaveScaleVS.value = params.waveScaleVS
    r.water.material.uniforms.uReflBlur.value = params.reflBlur
    r.water.material.uniforms.uCapillaryScale.value = params.capillaryScale
    r.water.material.uniforms.uCapillaryStrength.value = params.capillaryStrength
    r.water.material.uniforms.uCapillaryDrift.value = params.capillaryDrift
    r.water.material.uniforms.uRippleOrigin.value.set(params.rippleX, 0, params.rippleZ)
    r.water.material.uniforms.uRippleStrength.value = params.rippleStrength
    r.water.material.uniforms.uRippleFreq.value = params.rippleFreq
    r.water.material.uniforms.uRippleSpeed.value = params.rippleSpeed
    r.water.material.uniforms.uRippleDecay.value = params.rippleDecay
    r.water.material.uniforms.uRippleRadius.value = params.rippleRadius
    r.water.material.uniforms.uCenterPeakHeight.value = params.centerPeakHeight
    r.water.material.uniforms.uCenterPeakSharpness.value = params.centerPeakSharpness
    r.water.material.uniforms.uGrainScale.value = params.grainScale
    r.water.material.uniforms.uGrainStrength.value = params.grainStrength
    r.water.material.uniforms.uDimpleScale.value = params.dimpleScale
    r.water.material.uniforms.uDimpleStrength.value = params.dimpleStrength
    r.water.material.uniforms.uCrestStrength.value = params.crestStrength
    r.water.material.uniforms.uCrestThreshold.value = params.crestThreshold
    r.water.material.uniforms.uCrestSharpness.value = params.crestSharpness
    r.water.material.uniforms.uCrestColor.value.set(params.crestColor)
    r.water.material.uniforms.uWaterAmbient.value = params.waterAmbient
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

    // Camera + renderer.
    r.camera.position.y = params.cameraHeight
    r.camera.fov = params.fov
    r.camera.updateProjectionMatrix()
    r.renderer.toneMappingExposure = params.exposure
    if (r.bloomPass) {
      r.bloomPass.strength  = params.bloomStrength
      r.bloomPass.radius    = params.bloomRadius
      r.bloomPass.threshold = params.bloomThreshold
    }
    if (r.caPass) r.caPass.uniforms.uStrength.value = params.caStrength
  }, [params])

  // Helper to update a single param without rewriting the whole object.
  const set = (key) => (value) => setParams((p) => ({ ...p, [key]: value }))

  return (
    <div className="latestwater-page">
      <div className="latestwater-stage" ref={containerRef} />
      <div className="latestwater-panel">
        <details className="group" open>
          <summary>Surface</summary>
          <Slider label="Size"        value={params.size}            min={0.3}  max={5}    step={0.05} onChange={set('size')}            fmt={(v) => v.toFixed(2)} />
          <Slider label="Distortion"  value={params.distortionScale} min={0}    max={10}   step={0.1}  onChange={set('distortionScale')} fmt={(v) => v.toFixed(1)} />
          <Slider label="Wave speed"  value={params.waveSpeed}       min={0}    max={3}    step={0.05} onChange={set('waveSpeed')}       fmt={(v) => v.toFixed(2)} />
          <Slider label="Wave height" value={params.waveHeight}      min={0}    max={5}    step={0.05} onChange={set('waveHeight')}      fmt={(v) => v.toFixed(2)} />
          <Slider label="Wave scale"  value={params.waveScaleVS}     min={0.005} max={0.2} step={0.005} onChange={set('waveScaleVS')}    fmt={(v) => v.toFixed(3)} />
          <Slider label="Alpha"       value={params.alpha}           min={0}    max={1}    step={0.01} onChange={set('alpha')}           fmt={(v) => v.toFixed(2)} />
          <Slider label="Body mix"    value={params.scatterMix}      min={0}    max={2}    step={0.05} onChange={set('scatterMix')}      fmt={(v) => v.toFixed(2)} />
        </details>

        <details className="group" open>
          <summary>Colors</summary>
          <ColorRow label="Shallow"   value={params.shallowColor}                                        onChange={set('shallowColor')} />
          <ColorRow label="Deep"      value={params.deepColor}                                           onChange={set('deepColor')} />
          <ColorRow label="Transmit"  value={params.transColor}                                          onChange={set('transColor')} />
          <Slider label="Color depth" value={params.colorDepth}      min={0.2}  max={10}   step={0.1}  onChange={set('colorDepth')}      fmt={(v) => v.toFixed(1)} />
          <Slider label="Ambient"     value={params.waterAmbient}    min={0}    max={2}    step={0.05} onChange={set('waterAmbient')}    fmt={(v) => v.toFixed(2)} />
        </details>

        <details className="group" open>
          <summary>Reflection</summary>
          <Slider label="Strength"    value={params.reflStrength}    min={0}    max={2}    step={0.02} onChange={set('reflStrength')}    fmt={(v) => v.toFixed(2)} />
          <Slider label="Min (R0)"    value={params.reflBase}        min={0}    max={1}    step={0.01} onChange={set('reflBase')}        fmt={(v) => v.toFixed(2)} />
          <Slider label="Ambient"     value={params.reflAmbient}     min={0}    max={0.4}  step={0.005} onChange={set('reflAmbient')}    fmt={(v) => v.toFixed(3)} />
          <Slider label="Fresnel pow" value={params.fresnelPower}    min={0.5}  max={12}   step={0.1}  onChange={set('fresnelPower')}    fmt={(v) => v.toFixed(1)} />
          <Slider label="Refl blur"   value={params.reflBlur}        min={0}    max={0.5}  step={0.005} onChange={set('reflBlur')}       fmt={(v) => v.toFixed(3)} />
          <Slider label="Cap scale"   value={params.capillaryScale}    min={10}   max={400}  step={5}    onChange={set('capillaryScale')}    fmt={(v) => v.toFixed(0)} />
          <Slider label="Cap str"     value={params.capillaryStrength} min={0}    max={2}    step={0.01} onChange={set('capillaryStrength')} fmt={(v) => v.toFixed(2)} />
          <Slider label="Cap drift"   value={params.capillaryDrift}    min={0}    max={1}    step={0.005} onChange={set('capillaryDrift')}   fmt={(v) => v.toFixed(3)} />
        </details>

        <details className="group" open>
          <summary>Sun</summary>
          <Slider label="Azimuth"     value={params.sunAzimuth}      min={0}    max={360}  step={1}    onChange={set('sunAzimuth')}      fmt={(v) => `${v.toFixed(0)}°`} />
          <Slider label="Elevation"   value={params.sunElevation}    min={0}    max={90}   step={1}    onChange={set('sunElevation')}    fmt={(v) => `${v.toFixed(0)}°`} />
          <Slider label="Disk size"   value={params.sunDiskSize}     min={20}   max={500}  step={5}    onChange={set('sunDiskSize')}     fmt={(v) => v.toFixed(0)} />
          <Slider label="Light"       value={params.sunIntensity}    min={0}    max={3}    step={0.05} onChange={set('sunIntensity')}    fmt={(v) => v.toFixed(2)} />
          <Slider label="Spec str"    value={params.specStrength}    min={0}    max={6}    step={0.05} onChange={set('specStrength')}    fmt={(v) => v.toFixed(2)} />
          <Slider label="Spec sharp"  value={params.specShininess}   min={5}    max={500}  step={5}    onChange={set('specShininess')}   fmt={(v) => v.toFixed(0)} />
          <ColorRow label="Color"     value={params.sunColor}                                            onChange={set('sunColor')} />
        </details>

        <details className="group" open>
          <summary>Camera & Render</summary>
          <Slider label="Cam height"  value={params.cameraHeight}    min={1}    max={30}   step={0.5}  onChange={set('cameraHeight')}    fmt={(v) => v.toFixed(1)} />
          <Slider label="FOV"         value={params.fov}             min={25}   max={90}   step={1}    onChange={set('fov')}             fmt={(v) => `${v.toFixed(0)}°`} />
          <Slider label="Exposure"    value={params.exposure}        min={0.3}  max={2}    step={0.05} onChange={set('exposure')}        fmt={(v) => v.toFixed(2)} />
        </details>

        <details className="group">
          <summary>Ripple</summary>
          <Slider label="X"           value={params.rippleX}         min={-100} max={100}  step={0.5}  onChange={set('rippleX')}         fmt={(v) => v.toFixed(1)} />
          <Slider label="Z"           value={params.rippleZ}         min={-100} max={100}  step={0.5}  onChange={set('rippleZ')}         fmt={(v) => v.toFixed(1)} />
          <Slider label="Strength"    value={params.rippleStrength}  min={0}    max={5}    step={0.05} onChange={set('rippleStrength')}  fmt={(v) => v.toFixed(2)} />
          <Slider label="Freq"        value={params.rippleFreq}      min={0.05} max={3}    step={0.01} onChange={set('rippleFreq')}      fmt={(v) => v.toFixed(2)} />
          <Slider label="Speed"       value={params.rippleSpeed}     min={0}    max={10}   step={0.1}  onChange={set('rippleSpeed')}     fmt={(v) => v.toFixed(1)} />
          <Slider label="Decay"       value={params.rippleDecay}     min={0.005} max={0.5} step={0.005} onChange={set('rippleDecay')}    fmt={(v) => v.toFixed(3)} />
          <Slider label="Radius"      value={params.rippleRadius}    min={5}    max={300}  step={1}    onChange={set('rippleRadius')}    fmt={(v) => v.toFixed(0)} />
          <Slider label="Peak ht"     value={params.centerPeakHeight}    min={0}    max={10}   step={0.1}  onChange={set('centerPeakHeight')}    fmt={(v) => v.toFixed(1)} />
          <Slider label="Peak sharp"  value={params.centerPeakSharpness} min={0.01} max={1}    step={0.01} onChange={set('centerPeakSharpness')} fmt={(v) => v.toFixed(2)} />
        </details>

        <details className="group">
          <summary>Grain</summary>
          <Slider label="Scale"       value={params.grainScale}      min={1}    max={60}   step={0.5}  onChange={set('grainScale')}      fmt={(v) => v.toFixed(1)} />
          <Slider label="Strength"    value={params.grainStrength}   min={0}    max={3}    step={0.05} onChange={set('grainStrength')}   fmt={(v) => v.toFixed(2)} />
        </details>

        <details className="group">
          <summary>Dimples</summary>
          <Slider label="Scale"       value={params.dimpleScale}     min={5}    max={120}  step={1}    onChange={set('dimpleScale')}     fmt={(v) => v.toFixed(0)} />
          <Slider label="Strength"    value={params.dimpleStrength}  min={0}    max={2}    step={0.05} onChange={set('dimpleStrength')}  fmt={(v) => v.toFixed(2)} />
        </details>

        <details className="group">
          <summary>Crests</summary>
          <Slider label="Strength"    value={params.crestStrength}   min={0}    max={1}    step={0.01} onChange={set('crestStrength')}   fmt={(v) => v.toFixed(2)} />
          <Slider label="Threshold"   value={params.crestThreshold}  min={0}    max={1}    step={0.01} onChange={set('crestThreshold')}  fmt={(v) => v.toFixed(2)} />
          <Slider label="Sharpness"   value={params.crestSharpness}  min={0.01} max={1}    step={0.01} onChange={set('crestSharpness')}  fmt={(v) => v.toFixed(2)} />
          <ColorRow label="Color"     value={params.crestColor}                                        onChange={set('crestColor')} />
        </details>

        <details className="group">
          <summary>Post FX</summary>
          <Slider label="Bloom str"   value={params.bloomStrength}   min={0}    max={3}    step={0.05} onChange={set('bloomStrength')}   fmt={(v) => v.toFixed(2)} />
          <Slider label="Bloom rad"   value={params.bloomRadius}     min={0}    max={1}    step={0.01} onChange={set('bloomRadius')}     fmt={(v) => v.toFixed(2)} />
          <Slider label="Bloom thr"   value={params.bloomThreshold}  min={0}    max={1}    step={0.01} onChange={set('bloomThreshold')}  fmt={(v) => v.toFixed(2)} />
          <Slider label="CA"          value={params.caStrength}      min={0}    max={0.02} step={0.0005} onChange={set('caStrength')}    fmt={(v) => v.toFixed(4)} />
        </details>

        <div className="group" style={{ display: 'flex', gap: 8 }}>
          <button onClick={saveConfig} style={{ flex: 1, padding: '6px 10px', background: '#2a4a6e', color: '#e8eef5', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>Save Config</button>
          <button onClick={exportConfig} style={{ flex: 1, padding: '6px 10px', background: '#2a6e4a', color: '#e8eef5', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>Export JSON</button>
          <button onClick={resetConfig} style={{ flex: 1, padding: '6px 10px', background: '#3a2a2a', color: '#e8eef5', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>Reset</button>
        </div>
      </div>
    </div>
  )
}
