import { bbox } from '@turf/turf'
import type { FeatureCollection, Geometry } from 'geojson'
import { defineStore } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import { ACCENT, EMBER, LIGHT } from '../assets/palette'
import { GEOMETRY, TIMING, WGS84 } from '../config'
import { parseColorU32 } from '../sim/colors'
import type { SimView } from '../sim/SimView'
import { SimWorkerClient } from '../sim/workerClient'
import type { StatsUpdateMessage } from '../sim/workerProtocol'

import { useBehaviorStore } from './behavior'
import { computePatchesWidth } from './geo'
import { type NodeState, type ScenarioContainer } from './scenarios'

/**
 * Deep-unwrap a Vue reactive Proxy (or plain object) into structured-clone-
 * friendly plain data.
 *
 * Uses `toRaw` to strip the outermost reactive wrapper, then delegates to
 * `structuredClone` for a deep copy. Since the scenarios are constructed
 * from `loadScenario()` (plain JSON data) and stored via `markRaw(...)` in
 * [stores/scenarios.ts](./scenarios.ts), their nested references are
 * already plain — `structuredClone` succeeds directly. This avoids the
 * brute-force `JSON.parse(JSON.stringify(...))` round-trip we had before,
 * which cost ~1–5 MB of string thrash at init.
 */
function toPlainFeatureCollection<T extends FeatureCollection<Geometry>>(fc: T): T {
  return structuredClone(toRaw(fc)) as T
}

// Pre-packed cell palette colors — constant across scenarios. Base hues
// come from the official NFI palette; the trailing two hex digits encode
// per-layer alpha (0x10 ≈ 6%, 0x40 ≈ 25%, 0x60 ≈ 38%).
// Stalls use EMBER to match shopping agents; shade/trees use a neutral
// LIGHT tint so the canopy reads as context rather than a feature.
const TRANSPARENT_U32 = 0
const SURFACE_U32 = parseColorU32(`${ACCENT}10`)
const STALL_STOP_U32 = parseColorU32(`${EMBER}40`)
const FURNITURE_STOP_U32 = parseColorU32(`${ACCENT}40`)
const SHADE_STOP_U32 = parseColorU32(`${LIGHT}60`)

