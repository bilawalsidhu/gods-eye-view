<script setup>
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { atcAirportsForAircraft } from '../../../data/airportAtcChannels.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { useRadioStore } from '../../stores/radio.js';
import UiButton from '../../kit/UiButton.vue';

const selected = useEntityCardStore();
const radio = useRadioStore();
const airports = computed(() =>
  selected.card?.kind === 'aircraft' && !selected.lost
    ? atcAirportsForAircraft(selected.card)
    : [],
);
</script>

<template>
  <section v-if="airports.length" class="sdr-atc-channels">
    <h4>{{ t('ATC channels') }}</h4>
    <div v-for="airport in airports" :key="airport.ident" class="sdr-atc-airport">
      <strong translate="no">{{ airport.code }}</strong>
      <span v-if="airport.nearby"> · {{ t('Nearby airport') }}</span>
      <div v-if="airport.channels.length" class="sdr-atc-options">
        <UiButton v-for="[service, channel] in airport.channels" :key="service + channel" class="gev-field" :disabled="radio.sdr.connectDisabled" @click="radio.act('tuneAirportAtc', channel)">
          {{ service === 'TWR' ? t('Tower') : t('Approach') }} · {{ channel }}
        </UiButton>
      </div>
      <a :href="airport.source" target="_blank" rel="noopener" translate="no">{{ airport.code === 'LHBP' ? 'HungaroControl eAIP' : 'OurAirports' }}</a>
    </div>
  </section>
</template>
