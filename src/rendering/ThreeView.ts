import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { DARKEST, LIGHT, LIGHTER } from '../assets/palette'
import { getAgentVisualRisk } from '../sim/agentBehavior'
import { AGENT_RISK_COLORS } from '../sim/colors'
import type { Simulation } from '../sim/Simulation'
import type { SandboxTerrainDef } from '../stores/sandboxTerrains'

const MAX_AGENTS = 2000
const PADDING = 1.02 // 2% breathing room around terrain

// Mist parameters
const MIST_DECAY = 0.97        // per-update decay — high value = long lingering trails
const MIST_DEPOSIT = 4         // alpha added per agent stamp
const MIST_MAX_ALPHA = 30      // cap below border opacity

export interface ThreeViewOptions {
  container: HTMLElement
  model: Simulation
  terrain: SandboxTerrainDef
  nodeColorMap: Map<string, string>
}

export class ThreeView {
  private scene: THREE.Scene
  private camera: THREE.OrthographicCamera
  private renderer: THREE.WebGLRenderer
  private controls: OrbitControls

  private mistPlane!: THREE.Mesh
  private mistTexture!: THREE.DataTexture
  private mistData!: Uint8Array
  private mistW = 0
  private mistH = 0

  private agentMesh!: THREE.InstancedMesh
  private agentDummy = new THREE.Object3D()

  private terrainGroup = new THREE.Group()
  private nodeGroup = new THREE.Group()

  private model: Simulation
  private terrain: SandboxTerrainDef
  private nodeColorMap: Map<string, string>

  // World dimensions for resize. y=0 = north, y grows south.
  // The camera's up vector is flipped (0, -1, 0) so north displays at the
  // top of the viewport regardless of the y-down cell coordinate convention.
  private worldWidth: number
  private worldHeight: number
  private centerX: number
  private centerY: number

  private frameCount = 0
  private resizeObserver: ResizeObserver | null = null

  constructor(options: ThreeViewOptions) {
    const { container, model, terrain, nodeColorMap } = options
    this.model = model
    this.terrain = terrain
    this.nodeColorMap = nodeColorMap

    // Grid dimensions in cell units. y grows south.
    this.worldWidth = model.width
    this.worldHeight = model.height
    this.centerX = model.width / 2
    this.centerY = model.height / 2

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setClearColor(DARKEST)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    container.appendChild(this.renderer.domElement)

    // Scene
    this.scene = new THREE.Scene()

    // Orthographic camera looking down -Z (XY is the ground plane)
    const { left, right, top, bottom } = this.computeFrustum(
      container.clientWidth,
      container.clientHeight,
    )
    this.camera = new THREE.OrthographicCamera(left, right, top, bottom, -100, 100)
    this.camera.position.set(this.centerX, this.centerY, 50)
    // Flip the screen "up" direction so y=0 (north) displays at the top
    // and y=height (south) at the bottom of the viewport, despite the
    // y-down cell convention.
    this.camera.up.set(0, -1, 0)
    this.camera.lookAt(this.centerX, this.centerY, 0)

    // Controls: pan + zoom only, no rotation
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(this.centerX, this.centerY, 0)
    this.controls.enableRotate = false
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.1
    this.controls.screenSpacePanning = true
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }
    this.controls.update()

    // Build scene
    this.buildMistPlane()
    this.buildAgentMesh()
    this.buildTerrainFeatures()
    this.buildNodeMarkers()

