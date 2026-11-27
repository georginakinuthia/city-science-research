import { defineStore } from 'pinia'
import { computed, reactive, ref, shallowRef } from 'vue'

import { TACUBAYA_CAMERA, type TacubayaLegendLayer } from '../config'

const legendLayers: Record<TacubayaLegendLayer, string[]> = {
  stalls: ['stalls', 'stalls-fill', 'stalls-points', 'stalls-extrusion'],
  pedestrian_infrastructure: ['pedestrian-infrastructure-fill', 'src-walkway2-line'],
  crime: ['crime-halo'],
  trees: ['src-trees-points'],
  buses: ['bus-markers'],
}

export interface MapBounds {
  southwest: [number, number]
  northeast: [number, number]
}

export interface MapState {
  center: [number, number]
  zoom: number
  bearing: number
  pitch: number
  bounds?: MapBounds
}

export const useMapStore = defineStore('map', () => {
  // State
  const center = ref([...TACUBAYA_CAMERA.center] as [number, number])
  const zoom = ref(TACUBAYA_CAMERA.zoom)
  const bearing = ref(TACUBAYA_CAMERA.bearing)
  const pitch = ref(TACUBAYA_CAMERA.pitch)
  const zoomMin = ref(14)
  const zoomMax = ref(20)
  const mapA = shallowRef<any>(null)
  const mapB = shallowRef<any>(null)

  const hasMapA = computed(() => !!mapA.value)
  const hasMapB = computed(() => !!mapB.value)
  const hasBothMaps = computed(() => !!mapA.value && !!mapB.value)

  const layerVisibility = reactive<Record<TacubayaLegendLayer, boolean>>({
    stalls: true, pedestrian_infrastructure: true, crime: true, trees: true, buses: true,
  })

  function applyLayerVisibility(map: any) {
    for (const key of Object.keys(legendLayers) as TacubayaLegendLayer[]) {
      for (const id of legendLayers[key]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', layerVisibility[key] ? 'visible' : 'none')
      }
    }
  }

  function toggleLayer(layer: TacubayaLegendLayer) {
    layerVisibility[layer] = !layerVisibility[layer]
    if (mapA.value) applyLayerVisibility(mapA.value)
    if (mapB.value) applyLayerVisibility(mapB.value)
  }

  // Getters
  const mapState = computed(
    (): MapState => ({
      center: center.value,
      zoom: zoom.value,
      bearing: bearing.value,
      pitch: pitch.value,
    }),
  )

  const baseConfig = computed(() => ({
    center: center.value,
    zoom: zoom.value,
    bearing: bearing.value,
    pitch: pitch.value,
    interactive: true,
    minZoom: zoomMin.value,
    maxZoom: zoomMax.value,
    maxPitch: TACUBAYA_CAMERA.maxPitch,
  }))

  // Actions
  function updateMapState(newState: Partial<MapState>) {
    if (newState.center) center.value = newState.center
    if (newState.zoom !== undefined) zoom.value = newState.zoom
    if (newState.bearing !== undefined) bearing.value = newState.bearing
    if (newState.pitch !== undefined) pitch.value = newState.pitch
  }

  // Guard to prevent infinite sync loops
  let syncing = false

  function setupSync(source: any, target: any) {
    source.on('move', () => {
      if (syncing) return
      syncing = true
      try {
        const position = source.getCenter()
        const camera = {
          center: [position.lng, position.lat] as [number, number],
          zoom: source.getZoom(), bearing: source.getBearing(), pitch: source.getPitch(),
        }
        updateMapState(camera)
        target.jumpTo(camera)
      } finally {
        syncing = false
      }
    })
  }

  function setMapReferences(mapARef: any, mapBRef: any) {
    mapA.value = mapARef
    mapB.value = mapBRef
    // Set up bidirectional sync
    if (mapARef && mapBRef) {
      setupSync(mapARef, mapBRef)
      setupSync(mapBRef, mapARef)
    }
  }

  function setCenter(newCenter: [number, number]) {
    center.value = newCenter
    if (mapA.value) {
      mapA.value.setCenter(newCenter)
    } else if (mapB.value) {
      mapB.value.setCenter(newCenter)
    }
  }

  function setZoom(newZoom: number) {
    zoom.value = newZoom
    if (mapA.value) {
      mapA.value.setZoom(newZoom, { duration: 250 })
    } else if (mapB.value) {
      mapB.value.setZoom(newZoom, { duration: 250 })
    }
  }

  // Programmatic zoom by delta (positive to zoom in, negative to zoom out)
  function zoomBy(delta: number) {
    setZoom(Math.max(16, Math.min(20, zoom.value + delta)))
  }

  function setBearing(newBearing: number) {
    bearing.value = newBearing
    if (mapA.value) {
      mapA.value.setBearing(newBearing)
    } else if (mapB.value) {
      mapB.value.setBearing(newBearing)
    }
  }

  function setPitch(newPitch: number) {
    pitch.value = newPitch
    if (mapA.value) {
      mapA.value.setPitch(newPitch)
    } else if (mapB.value) {
      mapB.value.setPitch(newPitch)
    }
  }

  // Pan by pixel offset (applies to both maps)
  function panBy(offset: [number, number]) {
    const map = mapA.value ?? mapB.value
    map?.panBy(offset, { duration: 250 })
  }

  function fitToBounds(bounds: [[number, number], [number, number]], padding = 50) {
    if (mapA.value) {
      mapA.value.fitBounds(bounds, { padding })
    } else if (mapB.value) {
      mapB.value.fitBounds(bounds, { padding })
    }
  }

  // Sync view from mapA to mapB (copies center, zoom, bearing, pitch)
  function syncView(direction: 'AtoB' | 'BtoA' = 'AtoB', duration = 250) {
    try {
      if (direction === 'AtoB') {
        if (!mapA.value || !mapB.value) return
        const center = mapA.value.getCenter()
        const zoomVal = mapA.value.getZoom()
        const bearingVal = mapA.value.getBearing ? mapA.value.getBearing() : bearing.value
        const pitchVal = mapA.value.getPitch ? mapA.value.getPitch() : pitch.value

        const centerArray: [number, number] = [center.lng || center[0], center.lat || center[1]]

        console.info('Syncing A→B:', {
          center: centerArray,
          zoom: zoomVal,
          bearing: bearingVal,
          pitch: pitchVal,
          duration,
        })

        mapB.value.setCenter(centerArray)
        mapB.value.setZoom(zoomVal, { duration })
        if (typeof mapB.value.setBearing === 'function') mapB.value.setBearing(bearingVal)
        if (typeof mapB.value.setPitch === 'function') mapB.value.setPitch(pitchVal)
      } else {
        if (!mapA.value || !mapB.value) return
        const center = mapB.value.getCenter()
        const zoomVal = mapB.value.getZoom()
        const bearingVal = mapB.value.getBearing ? mapB.value.getBearing() : bearing.value
        const pitchVal = mapB.value.getPitch ? mapB.value.getPitch() : pitch.value

        const centerArray: [number, number] = [center.lng || center[0], center.lat || center[1]]

        console.info('Syncing B→A:', {
          center: centerArray,
          zoom: zoomVal,
          bearing: bearingVal,
          pitch: pitchVal,
          duration,
        })

        mapA.value.setCenter(centerArray)
        mapA.value.setZoom(zoomVal, { duration })
        if (typeof mapA.value.setBearing === 'function') mapA.value.setBearing(bearingVal)
        if (typeof mapA.value.setPitch === 'function') mapA.value.setPitch(pitchVal)
      }
    } catch (e) {
      console.warn('syncView failed', e)
    }
  }

  return {
    // State
    center: computed(() => center.value),
    zoom: computed(() => zoom.value),
    bearing: computed(() => bearing.value),
    pitch: computed(() => pitch.value),
    // interactive removed — maps are non-interactive by default in this UI

    // Getters
    mapState,
    baseConfig,

    // Actions
    updateMapState,
    setMapReferences,
    layerVisibility,
    applyLayerVisibility,
    toggleLayer,
    setCenter,
    setZoom,
    zoomBy,
    setBearing,
    setPitch,
    panBy,
    fitToBounds,
    syncView,
    zoomMin,
    zoomMax,
    hasMapA: computed(() => hasMapA.value),
    hasMapB: computed(() => hasMapB.value),
    hasBothMaps: computed(() => hasBothMaps.value),
  }
})
