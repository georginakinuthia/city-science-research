import type { Feature, FeatureCollection, Geometry, Point } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'

import { ACCENT, DARKEST, EMBER, LIGHT } from '../assets/palette'
import { toMarkerPoints } from '../stores/geo'
import { fetchScenarioGeoJSON } from '../stores/scenarios'
import { ENGAGEMENT_SHOPPING, ENGAGEMENT_WAITING } from './Simulation'
import type { SimView } from './SimView'

type ScenarioFolder = 'scenarioA' | 'scenarioB'

const MAP_BACKGROUND = '#15161a'
const AGENT_SOURCE = 'src-agent-heatmap'
const EMPTY_POINTS = { type: 'FeatureCollection', features: [] } as const

export const TACUBAYA_MAP_STYLE = {
  buildings: { fill: '#24262b', fillOpacity: 0.75, color: '#3a3d45', width: 0.6 },
  walkways: { color: '#4a5568', width: 1.25, opacity: 0.75 },
  busStops: { color: '#d4a359', radius: 3.5 },
  destinations: { color: '#5fa8a0', radius: 3 },
  boundary: { color: '#6b7280', width: 1, opacity: 0.65, dash: [4, 4] },
}

function assetPath(name: string, folder: ScenarioFolder = 'scenarioA'): string {
  return `${folder}/${name}.geojson`
}

function assetUrl(name: string, folder?: ScenarioFolder): string {
  const root = new URL(import.meta.env.BASE_URL, window.location.origin)
  return new URL(assetPath(name, folder), root).href
}

function addScenarioSource(
  map: MapLibreMap,
  name: string,
  folder: ScenarioFolder,
  transform?: (data: FeatureCollection<Geometry>) => FeatureCollection<Geometry>,
): void {
  const source = `src-${name}`
  map.addSource(source, { type: 'geojson', data: { ...EMPTY_POINTS, features: [] } })
  void fetchScenarioGeoJSON(folder, `${name}.geojson`)
    .then((data) => map.getSource<GeoJSONSource>(source)?.setData(transform ? transform(data) : data))
    .catch((error) => console.warn(`Could not load ${name} map data`, error))
}

export function createTacubayaBasemap(folder: ScenarioFolder): StyleSpecification {
  return {
    version: 8,
    sources: { streets: { type: 'geojson', data: assetUrl('streets', folder) } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': MAP_BACKGROUND } },
      {
        id: 'streets',
        type: 'line',
        source: 'streets',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#383b43', 'line-width': 1.5 },
      },
    ],
  }
}

