import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import './WaterPage.css'

const WATER_VERTEX_SHADER = `#define GLSLIFY 1
varying vec4 vMirrorCoord;
varying vec2 vUv;
varying vec3 vWorldPosition;

uniform mat4 uTextureMatrix;

void main () {
  vec3 transformedPosition = position;

  vUv = uv;
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vMirrorCoord = uTextureMatrix * vec4(transformedPosition, 1.0);

  vec4 mvPosition = vec4(transformedPosition, 1.0);
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
}`

const WATER_FRAGMENT_SHADER = `#define GLSLIFY 1
varying vec4 vMirrorCoord;
varying vec2 vUv;
varying vec3 vWorldPosition;

uniform sampler2D uTexture;
uniform sampler2D uAOTexture;
uniform sampler2D uNoiseTexture;
uniform sampler2D uFluidTexture;
uniform vec2 uMipmapTextureSize;
uniform vec2 uResolution;
uniform vec3 uColor;
uniform float uBaseLod;
uniform float uDistortionAmount;
uniform float uReflectionIntensity;
uniform float uTime;

vec4 cubic(float v) {
    vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
    vec4 s = n * n * n;
    float x = s.x;
    float y = s.y - 4.0 * s.x;
    float z = s.z - 4.0 * s.y + 6.0 * s.x;
    float w = 6.0 - x - y - z;
    return vec4(x, y, z, w);
}

vec4 textureBicubic(sampler2D t, vec2 texCoords, vec2 textureSize) {
    vec2 invTexSize = 1.0 / textureSize;
    texCoords = texCoords * textureSize - 0.5;

    vec2 fxy = fract(texCoords);
    texCoords -= fxy;
    vec4 xcubic = cubic(fxy.x);
    vec4 ycubic = cubic(fxy.y);

    vec4 c = texCoords.xxyy + vec2(-0.5, 1.5).xyxy;
    vec4 s = vec4(xcubic.xz + xcubic.yw, ycubic.xz + ycubic.yw);
    vec4 offset = c + vec4(xcubic.yw, ycubic.yw) / s;
    offset *= invTexSize.xxyy;

    vec4 sample0 = texture2D(t, offset.xz);
    vec4 sample1 = texture2D(t, offset.yz);
    vec4 sample2 = texture2D(t, offset.xw);
    vec4 sample3 = texture2D(t, offset.yw);

    float sx = s.x / (s.x + s.y);
    float sy = s.z / (s.z + s.w);

    return mix(
        mix(sample3, sample2, sx),
        mix(sample1, sample0, sx),
        sy
    );
}

vec4 packedTexture2DLOD(sampler2D tex, vec2 uv, int level, vec2 originalPixelSize) {
    float floatLevel = float(level);
    vec2 atlasSize;
    atlasSize.x = floor(originalPixelSize.x * 1.5);
    atlasSize.y = originalPixelSize.y;

    float maxLevel = min(floor(log2(originalPixelSize.x)), floor(log2(originalPixelSize.y)));
    floatLevel = min(floatLevel, maxLevel);

    vec2 currentPixelDimensions = floor(originalPixelSize / pow(2.0, floatLevel));
    vec2 pixelOffset = vec2(
        floatLevel > 0.0 ? originalPixelSize.x : 0.0,
        floatLevel > 0.0 ? currentPixelDimensions.y : 0.0
    );

    vec2 minPixel = pixelOffset;
    vec2 maxPixel = pixelOffset + currentPixelDimensions;
    vec2 samplePoint = mix(minPixel, maxPixel, uv);
    samplePoint /= atlasSize;
    vec2 halfPixelSize = 1.0 / (2.0 * atlasSize);
    samplePoint = min(samplePoint, maxPixel / atlasSize - halfPixelSize);
    samplePoint = max(samplePoint, minPixel / atlasSize + halfPixelSize);
    return textureBicubic(tex, samplePoint, originalPixelSize);
}

vec4 packedTexture2DLOD(sampler2D tex, vec2 uv, float level, vec2 originalPixelSize) {
    float ratio = mod(level, 1.0);
    int minLevel = int(floor(level));
    int maxLevel = int(ceil(level));
    vec4 minValue = packedTexture2DLOD(tex, uv, minLevel, originalPixelSize);
    vec4 maxValue = packedTexture2DLOD(tex, uv, maxLevel, originalPixelSize);
    return mix(minValue, maxValue, ratio);
}

const vec3 W = vec3(0.2125, 0.7154, 0.0721);
float luminance(in vec3 color) {
    return dot(color, W);
}

void main() {
    vec3 baseColor = uColor;
    float ao = texture2D(uAOTexture, vUv).r;
    vec4 fluid = texture2D(uFluidTexture, vUv);
    vec2 fluidPos = normalize(fluid.rgb).xy;

    float noiseTime = uTime * 0.05;
    vec2 noisePos = vec2((vUv.x + 0.5) * 6.0, vUv.y * 20.0) * 0.25;
    vec3 n1 = texture2D(uNoiseTexture, noisePos + vec2(0.0, 1.0 - noiseTime)).rgb - 0.5;

    float edgeReduce = smoothstep(0.0, uResolution.x * 0.1, gl_FragCoord.x) *
        smoothstep(uResolution.x, uResolution.x * 0.9, gl_FragCoord.x);

    vec2 reflectionUv = vMirrorCoord.xy / vMirrorCoord.w;
    reflectionUv.x += n1.x * 0.03 * edgeReduce * ao;
    reflectionUv.xy += fluidPos * 0.02 * ao * edgeReduce;

    vec2 fluidSpec = n1.xy + abs(fluidPos * 8.0);
    vec3 worldNormal = normalize(vec3(fluidSpec.x, 0.5 + fluidSpec.x, fluidSpec.y));
    vec3 specRay = reflect(normalize(vWorldPosition - cameraPosition), worldNormal);
    float spec = smoothstep(0.05, 1.0, dot(specRay, normalize(vec3(-1.0, 1.0, 1.0))));

    float lod = clamp(uBaseLod + spec * 2.0, 0.0, 4.0) * ao;

    vec3 color = packedTexture2DLOD(
        uTexture,
        reflectionUv,
        lod + clamp(length(fluidPos.xy) * 12.0, 0.0, 2.0),
        uMipmapTextureSize
    ).rgb;

    color *= baseColor;
    color *= mix(0.9, 1.0, n1.x) + spec * 0.2 * ao;

    float lum = luminance(abs(fluid.rgb));
    color += lum * 0.7 * ao;

    gl_FragColor = vec4(color, 1.0);
}`

