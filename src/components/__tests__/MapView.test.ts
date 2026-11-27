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

    addSource(id: string, source: { data: unknown }) {
      const entry = { ...source }
      Object.defineProperty(entry, 'setData', { value: (data: unknown) => { entry.data = data } })
      this.sources.set(id, entry)
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
  fetchScenarioBStalls: async () => ({
    type: 'FeatureCollection', features: [{
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[[-99.188, 19.402], [-99.1879, 19.402],
        [-99.1879, 19.4021], [-99.188, 19.402]]] },
    }],
  }),
  fetchOptionalMapLayer: async (candidates: [string, string][]) => {
    readLayer(candidates)
    const [folder, name] = candidates[0]!
    if (folder === 'scenarioA' && ['trees.geojson', 'bus_stops.geojson'].includes(name)) {
      return { type: 'FeatureCollection', features: [{
        type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: [-99.188, 19.402] },
      }] }
    }
    const scenarioBuildings = name === 'extra_building1.geojson'
    const scenarioBGround = folder === 'scenarioB' && ['surfaces.geojson', 'shade.geojson', 'furniture.geojson'].includes(name)
    if (scenarioBuildings || scenarioBGround) {
      return { type: 'FeatureCollection', features: [{
        type: 'Feature', properties: { height: folder === 'scenarioB' ? 19 : null },
        geometry: { type: 'Polygon', coordinates: [[[0, 0, 5], [1, 0, 5], [1, 1, 5], [0, 0, 5]]] },
      }, ...(scenarioBuildings ? [
        { type: 'Feature', properties: { height: '40' },
          geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0], [1, 1], [0, 0]] } },
        { type: 'Feature', properties: { level: '3' },
          geometry: { type: 'MultiLineString', coordinates: [
            [[0, 0], [1, 0], [1, 1], [0, 0]], [[2, 0], [3, 0], [3, 1], [2, 0]],
          ] } },
        ...[4773, 6548].map((id) => ({
          type: 'Feature', id, properties: {},
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
        })),
      ] : [])] }
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
  Object.assign(scenarios.scenarioA, { routing: undefined })
  Object.assign(scenarios.scenarioB, { routing: undefined })
  vi.clearAllMocks()
  host = document.createElement('div')
  app = createApp(MapView).use(createPinia())
})

afterEach(() => {
  app.unmount()
  vi.restoreAllMocks()
})

