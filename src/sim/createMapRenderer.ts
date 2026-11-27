import { bbox, difference, featureCollection, transformScale } from '@turf/turf'
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from 'geojson'
import type { ExpressionSpecification, FillExtrusionLayerSpecification, FilterSpecification, GeoJSONSource, LayerSpecification, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'

import { ACCENT, DARKEST, LIGHT } from '../assets/palette'
import { TACUBAYA_BUILDING_FILE, TACUBAYA_LEGEND } from '../config'
import { createTacubayaBuildingEdges, tacubayaMarket, TACUBAYA_MARKET_PART_IDS } from '../rendering/TacubayaBuildings'
import { toMarkerPoints } from '../stores/geo'
import { fetchOptionalMapLayer, fetchScenarioBStalls } from '../stores/scenarios'

const BACKGROUND = '#0b0d12'
const BASEMAP_SOURCE = 'basemap-vector'
const MAPTILER_KEY = 'go6pmAvswrTZcAQVPQcy'
const [stalls, infrastructure, , trees, busLegend] = TACUBAYA_LEGEND

export const TACUBAYA_LIGHT: NonNullable<StyleSpecification['light']> = {
  anchor: 'viewport', color: '#ffffff', intensity: 0.62, position: [1.35, 215, 38],
}

const excludeTransit: ExpressionSpecification = ['!', ['in', ['get', 'class'], ['literal',
  ['ferry', 'rail', 'transit', 'aerialway', 'busway', 'bus_guideway', 'light_rail', 'subway', 'tram'],
]]]
const excludePedestrianPaths: ExpressionSpecification = ['all',
  ['!', ['in', ['get', 'class'], ['literal', ['path', 'pedestrian', 'footway', 'steps']]]],
  ['!', ['in', ['get', 'subclass'], ['literal', ['path', 'pedestrian', 'footway', 'steps']]]],
]
const roadFilter: FilterSpecification = ['all',
  ['==', ['geometry-type'], 'LineString'],
  ['!=', ['get', 'brunnel'], 'tunnel'],
  ['!=', ['get', 'class'], 'pier'],
  excludeTransit,
  excludePedestrianPaths,
]

const BUILDING_COLOR = '#191b1e'
const buildingPaint: FillExtrusionLayerSpecification['paint'] = {
  'fill-extrusion-color': BUILDING_COLOR,
  'fill-extrusion-height': ['get', 'renderHeight'],
  'fill-extrusion-base': 0,
  'fill-extrusion-opacity': 0.94,
  'fill-extrusion-vertical-gradient': true,
}

export function createTacubayaBasemap(): StyleSpecification {
  return {
    version: 8,
    light: TACUBAYA_LIGHT,
    glyphs: `https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=${MAPTILER_KEY}`,
    sources: {
      [BASEMAP_SOURCE]: { type: 'vector', url: `https://api.maptiler.com/tiles/v3/tiles.json?key=${MAPTILER_KEY}` },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': BACKGROUND } },
      {
        id: 'road-casing', type: 'line', source: BASEMAP_SOURCE, 'source-layer': 'transportation',
        filter: roadFilter, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2c3240', 'line-opacity': 1,
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 5, 20, 13] },
      },
      {
        id: 'road-fill', type: 'line', source: BASEMAP_SOURCE, 'source-layer': 'transportation',
        filter: roadFilter, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#161a22', 'line-opacity': 1,
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.7, 17, 2.5, 20, 10] },
      },
      {
        id: 'street-labels', type: 'symbol', source: BASEMAP_SOURCE, 'source-layer': 'transportation_name',
        filter: ['all', excludeTransit, excludePedestrianPaths],
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 380,
          'symbol-sort-key': ['match', ['get', 'class'],
            ['motorway', 'trunk', 'primary'], 0, ['secondary', 'tertiary'], 1, 2],
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': ['Metropolis Semi Bold', 'Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10, 18, 11],
          'text-padding': 5,
          'text-pitch-alignment': 'map',
        },
        paint: { 'text-color': LIGHT, 'text-opacity': 0.88,
          'text-halo-color': DARKEST, 'text-halo-width': 1 },
      },
    ],
  }
}

