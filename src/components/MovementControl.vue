<script setup>
import {
  ArrowReset20Regular,
  ChevronCircleDown20Regular,
  WeatherCloudy20Regular,
  WeatherSunny20Regular,
} from '@vicons/fluent'
import { ArcElement, Chart, DoughnutController,Legend, Tooltip } from 'chart.js'
import { storeToRefs } from 'pinia'
import { AccordionContent, AccordionHeader, AccordionItem, AccordionTrigger } from 'reka-ui'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'
import { SwitchRoot, SwitchThumb } from 'reka-ui'
import { Separator } from 'reka-ui'
import { computed } from 'vue'
import { Doughnut } from 'vue-chartjs'

import {
  ACCENT,
  FOREST,
  PROXEMIC_INTIMATE,
  PROXEMIC_PERSONAL,
} from '../assets/palette'
import { useBehaviorStore } from '../stores/behavior'
import { useSimulationStore } from '../stores/simulation'

if (!Chart.registry?.elements?.arc) {
  Chart.register(ArcElement, Tooltip, Legend, DoughnutController)
}

const behaviorStore = useBehaviorStore()
const simStore = useSimulationStore()

// Use refs from the behavior store for reactive two-way binding
const {
  isSunny,
  behaviorDiversity,
  personalSpace,
  speedBase,
} = storeToRefs(behaviorStore)

const { globalTick } = storeToRefs(simStore)

// Convert to arrays for slider binding (sliders use array format)
const behaviorDiversityValue = computed({
  get: () => [behaviorDiversity.value],
  set: (val) => {
    behaviorDiversity.value = val[0]
  },
})

const personalSpaceValue = computed({
  get: () => [personalSpace.value],
  set: (val) => {
    personalSpace.value = val[0]
  },
})

const speedBaseValue = computed({
  get: () => [speedBase.value],
  set: (val) => {
    speedBase.value = val[0]
  },
})

// Stats computed properties
const modelAStats = computed(() => {
  // Track globalTick to ensure reactivity on every tick and after reset
  globalTick.value
  try {
    return simStore.modelAStats
      ? simStore.modelAStats()
      : {
          totalArrivals: 0,
          totalNormalDistanceTraveled: 0,
          totalNormalTime: 0,
          totalPublicZoneSteps: 0,
          totalSocialZoneSteps: 0,
          totalPersonalZoneSteps: 0,
          totalIntimateZoneSteps: 0,
        }
  } catch (e) {
    return {
      totalArrivals: 0,
      totalNormalDistanceTraveled: 0,
      totalNormalTime: 0,
      totalPublicZoneSteps: 0,
      totalSocialZoneSteps: 0,
      totalPersonalZoneSteps: 0,
      totalIntimateZoneSteps: 0,
    }
  }
})

const modelBStats = computed(() => {
  // Track globalTick to ensure reactivity on every tick and after reset
  globalTick.value
  try {
    return simStore.modelBStats
      ? simStore.modelBStats()
      : {
          totalArrivals: 0,
          totalNormalDistanceTraveled: 0,
          totalNormalTime: 0,
          totalPublicZoneSteps: 0,
          totalSocialZoneSteps: 0,
          totalPersonalZoneSteps: 0,
          totalIntimateZoneSteps: 0,
        }
  } catch (e) {
    return {
      totalArrivals: 0,
      totalNormalDistanceTraveled: 0,
      totalNormalTime: 0,
      totalPublicZoneSteps: 0,
      totalSocialZoneSteps: 0,
      totalPersonalZoneSteps: 0,
      totalIntimateZoneSteps: 0,
    }
  }
})

// Calculate average speed in m/s (total distance / total time for normal agents)
const avgSpeedA = computed(() => {
  if (modelAStats.value.totalNormalTime === 0) {
    return 0
  }
  return modelAStats.value.totalNormalDistanceTraveled / modelAStats.value.totalNormalTime
})

const avgSpeedB = computed(() => {
  if (modelBStats.value.totalNormalTime === 0) {
    return 0
  }
  return modelBStats.value.totalNormalDistanceTraveled / modelBStats.value.totalNormalTime
})

// Proxemic zone colors — Hall (1966). Public/social map to the brand
// forest and accent tokens; personal/intimate use sanctioned domain
// extensions (no brand-palette equivalent for amber/alert-red).
const zoneColors = {
  public: FOREST,
  social: ACCENT,
  personal: PROXEMIC_PERSONAL,
  intimate: PROXEMIC_INTIMATE,
}

