import { createExpression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { createPinia } from 'pinia'
import type { CustomLayerInterface, LayerSpecification, MapOptions, StyleSpecification } from 'maplibre-gl'
import type { Points, Scene, ShaderMaterial } from 'three'
import { createApp } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { maps, models, scenarios, simulation, snapshots, render, readLayer, TestMap } = vi.hoisted(() => {
  const render = vi.fn()
  const readLayer = vi.fn()
  class TestMap {
    layers: (LayerSpecification | CustomLayerInterface)[]
    sources = new Map()
    styleListener?: () => void
    moveListener?: () => void
    triggerRepaint = vi.fn()
    state: Pick<MapOptions, 'center' | 'zoom' | 'bearing' | 'pitch'>

    constructor(public options: MapOptions & { style: StyleSpecification }) {
      this.state = options
      this.layers = [...options.style.layers]
      maps.push(this)
    }

    on(event: string, listener: () => void) {
      if (event === 'style.load') {
        this.styleListener = listener
        queueMicrotask(listener)
      } else if (event === 'move') {
        this.moveListener = listener
      }
    }

    jumpTo(state: typeof this.state) {
      this.state = state
      this.moveListener?.()
    }

    getCenter() {
      const [lng, lat] = this.state.center as [number, number]
      return { lng, lat }
    }
    getZoom() { return this.state.zoom }
    getBearing() { return this.state.bearing }
    getPitch() { return this.state.pitch }

    getLayer(id: string) {
      return this.layers.find((layer) => layer.id === id)
    }

    addSource(id: string, source: unknown) {
      this.sources.set(id, source)
    }

    addLayer(layer: LayerSpecification | CustomLayerInterface, before?: string) {
      const index = this.layers.findIndex(({ id }) => id === before)
      this.layers.splice(index < 0 ? this.layers.length : index, 0, layer)
    }

    setLayoutProperty() {}
    getSource(id: string) { return this.sources.get(id) }
    getCanvas() { return { width: 400, height: 200, clientWidth: 200, clientHeight: 100 } }
    project([x, y]: [number, number]) { return { x, y } }
    remove() {}
  }

  const maps: TestMap[] = []
  const snapshots = { callback: undefined as ((index: number) => void) | undefined }
  const models = {
    initModel: vi.fn(),
    selectedNodeId: null,
    getClient: () => ({
      onSnapshot: (callback: (index: number) => void) => { snapshots.callback = callback },
    }),
  }
  const scenarios = {
    hasScenarios: false,
    scenarioA: {},
    scenarioB: {},
    sharedNodes: [],
    nodesBuffered: null,
    loadScenarios: vi.fn(),
  }
  const simulation = { registerMasterControllers: vi.fn(), isRunning: false, destroy: vi.fn() }
  return { maps, models, scenarios, simulation, snapshots, render, readLayer, TestMap }
})

vi.mock('maplibre-gl', () => ({ default: { Map: TestMap } }))
vi.mock('three', async (importOriginal) => ({
  ...await importOriginal<typeof import('three')>(),
  WebGLRenderer: class {
    resetState() {}
    setViewport() {}
    dispose() {}
    render = render
  },
}))
vi.mock('../../stores/models', () => ({ useModelsStore: () => models }))
vi.mock('../../stores/scenarios', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../stores/scenarios')>(),
  useScenariosStore: () => scenarios,
  fetchOptionalMapLayer: async (candidates: [string, string][]) => {
    readLayer(candidates)
    const [folder, name] = candidates[0]!
    if (folder === 'scenarioA' && name === 'extra_buildings.geojson') {
      return { type: 'FeatureCollection', features: [{
        type: 'Feature', properties: { render_height: '9' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      }] }
    }
  },
}))
vi.mock('../../stores/simulation', () => ({ useSimulationStore: () => simulation }))
vi.mock('../CentralControl.vue', () => ({ __esModule: true, default: { render: () => null } }))
vi.mock('../MapLegend.vue', () => ({ default: { render: () => null } }))

import MapView from '../MapView.vue'

let app: ReturnType<typeof createApp>
let host: HTMLElement

beforeEach(() => {
  maps.length = 0
  snapshots.callback = undefined
  vi.clearAllMocks()
  host = document.createElement('div')
  app = createApp(MapView).use(createPinia())
})

afterEach(() => {
  app.unmount()
  vi.restoreAllMocks()
})

