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

import { TACUBAYA_BUILDING_FILE, TACUBAYA_CROWD } from '../config'
import { classifyInterventionFeature, interventionSpineAxis, type InterventionZones } from '../sim/scenarioBInterventions'
import { ScenarioContainer } from '../sim/scenarioGen'
import type { CrowdAnchors, NodeState, ScenarioData } from './geo'
import {
  applyCrimeInterventions,
  buildNodesFromCollection,
  computeNodeDistanceField,
  computeShortestPath,
  enrichZebraCrossings,
  featureMask,
  interventionOverlap,
  polygonizeBlocks,
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

declare const __SCENARIO_FILES__: Record<string, string[]>

function hasScenarioFile(folder: string, filename: string) {
  return typeof __SCENARIO_FILES__ === 'undefined' || __SCENARIO_FILES__[folder]?.includes(filename)
}

class MissingScenarioFileError extends Error {}

async function fetchLayerText(filename: string, accept: string): Promise<string> {
  const root = new URL(import.meta.env.BASE_URL, window.location.origin)
  const url = new URL(filename.replace(/^\//, ''), root)
  const response = await fetch(url, { headers: { Accept: accept } })

  if (response.status === 404 || response.headers.get('content-type')?.includes('text/html')) {
    throw new MissingScenarioFileError(`Scenario file not found: ${filename}`)
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${filename}: ${response.status} ${response.statusText}`)
  }

  const text = await response.text()
  if (!text.trim()) throw new MissingScenarioFileError(`Empty scenario file: ${filename}`)
  return text
}

export async function fetchGeoJSON(filename: string): Promise<FeatureCollection<Geometry>> {
  const text = await fetchLayerText(filename, 'application/geo+json, application/json')
  const data = JSON.parse(text) as FeatureCollection<Geometry>

  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error(`Invalid GeoJSON format in ${filename}`)
  }

  return data
}

async function fetchScenarioLayer<T>(
  scenarioPath: string,
  filename: string,
  load: (filename: string) => Promise<T>,
  isEmpty: (data: T) => boolean,
): Promise<T> {
  if (scenarioPath === 'scenarioB' && !hasScenarioFile(scenarioPath, filename)) {
    return load(`/scenarioA/${filename}`)
  }
  const request = load(`/${scenarioPath}/${filename}`)
  if (scenarioPath !== 'scenarioB') return request
  try {
    const data = await request
    if (!isEmpty(data)) return data
  } catch (error) {
    if (!(error instanceof MissingScenarioFileError)) throw error
  }
  return load(`/scenarioA/${filename}`)
}

const emptyCollection = (): FeatureCollection<Geometry> =>
  ({ type: 'FeatureCollection', features: [] })

const hasNoGeometry = (data: FeatureCollection<Geometry>) =>
  !data.features.some((feature) =>
    feature?.geometry && bbox(feature, { recompute: true }).every(Number.isFinite),
  )

export function fetchScenarioGeoJSON(scenarioPath: string, filename: string) {
  return fetchScenarioLayer(scenarioPath, filename, fetchGeoJSON, hasNoGeometry)
}

export async function fetchOptionalMapLayer(
  candidates: readonly (readonly [folder: string, filename: string])[],
  load = fetchGeoJSON,
  { checkManifest = true } = {},
): Promise<FeatureCollection<Geometry> | undefined> {
  for (const [folder, filename] of candidates) {
    if (checkManifest && !hasScenarioFile(folder, filename)) continue
    try {
      const data = await load(`/${folder}/${filename}`)
      if (!hasNoGeometry(data)) return data
    } catch (error) {
      if (!(error instanceof MissingScenarioFileError)) throw error
    }
  }
}

const SCENARIO_B_STALL_FILES = [
  ['scenarioB', 'newstalls.geojson'], ['scenarioB', 'stalls.geojson'],
] as const

export function fetchScenarioBStalls(load = fetchGeoJSON) {
  // The dev server's asset manifest can predate a newly exported GeoJSON file.
  return fetchOptionalMapLayer(SCENARIO_B_STALL_FILES, load, { checkManifest: false })
}

type TransportRow = Record<string, string>

async function fetchTransportRows(filename: string): Promise<TransportRow[]> {
  const csv = await fetchLayerText(filename, 'text/csv')
  const tokens = csv.replace(/^\uFEFF/, '').match(/"(?:[^"]|"")*"|[^",\r\n]+|,|\r\n|\r|\n/g) ?? []
  const rows: string[][] = [['']]
  for (const token of tokens) {
    const row = rows[rows.length - 1]!
    if (token === ',') row.push('')
    else if (token.startsWith('\r') || token.startsWith('\n')) rows.push([''])
    else row[row.length - 1] = token.startsWith('"') ? token.slice(1, -1).replace(/""/g, '"') : token
  }
  const [header = [], ...data] = rows
  const idColumn = header.indexOf('id')
  if (idColumn === -1) throw new Error(`Missing id column in ${filename}`)
  return data.filter((row) => row[idColumn]?.trim()).map((row) =>
    Object.fromEntries(header.map((key, index) => [key, row[index] ?? ''])),
  )
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

function createInterventionZones(
  explicit: FeatureCollection<Geometry> | undefined,
  fallback: [string, FeatureCollection<Geometry> | undefined][],
  area: ReturnType<typeof studyArea>,
): InterventionZones {
  const [west, south, east, north] = area.bounds
  const inputs: typeof fallback = explicit ? [['', explicit]] : fallback
  const features = inputs.flatMap(([hint, input]) => (input?.features ?? []).flatMap((feature) => {
    if (!feature?.geometry) return []
    const [x0, y0, x1, y1] = bbox(feature, { recompute: true })
    if (!(x0! <= east! && x1! >= west! && y0! <= north! && y1! >= south!)) return []
    const category = classifyInterventionFeature(feature.properties, hint)
    const { type } = feature.geometry
    const radius = type === 'Point' || type === 'MultiPoint' ? (category === 'street_lighting' ? 24 : 16)
      : type === 'LineString' || type === 'MultiLineString' ? 12 : 6
    const zone = buffer(feature, radius, { units: 'meters' })
    const axis = category === 'shared_access_spine' ? interventionSpineAxis(feature.geometry) : undefined
    return zone ? [{ ...zone, properties: { category, axis } }] : []
  }))
  return { type: 'FeatureCollection', features }
}

export async function loadScenario(
  scenarioPath: string,
  load = fetchGeoJSON,
  loadTransport = fetchTransportRows,
): Promise<ScenarioData> {
  const layer = (filename: string) => fetchScenarioLayer(scenarioPath, filename, load, hasNoGeometry)
  const optionalLayer = (filename: string) => fetchOptionalMapLayer(
    scenarioPath === 'scenarioB' ? [[scenarioPath, filename], ['scenarioA', filename]] : [[scenarioPath, filename]], load,
  )
  const isInterventionScenario = scenarioPath === 'scenarioB'
  const localLayer = (filename: string) => fetchOptionalMapLayer([[scenarioPath, filename]], load)
  const [
    structures, streets, buses, stalls, trees, blocks,
    reportedCrime, economicActivity, transportGeometry, transportRows, metro, busStops, boundary, streetLights,
    rawCrossings, scenarioStalls, explicitInterventions, publicSpace, plazaConnections, seating, canopy, landscaping, upgradedLights, upgradedCrossings,
  ] = await Promise.all([
    layer(TACUBAYA_BUILDING_FILE),
    layer('streets.geojson'),
    layer('buses.geojson'),
    layer('tacubaya_stalls.geojson'),
    layer('trees.geojson'),
    layer('blocks.geojson'),
    layer('crime.geojson'),
    layer('economic_activity2.geojson'),
    optionalLayer('transport_types.geojson'),
    fetchScenarioLayer(scenarioPath, 'transport_types.csv', loadTransport, (rows) => rows.length === 0),
    layer('metro_stations.geojson'),
    layer('bus_stops.geojson'),
    layer('study_boundary.geojson'),
    optionalLayer('street_lights.geojson'),
    optionalLayer('zebra_crossings.geojson'),
    isInterventionScenario ? fetchScenarioBStalls(load) : undefined,
    isInterventionScenario ? localLayer('interventions.geojson') : undefined,
    isInterventionScenario ? localLayer('surfaces.geojson') : undefined,
    isInterventionScenario ? optionalLayer('publicspace.geojson') : undefined,
    isInterventionScenario ? localLayer('furniture.geojson') : undefined,
    isInterventionScenario ? localLayer('shade.geojson') : undefined,
    isInterventionScenario ? localLayer('trees.geojson') : undefined,
    isInterventionScenario ? localLayer('street_lights.geojson') : undefined,
    isInterventionScenario ? localLayer('zebra_crossings.geojson') : undefined,
  ])

  const transportById = new Map(transportRows.map((row) => [row.id, row]))
  // Transit still influences routing when the optional transport geometry is unavailable.
  const transportSource = transportGeometry ?? {
    type: 'FeatureCollection',
    features: [...buses.features, ...metro.features, ...busStops.features],
  } satisfies FeatureCollection<Geometry>
  const transport: FeatureCollection<Geometry> = {
    ...transportSource,
    features: transportSource.features.map((feature) => ({
      ...feature,
      properties: {
        ...transportById.get(String(feature.properties?.id ?? feature.id)),
        ...feature.properties,
      },
    })),
  }
  const area = studyArea(boundary, streets)
  const interventionZones = isInterventionScenario
    ? createInterventionZones(explicitInterventions,
      [
        ['surfaces', publicSpace], ['crossings', plazaConnections], ['seating', seating],
        ['canopy', canopy], ['landscaping', landscaping], ['bus bays', buses],
        ['street lights', upgradedLights], ['crossings', upgradedCrossings],
      ], area)
    : undefined
  if (interventionZones && scenarioStalls) {
    interventionZones.features.push(...createInterventionZones(undefined, [['stalls', scenarioStalls]], area).features)
  }
  const dwellZones = interventionZones?.features.filter(({ properties }) =>
    properties.category === 'community_canopy' || properties.category === 'active_recreation',
  ) ?? []
  const dwellPoints = dwellZones.length
    ? uniquePoints(pointsInArea({ type: 'FeatureCollection', features: dwellZones }, area), 0.000035)
    : []
  const crime = interventionZones ? applyCrimeInterventions(reportedCrime, interventionZones) : reportedCrime
  const lights = streetLights ?? emptyCollection()
  const zebraCrossings = enrichZebraCrossings(
    rawCrossings ?? emptyCollection(), lights,
    { type: 'FeatureCollection', features: [
      ...stalls.features, ...(scenarioStalls?.features ?? []), ...structures.features, ...buses.features,
    ] },
    streets, crime,
    { type: 'FeatureCollection', features: [...metro.features, ...busStops.features] },
  )
  if (interventionZones?.features.length) {
    const overlaps = interventionOverlap(interventionZones)
    for (const crossing of zebraCrossings.features) {
      if (overlaps(crossing)) crossing.properties.improved = 1
    }
  }
  const walkwayPoints = uniquePoints(walkwayAnchors(streets, area), 0.000008)
  const busPoints = uniquePoints(pointsInArea(busStops, area), 0.000015)
  const crowd: CrowdAnchors = {
    walkways: coordinates(walkwayPoints),
    destinations: coordinates(uniquePoints(pointsInArea(economicActivity, area), 0.00015)),
    busStops: coordinates(busPoints),
  }

  return {
    furniture: { type: 'FeatureCollection', features: [...(seating?.features ?? []), ...dwellPoints] },
    stalls: scenarioStalls ?? stalls,
    structures,
    surfaces: emptyCollection(),
    shade: canopy ?? trees,
    routing: {
      transport,
      walkways: emptyCollection(),
      studyBoundary: area.studyBoundary,
      interventionZones,
      crowd,
      pedestrian: {
        streets,
        blocks: polygonizeBlocks(blocks),
        buses,
        metro: { type: 'FeatureCollection', features: pointsInArea(metro, area) },
        busStops: { type: 'FeatureCollection', features: busPoints },
        crime,
        economicActivity,
        streetLights: lights,
        zebraCrossings,
      },
    },
  }
}

function deduplicateRequests<T>(load: (filename: string) => Promise<T>) {
  const requests = new Map<string, Promise<T>>()
  return (filename: string) => {
    let request = requests.get(filename)
    if (!request) {
      request = load(filename)
      requests.set(filename, request)
    }
    return request
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
    const load = deduplicateRequests(fetchGeoJSON)
    const loadTransport = deduplicateRequests(fetchTransportRows)
    const loadContainer = async (folder: string) =>
      markRaw(new ScenarioContainer(await loadScenario(folder, load, loadTransport), folder))
    pendingLoad = Promise.all([loadContainer('scenarioA'), loadContainer('scenarioB')])
      .then(([a, b]) => {
        const scenarios = [a, b]
        const transitPoints = (key: 'metro' | 'busStops') =>
          scenarios.flatMap((scenario) => scenario.routing?.pedestrian?.[key].features ?? [])
        const walkwayPoints = scenarios.flatMap((scenario) =>
          (scenario.routing?.crowd?.walkways ?? []).map((coordinates): Feature<Point> => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates },
            properties: null,
          })),
        )
        const groups = [
          {
            id: 'metro',
            label: 'Metro exit',
            share: 0.55,
            points: uniquePoints(transitPoints('metro'), 0.000015),
          },
          {
            id: 'bus',
            label: 'Bus stop',
            share: 0.3,
            points: uniquePoints(transitPoints('busStops'), 0.000015),
          },
          {
            id: 'peripheral',
            label: 'Peripheral entry',
            share: 0.15,
            points: peripheralPoints(walkwayPoints),
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
        scenarioA.value = a
        scenarioB.value = b
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