const MIPMAP_FRAGMENT_SHADER = `#define GLSLIFY 1
varying vec2 vUv;

uniform sampler2D map;
uniform int parentLevel;
uniform vec2 parentMapSize;
uniform vec2 originalMapSize;

vec4 packedTexture2DLOD(sampler2D tex, vec2 uv, int level, vec2 originalPixelSize) {
    float floatLevel = float(level);
    vec2 atlasSize;
    atlasSize.x = floor(originalPixelSize.x * 1.5);
    atlasSize.y = originalPixelSize.y;

    float maxLevel = min(floor(log2(originalPixelSize.x)), floor(log2(originalPixelSize.y)));
    floatLevel = min(floatLevel, maxLevel);

    vec2 currentPixelDimensions = floor(originalPixelSize / pow(2.0, floatLevel));
    vec2 pixelOffset = vec2(
        floatLevel > 0.0 ? originalPixelSize.x : 0.0,
        floatLevel > 0.0 ? currentPixelDimensions.y : 0.0
    );

    vec2 minPixel = pixelOffset;
    vec2 maxPixel = pixelOffset + currentPixelDimensions;
    vec2 samplePoint = mix(minPixel, maxPixel, uv);
    samplePoint /= atlasSize;

    vec2 halfPixelSize = 1.0 / (2.0 * atlasSize);
    samplePoint = min(samplePoint, maxPixel / atlasSize - halfPixelSize);
    samplePoint = max(samplePoint, minPixel / atlasSize + halfPixelSize);
    return texture2D(tex, samplePoint);
}

vec4 sampleAt(vec2 uv) {
    return packedTexture2DLOD(map, uv, parentLevel, originalMapSize);
}

void main() {
    vec2 childMapSize = parentMapSize / 2.0;
    vec2 childPixelPos = floor(vUv * childMapSize);

    vec2 parentPixelSize = 1.0 / parentMapSize;
    vec2 halfParentPixelSize = parentPixelSize / 2.0;
    vec2 parentPixelPos = childPixelPos * 2.0;
    vec2 baseUv = (parentPixelPos / parentMapSize) + halfParentPixelSize;

    float xden = 2.0 * parentMapSize.x + 1.0;
    float wx0 = (parentMapSize.x - parentPixelPos.x) / xden;
    float wx1 = parentMapSize.x / xden;
    float wx2 = (parentPixelPos.x + 1.0) / xden;

    float yden = 2.0 * parentMapSize.y + 1.0;
    float wy0 = (parentMapSize.y - parentPixelPos.y) / yden;
    float wy1 = parentMapSize.y / yden;
    float wy2 = (parentPixelPos.y + 1.0) / yden;

    gl_FragColor =
        sampleAt(baseUv) * (wx0 * wy0) +
        sampleAt(baseUv + vec2(parentPixelSize.x, 0.0)) * (wx1 * wy0) +
        sampleAt(baseUv + vec2(2.0 * parentPixelSize.x, 0.0)) * (wx2 * wy0) +
        sampleAt(baseUv + vec2(0.0, parentPixelSize.y)) * (wx0 * wy1) +
        sampleAt(baseUv + vec2(parentPixelSize.x, parentPixelSize.y)) * (wx1 * wy1) +
        sampleAt(baseUv + vec2(2.0 * parentPixelSize.x, parentPixelSize.y)) * (wx2 * wy1) +
        sampleAt(baseUv + vec2(0.0, 2.0 * parentPixelSize.y)) * (wx0 * wy2) +
        sampleAt(baseUv + vec2(parentPixelSize.x, 2.0 * parentPixelSize.y)) * (wx1 * wy2) +
        sampleAt(baseUv + vec2(2.0 * parentPixelSize.x, 2.0 * parentPixelSize.y)) * (wx2 * wy2);
}`