export const useModelsStore = defineStore('models', () => {
  const behaviorStore = useBehaviorStore()

  // Worker-backed SimViews (null until initModel() completes)
  const viewA = ref<SimView | null>(null)
  const viewB = ref<SimView | null>(null)

  // Worker client — created fresh per init() call. Disposed on store destroy.
  let client: SimWorkerClient | null = null
  let disposeParamWatcher: (() => void) | null = null

  // Nodes for the UI — displayed on the map and bound to spawn-rate sliders.
  // Authoritative spawn calculation lives in the worker (see
  // `src/sim/worker.ts::tick`). This reactive copy exists ONLY so the UI
  // can render node markers and listen to slider events; when a slider
  // moves, `setSharedNodePph` forwards the change to the worker via
  // `client.setNodePph()` so the worker's own `workerNodes` list stays
  // aligned.
  const nodes = ref<NodeState[]>([])

  // Selected node for highlighting agents
  const selectedNodeId = ref<string | null>(null)

  // Latest stats per sim — updated by worker STATS messages so the UI has
  // reactive totals without reaching into the worker.
  const statsA = ref<StatsUpdateMessage | null>(null)
  const statsB = ref<StatsUpdateMessage | null>(null)

  function getClient(): SimWorkerClient | null {
    return client
  }

  async function initModel(
    scenarioA: ScenarioContainer,
    scenarioB: ScenarioContainer,
    sharedNodes: NodeState[],
  ): Promise<[SimView, SimView]> {
    // Tear down any prior worker + watcher.
    disposeClient()

    const filterValidFeatures = (fc: FeatureCollection<Geometry> | null) => {
      if (!fc || !Array.isArray(fc.features)) return fc
      return {
        ...fc,
        features: fc.features.filter((f) => {
          if (!f.geometry || !('coordinates' in f.geometry)) return false
          const coords = (f.geometry as any).coordinates
          if (Array.isArray(coords) && coords.length === 0) return false
          return true
        }),
      }
    }

    // Both workers share a grid that covers the two study areas and their anchors.
    const scenarioBounds = (scenario: ScenarioContainer) => bbox(
      scenario.routing?.studyBoundary ?? filterValidFeatures(scenario.surfaces)!,
      { recompute: true },
    )
    const boundsA = scenarioBounds(scenarioA)
    const boundsB = scenarioBounds(scenarioB)
    if (!boundsA.every(Number.isFinite) || !boundsB.every(Number.isFinite)) {
      throw new Error('Tacubaya needs a valid extent for both scenarios.')
    }
    const south = Math.min(boundsA[1], boundsB[1])
    const north = Math.max(boundsA[3], boundsB[3])
    const latPad = GEOMETRY.bboxPaddingMeters * WGS84.degPerMeterEquator
    const lonPad = latPad / Math.cos((south + north) * Math.PI / 360)
    const bounds: [number, number, number, number] = [
      Math.min(boundsA[0], boundsB[0]) - lonPad,
      south - latPad,
      Math.max(boundsA[2], boundsB[2]) + lonPad,
      north + latPad,
    ]
    const patchesWidth = computePatchesWidth(bounds, behaviorStore.targetPatchMeters)

    // Unwrap each scenario container into plain data that structured-clone
    // can ship across the worker boundary.
    const plainScenario = (s: ScenarioContainer) => ({
      name: s.name ?? 'scenario',
      surfaces: toPlainFeatureCollection(s.surfaces),
      structures: toPlainFeatureCollection(s.structures),
      stalls: toPlainFeatureCollection(s.stalls),
      furniture: toPlainFeatureCollection(s.furniture),
      shade: toPlainFeatureCollection(s.shade),
      routing: s.routing,
    })
    const scenarioDataA = plainScenario(scenarioA)
    const scenarioDataB = plainScenario(scenarioB)

    const workerClient = new SimWorkerClient()
    client = workerClient
    workerClient.onStats((msg) => {
      if (msg.simIdx === 0) statsA.value = msg
      else if (msg.simIdx === 1) statsB.value = msg
    })

    const initResult = await workerClient.init({
      mode: 'dual',
      bbox: bounds,
      targetWidth: patchesWidth,
      scenarioA: scenarioDataA,
      scenarioB: scenarioDataB,
      // Clone into plain objects — sharedNodes items come from a Vue
      // reactive ref, and the nested `coords` tuple would otherwise be
      // a reactive Array Proxy that postMessage can't serialize.
      nodes: sharedNodes.map((n) => {
        const raw = toRaw(n)
        return {
          id: raw.id,
          label: raw.label,
          coords: raw.coords ? ([raw.coords[0], raw.coords[1]] as [number, number]) : undefined,
          pph: raw.pph,
          interval: raw.interval,
          noEngagement: raw.noEngagement,
        }
      }),
      params: behaviorStore.snapshotParams(),
      timing: {
        fps: TIMING.fps,
        fastModeMultiplier: TIMING.fastModeMultiplier,
        simulationDuration: TIMING.simulationDuration,
      },
      palette: {
        transparent: TRANSPARENT_U32,
        surface: SURFACE_U32,
        stallStops: [TRANSPARENT_U32, STALL_STOP_U32],
        furnitureStops: [TRANSPARENT_U32, FURNITURE_STOP_U32],
        shadeStops: [TRANSPARENT_U32, SHADE_STOP_U32],
      },
    }).catch((error) => {
      if (client === workerClient) disposeClient()
      throw error
    })

    viewA.value = initResult.views[0] ?? null
    viewB.value = initResult.views[1] ?? null

    // Absorb worker-projected node positions into the reactive `nodes`
    // ref. The shared-nodes list feeds the main-thread spawn calculator,
    // which needs `worldX`/`worldY` set on each node.
    nodes.value = initResult.projectedNodes.map((n) => ({
      id: n.id,
      label: n.label,
      pph: n.pph,
      interval: n.interval,
      worldX: n.worldX,
      worldY: n.worldY,
      noEngagement: n.noEngagement,
      coords: sharedNodes.find((s) => s.id === n.id)?.coords,
    }))

    // Set up a reactive watcher that pushes behavior-param changes to the
    // worker whenever any slider or toggle moves. `flush: 'sync'` to
    // minimise latency between UI change and sim effect.
    disposeParamWatcher = watch(
      [
        () => behaviorStore.behaviorDiversity,
        () => behaviorStore.personalSpace,
        () => behaviorStore.speedBase,
        () => behaviorStore.shoppingProbability,
        () => behaviorStore.spareTimeProbability,
        () => behaviorStore.isSunny,
        () => behaviorStore.debugOrcaEnabled,
        () => behaviorStore.debugDensityEnabled,
        () => behaviorStore.debugMomentumEnabled,
        () => behaviorStore.debugDensityBeta,
        () => behaviorStore.debugMomentumBase,
        () => behaviorStore.debugFollowingStrength,
      ],
      () => {
        client?.setParams(behaviorStore.snapshotParams())
      },
      { flush: 'sync' },
    )

    return [viewA.value!, viewB.value!]
  }

  function disposeClient(): void {
    if (disposeParamWatcher) {
      disposeParamWatcher()
      disposeParamWatcher = null
    }
    if (client) {
      client.dispose()
      client = null
    }
    // Reset all reactive state so the UI reflects the teardown.
    // Re-init via `initModel` will repopulate everything.
    viewA.value = null
    viewB.value = null
    nodes.value = []
    statsA.value = null
    statsB.value = null
    selectedNodeId.value = null
  }

  function setSharedNodePph(nodeId: string, newPph: number): void {
    // Update the reactive copy so the UI reflects the change…
    const sharedNode = nodes.value.find((x) => x.id === nodeId)
    if (sharedNode) sharedNode.pph = newPph
    // …then ship the update into the worker, which keeps its own
    // `workerNodes` list for per-tick spawn calculation.
    client?.setNodePph(nodeId, newPph)
  }

  function setSelectedNodeId(nodeId: string | null): void {
    selectedNodeId.value = nodeId
  }

  return {
    initModel,
    disposeClient,
    getClient,
    viewA,
    viewB,
    nodes,
    selectedNodeId,
    setSelectedNodeId,
    setSharedNodePph,
    statsA,
    statsB,
  }
})
