import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { ExpressionSpecification, FillExtrusionLayerSpecification, FilterSpecification, LayerSpecification, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'

import { TACUBAYA_LEGEND } from '../config'
import { toMarkerPoints } from '../stores/geo'
import { fetchOptionalMapLayer } from '../stores/scenarios'

const BACKGROUND = '#e7e4db'
const LABEL_HALO = '#0f1117'
const SATELLITE_SOURCE = 'basemap-satellite'
const BASEMAP_SOURCE = 'basemap-vector'
const MAPTILER_KEY = 'go6pmAvswrTZcAQVPQcy'
const [stalls, infrastructure, , trees] = TACUBAYA_LEGEND

export const TACUBAYA_LIGHT: NonNullable<StyleSpecification['light']> = {
  anchor: 'viewport', color: '#ffffff', intensity: 0.75, position: [1.5, 90, 65],
}

const excludeTransit: ExpressionSpecification = ['!', ['in', ['get', 'class'], ['literal',
  ['ferry', 'rail', 'transit', 'aerialway', 'busway', 'bus_guideway', 'light_rail', 'subway', 'tram'],
]]]
const roadFilter: FilterSpecification = ['all',
  ['==', ['geometry-type'], 'LineString'],
  ['!=', ['get', 'brunnel'], 'tunnel'],
  ['!=', ['get', 'class'], 'pier'],
  excludeTransit,
]

const numberProperty = (key: string): ExpressionSpecification => ['to-number', ['get', key], 0]
const height = numberProperty('height')
const renderHeight = numberProperty('render_height')
const levels = numberProperty('levels')
const minHeight = numberProperty('min_height')
const buildingHeight: ExpressionSpecification = ['max', 1, ['case',
  ['>', height, 0], height,
  ['>', renderHeight, 0], renderHeight,
  ['>', levels, 0], ['*', levels, 3.5],
  12,
]]
const buildingPaint: FillExtrusionLayerSpecification['paint'] = {
  'fill-extrusion-color': '#64748b',
  'fill-extrusion-height': buildingHeight,
  'fill-extrusion-base': ['min', ['-', buildingHeight, 1], ['max', 0, ['case',
    ['has', 'min_height'], minHeight, numberProperty('render_min_height'),
  ]]],
  'fill-extrusion-opacity': 0.4,
  'fill-extrusion-vertical-gradient': true,
}

export function createTacubayaBasemap(): StyleSpecification {
  return {
    version: 8,
    light: TACUBAYA_LIGHT,
    glyphs: `https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=${MAPTILER_KEY}`,
    sources: {
      [SATELLITE_SOURCE]: {
        type: 'raster',
        url: `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${MAPTILER_KEY}`,
        tileSize: 512,
        maxzoom: 22,
      },
      [BASEMAP_SOURCE]: { type: 'vector', url: `https://api.maptiler.com/tiles/v3/tiles.json?key=${MAPTILER_KEY}` },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': BACKGROUND } },
      {
        // Failed imagery tiles leave the background and independent vector context visible.
        id: 'satellite-imagery', type: 'raster', source: SATELLITE_SOURCE,
        paint: { 'raster-saturation': -0.7, 'raster-brightness-max': 0.87 },
      },
      {
        id: 'road-casing', type: 'line', source: BASEMAP_SOURCE, 'source-layer': 'transportation',
        filter: roadFilter, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#303943', 'line-opacity': 0.58,
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 5, 20, 13] },
      },
      {
        id: 'road-fill', type: 'line', source: BASEMAP_SOURCE, 'source-layer': 'transportation',
        filter: roadFilter, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f5e9cf', 'line-opacity': 0.48,
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.7, 17, 2.5, 20, 10] },
      },
      {
        id: 'basemap_vector_building', type: 'fill-extrusion', source: BASEMAP_SOURCE, 'source-layer': 'building',
        paint: buildingPaint,
      },
      {
        id: 'street-labels', type: 'symbol', source: BASEMAP_SOURCE, 'source-layer': 'transportation_name',
        filter: excludeTransit,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': ['Metropolis Semi Bold', 'Noto Sans Bold'],
          'text-size': 12,
          'text-pitch-alignment': 'map',
        },
        paint: { 'text-color': '#8b95a8', 'text-halo-color': LABEL_HALO, 'text-halo-width': 1.2 },
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
  for (const key of ['height', 'render_height', 'levels', 'id', 'min_height', 'render_min_height']) {
    const value = properties[key]
    const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim())
      ? Number(value) : NaN
    if (Number.isFinite(parsed) && parsed >= 0) properties[key] = parsed
    else delete properties[key]
  }
  return properties
}

