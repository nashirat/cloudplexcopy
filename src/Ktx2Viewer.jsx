import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import * as THREE from 'three'
import './Ktx2Viewer.css'

const TRANSCODER_PATH = '/basis/'

function getTextureSize(texture) {
  const image = texture?.image
  if (image?.width && image?.height) {
    return { width: image.width, height: image.height }
  }
  const data = texture?.source?.data
  if (data?.width && data?.height) {
    return { width: data.width, height: data.height }
  }
  return { width: 0, height: 0 }
}

function Ktx2Plane({ url, colorSpace, flipY, onMeta, onError }) {
  const gl = useThree((state) => state.gl)
  const [texture, setTexture] = useState(null)

  useEffect(() => {
    if (!url) {
      setTexture((prev) => {
        prev?.dispose()
        return null
      })
      if (typeof onMeta === 'function') {
        onMeta(null)
      }
      return undefined
    }

    let cancelled = false
    const loader = new KTX2Loader()
    loader.setTranscoderPath(TRANSCODER_PATH)
    loader.detectSupport(gl)

    loader.load(
      url,
      (loaded) => {
        if (cancelled) {
          loaded.dispose()
          return
        }
        setTexture((prev) => {
          prev?.dispose()
          return loaded
        })
        if (typeof onMeta === 'function') {
          const { width, height } = getTextureSize(loaded)
          onMeta({ width, height })
        }
      },
      undefined,
      (error) => {
        if (cancelled) return
        if (typeof onError === 'function') {
          onError(error)
        }
      },
    )

    return () => {
      cancelled = true
      loader.dispose()
    }
  }, [gl, onError, onMeta, url])

  useEffect(() => {
    if (!texture) return
    texture.colorSpace =
      colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace
    texture.flipY = flipY
    texture.needsUpdate = true
  }, [colorSpace, flipY, texture])

  const size = useMemo(() => getTextureSize(texture), [texture])
  const aspect = size.width && size.height ? size.width / size.height : 1
  const width = Math.max(1, aspect)
  const height = Math.max(1, 1 / aspect)

  return (
    <mesh scale={[width, height, 1]}>
      <planeGeometry args={[1, 1]} />
      <meshStandardMaterial
        color={texture ? '#ffffff' : '#9aa7b4'}
        map={texture ?? null}
        roughness={0.6}
        metalness={0}
      />
    </mesh>
  )
}

export default function Ktx2Viewer() {
  const [fileUrl, setFileUrl] = useState(null)
  const [fileName, setFileName] = useState('No file loaded')
  const [error, setError] = useState('')
  const [meta, setMeta] = useState(null)
  const [colorSpace, setColorSpace] = useState('srgb')
  const [flipY, setFlipY] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const lastUrlRef = useRef(null)

  useEffect(() => {
    return () => {
      if (lastUrlRef.current) {
        URL.revokeObjectURL(lastUrlRef.current)
      }
    }
  }, [])

  const loadFile = useCallback((file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.ktx2')) {
      setError('Please drop a .ktx2 file.')
      return
    }
    if (lastUrlRef.current) {
      URL.revokeObjectURL(lastUrlRef.current)
    }
    const nextUrl = URL.createObjectURL(file)
    lastUrlRef.current = nextUrl
    setFileUrl(nextUrl)
    setFileName(file.name)
    setError('')
  }, [])

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault()
      setIsDragging(false)
      const file = event.dataTransfer?.files?.[0]
      loadFile(file)
    },
    [loadFile],
  )

  return (
    <div
      className={`ktx2-page ${isDragging ? 'ktx2-page--dragging' : ''} ${
        fileUrl ? 'ktx2-page--loaded' : ''
      }`}
      onDragOver={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        setIsDragging(false)
      }}
      onDrop={handleDrop}
    >
      <div className="ktx2-panel">
        <div>
          <div className="ktx2-kicker">KTX2 Viewer</div>
          <div className="ktx2-title">Texture Inspector</div>
        </div>
        <label className="ktx2-upload">
          Load .ktx2
          <input
            type="file"
            accept=".ktx2"
            onChange={(event) => {
              loadFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
        </label>
        <div className="ktx2-meta">
          <div>
            <span>File</span>
            <strong>{fileName}</strong>
          </div>
          <div>
            <span>Size</span>
            <strong>
              {meta?.width && meta?.height
                ? `${meta.width} x ${meta.height}`
                : '--'}
            </strong>
          </div>
          {error ? (
            <div className="ktx2-error">{error}</div>
          ) : (
            <div className="ktx2-hint">Drag + drop anywhere.</div>
          )}
        </div>
        <div className="ktx2-controls">
          <label>
            Color Space
            <select
              value={colorSpace}
              onChange={(event) => setColorSpace(event.target.value)}
            >
              <option value="srgb">sRGB (color)</option>
              <option value="linear">Linear (data)</option>
            </select>
          </label>
          <label className="ktx2-toggle">
            <input
              type="checkbox"
              checked={flipY}
              onChange={(event) => setFlipY(event.target.checked)}
            />
            Flip Y
          </label>
        </div>
      </div>
      <div className="ktx2-canvas">
        <Canvas camera={{ position: [0, 0, 2.6], fov: 45 }} dpr={[1, 2]}>
          <color attach="background" args={['#12161c']} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[2, 3, 2]} intensity={0.9} />
          <Suspense fallback={null}>
            <Ktx2Plane
              url={fileUrl}
              colorSpace={colorSpace}
              flipY={flipY}
              onMeta={setMeta}
              onError={(err) =>
                setError(err?.message ?? 'Failed to load texture.')
              }
            />
          </Suspense>
        </Canvas>
      </div>
    </div>
  )
}
