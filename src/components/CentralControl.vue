<script setup>
import { AccordionRoot } from 'reka-ui'
import { ref } from 'vue'

import { useSimulationStore } from '../stores/simulation'
import DescriptionControl from './DescriptionControl.vue'
import MapControl from './MapControl.vue'
import ModeControl from './ModeControl.vue'
import MovementControl from './MovementControl.vue'
import SpawnControl from './SpawnControl.vue'
import TechnicalControl from './TechnicalControl.vue'
import TimerWidget from './TimerWidget.vue'

const simStore = useSimulationStore()

// Shared accordion state - default to mode-settings
const accordionValue = ref('overview')
</script>

<template>
  <div
    id="controls-pane"
    class="flex h-full w-full flex-col items-stretch gap-1.5 overflow-x-hidden overflow-y-auto"
  >
    <TimerWidget :store="simStore" />

    <!-- Intro — always visible -->
    <div class="bg-dark w-full rounded-lg">
      <div class="bg-darker flex flex-col items-center rounded-lg p-2 text-sm">
        <div class="accordion-child">
          <div class="description-text">
            <p class="description-paragraph">
              Scenario A models the existing Plaza Tacubaya transit hub in Mexico City. Scenario B
              tests a redesign with more direct walking routes and places to stop away from the
              main pedestrian flow.
            </p>
            <p class="description-paragraph mb-0">
              Compare both panels under the same control settings. The model estimates how the
              redesign may affect walking, crowding, and exposure to mapped crime risk.
            </p>
          </div>
        </div>
      </div>
    </div>

    <AccordionRoot
      v-model="accordionValue"
      class="accordion-root"
      type="single"
      :collapsible="true"
    >
      <DescriptionControl />
      <ModeControl />
      <MovementControl />
      <SpawnControl />
      <TechnicalControl />
    </AccordionRoot>

    <MapControl class="mt-auto" />
  </div>
</template>

<style>
@reference "../assets/tailwind.css";

.btn {
  @apply text-light hover:text-lighter cursor-pointer transition-all duration-200;
}

.btn-icon {
  @apply flex items-center justify-center rounded-full;
}

.btn-icon svg {
  @apply h-8 w-8;
}

.btn-active {
  @apply text-darker bg-lighter;
}

.btn-disabled {
  @apply text-dark border-dark pointer-events-none;
}

.btn-round {
  border-radius: 9999px;
}

.separator {
  @apply border-dark my-2 w-full border-1;
}

.switch-root {
  @apply focus-within:border-accent data-[state=checked]:border-accent data-[state=checked]:bg-accent focus-within:shadow-accent border-grey/30 data-[state=unchecked]:border-grey data-[state=unchecked]:bg-grey relative mx-1 flex h-[20px] w-[32px] rounded-full border shadow-sm transition-[background] focus-within:shadow-[0_0_0_1px] focus-within:outline-none;
}

.switch-thumb {
  @apply bg-lighter my-auto flex h-3.5 w-3.5 translate-x-0.5 items-center justify-center rounded-full text-xs shadow-xl transition-transform will-change-transform data-[state=checked]:translate-x-full;
}

.accordion-root {
  @apply bg-dark w-full rounded-lg;
}

.accordion-item {
  @apply w-full rounded-lg;
}

.accordion-trigger {
  @apply text-lighter flex min-h-12 w-full items-center justify-between px-3 py-3 text-sm transition-colors duration-200;
}

.accordion-trigger-icon {
  @apply text-light group-hover:text-lighter h-6 w-6 rotate-0 transition-all duration-300 ease-[cubic-bezier(0.87,_0,_0.13,_1)] group-data-[state=open]:rotate-180;
}

.accordion-trigger-text {
  @apply text-lg leading-tight font-normal transition-colors duration-200;
}

.accordion-content {
  @apply bg-darker flex flex-col items-center justify-center overflow-hidden p-2 text-sm;
  transition: height 300ms cubic-bezier(0.87, 0, 0.13, 1);
}

.accordion-content[data-state='open'] {
  animation: slideDown 300ms cubic-bezier(0.87, 0, 0.13, 1);
}

.accordion-content[data-state='closed'] {
  animation: slideUp 300ms cubic-bezier(0.87, 0, 0.13, 1);
}

@keyframes slideDown {
  from {
    height: 0;
    opacity: 0;
  }
  to {
    height: var(--reka-accordion-content-height);
    opacity: 1;
  }
}

@keyframes slideUp {
  from {
    height: var(--reka-accordion-content-height);
    opacity: 1;
  }
  to {
    height: 0;
    opacity: 0;
  }
}

.accordion-child {
  @apply border-lighter flex min-h-12 w-full max-w-120 flex-col justify-evenly p-1 py-2;
}

.accordion-child-pairing {
  @apply flex min-h-8 w-full items-center justify-between py-1;
}

.accordion-child-left {
  @apply text-lighter;
}

.accordion-child-right {
  @apply text-lighter flex items-center justify-center;
}

.accordion-heading {
  @apply text-lighter font-medium;
  font-size: var(--font-h3);
}

.slider-thumb {
  @apply focus:shadow-accent shadow-accent bg-lighter hover:bg-lighter/90 block h-3 w-3 rounded-full shadow-sm focus:shadow-lg focus:outline-none;
}

.slider-track {
  @apply bg-light relative h-0.5 grow rounded-full;
}

.slider-range {
  @apply bg-accent absolute h-full rounded-full;
}

.slider-root {
  @apply relative my-2 flex h-3 w-full touch-none items-center justify-center select-none;
}

.stat-container {
  @apply my-2 flex flex-col justify-around p-1;
}

.stat-label {
  @apply mb-1 flex justify-center text-sm;
}

.stat-values {
  @apply my-1 flex min-h-8 items-center justify-center gap-16;
}

.stat-value {
  @apply flex flex-col items-center font-mono text-2xl;
}

.stat-value-small {
  @apply font-mono text-base;
}

.stat-label-top {
  @apply text-lighter my-2 text-center text-xs opacity-70;
}

.stat-values-side-by-side {
  @apply mx-auto flex w-full max-w-72 flex-1 items-center justify-around gap-4;
}

.stat-value-large {
  @apply text-lighter flex-1 text-center font-mono text-2xl font-semibold;
}

.description-text {
  @apply text-lighter w-full max-w-120 px-1 py-1 text-sm leading-relaxed font-light;
}

.description-intro {
  @apply mb-2 text-sm leading-relaxed opacity-80;
}

.description-heading {
  @apply mt-3 mb-2 font-semibold first:mt-0;
  font-size: var(--font-h3);
}

.description-paragraph {
  @apply mb-3 text-sm leading-relaxed;
}

.description-list {
  @apply mb-3 ml-4 list-disc space-y-1 text-sm;
}

.description-list li {
  @apply leading-relaxed;
}

.description-list strong {
  @apply font-medium;
}

/* Shared chart styles */
.chart-container {
  @apply mx-auto flex w-full max-w-72 gap-4;
}

.chart-wrapper {
  @apply w-full flex-1 overflow-hidden;
}

.chart-legend {
  @apply flex justify-center gap-4 pb-2 text-xs;
}

.chart-legend-item {
  @apply flex items-center gap-1;
}

.chart-legend-color {
  @apply h-3 w-3;
}

.chart-legend-label {
  @apply text-lighter;
}
</style>
