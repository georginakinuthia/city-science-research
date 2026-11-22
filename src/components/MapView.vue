<script setup>
import maplibregl from 'maplibre-gl'
import { defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'

import { ACCENT, EMBER, LIGHTER } from '../assets/palette'
import { addTacubayaMapLayers, createMapRenderer, createTacubayaBasemap } from '../sim/createMapRenderer'
import { useMapStore } from '../stores/map'
import { useModelsStore } from '../stores/models'
import { useScenariosStore } from '../stores/scenarios'
import { useSimulationStore } from '../stores/simulation'
import MapLegend from './MapLegend.vue'

const CentralControls = defineAsyncComponent(() => import('./CentralControl.vue'))
const mapStore = useMapStore()
const modelsStore = useModelsStore()
const scenariosStore = useScenariosStore()
const simStore = useSimulationStore()
const loadError = ref('')
const colors = { agent: LIGHTER, shopping: EMBER, waiting: ACCENT, highlight: ACCENT }
const panels = [
  { container: 'mapA', folder: 'scenarioA', map: null, renderer: null },
  { container: 'mapB', folder: 'scenarioB', map: null, renderer: null },
]
let disposed = false

function updateNodes(map) {
  const nodes = scenariosStore.nodesBuffered
  if (nodes) map.getSource('src-nodes-buffer')?.setData(nodes)
}

watch(() => modelsStore.selectedNodeId, () => {
  for (const { renderer } of panels) renderer?.draw()
})

onMounted(async () => {
  try {
    // The local basemap and site overlays have no dependency on simulation startup.
    for (const panel of panels) {
      const map = new maplibregl.Map({
        ...mapStore.baseConfig,
        container: panel.container,
        style: createTacubayaBasemap(panel.folder),
      })
      panel.map = map
      map.once('style.load', () => {
        addTacubayaMapLayers(map, panel.folder)
        updateNodes(map)
        panel.renderer?.draw()
      })
    }
    mapStore.setMapReferences(panels[0].map, panels[1].map)

    if (!scenariosStore.hasScenarios) await scenariosStore.loadScenarios()
    if (disposed) return
    const { scenarioA, scenarioB, sharedNodes, error } = scenariosStore
    if (!scenarioA || !scenarioB) throw new Error(error || 'Scenario data is unavailable.')
    for (const { map } of panels) updateNodes(map)

    const models = await modelsStore.initModel(scenarioA, scenarioB, sharedNodes)
    if (disposed) return

    for (const [index, panel] of panels.entries()) {
      const model = models[index]
      panel.renderer = createMapRenderer(panel.map, model, {
        selectedStartNodeIdx: () => model.nodeIdxFor(modelsStore.selectedNodeId),
        colors,
      })
      panel.renderer.draw()
    }
    modelsStore.getClient()?.onSnapshot((index) => {
      if (!simStore.isRunning) panels[index]?.renderer?.draw()
    })
    simStore.registerMasterControllers({
      viewA: panels[0].renderer,
      viewB: panels[1].renderer,
    })
    if (simStore.isRunning) simStore.start()
  } catch (error) {
    if (disposed) return
    loadError.value = 'The simulation could not start.'
    console.error('Tacubaya initialization failed:', error instanceof Error ? error.message : String(error), error)
  }
})

onUnmounted(() => {
  disposed = true
  simStore.destroy()
  for (const panel of panels) panel.map?.remove()
  mapStore.setMapReferences(null, null)
})
</script>

<template>
  <div class="page-grid bg-darkest">
    <div class="grid-sidebar">
      <p v-if="loadError" class="absolute left-3 top-3 z-20 rounded-md bg-dark px-3 py-2 text-sm text-lighter" role="alert">
        {{ loadError }}
      </p>
      <CentralControls />
    </div>
    <div id="mapA" class="map-container grid-map-a relative">
      <MapLegend />
    </div>
    <div id="mapB" class="map-container grid-map-b relative">
      <MapLegend />
    </div>
  </div>
</template>

<style scoped>
@reference "../assets/tailwind.css";

.page-grid {
  @apply relative h-full w-full gap-1.5 p-1.5;
  display: grid;
  grid-template-columns: min(33.33%, 34rem) 1fr 1fr;
  grid-template-rows: 1fr;
}

.map-container {
  @apply overflow-hidden rounded-lg;
}

.grid-map-a {
  min-height: 0;
}

.grid-map-b {
  min-height: 0;
}

.grid-sidebar {
  @apply flex h-full w-full items-stretch overflow-hidden;
  min-height: 0;
}
</style>
