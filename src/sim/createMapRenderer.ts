import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { ExpressionSpecification, FillExtrusionLayerSpecification, FilterSpecification, GeoJSONSource, LayerSpecification, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'

import { ACCENT, DARKEST, LIGHT } from '../assets/palette'
import { TACUBAYA_LEGEND } from '../config'
import { toMarkerPoints } from '../stores/geo'
import { fetchOptionalMapLayer } from '../stores/scenarios'

const BACKGROUND = '#0b0d12'
const BASEMAP_SOURCE = 'basemap-vector'
const MAPTILER_KEY = 'go6pmAvswrTZcAQVPQcy'
const [stalls, infrastructure, , trees] = TACUBAYA_LEGEND

export const TACUBAYA_LIGHT: NonNullable<StyleSpecification['light']> = {
  anchor: 'viewport', color: '#ffffff', intensity: 0.7, position: [1.5, 90, 65],
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

const numberProperty = (key: string): ExpressionSpecification => ['to-number', ['get', key], 0]
const height = numberProperty('height')
const renderHeight = numberProperty('render_height')
const levels = ['max', numberProperty('levels'), numberProperty('num_floors')] satisfies ExpressionSpecification
const buildingHeight: ExpressionSpecification = ['case',
  ['>', height, 0], height,
  ['>', renderHeight, 0], renderHeight,
  ['>', levels, 0], ['*', levels, 3.5],
  12,
]
const buildingPaint: FillExtrusionLayerSpecification['paint'] = {
  'fill-extrusion-color': '#2e3440',
  'fill-extrusion-height': buildingHeight,
  'fill-extrusion-base': 0,
  'fill-extrusion-opacity': 0.78,
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
        paint: { 'line-color': '#1e222b', 'line-opacity': 1,
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

function buildingProperties(feature: Feature): Feature['properties'] {
  const properties = { ...feature.properties }
  for (const key of ['height', 'render_height', 'levels', 'num_floors']) {
    const value = properties[key]
    const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim())
      ? Number(value) : NaN
    if (Number.isFinite(parsed) && parsed >= 0) properties[key] = parsed
    else delete properties[key]
  }
  return properties
}

export async function loadTacubayaMapAssets(): Promise<MapAsset[]> {
  const merge = async (...names: string[]) => combine(await Promise.all(
    ['scenarioA', 'scenarioB'].flatMap((folder) =>
      names.map((name) => fetchOptionalMapLayer([[folder, `${name}.geojson`]]))),
  ))
  const [buildings, perimeter, stallData, paths, treeData, surfaces, shade, furniture,
    lights, metro, buses, activity] = await Promise.all([
    fetchOptionalMapLayer([['scenarioA', 'extra_buildings.geojson']]),
    merge('study_boundary', 'boundary'),
    merge('tacubaya_stalls', 'stalls'),
    merge('pedestrian_infrastructure'),
    merge('trees'),
    merge('surfaces'),
    merge('shade'),
    merge('furniture'),
    merge('street_lights'),
    merge('metro_stations'),
    merge('buses', 'bus_stops'),
    merge('economic_activity2'),
  ])

  return [
    { id: 'surfaces', data: surfaces, belowRoads: true, layers: [{
      id: 'surfaces-fill', type: 'fill', source: 'src-surfaces', filter: polygonFilter,
      paint: { 'fill-color': DARKEST, 'fill-opacity': 0.25 },
    }] },
    { id: 'shade', data: shade, belowRoads: true, layers: [{
      id: 'shade', type: 'fill', source: 'src-shade', filter: polygonFilter,
      paint: { 'fill-color': LIGHT, 'fill-opacity': 0.08 },
    }, {
      id: 'shade-outline', type: 'line', source: 'src-shade', filter: polygonFilter,
      paint: { 'line-color': LIGHT, 'line-width': 1.5, 'line-opacity': 0.5 },
    }] },
    { id: 'buildings', data: collection((buildings?.features ?? []).map((feature) => ({
      ...feature, properties: buildingProperties(feature),
    }))), layers: [{
      id: 'buildings-extrusion', type: 'fill-extrusion', source: 'src-buildings',
      filter: polygonFilter, paint: buildingPaint,
    }] },
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
    { id: stalls.id, data: stallData, layers: [{
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
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 3.2],
        'circle-color': 'transparent',
        'circle-stroke-color': '#6b7280',
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.6,
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
    ...[
      { id: 'street-lights', data: lights, color: '#94a3b8', radius: 1.5, opacity: 0.55 },
      { id: 'bus-markers', data: buses, color: '#38bdf8', radius: 2.5, opacity: 0.75 },
      { id: 'economic-activity', data: activity, color: '#6b7280', radius: 1.5, opacity: 0.45 },
    ].map(({ id, data, color, radius, opacity }): MapAsset => ({
      id, data: toMarkerPoints(data), layers: [{
        id, type: 'circle', source: `src-${id}`,
        paint: { 'circle-color': color, 'circle-radius': radius, 'circle-opacity': opacity },
      }],
    })),
    { id: 'furniture', data: furniture, layers: [{
      id: 'furniture-outline', type: 'line', source: 'src-furniture',
      filter: ['any', polygonFilter, lineFilter],
      paint: { 'line-color': ACCENT, 'line-width': 2, 'line-opacity': 0.5 },
    }, {
      id: 'src-furniture-points', type: 'circle', source: 'src-furniture', filter: pointFilter,
      paint: { 'circle-color': ACCENT, 'circle-radius': 1.8, 'circle-opacity': 0.5 },
    }] },
  ]
}

export function addTacubayaMapAssets(map: MapLibreMap, assets: MapAsset[]): void {
  for (const { id, data, layers, belowRoads } of assets) {
    if (!data.features.length && id !== 'pedestrian_infrastructure' && id !== 'crime') continue
    if (!map.getSource(`src-${id}`)) map.addSource(`src-${id}`, { type: 'geojson', data })
    for (const layer of layers) {
      if (!map.getLayer(layer.id)) map.addLayer(layer, belowRoads ? 'road-casing' : 'street-labels')
    }
  }
}

export function addTacubayaInterventions(map: MapLibreMap, zones: Collection | undefined): void {
  if (!zones?.features.length) return
  addTacubayaMapAssets(map, [{
    id: 'interventions', data: zones, belowRoads: true, layers: [{
      id: 'intervention-areas', type: 'fill', source: 'src-interventions', filter: polygonFilter,
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
