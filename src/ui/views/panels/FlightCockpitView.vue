<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';
import { ESRI_IMAGERY_CREDIT } from '../../../maps/attribution.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import PreviewHud from './PreviewHud.vue';

// What the crew sees: the view ahead from the aircraft's own position,
// height and heading, a little nose down, over Esri World Imagery. The
// renderer draws it (the `cardPreviews` hook) only when asked: a still,
// moved along with the craft while it shows. It takes turns with the turning
// model. Speed and altitude ride on tapes either side, as on a head-up
// display: the ticks roll as the figures change, with the figure boxed in
// the middle. Its credit line sits in the corner.
const props = defineProps({
  lat: { type: Number, default: null },
  lon: { type: Number, default: null },
  /** Height above the ellipsoid, metres. */
  altitudeM: { type: Number, default: null },
  /** Degrees from north. */
  heading: { type: Number, default: null },
  /** Ground speed, metres a second. */
  speedMps: { type: Number, default: null },
  /** Whether the view is the one showing. */
  active: { type: Boolean, default: false },
});
const emit = defineEmits(['failed']);
const store = useEntityCardStore();

const host = ref(null);
let preview = null;
const craft = () => ({ lat: props.lat, lon: props.lon, altitudeM: props.altitudeM, heading: props.heading });

onMounted(() => {
  const previews = store.previews();
  if (!previews?.cockpit || !host.value) {
    emit('failed');
    return;
  }
  preview = previews.cockpit(host.value, craft(), { onFailed: () => emit('failed') });
  preview.setActive(props.active);
});
// While it shows, the view keeps up with the craft as the card refreshes.
watch(
  () => [props.lat, props.lon, props.altitudeM, props.heading],
  () => preview?.update(craft()),
);
watch(
  () => props.active,
  (active) => preview?.setActive(active),
);
onBeforeUnmount(() => {
  preview?.destroy();
  preview = null;
});

// The tapes: one tick every 10 kt and every 100 ft, 8 px apart; the ticks
// roll by the remainder, so a change in the figure moves them.
const TICK_PX = 8;
const knots = computed(() => (Number.isFinite(props.speedMps) ? Math.round(props.speedMps * 1.94384) : null));
const altFeet = computed(() => (Number.isFinite(props.altitudeM) ? Math.round(props.altitudeM * 3.28084) : null));
const feet = computed(() => (altFeet.value === null ? '' : t('{n} ft', { n: formatNumber(Math.round(altFeet.value / 100) * 100) })));
const roll = (value, per) => (value === null ? 0 : ((value % per) / per) * TICK_PX);
const speedRoll = computed(() => `${roll(knots.value, 10)}px`);
const altRoll = computed(() => `${roll(altFeet.value, 100)}px`);
const course = computed(() => (Number.isFinite(props.heading) ? `${String(Math.round(props.heading) % 360).padStart(3, '0')}°` : ''));
</script>

<template>
  <div class="flight-cockpit" aria-hidden="true">
    <div ref="host" class="flight-cockpit__scene"></div>
    <PreviewHud variant="cockpit" :running="active" />
    <span class="flight-cockpit__horizon"><i></i></span>
    <span v-if="knots !== null" class="flight-cockpit__tape flight-cockpit__tape--speed">
      <i class="flight-cockpit__ticks" :style="{ backgroundPositionY: speedRoll }"></i>
      <b>{{ formatNumber(knots) }}</b><em>{{ t('KT') }}</em>
    </span>
    <span v-if="altFeet !== null" class="flight-cockpit__tape flight-cockpit__tape--alt">
      <i class="flight-cockpit__ticks" :style="{ backgroundPositionY: altRoll }"></i>
      <b>{{ formatNumber(altFeet) }}</b><em>{{ t('FT') }}</em>
    </span>
    <span class="flight-cockpit__label">{{ t('Cockpit view') }}<strong>{{ [feet, course].filter(Boolean).join(' · ') }}</strong></span>
    <span class="flight-cockpit__credit">{{ ESRI_IMAGERY_CREDIT }}</span>
  </div>
</template>
