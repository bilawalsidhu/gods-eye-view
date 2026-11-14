<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { createRouteState } from '../../cockpitInstrumentState.js';
import { useCockpitStore } from '../../stores/cockpit.js';

// The Cockpit flight plan card. The Cockpit controller presents the route's
// endpoints and whether a destination direction exists; until it does, the
// card stays hidden.
const { route } = storeToRefs(useCockpitStore());
const initial = createRouteState();
const r = computed(() => route.value ?? initial);
// A provider subject's card is titled by its provider, in the page's language.
const kicker = computed(() =>
  r.value.kind === 'subject'
    ? r.value.title
    : r.value.kind === 'vessel'
      ? t('REPORTED VOYAGE')
      : t('ESTIMATED FLIGHT PLAN'),
);
const label = computed(() =>
  r.value.kind === 'subject'
    ? r.value.title || undefined
    : r.value.kind === 'vessel'
      ? t('Reported voyage')
      : t('Estimated flight plan'),
);
</script>

<template>
  <section id="cockpit-route" class="cockpit-route-card" :aria-label="label" :hidden="!r.visible">
    <div class="cockpit-route-heading">
      <span class="cockpit-route-kicker">{{ kicker }}</span>
      <small id="cockpit-route-status">{{ r.status }}</small>
    </div>
    <div class="cockpit-route-endpoints">
      <div v-if="r.kind !== 'vessel'" class="cockpit-route-airport">
        <span>{{ t('FROM') }}</span>
        <strong id="cockpit-route-from">{{ r.from }}</strong>
      </div>
      <span v-if="r.kind !== 'vessel'" class="cockpit-route-arrow material-symbols-outlined" aria-hidden="true">east</span>
      <div class="cockpit-route-airport">
        <span>{{ t('TO') }}</span>
        <strong id="cockpit-route-to">{{ r.to }}</strong>
      </div>
    </div>
  </section>
</template>
