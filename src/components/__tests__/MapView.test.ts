import { createApp } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { maps, models, scenarios, simulation, snapshots, TestMap } = vi.hoisted(() => {
  class TestMap {
    layers: Array<{ id: string }> = []
    sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>()

    constructor(options: { style: { layers: Array<{ id: string }> } }) {
      this.layers = [...options.style.layers]
      maps.push(this)
    }

    once(_event: string, listener: () => void) {
      queueMicrotask(listener)
    }

    addSource(id: string) {
      this.sources.set(id, { setData: vi.fn() })
    }

    addLayer(layer: { id: string }) {
      this.layers.push(layer)
    }

    getSource(id: string) {
      return this.sources.get(id)
    }

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
  return { maps, models, scenarios, simulation, snapshots, TestMap }
})

vi.mock('maplibre-gl', () => ({ default: { Map: TestMap } }))
vi.mock('../../stores/map', () => ({ useMapStore: () => ({ baseConfig: {}, setMapReferences: vi.fn() }) }))
vi.mock('../../stores/models', () => ({ useModelsStore: () => models }))
vi.mock('../../stores/scenarios', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../stores/scenarios')>(),
  useScenariosStore: () => scenarios,
  fetchScenarioGeoJSON: async () => ({ type: 'FeatureCollection', features: [] }),
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
  app = createApp(MapView)
})

afterEach(() => {
  app.unmount()
  vi.restoreAllMocks()
})

it('loads both maps and their site layers before the simulation data or worker is ready', async () => {
  scenarios.loadScenarios.mockReturnValue(new Promise(() => {}))
  app.mount(host)

  await vi.waitFor(() => {
    expect(maps).toHaveLength(2)
    for (const map of maps) {
      expect(map.layers.map((layer) => layer.id)).toEqual(expect.arrayContaining([
        'streets', 'src-buildings-fill', 'src-walkway2-line', 'src-bus_stops-points',
        'src-destinations-points', 'study-boundary', 'agents',
      ]))
    }
  })
  expect(models.initModel).not.toHaveBeenCalled()
})

it('draws agent coordinates from the first paused worker snapshot', async () => {
  const model = {
    pedX: new Float32Array(0),
    pedY: new Float32Array(0),
    pedCount: 0,
    pedEngagementMode: [0],
    pedStartNodeIdx: [0],
    pedIntimateViolations: [0],
    pedPersonalViolations: [0],
    xToLon: (x: number) => -99.187 + x / 1000,
    yToLat: (y: number) => 19.402 + y / 1000,
    nodeIdxFor: () => -1,
  }
  scenarios.loadScenarios.mockResolvedValue(undefined)
  models.initModel.mockResolvedValue([model, { ...model }])
  app.mount(host)
  await vi.waitFor(() => expect(simulation.registerMasterControllers).toHaveBeenCalled())

  model.pedX = new Float32Array([1])
  model.pedY = new Float32Array([2])
  model.pedCount = 1
  snapshots.callback?.(0)
  expect(maps[0]?.getSource('src-agent-heatmap')?.setData).toHaveBeenLastCalledWith({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [model.xToLon(1), model.yToLat(2)] },
      properties: { color: '#f6f6f6', radius: 2.5 },
    }],
  })
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
