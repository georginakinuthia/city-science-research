import { buffer } from '@turf/turf'
import type { FeatureCollection, Geometry } from 'geojson'
import { defineStore } from 'pinia'
import { computed, markRaw, ref } from 'vue'

import { ScenarioContainer } from '../sim/scenarioGen'
import type { NodeState, ScenarioData } from './geo'
import {
  buildNodesFromCollection,
  computeNodeDistanceField,
  computeShortestPath,
  featureMask,
  type GridLike,
} from './geo'

// Re-export so existing imports from './scenarios' still work
export { buildNodesFromCollection, computeNodeDistanceField, computeShortestPath, featureMask }
export { ScenarioContainer }
export type { GridLike, NodeState, ScenarioData }

// Empirically calibrated peak-hour flow for Tacubaya (2,190 peds/15 min at Jalisco/Dublán = 8,760 pph)
const TACUBAYA_PEAK_PPH = 8760

export async function fetchGeoJSON(filename: string): Promise<FeatureCollection<Geometry>> {
  const cleanPath = filename.replace(/^\//, '')
  const url = new URL(cleanPath, window.location.href)
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to fetch ${filename}: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as FeatureCollection<Geometry>

  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error(`Invalid GeoJSON format in ${filename}`)
  }

  return data
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

export async function loadScenario(scenarioPath: string): Promise<ScenarioData> {
  const [furniture, stalls, structures, surfaces, shade] = await Promise.all([
    fetchGeoJSON(`/${scenarioPath}/furniture.geojson`),
    fetchGeoJSON(`/${scenarioPath}/stalls.geojson`),
    fetchGeoJSON(`/${scenarioPath}/structures.geojson`),
    fetchGeoJSON(`/${scenarioPath}/surfaces.geojson`),
    fetchGeoJSON(`/${scenarioPath}/shade.geojson`).catch(() =>
      fetchGeoJSON(`/${scenarioPath}/trees.geojson`),
    ),
  ])

  return {
    furniture,
    stalls,
    structures,
    surfaces,
    shade,
  }
}

export const useScenariosStore = defineStore('scenarios', () => {
  const scenarioA = ref<ScenarioContainer | null>(null)
  const scenarioB = ref<ScenarioContainer | null>(null)
  const sharedNodes = ref<NodeState[]>([])
  const nodesBuffered = ref<FeatureCollection<Geometry> | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const hasScenarios = computed(() => scenarioA.value !== null && scenarioB.value !== null)
  const isReady = computed(() => hasScenarios.value && !isLoading.value)

  async function loadScenarios() {
    if (isLoading.value) return
    isLoading.value = true
    try {
      let sharedNodesGeoJSON: FeatureCollection<Geometry>
      try {
        sharedNodesGeoJSON = await fetchGeoJSON('/scenarioA/metro_stations.geojson')
      } catch {
        sharedNodesGeoJSON = await fetchGeoJSON('/nodes.geojson')
      }

      // Filter strictly to Tacubaya study-area coordinates so all 8,760 pph spawns locally
      sharedNodesGeoJSON.features = sharedNodesGeoJSON.features.filter((f: any) => {
        if (f.geometry?.type !== 'Point') return false
        const [lon, lat] = f.geometry.coordinates
        return lon >= -99.198 && lon <= -99.176 && lat >= 19.392 && lat <= 19.414
      })

      const nodeCount = Math.max(1, sharedNodesGeoJSON.features.length)
      const perNodePph = Math.round(TACUBAYA_PEAK_PPH / nodeCount)

      sharedNodesGeoJSON.features.forEach((f: any, index: number) => {
        if (!f.properties) f.properties = {}
        f.properties.fid = f.properties.fid || `station-${index}`
        f.properties.name = f.properties.name || `Tacubaya Node ${index + 1}`
        const currentPph = Number(f.properties.pph)
        f.properties.pph = Number.isFinite(currentPph) && currentPph > 500 ? currentPph : perNodePph
        f.properties.interval = f.properties.interval ?? 0
      })

      sharedNodes.value = buildNodesFromCollection(sharedNodesGeoJSON)
      nodesBuffered.value = bufferPointsByDia(sharedNodesGeoJSON)

      const [dataA, dataB] = await Promise.all([
        loadScenario('scenarioA'),
        loadScenario('scenarioB'),
      ])

      scenarioA.value = markRaw(new ScenarioContainer(dataA, 'scenarioA'))
      scenarioB.value = markRaw(new ScenarioContainer(dataB, 'scenarioB'))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred'
      error.value = `Failed to load scenarios: ${errorMessage}`
      console.error('Error loading scenarios:', err)
    } finally {
      isLoading.value = false
    }
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