const FULLSCREEN_VERTEX_SHADER = `#define GLSLIFY 1
varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const COPY_FRAGMENT_SHADER = `#define GLSLIFY 1
uniform sampler2D uTexture;
varying vec2 vUv;

void main() {
    gl_FragColor = texture2D(uTexture, vUv);
}`

const FLUID_VELOCITY_FRAGMENT_SHADER = `#define GLSLIFY 1
varying vec2 vUv;

uniform sampler2D uTexture;
uniform vec2 uCellSize;
uniform vec2 uForce;
uniform vec2 uMouse;
uniform vec2 uPrevMouse;
uniform vec2 uMouseVelocity;
uniform float uMouseRadius;
uniform float uPressure;

float sdLine(vec2 p, vec2 a, vec2 b) {
    float velocity = clamp(length(uMouseVelocity), 0.5, 1.5);
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) / velocity;
}

void main() {
    vec4 color = texture2D(uTexture, vUv - texture2D(uTexture, vUv).xy * uCellSize);

    float dir = smoothstep(1.0 - uMouseRadius, 1.0, 1.0 - min(sdLine(vUv, uPrevMouse, uMouse), 1.0));
    vec4 minColor = vec4(-1.0);
    vec4 maxColor = vec4(1.0);
    color = clamp((color + vec4(uForce * dir, 0.0, 1.0)) * uPressure, minColor, maxColor);
    gl_FragColor = color;
}`

const FLUID_DIVERGENCE_FRAGMENT_SHADER = `#define GLSLIFY 1
varying vec2 vUv;

uniform sampler2D uVelocity;
uniform vec2 uCellSize;
uniform float uViscosity;

void main() {
    float x0 = texture2D(uVelocity, vUv - vec2(uCellSize.x, 0.0)).x;
    float x1 = texture2D(uVelocity, vUv + vec2(uCellSize.x, 0.0)).x;
    float y0 = texture2D(uVelocity, vUv - vec2(0.0, uCellSize.y)).y;
    float y1 = texture2D(uVelocity, vUv + vec2(0.0, uCellSize.y)).y;

    float divergence = (x1 - x0 + y1 - y0) * uViscosity;
    gl_FragColor = vec4(divergence);
}`

const FLUID_PRESSURE_FRAGMENT_SHADER = `#define GLSLIFY 1
varying vec2 vUv;

uniform sampler2D uTexture;
uniform sampler2D uDivergence;
uniform float uAlpha;
uniform float uBeta;
uniform vec2 uCellSize;

void main() {
    float x0 = texture2D(uTexture, vUv - vec2(uCellSize.x, 0.0)).r;
    float x1 = texture2D(uTexture, vUv + vec2(uCellSize.x, 0.0)).r;
    float y0 = texture2D(uTexture, vUv - vec2(0.0, uCellSize.y)).r;
    float y1 = texture2D(uTexture, vUv + vec2(0.0, uCellSize.y)).r;
    float b = texture2D(uDivergence, vUv).r;

    float relaxed = (x0 + x1 + y0 + y1 + uAlpha * b) * uBeta;
    gl_FragColor = vec4(relaxed);
}`

const FLUID_SUBTRACT_FRAGMENT_SHADER = `#define GLSLIFY 1
varying vec2 vUv;

uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uCellSize;

