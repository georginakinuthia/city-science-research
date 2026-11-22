import { bbox, booleanPointInPolygon, buffer } from '@turf/turf'
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from 'geojson'
import { defineStore } from 'pinia'
import { computed, markRaw, ref } from 'vue'

import { TACUBAYA_CROWD } from '../config'
import { ScenarioContainer } from '../sim/scenarioGen'
import type { CrowdAnchors, NodeState, ScenarioData } from './geo'
import {
  buildNodesFromCollection,
  computeNodeDistanceField,
  computeShortestPath,
  featureMask,
  type GridLike,
  toMarkerPoints,
} from './geo'

// Re-export so existing imports from './scenarios' still work
export { buildNodesFromCollection, computeNodeDistanceField, computeShortestPath, featureMask }
export { ScenarioContainer }
export type { CrowdAnchors, GridLike, NodeState, ScenarioData }

type LonLat = [number, number]
type StudyBoundary = FeatureCollection<Polygon | MultiPolygon>
const TACUBAYA_BOUNDS = [-99.198, 19.392, -99.176, 19.414] as const

function studyArea(boundary: FeatureCollection<Geometry>, surfaces: FeatureCollection<Geometry>) {
  const polygons = boundary.features.filter(
    (feature): feature is Feature<Polygon | MultiPolygon> =>
      feature?.geometry?.type === 'Polygon' || feature?.geometry?.type === 'MultiPolygon',
  )
  const studyBoundary: StudyBoundary | undefined = polygons.length
    ? { type: 'FeatureCollection', features: polygons }
    : undefined
  const [west, south, east, north] = bbox(studyBoundary ?? surfaces, { recompute: true })
  const margin = TACUBAYA_CROWD.entrySnapMeters / 100_000
  const bounds = studyBoundary
    ? ([west, south, east, north] as const)
    : ([
        Math.max(TACUBAYA_BOUNDS[0], Number.isFinite(west) ? west - margin : -Infinity),
        Math.max(TACUBAYA_BOUNDS[1], Number.isFinite(south) ? south - margin : -Infinity),
        Math.min(TACUBAYA_BOUNDS[2], Number.isFinite(east) ? east + margin : Infinity),
        Math.min(TACUBAYA_BOUNDS[3], Number.isFinite(north) ? north + margin : Infinity),
      ] as const)

  const contains = ([lon, lat]: Position) =>
    lon! >= bounds[0] &&
    lon! <= bounds[2] &&
    lat! >= bounds[1] &&
    lat! <= bounds[3] &&
    (!studyBoundary || polygons.some((polygon) => booleanPointInPolygon([lon!, lat!], polygon)))

  return { studyBoundary, bounds, contains }
}

function pointsInArea(
  data: FeatureCollection<Geometry>,
  area: ReturnType<typeof studyArea>,
): Feature<Point>[] {
  return toMarkerPoints(data).features.filter(({ geometry }) => area.contains(geometry.coordinates))
}

function walkwayAnchors(
  data: FeatureCollection<Geometry>,
  area: ReturnType<typeof studyArea>,
): Feature<Point>[] {
  const points = pointsInArea(data, area)
  const [west, south, east, north] = area.bounds
  const spacing = 0.000012
  for (const feature of data.features) {
    const geometry = feature?.geometry
    if (geometry?.type !== 'LineString' && geometry?.type !== 'MultiLineString') continue
    const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const [x1, y1] = line[i - 1]!
        const [x2, y2] = line[i]!
        if (![x1, y1, x2, y2].every(Number.isFinite)) continue
        if (
          Math.max(x1!, x2!) < west ||
          Math.min(x1!, x2!) > east ||
          Math.max(y1!, y2!) < south ||
          Math.min(y1!, y2!) > north
        )
          continue
        const steps = Math.max(1, Math.ceil(Math.hypot(x2! - x1!, y2! - y1!) / spacing))
        for (let step = 0; step <= steps; step++) {
          const lon = x1! + ((x2! - x1!) * step) / steps
          const lat = y1! + ((y2! - y1!) * step) / steps
          if (!area.contains([lon, lat])) continue
          points.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: null,
          })
        }
      }
    }
  }
  return points
}

function uniquePoints(points: Feature<Point>[], resolution: number): Feature<Point>[] {
  const occupied = new Set<string>()
  return points.filter(({ geometry }) => {
    const [lon, lat] = geometry.coordinates
    const key = `${Math.round(lon! / resolution)},${Math.round(lat! / resolution)}`
    if (occupied.has(key)) return false
    occupied.add(key)
    return true
  })
}