it('shares the restored camera, dark vector ground, and slate extrusions before the worker is ready', async () => {
  scenarios.loadScenarios.mockReturnValue(new Promise(() => {}))
  app.mount(host)

  await vi.waitFor(() => {
    expect(maps).toHaveLength(2)
    for (const map of maps) {
      expect(map.layers.map(({ id }) => id)).toEqual(expect.arrayContaining([
        'background', 'road-casing', 'road-fill', 'street-labels',
        'buildings-extrusion', 'pedestrian-infrastructure-fill',
      ]))
      expect(map.layers.some((layer) => layer.type === 'raster')).toBe(false)
      expect(map.getLayer('background')).toMatchObject({ paint: { 'background-color': '#0b0d12' } })
      expect(map.layers.filter((layer) => layer.type === 'fill-extrusion' && layer.source === 'src-buildings').map(({ id }) => id))
        .toEqual(['buildings-extrusion'])
      expect(map.layers.filter((layer) => 'source' in layer && layer.source === 'src-buildings')
        .map(({ type }) => type)).toEqual(['fill-extrusion'])
      expect(map.getLayer('crossings')).toBeUndefined()
      expect(map.getLayer('basemap-building-outline')).toBeUndefined()
      expect(map.layers.some(({ id }) => /^transport.types/.test(id))).toBe(false)
      expect(map.getLayer('buildings-extrusion')).toMatchObject({
        paint: {
          'fill-extrusion-color': '#191b1e',
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.94,
          'fill-extrusion-vertical-gradient': true,
        },
      })
      expect(map.getLayer('market-roof')).toBeUndefined()
      expect(map.getLayer('buildings-roof-edges')).toMatchObject({ type: 'custom', renderingMode: '3d' })
      expect(map.options).toMatchObject({
        center: [-99.1868, 19.4042], zoom: 16.35, bearing: 22, pitch: 47, maxPitch: 75,
        style: {
          light: { anchor: 'viewport', color: '#ffffff', intensity: 0.62, position: [1.35, 215, 38] } },
      })
    }
  })
  const [existing, proposed] = maps
  for (const id of ['surfaces-fill', 'surfaces-outline', 'shade-outline', 'furniture-outline', 'stalls-extrusion']) {
    expect(existing?.getLayer(id)).toBeUndefined()
    expect(proposed?.getLayer(id)).toBeDefined()
  }
  expect(proposed?.getLayer('stalls-extrusion')).toMatchObject({
    paint: { 'fill-extrusion-height': 3.1, 'fill-extrusion-color': '#191b1e', 'fill-extrusion-vertical-gradient': true },
  })
  expect(proposed?.getSource('src-stalls').data.features[0].geometry.type).toBe('Polygon')
  expect(existing?.getLayer('src-trees-points')).toEqual(proposed?.getLayer('src-trees-points'))
  expect(proposed?.getLayer('src-trees-points')).toMatchObject({
    paint: { 'circle-radius': 2.6, 'circle-opacity': 0.22, 'circle-stroke-width': 0.6, 'circle-stroke-opacity': 0.35 },
  })
  expect(proposed?.getLayer('bus-markers')).toMatchObject({
    type: 'fill', paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.6 },
  })
  const marker = proposed?.getSource('src-bus-markers').data.features[0].geometry
  expect(marker.type).toBe('Polygon')
  expect(marker.coordinates[0]).toHaveLength(5)
  expect(marker.coordinates[0][0]).toEqual(marker.coordinates[0][4])
  const [[west, south], [east], [, north]] = marker.coordinates[0]
  expect((east - west) * 111_320 * Math.cos(19.402 * Math.PI / 180)).toBeCloseTo(2.2, 3)
  expect((north - south) * 111_320).toBeCloseTo(2.2, 3)
  expect(maps[1]?.getSource('src-buildings').data.features[0].properties.renderHeight).toBe(19)
  const footprints = maps[0]?.getSource('src-buildings').data.features
  expect(footprints.map(({ geometry }: { geometry: { type: string } }) => geometry.type))
    .toEqual(['Polygon', 'Polygon', 'MultiPolygon', 'Polygon'])
  expect(footprints[0].geometry.coordinates[0][0]).toEqual([0, 0])
  expect(footprints.map(({ properties }: { properties: unknown }) => properties)).toMatchObject([
    { renderHeight: 14, minHeight: 0 }, { renderHeight: 26, minHeight: 0 }, { renderHeight: 10.5, minHeight: 0 },
    { marketHall: true, renderHeight: 6, minHeight: 0 },
  ])
  const reads = readLayer.mock.calls.flatMap(([candidates]) => candidates)
  expect(new Set(reads.map(([folder]) => folder))).toEqual(new Set(['scenarioA', 'scenarioB']))
  expect(reads.filter(([, file]) => file === 'extra_building1.geojson').map(([folder]) => folder))
    .toEqual(['scenarioA', 'scenarioB'])
  expect(reads.map(([, file]) => file)).not.toContain('streets.geojson')
  for (const hiddenFile of ['transport_types.geojson', 'extra_buildings.geojson', 'extra_building.geojson', 'main_buildings.geojson', 'structures.geojson',
    'publicspace.geojson', 'zebra_crossings.geojson']) {
    expect(reads.map(([, file]) => file)).not.toContain(hiddenFile)
  }
  expect(reads.some(([, file]) => ['metro_stations.geojson', 'bus_stops.geojson', 'buses.geojson'].includes(file))).toBe(true)
  expect(reads.map(([, file]) => file)).not.toContain('blocks.geojson')
  const map = maps[1]!
  expect(validateStyleMin({
    ...map.options.style,
    sources: { ...map.options.style.sources, ...Object.fromEntries(map.sources) },
    layers: map.layers.filter((layer) => layer.type !== 'custom'),
  }).map(({ message }) => message)).toEqual([])

  const buildings = map.layers.find((layer) => layer.type === 'fill-extrusion')
  if (buildings?.type !== 'fill-extrusion') throw new Error('Missing extra building extrusions')
  const height = createExpression(buildings.paint?.['fill-extrusion-height'])
  const base = createExpression(buildings.paint?.['fill-extrusion-base'])
  if (height.result !== 'success' || base.result !== 'success') throw new Error('Invalid extrusion paint')
  const evaluateHeight = (properties: Record<string, unknown>) =>
    height.value.evaluate({ zoom: 16.35 }, { type: 'Polygon', properties })
  expect(evaluateHeight({ renderHeight: 14 })).toBe(14)
  expect(base.value.evaluate({ zoom: 16.35 }, {
    type: 'Polygon', properties: { height: 9, min_height: 12 },
  })).toBe(0)

  map.jumpTo({ center: [-99.185, 19.404], zoom: 17, pitch: 54, bearing: 95 })
  expect(maps[0]?.state).toEqual(map.state)
  map.layers = [...map.options.style.layers]
  map.sources.clear()
  map.styleListener?.()
  await vi.waitFor(() => expect(map.getLayer('buildings-extrusion')).toBeDefined())
  expect(map.state).toEqual({ center: [-99.185, 19.404], zoom: 17, pitch: 54, bearing: 95 })
  expect(models.initModel).not.toHaveBeenCalled()
})