function buildProxemicChartData(stats) {
  const pub = stats.totalPublicZoneSteps || 0
  const social = stats.totalSocialZoneSteps || 0
  const personal = stats.totalPersonalZoneSteps || 0
  const intimate = stats.totalIntimateZoneSteps || 0
  const total = pub + social + personal + intimate

  if (total === 0) {
    return {
      labels: ['Public', 'Social', 'Personal', 'Intimate'],
      datasets: [
        {
          data: [100, 0, 0, 0],
          backgroundColor: [
            zoneColors.public,
            zoneColors.social,
            zoneColors.personal,
            zoneColors.intimate,
          ],
          borderWidth: 0,
        },
      ],
    }
  }

  const toPct = (value) => (value / total) * 100

  return {
    labels: ['Public', 'Social', 'Personal', 'Intimate'],
    datasets: [
      {
        data: [toPct(pub), toPct(social), toPct(personal), toPct(intimate)],
        backgroundColor: [
          zoneColors.public,
          zoneColors.social,
          zoneColors.personal,
          zoneColors.intimate,
        ],
        borderWidth: 0,
      },
    ],
  }
}

const proxemicChartOptions = {
  responsive: true,
  maintainAspectRatio: true,
  aspectRatio: 1,
  cutout: '80%',
  animation: false,
  layout: {
    padding: { top: 0, bottom: 0, left: 0, right: 0 },
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        label(context) {
          const label = context.label || ''
          const value = context.parsed || 0
          return `${label} zone: ${value.toFixed(1)}%`
        },
      },
    },
  },
}

const proxemicChartAData = computed(() => buildProxemicChartData(modelAStats.value))
const proxemicChartBData = computed(() => buildProxemicChartData(modelBStats.value))

function publicLabel(stats) {
  const pub = stats.totalPublicZoneSteps || 0
  const social = stats.totalSocialZoneSteps || 0
  const personal = stats.totalPersonalZoneSteps || 0
  const intimate = stats.totalIntimateZoneSteps || 0
  const total = pub + social + personal + intimate

  if (total === 0) {
    return '100%'
  }

  const pct = Math.round((pub / total) * 100)
  return `${pct}%`
}

const publicLabelA = computed(() => publicLabel(modelAStats.value))
const publicLabelB = computed(() => publicLabel(modelBStats.value))
</script>

