<script setup>
import { ArrowReset20Regular,ChevronCircleDown20Regular } from '@vicons/fluent'
import { ArcElement, Chart, DoughnutController,Legend, Tooltip } from 'chart.js'
import { storeToRefs } from 'pinia'
import { AccordionContent, AccordionHeader, AccordionItem, AccordionTrigger } from 'reka-ui'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'
import { Separator } from 'reka-ui'
import { computed } from 'vue'
import { Doughnut } from 'vue-chartjs'

import { ACCENT, EMBER, LIGHT } from '../assets/palette'
import { useBehaviorStore } from '../stores/behavior'
import { useSimulationStore } from '../stores/simulation'

// Register Chart.js components
if (!Chart.registry?.elements?.arc) {
  Chart.register(ArcElement, Tooltip, Legend, DoughnutController)
}
const behaviorStore = useBehaviorStore()
const simStore = useSimulationStore()

// Use refs from the behavior store for reactive two-way binding
const { shoppingProbability, spareTimeProbability } =
  storeToRefs(behaviorStore)

const { globalTick } = storeToRefs(simStore)

// Convert to arrays for slider binding (sliders use array format)
const shoppingValue = computed({
  get: () => [shoppingProbability.value],
  set: (val) => {
    shoppingProbability.value = val[0]
  },
})

const spareTimeValue = computed({
  get: () => [spareTimeProbability.value],
  set: (val) => {
    spareTimeProbability.value = val[0]
  },
})

// 4 stops: 0, 0.333, 0.666, 1.0
function levelLabel(v) {
  if (v < 0.17) return 'None'
  if (v < 0.5) return 'Low'
  if (v < 0.83) return 'Medium'
  return 'High'
}

// Stats computed properties
const modelAStats = computed(() => {
  const tick = globalTick.value
  try {
    return simStore.modelAStats
      ? simStore.modelAStats()
      : {
          totalMinutesShopped: 0,
          totalMinutesWaited: 0,
          currentAgents: 0,
          currentShopping: 0,
          currentWaiting: 0,
        }
  } catch (e) {
    return {
      totalMinutesShopped: 0,
      totalMinutesWaited: 0,
      currentAgents: 0,
      currentShopping: 0,
      currentWaiting: 0,
    }
  }
})

const modelBStats = computed(() => {
  const tick = globalTick.value
  try {
    return simStore.modelBStats
      ? simStore.modelBStats()
      : {
          totalMinutesShopped: 0,
          totalMinutesWaited: 0,
          currentAgents: 0,
          currentShopping: 0,
          currentWaiting: 0,
        }
  } catch (e) {
    return {
      totalMinutesShopped: 0,
      totalMinutesWaited: 0,
      currentAgents: 0,
      currentShopping: 0,
      currentWaiting: 0,
    }
  }
})

// Colors matching MapView.vue — drawn from the official NFI palette.
const shoppingColor = EMBER
const waitingColor = ACCENT
const normalColor = LIGHT

// Compute chart data for each scenario
const chartAData = computed(() => {
  const stats = modelAStats.value
  const totalAgents = stats.currentAgents || 0
  const shopping = stats.currentShopping || 0
  const waiting = stats.currentWaiting || 0
  const normal = Math.max(0, totalAgents - shopping - waiting)

  // Calculate proportions (as percentages)
  const shoppingPct = totalAgents > 0 ? (shopping / totalAgents) * 100 : 0
  const waitingPct = totalAgents > 0 ? (waiting / totalAgents) * 100 : 0
  const normalPct = totalAgents > 0 ? (normal / totalAgents) * 100 : 100

  return {
    labels: ['Shopping', 'Waiting', 'Normal'],
    datasets: [
      {
        data: [shoppingPct, waitingPct, normalPct],
        backgroundColor: [shoppingColor, waitingColor, normalColor],
        borderWidth: 0,
      },
    ],
  }
})

const chartBData = computed(() => {
  const stats = modelBStats.value
  const totalAgents = stats.currentAgents || 0
  const shopping = stats.currentShopping || 0
  const waiting = stats.currentWaiting || 0
  const normal = Math.max(0, totalAgents - shopping - waiting)

  // Calculate proportions (as percentages)
  const shoppingPct = totalAgents > 0 ? (shopping / totalAgents) * 100 : 0
  const waitingPct = totalAgents > 0 ? (waiting / totalAgents) * 100 : 0
  const normalPct = totalAgents > 0 ? (normal / totalAgents) * 100 : 100

  return {
    labels: ['Shopping', 'Waiting', 'Normal'],
    datasets: [
      {
        data: [shoppingPct, waitingPct, normalPct],
        backgroundColor: [shoppingColor, waitingColor, normalColor],
        borderWidth: 0,
      },
    ],
  }
})