export function addTacubayaMapLayers(map: MapLibreMap, folder: ScenarioFolder): void {
  const { buildings, walkways, busStops, destinations, boundary } = TACUBAYA_MAP_STYLE
  map.addSource('src-surfaces', { type: 'geojson', data: assetUrl('surfaces', folder) })
  map.addLayer({
    id: 'surfaces-fill',
    type: 'fill',
    source: 'src-surfaces',
    paint: { 'fill-color': walkways.color, 'fill-opacity': 0.08 },
  })

  for (const [name, data] of [
    ['structures', assetUrl('structures', folder)],
    ['buildings', assetUrl('buildings')],
    ['extra_buildings', assetUrl('extra_buildings')],
  ] as const) {
    const source = `src-${name}`
    map.addSource(source, { type: 'geojson', data })
    map.addLayer({
      id: `${source}-fill`,
      type: 'fill',
      source,
      paint: { 'fill-color': buildings.fill, 'fill-opacity': buildings.fillOpacity },
    })
    map.addLayer({
      id: `${source}-outline`,
      type: 'line',
      source,
      paint: { 'line-color': buildings.color, 'line-width': buildings.width },
    })
  }

  addScenarioSource(map, 'study_boundary', folder)
  map.addLayer({
    id: 'study-boundary',
    type: 'line',
    source: 'src-study_boundary',
    paint: {
      'line-color': boundary.color,
      'line-width': boundary.width,
      'line-opacity': boundary.opacity,
      'line-dasharray': boundary.dash,
    },
  })

  for (const [name, color, width] of [
    ['stalls', EMBER, 1.5], ['furniture', ACCENT, 2], ['shade', LIGHT, 1.5],
  ] as const) {
    const source = `src-${name}`
    map.addSource(source, { type: 'geojson', data: assetUrl(name, folder) })
    map.addLayer({
      id: name,
      type: 'line',
      source,
      paint: { 'line-color': color, 'line-opacity': 0.5, 'line-width': width },
    })
  }

  const walkwaySource = 'src-walkway2'
  addScenarioSource(map, 'walkway2', folder)
  map.addLayer({
    id: 'src-walkway2-line',
    type: 'line',
    source: walkwaySource,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': walkways.color,
      'line-width': walkways.width,
      'line-opacity': walkways.opacity,
    },
  })

  for (const [name, style] of [
    ['destinations', destinations],
    ['bus_stops', busStops],
  ] as const) {
    const source = `src-${name}`
    addScenarioSource(map, name, folder, toMarkerPoints)
    map.addLayer({
      id: `${source}-points`,
      type: 'circle',
      source,
      paint: {
        'circle-color': MAP_BACKGROUND,
        'circle-radius': style.radius,
        'circle-stroke-color': style.color,
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.8,
      },
    })
  }

  map.addSource('src-nodes-buffer', { type: 'geojson', data: { ...EMPTY_POINTS, features: [] } })
  map.addLayer({
    id: 'nodes',
    type: 'line',
    source: 'src-nodes-buffer',
    paint: { 'line-color': LIGHT, 'line-opacity': 0.45, 'line-width': 1 },
  })
  map.addLayer({
    id: 'nodes-labels',
    type: 'symbol',
    source: 'src-nodes-buffer',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['sans-serif'],
      'text-size': 12,
      'text-offset': [0, 1],
      'text-anchor': 'top',
    },
    paint: { 'text-color': LIGHT, 'text-halo-color': DARKEST, 'text-halo-width': 1 },
  })

  map.addSource(AGENT_SOURCE, { type: 'geojson', data: { ...EMPTY_POINTS, features: [] } })
  map.addLayer({
    id: 'agent-heatmap',
    type: 'heatmap',
    source: AGENT_SOURCE,
    paint: {
      'heatmap-weight': 0.3,
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 16, 8, 18, 20, 20, 50],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 16, 1.2, 18, 1.5, 20, 2],
      'heatmap-opacity': 0.35,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, `${ACCENT}00`, 0.4, `${ACCENT}80`, 0.8, `${EMBER}b3`, 1, `${EMBER}e6`,
      ],
    },
  })
  map.addLayer({
    id: 'agents',
    type: 'circle',
    source: AGENT_SOURCE,
    paint: {
      'circle-color': ['get', 'color'],
      'circle-radius': ['get', 'radius'],
      'circle-stroke-color': MAP_BACKGROUND,
      'circle-stroke-width': 0.5,
    },
  })
}

interface AgentProperties {
  color: string
  radius: number
}

interface MapRendererOptions {
  selectedStartNodeIdx: () => number
  colors: { agent: string; shopping: string; waiting: string; highlight: string }
}

export function createMapRenderer(map: MapLibreMap, sim: SimView, options: MapRendererOptions) {
  let previousPositions: Float32Array | undefined
  let previousSelection: number | undefined

  return {
    draw(): void {
      const source = map.getSource<GeoJSONSource>(AGENT_SOURCE)
      if (!source) return

      const x = sim.pedX
      const selected = options.selectedStartNodeIdx()
      if (x === previousPositions && selected === previousSelection) return
      previousPositions = x
      previousSelection = selected

      const y = sim.pedY
      const mode = sim.pedEngagementMode
      const starts = sim.pedStartNodeIdx
      const intimate = sim.pedIntimateViolations
      const personal = sim.pedPersonalViolations
      const { colors } = options
      const features: Feature<Point, AgentProperties>[] = []
      for (let i = 0; i < sim.pedCount; i++) {
        const longitude = sim.xToLon(x[i]!)
        const latitude = sim.yToLat(y[i]!)
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue
        const color = selected >= 0 && starts[i] === selected ? colors.highlight
          : mode[i] === ENGAGEMENT_SHOPPING ? colors.shopping
          : mode[i] === ENGAGEMENT_WAITING ? colors.waiting : colors.agent
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [longitude, latitude] },
          properties: { color, radius: intimate[i] ? 2 : personal[i] ? 2.2 : 2.5 },
        })
      }
      source.setData({ type: 'FeatureCollection', features })
    },
  }
}