<template>
  <AccordionItem value="movement-settings" class="accordion-item">
    <AccordionHeader class="border-grey/20 border-b">
      <AccordionTrigger class="accordion-trigger group">
        <span class="accordion-trigger-text">Movement</span>
        <ChevronCircleDown20Regular class="accordion-trigger-icon" />
      </AccordionTrigger>
    </AccordionHeader>
    <AccordionContent class="accordion-content">
      <!-- Weather Switch -->
      <div class="accordion-child">
        <div class="accordion-child-pairing">
          <label for="weather" class="accordion-child-left accordion-heading"> Weather </label>
          <div class="accordion-child-right">
            <WeatherCloudy20Regular
              class="h-4 w-4 transition-colors"
              :class="isSunny ? 'text-light' : 'text-lighter'"
            />
            <SwitchRoot id="weather" v-model="isSunny" class="switch-root">
              <SwitchThumb class="switch-thumb" />
            </SwitchRoot>
            <WeatherSunny20Regular
              class="h-4 w-4 transition-colors"
              :class="isSunny ? 'text-accent' : 'text-light'"
            />
          </div>
        </div>
        <div class="description-text">
          <p class="description-intro">
            In sunny conditions, agents prefer shaded routes, biasing path choice toward
            tree canopy and covered areas. The weighting is suppressed in crowded areas so
            that collision avoidance takes priority over thermal comfort.
          </p>
        </div>
      </div>

      <Separator class="separator" />

      <div class="accordion-child">
        <div class="accordion-child-pairing">
          <div class="accordion-child-left accordion-heading">Parameters</div>
          <button
            class="accordion-child-right btn"
            title="Reset to defaults"
            @click="behaviorStore.resetParams()"
          >
            <ArrowReset20Regular class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- Path Randomness Slider -->
      <div class="accordion-child">
        <div class="accordion-child-pairing">
          <label for="behavior-diversity" class="accordion-child-left">Path Randomness</label>
          <div class="accordion-child-right">{{ (behaviorDiversity * 100).toFixed(0) }}%</div>
        </div>
        <SliderRoot
          v-model="behaviorDiversityValue"
          :min="0.0"
          :max="1.0"
          :step="0.05"
          class="slider-root"
        >
          <SliderTrack class="slider-track">
            <SliderRange class="slider-range" />
          </SliderTrack>
          <SliderThumb class="slider-thumb" aria-label="Path Randomness" />
        </SliderRoot>
        <div class="description-text">
          <p class="description-intro">
            Adjusts how much route-choice preferences vary among pedestrians. Scenario B’s
            shared-access alignment continues to guide through trips at every setting.
          </p>
        </div>
      </div>

      <!-- Personal Space Slider -->
      <div class="accordion-child">
        <div class="accordion-child-pairing">
          <label for="personal-space" class="accordion-child-left">Personal Space</label>
          <div class="accordion-child-right">{{ personalSpace.toFixed(2) }}m</div>
        </div>
        <SliderRoot
          v-model="personalSpaceValue"
          :min="0.45"
          :max="1.5"
          :step="0.05"
          class="slider-root"
        >
          <SliderTrack class="slider-track">
            <SliderRange class="slider-range" />
          </SliderTrack>
          <SliderThumb class="slider-thumb" aria-label="Personal Space" />
        </SliderRoot>
        <div class="description-text">
          <p class="description-intro">
            Preferred separation between pedestrians, in metres. The collision-avoidance
            model uses this setting when agents pass each other in open and crowded areas.
          </p>
        </div>
      </div>

      <!-- Walking Speed Slider -->
      <div class="accordion-child">
        <div class="accordion-child-pairing">
          <label for="speed-base" class="accordion-child-left">Walking Speed</label>
          <div class="accordion-child-right">{{ speedBase.toFixed(2) }}m/s</div>
        </div>
        <SliderRoot
          v-model="speedBaseValue"
          :min="0.8"
          :max="2.0"
          :step="0.05"
          class="slider-root"
        >
          <SliderTrack class="slider-track">
            <SliderRange class="slider-range" />
          </SliderTrack>
          <SliderThumb class="slider-thumb" aria-label="Walking Speed" />
        </SliderRoot>
        <div class="description-text">
          <p class="description-intro">
            Baseline free-flow pace before crowding and crossing effects. Scenario B applies
            a calmer walking pace while retaining its corridor guidance.
          </p>
        </div>
      </div>

      <Separator class="separator" />

      <!-- Stats -->
      <div class="accordion-child">
        <div class="stat-label-top">Arrivals</div>
        <div class="stat-values-side-by-side">
          <div class="stat-value-large">{{ modelAStats.totalArrivals }}</div>
          <div class="stat-value-large">{{ modelBStats.totalArrivals }}</div>
        </div>
      </div>

      <div class="accordion-child">
        <div class="stat-label-top">Avg. Speed</div>
        <div class="stat-values-side-by-side">
          <div class="stat-value-large">{{ avgSpeedA.toFixed(2) }}m/s</div>
          <div class="stat-value-large">{{ avgSpeedB.toFixed(2) }}m/s</div>
        </div>
      </div>

      <div class="accordion-child" style="padding: 0">
        <div class="stat-label-top">Ease Of Movement</div>
        <div class="description-text" style="padding: 0 1rem">
          <p class="description-intro">
            Proxemic zones after Hall (1966). The centre percentage reports the share of
            agent-steps spent in the public zone (no crowding).
          </p>
        </div>
        <div class="chart-container px-8 py-2">
          <div class="chart-wrapper">
            <Doughnut :data="proxemicChartAData" :options="proxemicChartOptions" />
            <div class="chart-center-label">{{ publicLabelA }}</div>
          </div>
          <div class="chart-wrapper">
            <Doughnut :data="proxemicChartBData" :options="proxemicChartOptions" />
            <div class="chart-center-label">{{ publicLabelB }}</div>
          </div>
        </div>

        <div class="chart-legend gap-6">
          <div class="chart-legend-item gap-2">
            <div
              class="chart-legend-color"
              :style="{ backgroundColor: zoneColors.social }"
            ></div>
            <span class="chart-legend-label">Social</span>
          </div>
          <div class="chart-legend-item gap-2">
            <div
              class="chart-legend-color"
              :style="{ backgroundColor: zoneColors.personal }"
            ></div>
            <span class="chart-legend-label">Personal</span>
          </div>
          <div class="chart-legend-item gap-2">
            <div
              class="chart-legend-color"
              :style="{ backgroundColor: zoneColors.intimate }"
            ></div>
            <span class="chart-legend-label">Intimate</span>
          </div>
        </div>
      </div>
    </AccordionContent>
  </AccordionItem>
</template>

<style scoped>
@reference "../assets/tailwind.css";

.chart-wrapper {
  position: relative;
}

.chart-center-label {
  @apply text-lighter pointer-events-none absolute text-center text-lg font-semibold;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
</style>
