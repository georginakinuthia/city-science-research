<script setup>
import { ArrowReset20Regular,ChevronCircleDown20Regular } from '@vicons/fluent'
import { storeToRefs } from 'pinia'
import { AccordionContent, AccordionHeader, AccordionItem, AccordionTrigger } from 'reka-ui'

import { useModelsStore } from '../stores/models'
import NumberField from './NumberField.vue'

const models = useModelsStore()
const { selectedNodeId } = storeToRefs(models)

function onSharedPphChange(nodeId, raw) {
  const val = Number(raw)
  if (Number.isNaN(val)) return
  models.setSharedNodePph(nodeId, val)
}

function toggleNodeSelection(nodeId) {
  if (selectedNodeId.value === nodeId) {
    models.setSelectedNodeId(null)
  } else {
    models.setSelectedNodeId(nodeId)
  }
}

function resetSelectedNode() {
  models.setSelectedNodeId(null)
}
</script>

<template>
  <AccordionItem v-if="models.nodes.length > 0" value="spawn-settings" class="accordion-item">
    <AccordionHeader class="border-grey/20 border-b">
      <AccordionTrigger class="accordion-trigger group">
        <span class="accordion-trigger-text">Spawn</span>
        <ChevronCircleDown20Regular class="accordion-trigger-icon" />
      </AccordionTrigger>
    </AccordionHeader>
    <AccordionContent class="accordion-content">
      <!-- Introduction -->
      <div class="accordion-child">
        <div class="description-text">
          <p class="description-intro">
            Set the arrival rate in people per hour for each listed entry point. The controls
            apply to both maps, while each scenario uses its own walkable network to route
            trips. Select an entry point to highlight its agents on both maps.
          </p>
        </div>
      </div>

      <div class="accordion-child">
        <div class="accordion-child-pairing">
          <div class="accordion-child-left accordion-heading">Persons Per Hour</div>
          <button
            class="accordion-child-right btn"
            title="Reset to defaults"
            @click="resetSelectedNode"
          >
            <ArrowReset20Regular class="h-4 w-4" />
          </button>
        </div>
      </div>
      <div class="accordion-child node-list">
        <div
          v-for="node in models.nodes"
          :key="node.id"
          class="accordion-child-pairing node-row"
          :class="{ 'node-selected': selectedNodeId === node.id }"
          @click="toggleNodeSelection(node.id)"
        >
          <div class="accordion-child-left node-label text-xs font-light">
            {{ node.label || node.id }}
          </div>
          <NumberField
            :model-value="node.pph"
            class="accordion-child-right"
            @update:model-value="(val) => onSharedPphChange(node.id, val)"
            @click.stop
          />
        </div>
      </div>
    </AccordionContent>
  </AccordionItem>
</template>

<style scoped>
@reference "../assets/tailwind.css";

.node-list {
  @apply max-w-88;
}

.node-row {
  cursor: pointer;
  transition: background-color 0.2s;
  @apply p-0.5;
}

.node-row:hover {
  @apply bg-grey;
}

.node-selected {
  @apply bg-grey;
}

.node-selected:hover {
  @apply text-lighter;
}

.node-selected .node-label {
  @apply text-lighter font-semibold;
}
</style>
