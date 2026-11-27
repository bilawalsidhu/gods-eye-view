<script setup>
import { computed, ref, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import { airportCode, findAirportByCode } from '../../../data/airports.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import UiButton from '../../kit/UiButton.vue';
import { focusInCard } from '../../cardFocus.js';

// An airport named by its code ("SDF", "KSDF") wherever Context shows one: a
// button that opens the airport's card (as a search for the code does) once
// the bundled airports pack knows the code; plain text while it is looked up
// and when the pack does not know it. The slot is what shows; the code by
// default.
const props = defineProps({
  code: { type: String, required: true },
});

const store = useEntityCardStore();

const airport = ref(null);
watch(
  () => props.code,
  async (code) => {
    airport.value = null;
    const found = await findAirportByCode(String(code || '').trim()).catch(() => null);
    if (code === props.code) airport.value = found;
  },
  { immediate: true },
);

// The name says the code as shown: an ICAO alias ("KSDF") stays itself rather
// than the pack's preferred code ("SDF").
const label = computed(() => {
  const found = airport.value;
  if (!found) return '';
  const code = String(props.code || '').trim() || airportCode(found);
  return found.city ? t('Open {city} airport ({code})', { city: found.city, code }) : t('Open {name} ({code})', { name: found.name, code });
});

// The link goes with the card it was on: focus moves to the airport card's
// Back, else its title.
function open(event) {
  if (store.openAirport(airport.value, { viaKey: event.currentTarget?.dataset.viaKey })) void focusInCard(['.place-details__back'], store);
}
</script>

<template>
  <UiButton v-if="airport" class="airport-link" :data-airport="airport.ident" :label="label" @click="open">
    <slot>{{ code }}</slot>
  </UiButton>
  <span v-else class="airport-link airport-link--plain">
    <slot>{{ code }}</slot>
  </span>
</template>