    // Resize observer
    this.resizeObserver = new ResizeObserver(() => this.handleResize(container))
    this.resizeObserver.observe(container)
  }

  /** Compute ortho frustum that fits the world into the container with padding */
  private computeFrustum(containerW: number, containerH: number) {
    const containerAspect = containerW / containerH
    const worldAspect = this.worldWidth / this.worldHeight

    let halfW: number
    let halfH: number

    if (containerAspect > worldAspect) {
      halfH = (this.worldHeight / 2) * PADDING
      halfW = halfH * containerAspect
    } else {
      halfW = (this.worldWidth / 2) * PADDING
      halfH = halfW / containerAspect
    }

    return {
      left: -halfW,
      right: halfW,
      top: halfH,
      bottom: -halfH,
    }
  }

  // --- Build scene objects ---

  private buildMistPlane(): void {
    // 1/4 resolution — soft broad wisps; LinearFilter gives natural blur
    this.mistW = Math.ceil(this.model.width / 4)
    this.mistH = Math.ceil(this.model.height / 4)

    this.mistData = new Uint8Array(this.mistW * this.mistH * 4)
    this.mistTexture = new THREE.DataTexture(
      this.mistData,
      this.mistW,
      this.mistH,
      THREE.RGBAFormat,
    )
    this.mistTexture.minFilter = THREE.LinearFilter
    this.mistTexture.magFilter = THREE.LinearFilter
    this.mistTexture.flipY = false

    const geometry = new THREE.PlaneGeometry(this.worldWidth, this.worldHeight)
    const material = new THREE.MeshBasicMaterial({
      map: this.mistTexture,
      transparent: true,
      depthWrite: false,
    })

    this.mistPlane = new THREE.Mesh(geometry, material)
    this.mistPlane.position.set(this.centerX, this.centerY, -0.01)
    this.scene.add(this.mistPlane)
  }

  private buildAgentMesh(): void {
    // Colored fill
    const agentGeom = new THREE.CircleGeometry(0.105, 12)
    const agentMat = new THREE.MeshBasicMaterial()
    this.agentMesh = new THREE.InstancedMesh(agentGeom, agentMat, MAX_AGENTS)
    this.agentMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.agentMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_AGENTS * 3), 3,
    )
    this.agentMesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    this.agentMesh.count = 0
    this.agentMesh.frustumCulled = false
    this.scene.add(this.agentMesh)
  }

  private buildTerrainFeatures(): void {
    const sim = this.model

    const toWorld = (lon: number, lat: number): [number, number] => {
      return [sim.lonToX(lon), sim.latToY(lat)]
    }

    const ringToPoints = (ring: number[][], z: number = 0.01): THREE.Vector3[] => {
      return ring.map(([lon, lat]) => {
        const [wx, wy] = toWorld(lon!, lat!)
        return new THREE.Vector3(wx, wy, z)
      })
    }

    const addLineLoop = (feat: any, opacity: number, z: number = 0.01) => {
      if (feat.geometry.type !== 'Polygon') return
      const points = ringToPoints(feat.geometry.coordinates[0], z)
      const geom = new THREE.BufferGeometry().setFromPoints(points)
      const mat = new THREE.LineBasicMaterial({
        color: LIGHTER,
        transparent: true,
        opacity,
      })
      this.terrainGroup.add(new THREE.LineLoop(geom, mat))
    }

    for (const feat of this.terrain.surfaces.features) {
      addLineLoop(feat, 0.7, 0.005)
    }
    for (const feat of this.terrain.stalls.features) {
      addLineLoop(feat, 0.7, 0.01)
    }
    for (const feat of this.terrain.structures.features) {
      addLineLoop(feat, 0.7, 0.01)
    }
    for (const feat of this.terrain.furniture.features) {
      addLineLoop(feat, 0.7, 0.01)
    }

    // Shade (trees) — neutral LIGHT tint so canopy reads as environmental
    // context, not a competing feature colour.
    for (const feat of this.terrain.shade.features) {
      if (!feat || feat.geometry.type !== 'Polygon') continue
      const ring = (feat.geometry as any).coordinates[0] as number[][]
      if (!ring || ring.length < 3) continue
      const shape = new THREE.Shape()
      const first = ring[0]!
      const [wx0, wy0] = toWorld(first[0]!, first[1]!)
      shape.moveTo(wx0, wy0)
      for (let i = 1; i < ring.length; i++) {
        const pt = ring[i]!
        const [wx, wy] = toWorld(pt[0]!, pt[1]!)
        shape.lineTo(wx, wy)
      }
      // Outline
      const outlinePoints = ring.map(([lo, la]) => {
        const [owx, owy] = toWorld(lo!, la!)
        return new THREE.Vector3(owx, owy, 0.01)
      })
      const outlineGeom = new THREE.BufferGeometry().setFromPoints(outlinePoints)
      const outlineMat = new THREE.LineBasicMaterial({
        color: LIGHT,
        transparent: true,
        opacity: 0.6,
      })
      this.terrainGroup.add(new THREE.LineLoop(outlineGeom, outlineMat))

      // Very light fill
      const geom = new THREE.ShapeGeometry(shape)
      const mat = new THREE.MeshBasicMaterial({
        color: LIGHT,
        transparent: true,
        opacity: 0.08,
      })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.position.z = 0.01
      this.terrainGroup.add(mesh)
    }

    this.scene.add(this.terrainGroup)
  }

  private buildNodeMarkers(): void {
    const sim = this.model
    const features = this.terrain.nodes.features

    for (let i = 0; i < features.length; i++) {
      const feat = features[i]!
      if (feat.geometry.type !== 'Point') continue
      const [lon, lat] = (feat.geometry as any).coordinates
      const wx = sim.lonToX(lon!)
      const wy = sim.latToY(lat!)

      const colorHex = this.nodeColorMap.get(feat.properties?.id as string) ?? LIGHT

      const geom = new THREE.CircleGeometry(1.5, 16)
      const mat = new THREE.MeshBasicMaterial({ color: colorHex })
      const marker = new THREE.Mesh(geom, mat)
      marker.position.set(wx, wy, 0.03)
      this.nodeGroup.add(marker)
    }

    this.scene.add(this.nodeGroup)
  }

  // --- Per-frame updates ---

  private updateMist(): void {
    const mw = this.mistW
    const mh = this.mistH
    const data = this.mistData

    // Decay existing mist
    for (let i = 3; i < data.length; i += 4) {
      data[i] = Math.floor(data[i]! * MIST_DECAY)
    }

    // Stamp current agent positions into mist
    const scaleX = mw / this.worldWidth
    const scaleY = mh / this.worldHeight
    const sim = this.model
    const alive = sim.pedAlive
    const pedX = sim.pedX
    const pedY = sim.pedY
    const n = sim.pedCount

    for (let i = 0; i < n; i++) {
      if (alive[i] === 0) continue
      const mx = Math.floor(pedX[i]! * scaleX)
      const my = Math.floor(pedY[i]! * scaleY)
      if (mx < 0 || mx >= mw || my < 0 || my >= mh) continue

      const idx = (my * mw + mx) * 4
      data[idx] = 0xff
      data[idx + 1] = 0xff
      data[idx + 2] = 0xff
      data[idx + 3] = Math.min(data[idx + 3]! + MIST_DEPOSIT, MIST_MAX_ALPHA)
    }

    this.mistTexture.needsUpdate = true
  }

  private static AGENT_COLORS = AGENT_RISK_COLORS.map((color) => new THREE.Color(color))

  private updateAgents(): void {
    const dummy = this.agentDummy
    const sim = this.model
    const alive = sim.pedAlive
    const pedX = sim.pedX
    const pedY = sim.pedY
    const n = sim.pedCount
    let idx = 0

    for (let i = 0; i < n; i++) {
      if (alive[i] === 0) continue
      if (idx >= MAX_AGENTS) break

      dummy.position.set(pedX[i]!, pedY[i]!, 0.1)
      dummy.updateMatrix()
      this.agentMesh.setMatrixAt(idx, dummy.matrix)

      const color = getAgentVisualRisk(sim, i)
      this.agentMesh.setColorAt(idx, ThreeView.AGENT_COLORS[color] ?? ThreeView.AGENT_COLORS[0]!)

      idx++
    }

    this.agentMesh.count = idx
    this.agentMesh.instanceMatrix.needsUpdate = true
    if (this.agentMesh.instanceColor) {
      this.agentMesh.instanceColor.needsUpdate = true
    }
  }

  // --- Public interface ---

  get agentCount(): number {
    return this.agentMesh.count
  }

  get cameraInfo(): { zoom: number; centerX: number; centerY: number } {
    return {
      zoom: this.camera.zoom,
      centerX: this.controls.target.x,
      centerY: this.controls.target.y,
    }
  }

  draw(): void {
    // Mist update is cheap (~300 agents into ~1k pixel texture) — run every 4 frames
    if (this.frameCount % 4 === 0) {
      this.updateMist()
    }
    this.frameCount++
    this.updateAgents()
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    this.controls.dispose()

    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
        obj.geometry.dispose()
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const m of mats) m.dispose()
      }
      if (obj instanceof THREE.Line) {
        obj.geometry.dispose()
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const m of mats) m.dispose()
      }
    })

    this.mistTexture.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private handleResize(container: HTMLElement): void {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return

    const { left, right, top, bottom } = this.computeFrustum(w, h)
    this.camera.left = left
    this.camera.right = right
    this.camera.top = top
    this.camera.bottom = bottom
    this.camera.updateProjectionMatrix()

    this.renderer.setSize(w, h)
  }
}
