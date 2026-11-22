<script setup>
import { ACCENT, EMBER, LIGHT } from '../assets/palette'
import { TACUBAYA_MAP_STYLE } from '../sim/createMapRenderer'

const { buildings, walkways, busStops, destinations, boundary } = TACUBAYA_MAP_STYLE

const pointItems = [
  { label: 'Bus stops', ...busStops },
  { label: 'Destinations', ...destinations },
]

const simulationItems = [
  { label: 'Stalls', color: EMBER },
  { label: 'Waiting', color: ACCENT },
  { label: 'Trees', color: LIGHT },
]
</script>

<template>
  <ul class="map-legend" aria-label="Map legend">
    <li class="legend-item">
      <span class="legend-swatch" :style="{ background: buildings.fill, borderColor: buildings.color }"></span>
      Buildings
    </li>
    <li class="legend-item">
      <span
        class="legend-line"
        :style="{ background: walkways.color, height: walkways.width + 'px', opacity: walkways.opacity }"
      ></span>
      Walkways
    </li>
    <li v-for="item in pointItems" :key="item.label" class="legend-item">
      <span class="legend-swatch legend-point" :style="{ borderColor: item.color }"></span>
      {{ item.label }}
    </li>
    <li class="legend-item">
      <span class="legend-dash" :style="{ borderColor: boundary.color, opacity: boundary.opacity }"></span>
      Study boundary
    </li>
    <li v-for="item in simulationItems" :key="item.label" class="legend-item">
      <span class="legend-swatch" :style="{ borderColor: item.color }"></span>
      {{ item.label }}
    </li>
    <li class="legend-item">
      <span
        class="legend-swatch legend-point"
        :style="{ background: `radial-gradient(circle, ${EMBER}, ${ACCENT})` }"
      ></span>
      Crowds
    </li>
  </ul>
</template>

<style scoped>
@reference "../assets/tailwind.css";

.map-legend {
  @apply pointer-events-none absolute bottom-3 left-3 right-10 z-10 flex w-fit
         flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-white/10
         bg-darkest/90 px-2.5 py-1.5 text-[11px] leading-tight text-lighter;
  max-width: calc(100% - 3.25rem);
}

.legend-item {
  @apply flex items-center gap-1 whitespace-nowrap;
}

.legend-swatch {
  @apply inline-block size-2 rounded-xs border;
}

.legend-point {
  @apply rounded-full;
}

.legend-line,
.legend-dash {
  @apply inline-block w-3;
}

.legend-dash {
  @apply border-t border-dashed;
}
</style>