void main() {
    float x0 = texture2D(uPressure, vUv - vec2(uCellSize.x, 0.0)).r;
    float x1 = texture2D(uPressure, vUv + vec2(uCellSize.x, 0.0)).r;
    float y0 = texture2D(uPressure, vUv - vec2(0.0, uCellSize.y)).r;
    float y1 = texture2D(uPressure, vUv + vec2(0.0, uCellSize.y)).r;

    vec2 v = texture2D(uVelocity, vUv).xy;

    gl_FragColor = vec4(
        v - vec2(x1 - x0, y1 - y0) * 0.5,
        1.0,
        1.0
    );
}`

class FullscreenQuad {
  constructor(material) {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  }

  get material() {
    return this.mesh.material
  }

  set material(material) {
    this.mesh.material = material
  }

  dispose() {
    this.mesh.geometry.dispose()
  }

  render(renderer) {
    renderer.render(this.mesh, this.camera)
  }
}

class Simulation {
  constructor(renderer, options) {
    this.renderer = renderer
    this.width = options.width ?? 32
    this.height = options.height ?? 32
    this.uniforms = options.uniforms ?? {}
    this.pingPong = options.pingPong ?? true
    this.autoSwap = options.autoSwap ?? true
    this.filter = options.filter ?? THREE.LinearFilter
    this.wrap = options.wrap ?? THREE.RepeatWrapping
    this.type = options.type ?? THREE.HalfFloatType
    this.texture = null

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.camera.position.z = 1

    this.buildRenderTargets()
    this.buildPlane(options.fragmentShader)
    if (options.createTexture !== false) {
      this.buildBaseTexture(options.data)
    }
    this.render()
  }

  buildRenderTargets() {
    this.renderTargets = {}
    this.renderTargets.a = new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: this.filter,
      magFilter: this.filter,
      wrapS: this.wrap,
      wrapT: this.wrap,
      generateMipmaps: false,
      format: THREE.RGBAFormat,
      type: this.type,
      depthBuffer: false,
      stencilBuffer: false,
    })
    this.renderTargets.write = this.renderTargets.a
    if (this.pingPong) {
      this.renderTargets.b = this.renderTargets.a.clone()
      this.renderTargets.read = this.renderTargets.b
    }
  }

  buildPlane(fragmentShader) {
    Object.assign(this.uniforms, {
      uBaseTexture: { value: null },
      uTexture: { value: null },
      uTime: { value: 0 },
      uDelta: { value: 0 },
      uResolution: { value: new THREE.Vector2(this.width, this.height) },
      uCellSize: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
    })

    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX_SHADER,
        fragmentShader,
        uniforms: this.uniforms,
        depthTest: false,
        depthWrite: false,
      }),
    )
    this.scene.add(this.plane)
  }

  buildBaseTexture(data) {
    const total = this.width * this.height * 4
    const values = new Float32Array(total)

    if (data) {
      for (let i = 0; i < total; i += 4) {
        values[i + 0] = data[i + 0]
        values[i + 1] = data[i + 1]
        values[i + 2] = data[i + 2]
        values[i + 3] = data[i + 3]
      }
    } else {
      for (let i = 0; i < total; i += 4) {
        values[i + 0] = 0
        values[i + 1] = 0
        values[i + 2] = 0
        values[i + 3] = 1
      }
    }

    this.baseTexture = new THREE.DataTexture(
      values,
      this.width,
      this.height,
      THREE.RGBAFormat,
      this.type,
    )
    this.baseTexture.minFilter = this.filter
    this.baseTexture.magFilter = this.filter
    this.baseTexture.wrapS = this.wrap
    this.baseTexture.wrapT = this.wrap
    this.baseTexture.generateMipmaps = false
    this.baseTexture.needsUpdate = true
    this.uniforms.uBaseTexture.value = this.baseTexture
    this.uniforms.uTexture.value = this.baseTexture
  }

  render() {
    const current = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(this.renderTargets.write)
    this.renderer.render(this.scene, this.camera)
    this.renderer.setRenderTarget(current)

    if (this.pingPong && this.autoSwap) {
      this.swap()
    } else {
      this.texture = this.renderTargets.write.texture
    }
  }

  swap() {
    const write = this.renderTargets.write
    this.renderTargets.write = this.renderTargets.read
    this.renderTargets.read = write
    this.texture = this.renderTargets.read.texture
  }

  update(time, delta, updateInput = true) {
    this.uniforms.uTime.value = time
    this.uniforms.uDelta.value = delta
    if (updateInput) {
      this.uniforms.uTexture.value = this.pingPong
        ? this.renderTargets.read.texture
        : this.renderTargets.write.texture
    }
    this.render()
  }

  setSize(width, height) {
    this.width = width
    this.height = height
    this.renderTargets.a.setSize(width, height)
    if (this.renderTargets.b) this.renderTargets.b.setSize(width, height)
    this.uniforms.uResolution.value.set(width, height)
    this.uniforms.uCellSize.value.set(1 / width, 1 / height)
  }

  destroy() {
    this.renderTargets.a.dispose()
    if (this.renderTargets.b) this.renderTargets.b.dispose()
    this.plane.geometry.dispose()
    this.plane.material.dispose()
    if (this.baseTexture) this.baseTexture.dispose()
  }
}

class FluidSimulation {
  constructor(renderer) {
    this.renderer = renderer
    this.raycaster = new THREE.Raycaster()
    this.prevMouse = new THREE.Vector2(-1, -1)
    this.lastPointer = new THREE.Vector2(999, 999)
    this.pointerMoved = false
    this.forcePointer = false
    this.mouseRadius = 0.2
    this.force = 20
    this.iterations = 1
    this.pressure = 0.999
    this.viscosity = 0.999

    this.velocitySim = new Simulation(renderer, {
      fragmentShader: FLUID_VELOCITY_FRAGMENT_SHADER,
      uniforms: {
        uMouse: { value: new THREE.Vector2(-1, -1) },
        uPrevMouse: { value: new THREE.Vector2(-1, -1) },
        uMouseVelocity: { value: new THREE.Vector2() },
        uForce: { value: new THREE.Vector2() },
        uMouseRadius: { value: this.mouseRadius },
        uPressure: { value: this.pressure },
      },
      width: 128,
      height: 128,
      filter: THREE.LinearFilter,
      wrap: THREE.RepeatWrapping,
      createTexture: false,
    })

    this.divergenceSim = new Simulation(renderer, {
      fragmentShader: FLUID_DIVERGENCE_FRAGMENT_SHADER,
      uniforms: {
        uVelocity: { value: this.velocitySim.texture },
        uViscosity: { value: this.viscosity },
      },
      width: 128,
      height: 128,
      filter: THREE.LinearFilter,
      wrap: THREE.RepeatWrapping,
      pingPong: false,
      createTexture: false,
    })

    this.pressureSim = new Simulation(renderer, {
      fragmentShader: FLUID_PRESSURE_FRAGMENT_SHADER,
      uniforms: {
        uDivergence: { value: this.divergenceSim.texture },
        uAlpha: { value: -1 },
        uBeta: { value: 0.25 },
      },
      width: 128,
      height: 128,
      filter: THREE.LinearFilter,
      wrap: THREE.RepeatWrapping,
      createTexture: false,
    })

    this.subtractPressureSim = new Simulation(renderer, {
      fragmentShader: FLUID_SUBTRACT_FRAGMENT_SHADER,
      uniforms: {
        uPressure: { value: this.pressureSim.texture },
        uVelocity: { value: this.velocitySim.texture },
      },
      width: 128,
      height: 128,
      filter: THREE.LinearFilter,
      wrap: THREE.RepeatWrapping,
      createTexture: false,
    })
  }

  update(pointer, camera, raycastObject, time, delta) {
    if (this.lastPointer.distanceToSquared(pointer) > 0.0000001) {
      this.lastPointer.copy(pointer)
      this.pointerMoved = true
    }

    this.velocitySim.uniforms.uPrevMouse.value.copy(this.prevMouse)

    if (this.pointerMoved) {
      this.raycaster.setFromCamera(pointer, camera)
      const hits = raycastObject ? this.raycaster.intersectObject(raycastObject, false) : []

      if (hits.length) {
        const uv = hits[0].uv
        if (this.prevMouse.x === -1 && this.prevMouse.y === -1) {
          this.prevMouse.copy(uv)
        }

        this.velocitySim.uniforms.uMouse.value.copy(uv)
        this.velocitySim.uniforms.uForce.value.set(
          (uv.x - this.prevMouse.x) * this.force,
          (uv.y - this.prevMouse.y) * this.force,
        )
        this.prevMouse.copy(uv)
      } else {
        this.velocitySim.uniforms.uMouse.value.set(-1, -1)
        this.velocitySim.uniforms.uForce.value.set(0, 0)
        this.prevMouse.set(-1, -1)
      }

      this.pointerMoved = false
    } else if (!this.forcePointer) {
      this.velocitySim.uniforms.uMouse.value.set(-1, -1)
      this.velocitySim.uniforms.uForce.value.set(0, 0)
      this.prevMouse.set(-1, -1)
    }

    this.velocitySim.uniforms.uMouseVelocity.value.set(
      (this.velocitySim.uniforms.uMouse.value.x - this.velocitySim.uniforms.uPrevMouse.value.x) / 16,
      (this.velocitySim.uniforms.uMouse.value.y - this.velocitySim.uniforms.uPrevMouse.value.y) / 16,
    )

    this.velocitySim.update(time, delta)
    this.divergenceSim.uniforms.uVelocity.value = this.velocitySim.texture
    this.divergenceSim.update(time, delta)
    this.pressureSim.uniforms.uDivergence.value = this.divergenceSim.texture

    for (let i = 0; i < this.iterations; i += 1) {
      this.pressureSim.update(time, delta)
    }

    this.subtractPressureSim.uniforms.uPressure.value = this.pressureSim.texture
    this.subtractPressureSim.uniforms.uVelocity.value = this.velocitySim.texture
    this.subtractPressureSim.update(time, delta)
    this.velocitySim.uniforms.uTexture.value = this.subtractPressureSim.texture
    this.velocitySim.update(time, delta, false)
  }

  destroy() {
    this.velocitySim.destroy()
    this.divergenceSim.destroy()
    this.pressureSim.destroy()
    this.subtractPressureSim.destroy()
  }
}

class Mipmapper {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX_SHADER,
      fragmentShader: MIPMAP_FRAGMENT_SHADER,
      uniforms: {
        map: { value: null },
        originalMapSize: { value: new THREE.Vector2() },
        parentMapSize: { value: new THREE.Vector2() },
        parentLevel: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })

    this.swapTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    })
    this.copyQuad = new FullscreenQuad(
      new THREE.RawShaderMaterial({
        vertexShader: `precision highp float;