export async function loadTacubayaMapAssets(): Promise<MapAsset[]> {
  const read = (...names: string[]) => fetchOptionalMapLayer(names.map((name) => ['scenarioA', `${name}.geojson`]))
  const merge = async (...names: string[]) => combine(await Promise.all(names.map((name) => read(name))))
  const [buildings, perimeter, crime, stallData, paths, treeData, surfaces, shade, furniture] =
    await Promise.all([
      merge('extra_buildings', 'main_buildings', 'structures'),
      read('study_boundary', 'boundary'),
      read('crime'),
      merge('tacubaya_stalls', 'stalls'),
      read('pedestrian_infrastructure'),
      read('trees'),
      read('surfaces'),
      read('shade'),
      read('furniture'),
    ])

  return [
    { id: 'surfaces', data: surfaces ?? collection(), belowRoads: true, layers: [{
      id: 'surfaces-fill', type: 'fill', source: 'src-surfaces', filter: polygonFilter,
      paint: { 'fill-color': '#1b1e24', 'fill-opacity': 0.6 },
    }] },
    { id: 'shade', data: shade ?? collection(), belowRoads: true, layers: [{
      id: 'shade', type: 'fill', source: 'src-shade', filter: polygonFilter,
      paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.35 },
    }] },
    { id: 'buildings', data: collection(buildings.features.map((feature) => ({
      ...feature, properties: buildingProperties(feature),
    }))), layers: [{
      id: 'buildings-extrusion', type: 'fill-extrusion', source: 'src-buildings',
      filter: polygonFilter, paint: buildingPaint,
    }] },
    { id: 'study_boundary', data: perimeter ?? collection(), layers: [{
      id: 'study-boundary', type: 'line', source: 'src-study_boundary',
      paint: { 'line-color': '#e2e8f0', 'line-width': 1.1, 'line-opacity': 0.65 },
    }] },
    { id: 'crime', data: toMarkerPoints(crime ?? collection()), layers: [{
      id: 'crime-halo', type: 'heatmap', source: 'src-crime', paint: {
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 14, 15, 17, 30],
        'heatmap-intensity': 1.2,
        'heatmap-opacity': 0.32,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(220, 38, 38, 0)', 0.3, 'rgba(220, 38, 38, 0.45)',
          0.7, 'rgba(239, 68, 68, 0.75)', 1, 'rgba(255, 65, 65, 0.95)'],
      },
    }] },
    { id: stalls.id, data: stallData, layers: [{
      id: 'stalls-fill', type: 'fill', source: 'src-stalls', filter: polygonFilter,
      paint: { 'fill-color': stalls.color, 'fill-opacity': 0.8 },
    }, {
      id: 'stalls', type: 'line', source: 'src-stalls',
      filter: ['any', polygonFilter, lineFilter],
      paint: { 'line-color': '#fca5a5', 'line-width': 1 },
    }, {
      id: 'stalls-points', type: 'circle', source: 'src-stalls', filter: pointFilter,
      paint: { 'circle-color': stalls.color, 'circle-radius': 3.5,
        'circle-stroke-color': '#fca5a5', 'circle-stroke-width': 1 },
    }] },
    { id: infrastructure.id, data: paths ?? collection(), layers: [{
      id: 'pedestrian-infrastructure-fill', type: 'fill', source: 'src-pedestrian_infrastructure',
      filter: polygonFilter, paint: { 'fill-color': infrastructure.color, 'fill-opacity': 0.25 },
    }, {
      id: 'src-walkway2-line', type: 'line', source: 'src-pedestrian_infrastructure',
      filter: lineFilter, paint: { 'line-color': infrastructure.color, 'line-width': 1.6 },
    }] },
    { id: trees.id, data: toMarkerPoints(treeData ?? collection()), layers: [{
      id: 'src-trees-points', type: 'circle', source: 'src-trees',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 3.2],
        'circle-color': 'transparent',
        'circle-stroke-color': '#4b5563',
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.38,
      },
    }] },
    { id: 'furniture', data: toMarkerPoints(furniture ?? collection()), layers: [{
      id: 'src-furniture-points', type: 'circle', source: 'src-furniture',
      paint: { 'circle-color': '#475569', 'circle-radius': 1.8 },
    }] },
  ]
}

export function addTacubayaMapAssets(map: MapLibreMap, assets: MapAsset[]): void {
  for (const { id, data, layers, belowRoads } of assets) {
    if (!data.features.length && id !== 'pedestrian_infrastructure') continue
    if (!map.getSource(`src-${id}`)) map.addSource(`src-${id}`, { type: 'geojson', data })
    for (const layer of layers) {
      if (!map.getLayer(layer.id)) map.addLayer(layer, belowRoads ? 'road-casing' : 'street-labels')
    }
  }
}