// Chart configuration
const chartOptions = {
  responsive: true,
  maintainAspectRatio: true,
  aspectRatio: 1,
  cutout: '80%', // Creates the donut hole
  animation: false,
  layout: {
    padding: {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    },
  },
  plugins: {
    legend: {
      display: false,
    },
    tooltip: {
      callbacks: {
        label: function (context) {
          const label = context.label || ''
          const value = context.parsed || 0
          return `${label}: ${value.toFixed(0)}`
        },
      },
    },
  },
}
</script>

<template>
  <AccordionItem value="mode-settings" class="accordion-item">
    <AccordionHeader class="border-grey/20 border-b">
      <AccordionTrigger class="accordion-trigger group">
        <span class="accordion-trigger-text">Mode</span>
        <ChevronCircleDown20Regular class="accordion-trigger-icon" />
      </AccordionTrigger>
    </AccordionHeader>
    <AccordionContent class="accordion-content">
      <div class="accordion-child">
        <div class="accordion-child-pairing">
          <div class="accordion-child-left accordion-heading">Stop Frequency</div>
          <button
            class="accordion-child-right btn"
            title="Reset to defaults"
            @click="behaviorStore.resetParams()"
          >
            <ArrowReset20Regular class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- Shopping Slider -->
      <div class="accordion-child">
        <div class="accordion-child-pairing">
          <label class="accordion-child-left">Shopping</label>
          <div class="accordion-child-right">{{ levelLabel(shoppingProbability) }}</div>
        </div>
        <SliderRoot
          v-model="shoppingValue"
          :min="0"
          :max="1"
          :step="0.333"
          class="slider-root"
        >
          <SliderTrack class="slider-track">
            <SliderRange class="slider-range" />
          </SliderTrack>
          <SliderThumb class="slider-thumb" aria-label="Shopping" />
        </SliderRoot>
      </div>

      <!-- Resting Slider -->
      <div class="accordion-child">
        <div class="accordion-child-pairing">
          <label class="accordion-child-left">Resting</label>
          <div class="accordion-child-right">{{ levelLabel(spareTimeProbability) }}</div>
        </div>
        <SliderRoot
          v-model="spareTimeValue"
          :min="0"
          :max="1"
          :step="0.333"
          class="slider-root"
        >
          <SliderTrack class="slider-track">
            <SliderRange class="slider-range" />
          </SliderTrack>
          <SliderThumb class="slider-thumb" aria-label="Resting" />
        </SliderRoot>
      </div>

      <div class="accordion-child description-text">
        <p class="description-intro">
          Shopping adjusts the chance of stopping at stalls, including Scenario B’s organized bays.
          Resting adjusts the chance of pausing at seating and other waiting spaces.
          Crowding makes either stop less likely.
        </p>
      </div>

      <Separator class="separator" />

      <!-- Stats -->
      <div class="accordion-child">
        <div class="stat-label-top">Total Shopping Minutes</div>
        <div class="stat-values-side-by-side">
          <div class="stat-value-large">{{ modelAStats.totalMinutesShopped.toFixed(0) }}</div>
          <div class="stat-value-large">{{ modelBStats.totalMinutesShopped.toFixed(0) }}</div>
        </div>
        <div class="stat-label-top">Total Resting Minutes</div>
        <div class="stat-values-side-by-side">
          <div class="stat-value-large">{{ modelAStats.totalMinutesWaited.toFixed(0) }}</div>
          <div class="stat-value-large">{{ modelBStats.totalMinutesWaited.toFixed(0) }}</div>
        </div>
      </div>

      <!-- Mode Distribution Charts -->
      <div class="accordion-child" style="padding: 0">
        <div class="stat-label-top">Activity Distribution</div>
        <div class="chart-container px-8 py-2">
          <div class="chart-wrapper">
            <Doughnut :data="chartAData" :options="chartOptions" />
          </div>
          <div class="chart-wrapper">
            <Doughnut :data="chartBData" :options="chartOptions" />
          </div>
        </div>

        <!-- Shared Legend -->
        <div class="chart-legend gap-8">
          <div class="chart-legend-item gap-2">
            <div class="chart-legend-color" :style="{ backgroundColor: normalColor }"></div>
            <span class="chart-legend-label">Walking</span>
          </div>
          <div class="chart-legend-item gap-2">
            <div class="chart-legend-color" :style="{ backgroundColor: shoppingColor }"></div>
            <span class="chart-legend-label">Shopping</span>
          </div>
          <div class="chart-legend-item gap-2">
            <div class="chart-legend-color" :style="{ backgroundColor: waitingColor }"></div>
            <span class="chart-legend-label">Waiting</span>
          </div>
        </div>
      </div>
    </AccordionContent>
  </AccordionItem>
</template>

<style scoped>
@reference "../assets/tailwind.css";
</style>
