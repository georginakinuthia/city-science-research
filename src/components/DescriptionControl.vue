<script setup>
import { ChevronCircleDown20Regular } from '@vicons/fluent'
import { AccordionContent, AccordionHeader, AccordionItem, AccordionTrigger } from 'reka-ui'
</script>

<template>
  <AccordionItem value="overview" class="accordion-item">
    <AccordionHeader class="border-grey/20 border-b">
      <AccordionTrigger class="accordion-trigger group">
        <span class="accordion-trigger-text">Overview</span>
        <ChevronCircleDown20Regular class="accordion-trigger-icon" />
      </AccordionTrigger>
    </AccordionHeader>
    <AccordionContent class="accordion-content">
      <div class="accordion-child">
        <div class="description-text">
          <h3 class="description-heading">Scenario B Design</h3>
          <p class="description-paragraph">
            Metro connections (01), the bus interchange (08), and shared access (07) link
            through routes. Linear and clustered markets (02, 10), planted seating (04),
            the canopy grove (05), and covered community space (06) provide places to stop.
            Sports and table games (03), children’s play (09), and the flexible social court
            (11) create activity pockets off the spine.
          </p>

          <h3 class="description-heading">Mode</h3>
          <p class="description-paragraph">
            Shopping and Resting control how often pedestrians stop. Scenario B gives them
            organized market bays and places to linger away from through traffic.
          </p>

          <h3 class="description-heading">Movement</h3>
          <p class="description-paragraph">
            Compare routes and walking speeds. Scenario B steers through trips along the
            shared-access spine, crossings, and links to Metro and buses.
          </p>

          <h3 class="description-heading">Spawn</h3>
          <p class="description-paragraph">
            Adjust pedestrian demand in people per hour at each listed entry point.
          </p>

          <h3 class="description-heading">Technical</h3>
          <p class="description-paragraph mb-0">
            See how agents choose routes, respond to crowding, avoid collisions, and
            register exposure to nearby crime or congestion.
          </p>
        </div>
      </div>
    </AccordionContent>
  </AccordionItem>
</template>