it('assigns per-scenario crime weights and draws mapped intervention fills only in B', async () => {
  const crime = (weight: number) => ({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', geometry: { type: 'Point', coordinates: [-99.19, 19.4] },
      properties: { crimeWeight: weight },
    }],
  })
  Object.assign(scenarios.scenarioA, { routing: { pedestrian: { crime: crime(1) } } })
  const interventionZones = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', properties: { category: 'shared_access_spine' },
      geometry: { type: 'Polygon', coordinates: [[[-99.19, 19.4], [-99.189, 19.4], [-99.189, 19.401], [-99.19, 19.4]]] },
    }],
  }
  Object.assign(scenarios.scenarioB, { routing: { pedestrian: { crime: crime(0.2) }, interventionZones } })
  scenarios.loadScenarios.mockResolvedValue(undefined)
  models.initModel.mockReturnValue(new Promise(() => {}))
  app.mount(host)

  await vi.waitFor(() => {
    expect(maps[0]?.getSource('src-crime')?.data).toEqual(crime(1))
    expect(maps[1]?.getSource('src-crime')?.data).toEqual(crime(0.2))
    expect(maps[0]?.getLayer('intervention-areas')).toBeUndefined()
    expect(maps[1]?.getSource('src-interventions')?.data).toEqual(interventionZones)
    expect(maps[1]?.getLayer('intervention-areas')).toMatchObject({
      type: 'fill', paint: { 'fill-opacity': 0.08, 'fill-antialias': false },
    })
    const ids = maps[1]!.layers.map(({ id }) => id)
    expect(ids.indexOf('background')).toBeLessThan(ids.indexOf('intervention-areas'))
    expect(ids.indexOf('intervention-areas')).toBeLessThan(ids.indexOf('road-casing'))
  })
})

it('projects the paused snapshot into a Three.js pinpoint and glow pass', async () => {
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
  const projection = { defaultProjectionData: { mainMatrix: new Float64Array(16) } }
  layer.render(gl, projection as never)
  const scene = render.mock.lastCall?.[0] as Scene
  expect(scene.children).toHaveLength(2)
  const [halo, core] = scene.children as Points<Points['geometry'], ShaderMaterial>[]
  expect(halo?.material.uniforms.diameter?.value).toBe(14)
  expect(halo?.material.uniforms.opacity?.value).toBe(0.25)
  expect(core?.material.uniforms.diameter?.value).toBe(6)
  const geometry = core!.geometry
  expect(geometry.drawRange.count).toBe(1)
  expect(geometry.getAttribute('position').getX(0)).toBeCloseTo(-0.6)
  expect(geometry.getAttribute('position').getY(0)).toBeCloseTo(0.6)
  expect(geometry.getAttribute('danger').getX(0)).toBe(0)

  const position = geometry.getAttribute('position')
  const firstVersion = position.version
  layer.render(gl, projection as never)
  expect(position.version).toBe(firstVersion)
  projection.defaultProjectionData.mainMatrix[0] = 1
  layer.render(gl, projection as never)
  expect(position.version).toBe(firstVersion + 1)

  model.pedVisualRisk[0] = 1
  model.pedX = new Float32Array([40])
  snapshots.callback?.(0)
  expect(map.triggerRepaint).toHaveBeenCalled()
  layer.render(gl, projection as never)
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