type Collection = FeatureCollection<Geometry>
type MapAsset = { id: string; data: Collection; layers: LayerSpecification[]; belowRoads?: boolean }
const collection = (features: Feature<Geometry>[] = []): Collection => ({ type: 'FeatureCollection', features })
const polygonFilter = ['==', ['geometry-type'], 'Polygon'] satisfies FilterSpecification
const lineFilter = ['==', ['geometry-type'], 'LineString'] satisfies FilterSpecification
const pointFilter: FilterSpecification = ['==', ['geometry-type'], 'Point']

function combine(inputs: (Collection | undefined)[]): Collection {
  const seen = new Set<string>()
  return collection(inputs.flatMap((input) => (input?.features ?? []).filter(({ geometry }) => {
    if (!geometry) return false
    const key = JSON.stringify(geometry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })))
}

function isPolygon(feature: Feature<Geometry>): feature is Feature<Polygon | MultiPolygon> {
  return feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon'
}

function scaleBusFootprints(data: Collection | undefined): Collection {
  return collection((data?.features ?? [])
    .filter(isPolygon)
    .map((feature) => transformScale(feature, 2 / 3)))
}

function closedFootprint(ring: Position[]): boolean {
  const first = ring[0]
  const last = ring.at(-1)
  return ring.length >= 4 && first !== undefined && last !== undefined
    && first[0] === last[0] && first[1] === last[1]
    && new Set(ring.map(([x, y]) => `${x},${y}`)).size >= 3
}

function normalizeBuilding(feature: Feature): Feature[] {
  let { geometry } = feature
  if (geometry?.type === 'LineString' || geometry?.type === 'MultiLineString') {
    const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates
    const footprints = lines.filter(closedFootprint)
    if (!footprints.length) return []
    geometry = footprints.length === 1
      ? { type: 'Polygon', coordinates: [footprints[0]!] }
      : { type: 'MultiPolygon', coordinates: footprints.map((ring) => [ring]) }
  }
  if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon') return []

  const stripZ = (ring: Position[]) => ring.map(([x, y]): Position => [x!, y!])
  geometry = geometry.type === 'Polygon'
    ? { type: 'Polygon', coordinates: geometry.coordinates.map(stripZ) }
    : { type: 'MultiPolygon', coordinates: geometry.coordinates.map((polygon) => polygon.map(stripZ)) }

  const properties = feature.properties ?? {}
  const numeric = (value: unknown) => typeof value === 'number' || typeof value === 'string'
    ? Number(value) : NaN
  const height = numeric(properties.height)
  const levelHeight = [properties.levels, properties.level, properties.num_floors]
    .map((value) => numeric(value) * 3.5)
    .find((value) => Number.isFinite(value) && value > 2)
  const candidate = Number.isFinite(height) && height > 2 ? height : (levelHeight ?? 14)
  return [{
    ...feature, geometry,
    properties: { ...properties, renderHeight: Math.max(3, Math.min(26, candidate)), minHeight: 0 },
  }]
}

export async function loadTacubayaMapAssets(): Promise<readonly [MapAsset[], MapAsset[]]> {
  const merge = async (...names: string[]) => combine(await Promise.all(
    ['scenarioA', 'scenarioB'].flatMap((folder) =>
      names.map((name) => fetchOptionalMapLayer([[folder, `${name}.geojson`]]))),
  ))
  const [buildingsA, buildingsB, perimeter, stallData, proposedStalls, paths, treeData, surfaces, shade, furniture,
    lights, metro, buses, newBuses, activity] = await Promise.all([
    fetchOptionalMapLayer([['scenarioA', TACUBAYA_BUILDING_FILE]]),
    fetchOptionalMapLayer([['scenarioB', TACUBAYA_BUILDING_FILE]]),
    merge('study_boundary', 'boundary'),
    fetchOptionalMapLayer([['scenarioA', 'tacubaya_stalls.geojson']]),
    fetchScenarioBStalls(),
    merge('pedestrian_infrastructure'),
    merge('trees'),
    fetchOptionalMapLayer([['scenarioB', 'surfaces.geojson']]),
    fetchOptionalMapLayer([['scenarioB', 'shade.geojson']]),
    fetchOptionalMapLayer([['scenarioB', 'furniture.geojson']]),
    merge('street_lights'),
    merge('metro_stations'),
    fetchOptionalMapLayer([['scenarioA', 'buses.geojson']]),
    fetchOptionalMapLayer([['scenarioB', 'new_buses.geojson']], undefined, { checkManifest: false }),
    merge('economic_activity2'),
  ])

  const treeCanopies = collection(shade?.features.filter((feature) => feature.properties?.eq_dia != null))
  const builtShade = collection(shade?.features.filter((feature) => feature.properties?.eq_dia == null))
  const ground: MapAsset[] = [
    { id: 'surfaces', data: surfaces ?? collection(), belowRoads: true, layers: [{
      id: 'surfaces-fill', type: 'fill', source: 'src-surfaces', filter: polygonFilter,
      paint: { 'fill-color': '#64748b', 'fill-opacity': 0.10 },
    }, {
      id: 'surfaces-outline', type: 'line', source: 'src-surfaces', filter: polygonFilter,
      paint: { 'line-color': '#94a3b8', 'line-width': 0.6, 'line-opacity': 0.24 },
    }] },
    { id: 'shade', data: builtShade, belowRoads: true, layers: [{
      id: 'shade', type: 'fill', source: 'src-shade', filter: polygonFilter,
      paint: { 'fill-color': LIGHT, 'fill-opacity': 0.08 },
    }, {
      id: 'shade-outline', type: 'line', source: 'src-shade', filter: polygonFilter,
      paint: { 'line-color': LIGHT, 'line-width': 0.7, 'line-opacity': 0.25 },
    }] },
  ]
  const overlays: MapAsset[] = [
    { id: 'study_boundary', data: perimeter ?? collection(), layers: [{
      id: 'study-boundary', type: 'line', source: 'src-study_boundary',
      paint: { 'line-color': '#e2e8f0', 'line-width': 1.5, 'line-opacity': 0.9 },
    }] },
    { id: 'crime', data: collection(), layers: [{
      id: 'crime-halo', type: 'heatmap', source: 'src-crime', paint: {
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 14, 24, 17, 45],
        'heatmap-intensity': 1,
        'heatmap-weight': ['coalesce', ['get', 'crimeWeight'], 1],
        'heatmap-opacity': 0.5,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(255, 25, 25, 0)', 0.3, 'rgba(220, 38, 38, 0.45)',
          1, 'rgba(255, 55, 55, 0.88)'],
      },
    }] },
    { id: stalls.id, data: stallData ?? collection(), layers: [{
      id: 'stalls-fill', type: 'fill', source: 'src-stalls', filter: polygonFilter,
      paint: { 'fill-color': stalls.color, 'fill-opacity': 0.2 },
    }, {
      id: 'stalls', type: 'line', source: 'src-stalls',
      filter: ['any', polygonFilter, lineFilter],
      paint: { 'line-color': '#fca5a5', 'line-width': 1.5, 'line-opacity': 0.5 },
    }, {
      id: 'stalls-points', type: 'circle', source: 'src-stalls', filter: pointFilter,
      paint: { 'circle-color': stalls.color, 'circle-radius': 2.5,
        'circle-stroke-color': '#fca5a5', 'circle-stroke-width': 1 },
    }] },
    { id: infrastructure.id, data: paths ?? collection(), layers: [{
      id: 'pedestrian-infrastructure-fill', type: 'fill', source: 'src-pedestrian_infrastructure',
      filter: polygonFilter, paint: { 'fill-color': infrastructure.color, 'fill-opacity': 0.18 },
    }, {
      id: 'src-walkway2-line', type: 'line', source: 'src-pedestrian_infrastructure',
      filter: lineFilter, paint: { 'line-color': infrastructure.color, 'line-width': 1.2 },
    }] },
    { id: trees.id, data: toMarkerPoints(treeData ?? collection()), layers: [{
      id: 'src-trees-points', type: 'circle', source: 'src-trees',
      paint: {
        'circle-radius': 2.6,
        'circle-color': '#6b7280',
        'circle-opacity': 0.22,
        'circle-stroke-color': '#6b7280',
        'circle-stroke-width': 0.6,
        'circle-stroke-opacity': 0.35,
      },
    }] },
    { id: 'metro', data: metro, layers: [{
      id: 'metro-fill', type: 'fill', source: 'src-metro', filter: polygonFilter,
      paint: { 'fill-color': '#334155', 'fill-opacity': 0.55 },
    }, {
      id: 'metro-outline', type: 'line', source: 'src-metro', filter: polygonFilter,
      paint: { 'line-color': '#64748b', 'line-width': 1, 'line-opacity': 0.55 },
    }, {
      id: 'metro-points', type: 'circle', source: 'src-metro', filter: pointFilter,
      paint: { 'circle-color': '#334155', 'circle-radius': 2.5, 'circle-opacity': 0.55,
        'circle-stroke-color': '#64748b', 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.55 },
    }] },
    { id: 'bus-markers', data: scaleBusFootprints(buses), layers: [{
      id: 'bus-markers', type: 'fill', source: 'src-bus-markers', filter: polygonFilter,
      paint: { 'fill-color': busLegend.color, 'fill-opacity': 0.60 },
    }] },
    ...[
      { id: 'street-lights', data: lights, color: '#94a3b8', radius: 1.5, opacity: 0.55 },
      { id: 'economic-activity', data: activity, color: '#6b7280', radius: 1.5, opacity: 0.45 },
    ].map(({ id, data, color, radius, opacity }): MapAsset => ({
      id, data: toMarkerPoints(data), layers: [{
        id, type: 'circle', source: `src-${id}`,
        paint: { 'circle-color': color, 'circle-radius': radius, 'circle-opacity': opacity },
      }],
    })),
    { id: 'furniture', data: furniture ?? collection(), layers: [{
      id: 'furniture-outline', type: 'line', source: 'src-furniture',
      filter: ['any', polygonFilter, lineFilter],
      paint: { 'line-color': '#8b95a8', 'line-width': 0.65, 'line-opacity': 0.3 },
    }, {
      id: 'src-furniture-points', type: 'circle', source: 'src-furniture', filter: pointFilter,
      paint: { 'circle-color': ACCENT, 'circle-radius': 1.8, 'circle-opacity': 0.5 },
    }] },
  ]
  const withBuildings = (buildings: Collection | undefined, proposed: boolean): MapAsset[] => {
    const footprints = collection(
      (buildings?.features ?? []).flatMap((feature) => {
        const id = feature.id ?? feature.properties?.fid
        if (!TACUBAYA_MARKET_PART_IDS.has(id)) return normalizeBuilding(feature)
        return id === tacubayaMarket.id ? normalizeBuilding(tacubayaMarket) : []
      }),
    )
    const buildingBounds = footprints.features
      .filter(isPolygon)
      .map((feature) => ({ feature, bounds: bbox(feature) }))
    return [
      ...(proposed ? ground : []),
      ...overlays.filter(({ id }) => id === 'bus-markers').map((asset): MapAsset => {
        const markers = proposed && newBuses ? scaleBusFootprints(newBuses).features : asset.data.features
        const count = proposed && !newBuses ? Math.round(markers.length * 2 / 3) : markers.length
        const selected = Array.from({ length: count }, (_, index) =>
          markers[Math.floor((index + 0.5) * markers.length / count)]!,
        )
        return { ...asset, data: collection(selected.filter(isPolygon).flatMap((marker) => {
          const [west, south, east, north] = bbox(marker)
          const overlaps = buildingBounds.filter(({ bounds: [x0, y0, x1, y1] }) =>
            west! < x1! && east! > x0! && south! < y1! && north! > y0!,
          )
          if (!overlaps.length) return [marker]
          const visible = difference(featureCollection([marker, ...overlaps.map(({ feature }) => feature)]))
          return visible ? [{ ...marker, geometry: visible.geometry }] : []
        })) }
      }),
      { id: 'buildings', data: footprints, layers: [{
        id: 'buildings-extrusion', type: 'fill-extrusion', source: 'src-buildings',
        filter: polygonFilter, paint: buildingPaint,
      }] },
      ...overlays.filter((asset) => asset.id !== 'bus-markers' && (proposed || asset.id !== 'furniture')).map((asset): MapAsset => {
        if (proposed && asset.id === trees.id && treeCanopies.features.length) {
          return { ...asset, data: combine([asset.data, toMarkerPoints(treeCanopies)]) }
        }
        if (!proposed || asset.id !== stalls.id || !proposedStalls) return asset
        return { ...asset, data: proposedStalls, layers: [
          { id: 'stalls-extrusion', type: 'fill-extrusion', source: 'src-stalls', filter: polygonFilter,
            paint: { ...buildingPaint, 'fill-extrusion-height': 3.1 } },
          { id: 'stalls', type: 'line', source: 'src-stalls', filter: ['any', polygonFilter, lineFilter],
            paint: { 'line-color': '#737985', 'line-width': 0.85, 'line-opacity': 0.52 } },
          { id: 'stalls-points', type: 'circle', source: 'src-stalls', filter: pointFilter,
            paint: { 'circle-color': BUILDING_COLOR, 'circle-radius': 1.5, 'circle-opacity': 0.55 } },
        ] }
      }),
    ]
  }
  return [withBuildings(buildingsA, false), withBuildings(buildingsB ?? buildingsA, true)]
}

