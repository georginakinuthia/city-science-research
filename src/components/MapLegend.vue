<script setup>
import { TACUBAYA_LEGEND } from '../config'
import { useMapStore } from '../stores/map'

const mapStore = useMapStore()
</script>

<template>
  <ul class="map-legend" aria-label="Map legend">
    <li v-for="item in TACUBAYA_LEGEND" :key="item.id">
      <button type="button" class="legend-item" :aria-pressed="mapStore.layerVisibility[item.id]"
        @click="mapStore.toggleLayer(item.id)">
        <span class="legend-swatch" aria-hidden="true" :style="{ borderColor: item.color }"></span>
        {{ item.label }}
      </button>
    </li>
  </ul>
</template>

<style scoped>
@reference "../assets/tailwind.css";

.map-legend {
  @apply absolute bottom-3 left-3 right-10 z-10 flex w-fit
         flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-white/10
         bg-darkest/90 px-2.5 py-1.5 text-[11px] leading-tight text-lighter;
  max-width: calc(100% - 3.25rem);
}

.legend-item {
  @apply flex cursor-pointer items-center gap-1 whitespace-nowrap;
}

.legend-item[aria-pressed='false'] {
  @apply opacity-50 line-through;
}

.legend-swatch {
  @apply inline-block size-2 rounded-xs border;
}
</style>
