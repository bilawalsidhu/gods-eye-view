<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { createContextState } from '../../cockpitContextState.js';
import { vClassToggle } from '../../rail/classToggle.js';
import { useCockpitStore } from '../../stores/cockpit.js';
import UiButton from '../../kit/UiButton.vue';

// The Cockpit Contact card. The Cockpit controller presents its scope,
// navigation, cohort counts, nearest contact and weather toggle; until it
// does, the card shows the state it starts in. Its visibility and collapse
// render from the presence; its layout stays with the controller, and the
// controls keep its listeners.
const { presence, context } = storeToRefs(useCockpitStore());
const initial = createContextState();
const c = computed(() => context.value ?? initial);
const directionStyle = computed(() =>
  c.value.direction.angle === null
    ? undefined
    : { transform: `rotate(${c.value.direction.angle}deg)` },
);
const collapsed = computed(() => !!presence.value?.contextCollapsed);
const weatherLabel = computed(() =>
  c.value.weather
    ? t('Disable cockpit weather effects')
    : t('Enable cockpit weather effects'),
);
</script>

<template>
  <aside id="cockpit-context" class="cockpit-context-window" :aria-label="t('Contact cockpit summary')" :hidden="!presence?.context" :data-state="c.state ?? undefined" :data-collapsed="presence ? String(collapsed) : undefined">
    <header class="cockpit-card-header cockpit-context-header">
      <div>
        <span class="cockpit-card-kicker cockpit-context-kicker">{{ t('CONTACT') }}</span>
        <strong id="cockpit-context-subject">{{ c.subject }}</strong>
      </div>
      <nav class="cockpit-card-actions cockpit-context-actions" :aria-label="t('Contact navigation')">
        <button id="cockpit-context-previous" type="button" :disabled="!c.canPrevious" :aria-label="t('Previous — prior visited contact in the 250 km window')" :title="t('Previous — prior visited contact in the 250 km window')">
          <span class="material-symbols-outlined" aria-hidden="true">skip_previous</span>
        </button>
        <button id="cockpit-context-next" type="button" :disabled="!c.canNext" :aria-label="t('Next — nearest unvisited contact in the 250 km window')" :title="t('Next — nearest unvisited contact in the 250 km window')">
          <span class="material-symbols-outlined" aria-hidden="true">skip_next</span>
        </button>
        <button id="cockpit-context-toggle" type="button" :aria-label="collapsed ? t('Expand Contact panel') : t('Collapse Contact panel')" :aria-expanded="String(!collapsed)" :title="collapsed ? t('Expand contact panel') : t('Collapse contact panel')">
          <span class="material-symbols-outlined" aria-hidden="true">{{ collapsed ? 'chevron_right' : 'chevron_left' }}</span>
        </button>
      </nav>
      <span class="cockpit-context-qualifier">{{ t('CONTEXT ONLY') }}</span>
    </header>
    <div class="cockpit-context-cohorts" role="list" :aria-label="t('Nearby cohort counts')">
      <div v-class-toggle="{ unknown: c.cohorts.flights.unknown }" role="listitem" data-context-cohort="flights"><span>{{ t('FLT') }}</span><strong>{{ c.cohorts.flights.count }}</strong><small translate="no" :title="c.cohorts.flights.source">{{ c.cohorts.flights.source }}</small></div>
      <div v-class-toggle="{ unknown: c.cohorts.military.unknown }" role="listitem" data-context-cohort="military"><span>{{ t('MIL') }}</span><strong>{{ c.cohorts.military.count }}</strong><small translate="no" :title="c.cohorts.military.source">{{ c.cohorts.military.source }}</small></div>
      <div v-class-toggle="{ unknown: c.cohorts['ais-live-vessels'].unknown }" role="listitem" data-context-cohort="ais-live-vessels"><span translate="no">AIS</span><strong>{{ c.cohorts['ais-live-vessels'].count }}</strong><small translate="no" :title="c.cohorts['ais-live-vessels'].source">{{ c.cohorts['ais-live-vessels'].source }}</small></div>
      <div v-class-toggle="{ unknown: c.cohorts['military-installations'].unknown }" role="listitem" data-context-cohort="military-installations"><span>{{ t('SITE') }}</span><strong>{{ c.cohorts['military-installations'].count }}</strong><small translate="no" :title="c.cohorts['military-installations'].source">{{ c.cohorts['military-installations'].source }}</small></div>
    </div>
    <div class="cockpit-context-nearest">
      <span id="cockpit-context-direction" v-class-toggle="{ unknown: c.direction.unknown }" class="material-symbols-outlined" :style="directionStyle" aria-hidden="true">navigation</span>
      <div>
        <small>{{ t('NEAREST OBSERVED / MAPPED') }}</small>
        <strong id="cockpit-context-nearest-label" :aria-label="c.nearest.ariaLabel ?? undefined">{{ c.nearest.label }}</strong>
      </div>
      <span id="cockpit-context-bearing">{{ c.bearing }}</span>
      <span id="cockpit-context-distance" :aria-label="c.distance.ariaLabel ?? undefined">{{ c.distance.text }}</span>
    </div>
    <footer class="cockpit-context-footer">
      <span id="cockpit-context-uncertainty">{{ c.uncertainty }}</span>
      <UiButton id="cockpit-weather-toggle" class="cockpit-context-weather" :aria-label="weatherLabel" :pressed="Boolean(c.weather)" :title="weatherLabel">
        <span>{{ t('WX') }}</span>
        <strong id="cockpit-weather-state">{{ c.weather ? t('ON') : t('OFF') }}</strong>
      </UiButton>
      <time id="cockpit-context-updated">{{ c.updated }}</time>
    </footer>
  </aside>
</template>