export function addTacubayaMapAssets(map: MapLibreMap, assets: MapAsset[]): void {
  for (const { id, data, layers, belowRoads } of assets) {
    if (!data.features.length && id !== 'pedestrian_infrastructure' && id !== 'crime') continue
    if (!map.getSource(`src-${id}`)) map.addSource(`src-${id}`, { type: 'geojson', data })
    for (const layer of layers) {
      if (!map.getLayer(layer.id)) map.addLayer(layer, belowRoads ? 'road-casing' : 'street-labels')
    }
    if (id === 'buildings' && !map.getLayer('buildings-roof-edges')) {
      map.addLayer(createTacubayaBuildingEdges(data), 'street-labels')
    }
  }
}

export function addTacubayaInterventions(map: MapLibreMap, zones: Collection | undefined): void {
  if (!zones?.features.length) return
  addTacubayaMapAssets(map, [{
    id: 'interventions', data: zones, belowRoads: true, layers: [{
      id: 'intervention-areas', type: 'fill', source: 'src-interventions',
      filter: ['all', polygonFilter, ['!=', ['get', 'category'], 'transit_wayfinding'],
        ['!=', ['get', 'category'], 'street_lighting']],
      paint: {
        'fill-color': ['match', ['get', 'category'],
          'shared_access_spine', '#5e8a82',
          'transit_wayfinding', '#57738a',
          'street_lighting', '#998465',
          '#64796d'],
        'fill-opacity': 0.08,
        'fill-antialias': false,
      },
    }],
  }])
}

export function updateTacubayaCrime(map: MapLibreMap, crime: Collection | undefined): void {
  const source = map.getSource<GeoJSONSource>('src-crime')
  if (source) source.setData(toMarkerPoints(crime ?? collection()))
}
