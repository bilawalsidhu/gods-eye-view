<script setup>
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { atcAirportsForAircraft } from '../../../data/airportAtcChannels.js';
import { useRadioStore } from '../../stores/radio.js';
import UiButton from '../../kit/UiButton.vue';

const props = defineProps({
  aircraft: { type: Object, required: true },
  lost: Boolean,
});
const radio = useRadioStore();
const airports = computed(() => props.lost ? [] : atcAirportsForAircraft(props.aircraft));
</script>

<template>
  <section v-if="radio.sdr" class="entity-card__section aircraft-atc">
    <h4>{{ t('ATC channels') }}</h4>
    <UiButton class="entity-card__action" :disabled="radio.sdr.connectDisabled" @click="radio.act('openManualAtc')">
      {{ t('Manual tuning') }}
    </UiButton>
    <div v-for="airport in airports" :key="airport.ident" class="aircraft-atc__airport">
      <strong translate="no">{{ airport.code }}</strong>
      <span v-if="airport.nearby"> · {{ t('Nearby airport') }}</span>
      <div v-if="airport.channels.length" class="entity-card__action-row">
        <UiButton v-for="[service, channel] in airport.channels" :key="service + channel" class="entity-card__action" :disabled="radio.sdr.connectDisabled" @click="radio.act('tuneAirportAtc', channel)">
          {{ service === 'TWR' ? t('Tower') : t('Approach') }} · {{ channel }}
        </UiButton>
      </div>
      <p class="entity-card__source"><a :href="airport.source" target="_blank" rel="noopener" translate="no">{{ airport.code === 'LHBP' ? 'HungaroControl eAIP' : 'OurAirports' }}</a></p>
    </div>
  </section>
</template>
