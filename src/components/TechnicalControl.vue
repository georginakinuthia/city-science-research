<script setup>
import { BoxToolbox20Regular,ChevronCircleDown20Regular } from '@vicons/fluent'
import { AccordionContent, AccordionHeader, AccordionItem, AccordionTrigger } from 'reka-ui'
import { inject } from 'vue'

const appMode = inject('appMode')
</script>

<template>
  <AccordionItem value="technical" class="accordion-item">
    <AccordionHeader class="border-grey/20 border-b">
      <AccordionTrigger class="accordion-trigger group">
        <span class="accordion-trigger-text">Technical</span>
        <ChevronCircleDown20Regular class="accordion-trigger-icon" />
      </AccordionTrigger>
    </AccordionHeader>
    <AccordionContent class="accordion-content">
      <div class="accordion-child">
        <div class="description-text">
          <button class="sandbox-link" @click="appMode = 'sandbox'">
            <BoxToolbox20Regular class="sandbox-link-icon" />
            <span>Open Sandbox</span>
          </button>

          <h3 class="description-heading">How Agents Navigate</h3>
          <p class="description-paragraph">
            Each agent navigates using a <strong>discrete-choice model</strong> in the
            tradition of Antonini, Bierlaire and Weber (2006). At every simulation step,
            an agent evaluates a set of candidate neighbouring directions and selects among
            them under a multinomial logit (MNL) specification. The utility of each
            direction combines progress toward the destination, heading alignment, local
            crowd density (weighted by relative motion, so that oncoming agents contribute
            more than co-directional ones), obstacle proximity, and&mdash;under sunny
            conditions&mdash;shade availability
            <span class="description-cite">(Antonini et al., 2006)</span>.
            The shade term is suppressed in crowded regions so that collision avoidance
            takes precedence. Per-agent variation in these weights is governed by the
            Path Randomness parameter.
          </p>

          <h3 class="description-heading">How Speed Adapts</h3>
          <p class="description-paragraph">
            Walking speed adapts to local density through Weidmann's
            <strong>speed&ndash;density relationship</strong>, an empirical curve
            derived from pedestrian field observations
            <span class="description-cite">(Weidmann, 1993)</span>.
            Speed also falls at pinch points with heavy oncoming flow, producing emergent
            bottleneck queues. Personal-space preferences are drawn from Hall's proxemic
            framework
            <span class="description-cite">(Hall, 1966)</span>.
          </p>

          <h3 class="description-heading">How Agents Avoid Collisions</h3>
          <p class="description-paragraph">
            Near-collisions are resolved using
            <strong>ORCA</strong> (Optimal Reciprocal Collision Avoidance), a velocity-space
            method that yields smooth, reciprocal lateral avoidance rather than stop-and-wait
            behaviour
            <span class="description-cite">(van den Berg et al., 2011)</span>.
            The model checks the resulting movement against walkable space and accessibility
            constraints before accepting each step.
          </p>

          <h3 class="description-heading">Scenario B and Agent Colour</h3>
          <p class="description-paragraph">
            Scenario B favours straight movement along shared access and transit links.
            Shopping and waiting can draw agents toward off-spine destinations. The model
            represents Crime Prevention Through Environmental Design (CPTED) by reducing
            mapped crime risk and increasing pedestrian capacity in treated areas.
            Agents are white by default and turn red only near mapped crime risk or when
            experiencing congestion. These are simulated conditions.
          </p>

          <h3 class="description-heading">References</h3>
          <ul class="description-list description-references">
            <li>
              Antonini, G., Bierlaire, M. &amp; Weber, M. (2006). Discrete choice models of
              pedestrian walking behavior. <em>Transportation Research Part B:
              Methodological</em>, 40(8), 667&ndash;687.
            </li>
            <li>
              Hall, E.T. (1966). <em>The Hidden Dimension</em>. New York: Doubleday.
            </li>
            <li>
              van den Berg, J., Guy, S.J., Lin, M. &amp; Manocha, D. (2011). Reciprocal
              n-body collision avoidance. In C. Pradalier, R. Siegwart &amp; G. Hirzinger
              (eds.), <em>Robotics Research</em> (Springer Tracts in Advanced Robotics,
              vol. 70, pp. 3&ndash;19). Berlin: Springer.
            </li>
            <li>
              Weidmann, U. (1993). <em>Transporttechnik der Fussg&auml;nger: Transporttechnische
              Eigenschaften des Fussg&auml;ngerverkehrs, Literaturauswertung</em>
              (Schriftenreihe des IVT, Nr. 90). Z&uuml;rich: Institut f&uuml;r
              Verkehrsplanung, Transporttechnik, Strassen- und Eisenbahnbau, ETH Z&uuml;rich.
            </li>
          </ul>

          <p class="description-paragraph" style="margin-top: 0.75rem">
            Built with
            <a href="https://vuejs.org" target="_blank" rel="noopener">Vue.js</a>,
            <a href="https://maplibre.org" target="_blank" rel="noopener">MapLibre GL</a>, and
            <a href="https://reka-ui.com" target="_blank" rel="noopener">Reka UI</a>.
          </p>
        </div>
      </div>
    </AccordionContent>
  </AccordionItem>
</template>

<style scoped>
@reference "../assets/tailwind.css";

.sandbox-link {
  @apply text-accent mb-3 flex w-full cursor-pointer items-center justify-center gap-2 text-sm transition-opacity hover:opacity-80;
}

.sandbox-link-icon {
  @apply h-4 w-4;
}

.description-cite {
  @apply text-lighter text-[0.65rem] italic;
}

.description-references {
  @apply text-lighter text-[0.65rem] leading-relaxed;
}
</style>