function peripheralPoints(walkways: Feature<Point>[]): Feature<Point>[] {
  const edges: Feature<Point>[] = []
  for (const [axis, direction] of [
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 1],
  ] as const) {
    const edge = walkways.reduce<Feature<Point> | undefined>((outermost, point) => {
      if (!outermost) return point
      const delta = point.geometry.coordinates[axis]! - outermost.geometry.coordinates[axis]!
      return delta * direction > 0 ? point : outermost
    }, undefined)
    if (edge) edges.push(edge)
  }
  return uniquePoints(edges, 0.00006)
}

function coordinates(points: Feature<Point>[]): LonLat[] {
  return points.map(({ geometry }) => [geometry.coordinates[0]!, geometry.coordinates[1]!])
}

class MissingGeoJSONError extends Error {}

export async function fetchGeoJSON(filename: string): Promise<FeatureCollection<Geometry>> {
  const root = new URL(import.meta.env.BASE_URL, window.location.origin)
  const url = new URL(filename.replace(/^\//, ''), root)
  const response = await fetch(url, {
    headers: { Accept: 'application/geo+json, application/json' },
  })

  if (response.status === 404 || response.headers.get('content-type')?.includes('text/html')) {
    throw new MissingGeoJSONError(`GeoJSON file not found: ${filename}`)
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${filename}: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as FeatureCollection<Geometry>

  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error(`Invalid GeoJSON format in ${filename}`)
  }

  return data
}

async function fetchScenarioLayer(
  scenarioPath: string,
  filename: string,
  load: typeof fetchGeoJSON,
  legacyFilename?: string,
): Promise<FeatureCollection<Geometry>> {
  const loadFolder = async (folder: string) => {
    try {
      return await load(`/${folder}/${filename}`)
    } catch (error) {
      if (!(error instanceof MissingGeoJSONError) || !legacyFilename) throw error
      return load(`/${folder}/${legacyFilename}`)
    }
  }
  try {
    return await loadFolder(scenarioPath)
  } catch (error) {
    if (!(error instanceof MissingGeoJSONError) || scenarioPath !== 'scenarioB') throw error
    return loadFolder('scenarioA')
  }
}

export function fetchScenarioGeoJSON(scenarioPath: string, filename: string) {
  return fetchScenarioLayer(scenarioPath, filename, fetchGeoJSON)
}

async function optionalGeoJSON(
  filename: string,
  request: Promise<FeatureCollection<Geometry>>,
): Promise<FeatureCollection<Geometry>> {
  try {
    return await request
  } catch (error) {
    console.warn(`Could not load ${filename}`, error)
    return { type: 'FeatureCollection', features: [] }
  }
}

function bufferPointsByDia(fc: FeatureCollection<Geometry> | null): FeatureCollection<Geometry> {
  if (!fc || !Array.isArray(fc.features)) {
    return { type: 'FeatureCollection', features: [] }
  }

  const features = fc.features.map((f: any) => {
    const props = f.properties || {}
    const dia = Number(props.dia) || 5
    const radius = dia > 0 ? dia / 2 : 0

    if (radius > 0 && f.geometry && f.geometry.type === 'Point') {
      try {
        const buf = buffer(f as any, radius, { units: 'meters' })
        if (buf && buf.properties) {
          buf.properties = { ...props, dia }
        }
        return buf || { ...f, properties: { ...props, dia } }
      } catch {
        return { ...f, properties: { ...props, dia } }
      }
    }

    return { ...f, properties: { ...props, dia } }
  })

  return { type: 'FeatureCollection', features }
}

export async function loadScenario(
  scenarioPath: string,
  load = fetchGeoJSON,
): Promise<ScenarioData> {
  const layer = (filename: string, legacyFilename?: string) =>
    fetchScenarioLayer(scenarioPath, filename, load, legacyFilename)
  const [furniture, stalls, structures, surfaces, shade] = await Promise.all([
    layer('furniture.geojson'),
    layer('stalls.geojson'),
    layer('structures.geojson'),
    layer('surfaces.geojson'),
    layer('shade.geojson', 'trees.geojson'),
  ])

  return {
    furniture,
    stalls,
    structures,
    surfaces,
    shade,
  }
}

async function loadScenarioInputs(scenarioPath: string, load: typeof fetchGeoJSON) {
  const layer = (filename: string) => fetchScenarioLayer(scenarioPath, filename, load)
  const optionalLayer = (filename: string) =>
    optionalGeoJSON(`/${scenarioPath}/${filename}`, layer(filename))
  const [data, transport, walkways, metro, buses, destinations, boundary] = await Promise.all([
    loadScenario(scenarioPath, load),
    optionalLayer('transport_types.geojson'),
    optionalLayer('walkway2.geojson'),
    optionalGeoJSON(
      `/${scenarioPath}/metro_stations.geojson`,
      layer('metro_stations.geojson').catch((error) => {
        if (!(error instanceof MissingGeoJSONError)) throw error
        return load('/nodes.geojson')
      }),
    ),
    optionalLayer('bus_stops.geojson'),
    optionalLayer('destinations.geojson'),
    optionalLayer('study_boundary.geojson'),
  ])

  const area = studyArea(boundary, data.surfaces)
  const walkwayPoints = uniquePoints(walkwayAnchors(walkways, area), 0.000008)
  const busPoints = uniquePoints(pointsInArea(buses, area), 0.000015)
  const crowd: CrowdAnchors = {
    walkways: coordinates(walkwayPoints),
    destinations: coordinates(uniquePoints(pointsInArea(destinations, area), 0.00015)),
    busStops: coordinates(busPoints),
  }
  const routing = { transport, walkways, studyBoundary: area.studyBoundary, crowd }
  return {
    scenario: markRaw(new ScenarioContainer({ ...data, routing }, scenarioPath)),
    walkwayPoints,
    busPoints,
    metroPoints: pointsInArea(metro, area),
  }
}

export const useScenariosStore = defineStore('scenarios', () => {
  const scenarioA = ref<ScenarioContainer | null>(null)
  const scenarioB = ref<ScenarioContainer | null>(null)
  const sharedNodes = ref<NodeState[]>([])
  const nodesBuffered = ref<FeatureCollection<Geometry> | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  let pendingLoad: Promise<void> | undefined

  const hasScenarios = computed(() => scenarioA.value !== null && scenarioB.value !== null)
  const isReady = computed(() => hasScenarios.value && !isLoading.value)

  function loadScenarios(): Promise<void> {
    if (pendingLoad) return pendingLoad
    const requests = new Map<string, ReturnType<typeof fetchGeoJSON>>()
    const load = (filename: string) => {
      let request = requests.get(filename)
      if (!request) {
        request = fetchGeoJSON(filename)
        requests.set(filename, request)
      }
      return request
    }
    pendingLoad = Promise.all([
      loadScenarioInputs('scenarioA', load),
      loadScenarioInputs('scenarioB', load),
    ])
      .then(([a, b]) => {
        const groups = [
          {
            id: 'metro',
            label: 'Metro exit',
            share: 0.55,
            points: uniquePoints([...a.metroPoints, ...b.metroPoints], 0.000015),
          },
          {
            id: 'bus',
            label: 'Bus stop',
            share: 0.3,
            points: uniquePoints([...a.busPoints, ...b.busPoints], 0.000015),
          },
          {
            id: 'peripheral',
            label: 'Peripheral entry',
            share: 0.15,
            points: peripheralPoints([...a.walkwayPoints, ...b.walkwayPoints]),
          },
        ].filter(({ points }) => points.length > 0)
        const totalShare = groups.reduce((total, group) => total + group.share, 0)
        const entries: Feature<Point>[] = groups.flatMap(({ id, label, share, points }) =>
          points.map((feature, index) => ({
            ...feature,
            id: `${id}-${index + 1}`,
            properties: {
              ...feature.properties,
              name: feature.properties?.name || `${label} ${index + 1}`,
              pph: (TACUBAYA_CROWD.peakPph * share) / (totalShare * points.length),
              interval: feature.properties?.interval ?? 0,
            },
          })),
        )
        const nodes = buildNodesFromCollection({ type: 'FeatureCollection', features: entries })
        const buffered = bufferPointsByDia({
          type: 'FeatureCollection',
          // Bus stops already have a dedicated map layer.
          features: entries.filter((entry) => !String(entry.id).startsWith('bus-')),
        })

        sharedNodes.value = nodes
        nodesBuffered.value = buffered
        scenarioA.value = a.scenario
        scenarioB.value = b.scenario
      })
      .catch((err) => {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred'
        error.value = `Failed to load scenarios: ${errorMessage}`
        console.error('Error loading scenarios:', err)
      })
      .finally(() => {
        pendingLoad = undefined
        isLoading.value = false
      })
    isLoading.value = true
    error.value = null
    return pendingLoad
  }

  return {
    scenarioA,
    scenarioB,
    sharedNodes,
    nodesBuffered,
    isLoading,
    error,
    hasScenarios,
    isReady,
    loadScenarios,
  }
})