precision highp int;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}`,
        fragmentShader: `precision highp float;
precision highp int;
uniform sampler2D uTexture;
varying vec2 vUv;
void main () {
  gl_FragColor = texture2D(uTexture, vUv);
}`,
        uniforms: { uTexture: { value: null } },
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
      }),
    )
    this.mipQuad = new FullscreenQuad(this.material)
    this.size = new THREE.Vector2()
    this.targetSize = new THREE.Vector2()
    this.maxMipMapLevel = 1
  }

  resize(size, target) {
    const width = Math.floor(size.x)
    const height = Math.floor(size.y)
    this.size.set(width, height)
    this.targetSize.set(Math.floor(this.size.x * 1.5), this.size.y)
    this.maxMipMapLevel = 1
    target.setSize(this.targetSize.x, this.targetSize.y)
    this.swapTarget.setSize(this.targetSize.x, this.targetSize.y)
  }

  update(inputTexture, target, renderer) {
    const previousAutoClear = renderer.autoClear
    const previousTarget = renderer.getRenderTarget()

    renderer.autoClear = false
    this.copyQuad.material.uniforms.uTexture.value = inputTexture
    renderer.setRenderTarget(this.swapTarget)
    this.copyQuad.render(renderer)

    let width = this.size.x
    let height = this.size.y
    let level = 0

    while (width > this.maxMipMapLevel && height > this.maxMipMapLevel) {
      this.material.uniforms.map.value = this.swapTarget.texture
      this.material.uniforms.parentLevel.value = level
      this.material.uniforms.parentMapSize.value.set(width, height)
      this.material.uniforms.originalMapSize.value.set(this.size.x, this.size.y)

      width = Math.floor(width / 2)
      height = Math.floor(height / 2)

      const yOffset = this.targetSize.y - 2 * height
      renderer.setRenderTarget(target)
      this.mipQuad.camera.setViewOffset(
        width,
        height,
        -this.size.x,
        -yOffset,
        this.targetSize.x,
        this.targetSize.y,
      )
      this.mipQuad.render(renderer)

      renderer.setRenderTarget(this.swapTarget)
      this.material.uniforms.map.value = target.texture
      this.mipQuad.render(renderer)
      level += 1
    }

    this.mipQuad.camera.clearViewOffset()
    renderer.setRenderTarget(previousTarget)
    renderer.autoClear = previousAutoClear
  }

  dispose() {
    this.swapTarget.dispose()
    this.copyQuad.dispose()
    this.mipQuad.dispose()
    this.material.dispose()
  }
}

class ReflectorHelper {
  constructor(renderer) {
    this.renderer = renderer
    this.camera = new THREE.PerspectiveCamera()
    this.reflectorPlane = new THREE.Plane()
    this.normal = new THREE.Vector3()
    this.reflectorWorldPosition = new THREE.Vector3()
    this.cameraWorldPosition = new THREE.Vector3()
    this.rotationMatrix = new THREE.Matrix4()
    this.lookAtPosition = new THREE.Vector3(0, 0, -1)
    this.clipPlane = new THREE.Vector4()
    this.view = new THREE.Vector3()
    this.target = new THREE.Vector3()
    this.q = new THREE.Vector4()
    this.textureSize = new THREE.Vector2(1, 1)
    this.textureMatrix = new THREE.Matrix4()
    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
    })
    this.mipmapper = new Mipmapper()
  }

  resize(width, height) {
    this.textureSize.set(width * 0.5, height * 0.5)
    this.mipmapper.resize(this.textureSize, this.renderTarget)
  }

  update(mesh, sceneCamera, scene, ignoreObjects = []) {
    this.reflectorWorldPosition.setFromMatrixPosition(mesh.matrixWorld)
    this.cameraWorldPosition.setFromMatrixPosition(sceneCamera.matrixWorld)

    this.rotationMatrix.extractRotation(mesh.matrixWorld)
    this.normal.set(0, 0, 1).applyMatrix4(this.rotationMatrix)

    this.view.subVectors(this.reflectorWorldPosition, this.cameraWorldPosition)
    if (this.view.dot(this.normal) > 0) return

    this.view.reflect(this.normal).negate()
    this.view.add(this.reflectorWorldPosition)

    this.rotationMatrix.extractRotation(sceneCamera.matrixWorld)
    this.lookAtPosition.set(0, 0, -1)
    this.lookAtPosition.applyMatrix4(this.rotationMatrix)
    this.lookAtPosition.add(this.cameraWorldPosition)

    this.target.subVectors(this.reflectorWorldPosition, this.lookAtPosition)
    this.target.reflect(this.normal).negate()
    this.target.add(this.reflectorWorldPosition)

    this.camera.position.copy(this.view)
    this.camera.up.set(0, 1, 0)
    this.camera.up.applyMatrix4(this.rotationMatrix)
    this.camera.up.reflect(this.normal)
    this.camera.lookAt(this.target)
    this.camera.far = sceneCamera.far
    this.camera.near = sceneCamera.near
    this.camera.aspect = sceneCamera.aspect
    this.camera.fov = sceneCamera.fov
    this.camera.zoom = sceneCamera.zoom
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()

    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    )
    this.textureMatrix.multiply(this.camera.projectionMatrix)
    this.textureMatrix.multiply(this.camera.matrixWorldInverse)
    this.textureMatrix.multiply(mesh.matrixWorld)

    this.reflectorPlane.setFromNormalAndCoplanarPoint(this.normal, this.reflectorWorldPosition)
    this.reflectorPlane.applyMatrix4(this.camera.matrixWorldInverse)
    this.clipPlane.set(
      this.reflectorPlane.normal.x,
      this.reflectorPlane.normal.y,
      this.reflectorPlane.normal.z,
      this.reflectorPlane.constant,
    )

    const projectionMatrix = this.camera.projectionMatrix
    const elements = projectionMatrix.elements

    this.q.x = (Math.sign(this.clipPlane.x) + elements[8]) / elements[0]
    this.q.y = (Math.sign(this.clipPlane.y) + elements[9]) / elements[5]
    this.q.z = -1.0
    this.q.w = (1.0 + elements[10]) / elements[14]

    this.clipPlane.multiplyScalar(2.0 / this.clipPlane.dot(this.q))
    elements[2] = this.clipPlane.x
    elements[6] = this.clipPlane.y
    elements[10] = this.clipPlane.z + 1.0 - 0.003
    elements[14] = this.clipPlane.w

    const previousTarget = this.renderer.getRenderTarget()
    const previousXrEnabled = this.renderer.xr.enabled
    const previousAutoClear = this.renderer.autoClear
    const viewport = new THREE.Vector4()
    this.renderer.getViewport(viewport)

    mesh.visible = false
    for (const object of ignoreObjects) object.visible = false

    this.renderer.xr.enabled = false
    this.renderer.autoClear = true
    this.renderer.setRenderTarget(this.renderTarget)
    this.renderer.setViewport(0, 0, this.textureSize.x / this.renderer.getPixelRatio(), this.textureSize.y / this.renderer.getPixelRatio())
    this.renderer.setScissor(0, 0, this.textureSize.x, this.textureSize.y)
    this.renderer.setScissorTest(true)
    this.renderer.clear(true, true, true)
    this.renderer.render(scene, this.camera)
    this.renderer.setScissorTest(false)
    this.renderer.setRenderTarget(previousTarget)
    this.renderer.setViewport(viewport)
    this.renderer.xr.enabled = previousXrEnabled
    this.renderer.autoClear = previousAutoClear

    this.mipmapper.update(this.renderTarget.texture, this.renderTarget, this.renderer)

    mesh.visible = true
    for (const object of ignoreObjects) object.visible = true
  }

  destroy() {
    this.renderTarget.dispose()
    this.mipmapper.dispose()
  }
}

function useKTX2Texture(path) {
  const { gl } = useThree()
  const [texture, setTexture] = useState(null)

  useEffect(() => {
    let alive = true
    let loadedTexture = null

    const loader = new KTX2Loader()
    loader.setTranscoderPath('/basis/')
    loader.detectSupport(gl)
    loader.load(
      path,
      (value) => {
        if (!alive) {
          value.dispose()
          return
        }
        loadedTexture = value
        value.minFilter = THREE.LinearFilter
        value.magFilter = THREE.LinearFilter
        if ('colorSpace' in value) value.colorSpace = THREE.NoColorSpace
        setTexture(value)
      },
      undefined,
      (error) => {
        console.error('Failed to load KTX2 texture', error)
      },
    )

    return () => {
      alive = false
      loader.dispose()
      if (loadedTexture) loadedTexture.dispose()
    }
  }, [gl, path])

  return texture
}

function GradientBackdrop() {
  return (
    <>
      <mesh position={[0, 0.3, -0.8]}>
        <planeGeometry args={[4.5, 2.4]} />
        <shaderMaterial
          depthWrite={false}
          vertexShader={`
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `}
          fragmentShader={`
            varying vec2 vUv;
            void main() {
              vec3 top = vec3(0.97, 0.98, 0.99);
              vec3 middle = vec3(0.86, 0.89, 0.94);
              vec3 bottom = vec3(0.73, 0.77, 0.84);
              float t = smoothstep(0.0, 1.0, vUv.y);
              vec3 color = mix(bottom, middle, smoothstep(0.0, 0.56, t));
              color = mix(color, top, smoothstep(0.48, 1.0, t));
              gl_FragColor = vec4(color, 1.0);
            }
          `}
        />
      </mesh>
      <mesh position={[0, 0.02, -0.45]}>
        <planeGeometry args={[4.2, 0.18]} />
        <meshBasicMaterial color="#f5f8fc" transparent opacity={0.55} depthWrite={false} />
      </mesh>
    </>
  )
}

function UnseenWater() {
  const { gl, scene, camera, size, pointer, viewport } = useThree()
  const meshRef = useRef(null)
  const materialRef = useRef(null)
  const noiseTexture = useLoader(THREE.TextureLoader, '/gradient-noise.webp')
  const aoTexture = useKTX2Texture('/ao.ktx2')

  const fluid = useMemo(() => new FluidSimulation(gl), [gl])
  const reflector = useMemo(() => new ReflectorHelper(gl), [gl])

  const uniforms = useMemo(
    () => ({
      uTextureMatrix: { value: reflector.textureMatrix },
      uTexture: { value: reflector.renderTarget.texture },
      uAOTexture: { value: null },
      uNoiseTexture: { value: null },
      uFluidTexture: { value: fluid.velocitySim.texture },
      uMipmapTextureSize: { value: reflector.mipmapper.targetSize },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uColor: { value: new THREE.Color(14870006) },
      uBaseLod: { value: 1 },
      uDistortionAmount: { value: 0.013 },
      uReflectionIntensity: { value: 0.24 },
      uTime: { value: 0 },
    }),
    [fluid.velocitySim.texture, reflector.mipmapper.targetSize, reflector.renderTarget.texture, reflector.textureMatrix],
  )

  useEffect(() => {
    noiseTexture.wrapS = THREE.RepeatWrapping
    noiseTexture.wrapT = THREE.RepeatWrapping
    noiseTexture.minFilter = THREE.LinearFilter
    noiseTexture.magFilter = THREE.LinearFilter
    if ('colorSpace' in noiseTexture) noiseTexture.colorSpace = THREE.NoColorSpace
    uniforms.uNoiseTexture.value = noiseTexture
  }, [noiseTexture, uniforms])

  useEffect(() => {
    if (!aoTexture) return
    uniforms.uAOTexture.value = aoTexture
  }, [aoTexture, uniforms])

  useEffect(() => {
    reflector.resize(size.width, size.height)
    uniforms.uResolution.value.set(size.width * gl.getPixelRatio(), size.height * gl.getPixelRatio())
  }, [gl, reflector, size.height, size.width, uniforms])

  useEffect(() => {
    return () => {
      fluid.destroy()
      reflector.destroy()
    }
  }, [fluid, reflector])

  useEffect(() => {
    camera.position.set(-0.15, 0.085, 0.42)
    camera.lookAt(-0.12, 0.01, 0.04)
    camera.near = 0.001
    camera.far = 2
    camera.fov = 40
    camera.updateProjectionMatrix()
  }, [camera])

  useFrame((state, delta) => {
    if (!meshRef.current || !materialRef.current || !aoTexture) return

    fluid.update(pointer, camera, meshRef.current, state.clock.elapsedTime, Math.min(delta, 0.016))
    reflector.update(meshRef.current, camera, scene, [])

    materialRef.current.uniforms.uTime.value = state.clock.elapsedTime
    materialRef.current.uniforms.uTexture.value = reflector.renderTarget.texture
    materialRef.current.uniforms.uTextureMatrix.value.copy(reflector.textureMatrix)
    materialRef.current.uniforms.uMipmapTextureSize.value.copy(reflector.mipmapper.targetSize)
    materialRef.current.uniforms.uFluidTexture.value = fluid.velocitySim.texture
  })

  return (
    <mesh
      ref={meshRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[-0.1193, 0.007851, 0.048929]}
      scale={[0.5, 0.5, 0.5]}
    >
      <planeGeometry args={[1, 1]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={WATER_VERTEX_SHADER}
        fragmentShader={WATER_FRAGMENT_SHADER}
      />
    </mesh>
  )
}

function Scene() {
  return (
    <>
      <color attach="background" args={['#d6dbe5']} />
      <fog attach="fog" args={['#d6dbe5', 0.45, 1.6]} />
      <GradientBackdrop />
      <UnseenWater />
    </>
  )
}

export default function WaterPage() {
  return (
    <div className="water-page">
      <Canvas
        camera={{ position: [-0.15, 0.085, 0.42], fov: 40, near: 0.001, far: 2 }}
        gl={{ antialias: true }}
        dpr={[1, 2]}
      >
        <Scene />
      </Canvas>
    </div>
  )
}