it('shares the specified camera and static Scenario A layers before the worker is ready', async () => {
  scenarios.loadScenarios.mockReturnValue(new Promise(() => {}))
  app.mount(host)

  await vi.waitFor(() => {
    expect(maps).toHaveLength(2)
    const ids = maps[0]!.layers.map(({ id }) => id)
    expect(ids.indexOf('satellite-imagery')).toBeLessThan(ids.indexOf('road-casing'))
    for (const map of maps) {
      expect(map.layers.map(({ id }) => id)).toEqual(expect.arrayContaining([
        'background', 'satellite-imagery', 'road-casing', 'road-fill', 'street-labels', 'basemap_vector_building',
        'buildings-extrusion', 'pedestrian-infrastructure-fill',
      ]))
      expect(map.layers.filter((layer) => 'source' in layer &&
        (layer.source === 'src-buildings' || ('source-layer' in layer && layer['source-layer'] === 'building')),
      ).map((layer) => layer.type)).toEqual(['fill-extrusion', 'fill-extrusion'])
      expect(map.layers.some(({ id }) => /^(metro|transit|transport.types)/.test(id))).toBe(false)
      expect(map.options).toMatchObject({
        center: [-99.1868, 19.4042], zoom: 16.35, bearing: 22, pitch: 47, maxPitch: 75,
        style: {
          sources: { 'basemap-satellite': { type: 'raster', tileSize: 512, maxzoom: 22 } },
          light: { anchor: 'viewport', color: '#ffffff', intensity: 0.75, position: [1.5, 90, 65] } },
      })
    }
  })
  expect(maps[0]?.layers).toEqual(maps[1]?.layers)
  expect(maps[0]?.getSource('src-buildings').data).toEqual(maps[1]?.getSource('src-buildings').data)
  expect(maps[0]?.getSource('src-buildings').data.features[0].properties.render_height).toBe(9)
  const reads = readLayer.mock.calls.flatMap(([candidates]) => candidates)
  expect(reads.every(([folder]) => folder === 'scenarioA')).toBe(true)
  expect(reads.map(([, file]) => file)).not.toContain('streets.geojson')
  expect(reads.map(([, file]) => file)).not.toContain('transport_types.geojson')
  expect(reads.some(([, file]) => ['metro_stations.geojson', 'bus_stops.geojson', 'buses.geojson'].includes(file))).toBe(false)
  expect(reads.map(([, file]) => file)).not.toContain('blocks.geojson')
  const map = maps[1]!
  expect(validateStyleMin({
    ...map.options.style,
    sources: { ...map.options.style.sources, ...Object.fromEntries(map.sources) },
    layers: map.layers,
  }).map(({ message }) => message)).toEqual([])

  const buildings = map.layers.find((layer) => layer.type === 'fill-extrusion')
  if (buildings?.type !== 'fill-extrusion') throw new Error('Missing basemap building extrusions')
  const height = createExpression(buildings.paint?.['fill-extrusion-height'])
  const base = createExpression(buildings.paint?.['fill-extrusion-base'])
  if (height.result !== 'success' || base.result !== 'success') throw new Error('Invalid extrusion paint')
  const evaluateHeight = (properties: Record<string, unknown>) =>
    height.value.evaluate({ zoom: 16.35 }, { type: 'Polygon', properties })
  expect(evaluateHeight({ height: 18 })).toBe(18)
  expect(evaluateHeight({ height: 0, render_height: '9' })).toBe(9)
  expect(evaluateHeight({ levels: 3 })).toBe(10.5)
  expect(evaluateHeight({ height: 0 })).toBe(12)
  expect(base.value.evaluate({ zoom: 16.35 }, {
    type: 'Polygon', properties: { height: 9, min_height: 12 },
  })).toBe(8)

  map.jumpTo({ center: [-99.185, 19.404], zoom: 17, pitch: 54, bearing: 95 })
  expect(maps[0]?.state).toEqual(map.state)
  map.layers = [...map.options.style.layers]
  map.sources.clear()
  map.styleListener?.()
  await vi.waitFor(() => expect(map.getLayer('buildings-extrusion')).toBeDefined())
  expect(map.state).toEqual({ center: [-99.185, 19.404], zoom: 17, pitch: 54, bearing: 95 })
  expect(models.initModel).not.toHaveBeenCalled()
})

it('projects the paused snapshot into the Three.js core and halo in screen pixels', async () => {
  const model = {
    pedX: new Float32Array([40]),
    pedY: new Float32Array([20]),
    pedCount: 1,
    pedVisualRisk: new Uint8Array([0]),
    xToLon: (x: number) => x,
    yToLat: (y: number) => y,
  }
  scenarios.loadScenarios.mockResolvedValue(undefined)
  models.initModel.mockResolvedValue([model, { ...model }])
  app.mount(host)
  await vi.waitFor(() => expect(simulation.registerMasterControllers).toHaveBeenCalled())

  const map = maps[0]!
  const layer = map.getLayer('agents') as CustomLayerInterface
  const gl = {} as WebGL2RenderingContext
  layer.onAdd?.(map as never, gl)
  layer.render(gl, {} as never)
  const scene = render.mock.lastCall?.[0] as Scene
  const [halo, core] = scene.children as Points<never, ShaderMaterial>[]
  expect(halo?.material.uniforms.diameter?.value).toBe(16.8)
  expect(halo?.material.uniforms.opacity?.value).toBe(0.28)
  expect(core?.material.uniforms.diameter?.value).toBe(10)
  expect(core?.material.uniforms.coreRatio?.value).toBeCloseTo(0.64)
  const geometry = (scene.children[1] as Points).geometry
  expect(geometry.drawRange.count).toBe(1)
  expect(geometry.getAttribute('position').getX(0)).toBeCloseTo(-0.6)
  expect(geometry.getAttribute('position').getY(0)).toBeCloseTo(0.6)
  expect(geometry.getAttribute('danger').getX(0)).toBe(0)

  model.pedVisualRisk[0] = 1
  snapshots.callback?.(0)
  expect(map.triggerRepaint).toHaveBeenCalled()
  layer.render(gl, {} as never)
  expect(geometry.getAttribute('danger').getX(0)).toBe(1)
  layer.onRemove?.(map as never, gl)
})

it('logs the initialization error message when the worker rejects', async () => {
  const error = new Error('Cannot initialize the simulation with an invalid grid.')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  scenarios.loadScenarios.mockResolvedValue(undefined)
  models.initModel.mockRejectedValue(error)
  app.mount(host)

  await vi.waitFor(() => {
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('The simulation could not start.')
    expect(log).toHaveBeenCalledWith('Tacubaya initialization failed:', error.message, error)
  })
})
