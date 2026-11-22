<script setup>
import {
  AnimalRabbit20Regular,
  AnimalTurtle20Regular,
  ArrowRepeatAll20Regular,
  ArrowReset24Regular,
  Play24Regular,
  Stop24Regular,
  Timer20Regular,
} from '@vicons/fluent'
import { SwitchRoot, SwitchThumb } from 'reka-ui'

import nfiLogoSrc from '../assets/00_Logo_White_Block.png'

const props = defineProps({
  store: {
    type: Object,
    required: true,
  },
})
</script>

<template>
  <div
    class="bg-dark text-lighter flex w-full flex-col items-center justify-around gap-6 rounded-lg px-3 py-8 text-xs"
  >
    <img :src="nfiLogoSrc" alt="NFI" class="w-16" />

    <!-- Controls row -->
    <div class="bg-darker flex items-stretch justify-evenly gap-8 rounded-lg px-6 py-3">
      <!-- Play controls -->
      <div class="flex items-center justify-center gap-2">
        <button v-if="!store.isRunning" class="btn btn-icon" aria-label="Play" @click="store.start()">
          <Play24Regular />
        </button>
        <button v-else class="btn btn-icon" aria-label="Stop" @click="store.stop()">
          <Stop24Regular />
        </button>
        <button class="btn btn-icon" aria-label="Reset" @click="store.reset()">
          <ArrowReset24Regular />
        </button>
      </div>

      <!-- Toggles -->
      <div class="flex flex-col items-center justify-evenly gap-3">
        <!-- Countdown / Indefinite Toggle -->
        <div class="flex items-center gap-2">
          <Timer20Regular
            class="h-5 w-5 transition-colors"
            :class="store.isIndefiniteMode ? 'text-light' : 'text-lighter'"
          />
          <SwitchRoot v-model="store.isIndefiniteMode" class="switch-root">
            <SwitchThumb class="switch-thumb" />
          </SwitchRoot>
          <ArrowRepeatAll20Regular
            class="h-5 w-5 transition-colors"
            :class="store.isIndefiniteMode ? 'text-accent' : 'text-light'"
          />
        </div>
        <!-- Speed/Framerate Toggle -->
        <div class="flex items-center gap-2">
          <AnimalTurtle20Regular
            class="h-6 w-6 transition-colors"
            :class="store.isFastMode ? 'text-light' : 'text-lighter'"
          />
          <SwitchRoot v-model="store.isFastMode" class="switch-root">
            <SwitchThumb class="switch-thumb" />
          </SwitchRoot>
          <AnimalRabbit20Regular
            class="h-6 w-6 transition-colors"
            :class="store.isFastMode ? 'text-accent' : 'text-light'"
          />
        </div>
      </div>
    </div>

    <!-- Timer -->
    <div class="text-center font-mono text-4xl font-light">{{ store.currentTime }}</div>
  </div>
</template>

<style scoped>
@reference "../assets/tailwind.css";
</style>
