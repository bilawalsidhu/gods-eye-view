<script setup>
import { computed } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';
import { cardFlightLevelDigits } from '../../../data/entityContext.js';
import AirportLink from './AirportLink.vue';

// Route and altitude in one view: how far along its route a flight is and how
// high it flies there. The line climbs from the origin to the plane's
// altitude, runs level, and comes down to the destination; the part flown is
// solid, the part to go dashed, and the plane sits where it is now, labelled
// with its flight level and the time left at its current speed.
const props = defineProps({
  from: { type: String, required: true },
  to: { type: String, required: true },
  fromPlace: { type: String, default: '' },
  toPlace: { type: String, default: '' },
  /** Share of the route flown, 0 to 1. */
  share: { type: Number, required: true },
  altitudeM: { type: Number, default: null },
  /** "1 h 52 min", or empty when the speed does not tell it. */
  eta: { type: String, default: '' },
});

const WIDTH = 200;
const HEIGHT = 44;
const BASE = 38;
const TOP = 10;
/** How much of the width the climb and the descent each take. */
const RAMP = 22;

const x = computed(() => Math.max(0, Math.min(1, props.share)) * WIDTH);
// The level the line runs at: the plane's altitude where known, else the
// middle of the chart.
const y = computed(() => {
  if (!Number.isFinite(props.altitudeM)) return (TOP + BASE) / 2;
  // 12,500 m (about FL410) reaches the top.
  const share = Math.max(0.08, Math.min(1, props.altitudeM / 12_500));
  return BASE - share * (BASE - TOP);
});
const flown = computed(() => {
  const at = x.value;
  if (at <= RAMP) return `M0 ${BASE} L${at} ${planeY.value}`;
  if (at >= WIDTH - RAMP) return `M0 ${BASE} L${RAMP} ${y.value} L${WIDTH - RAMP} ${y.value} L${at} ${planeY.value}`;
  return `M0 ${BASE} L${RAMP} ${y.value} L${at} ${y.value}`;
});
const ahead = computed(() => {
  const at = x.value;
  const climb = at < RAMP ? ` L${RAMP} ${y.value}` : '';
  const cruise = at < WIDTH - RAMP ? ` L${WIDTH - RAMP} ${y.value}` : '';
  return `M${at} ${planeY.value}${climb}${cruise} L${WIDTH} ${BASE}`;
});
const planeY = computed(() => {
  const at = x.value;
  if (at <= RAMP) return BASE - ((BASE - y.value) * at) / RAMP;
  if (at >= WIDTH - RAMP) return y.value + ((BASE - y.value) * (at - (WIDTH - RAMP))) / RAMP;
  return y.value;
});

const level = computed(() => {
  const m = props.altitudeM;
  if (!Number.isFinite(m)) return '';
  const digits = cardFlightLevelDigits(m);
  return digits ? t('FL{n}', { n: digits }) : t('{n} ft', { n: formatNumber(Math.round((m * 3.28084) / 100) * 100) });
});
const note = computed(() => [level.value, props.eta ? t('{time} left', { time: t('~{n}', { n: props.eta }) }) : ''].filter(Boolean).join(' · '));
</script>

<template>
  <section class="route-profile" :aria-label="t('Route and altitude')">
    <h4 class="route-profile__head">
      <span>{{ t('Route and altitude') }}</span>
      <span>{{ t('{n}% flown', { n: formatNumber(Math.round(share * 100)) }) }}</span>
    </h4>
    <!-- Drawn origin to destination, left to right, in every language. -->
    <div class="route-profile__chart" role="img" :aria-label="note || t('Route and altitude')">
      <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" preserveAspectRatio="none" aria-hidden="true">
        <line class="route-profile__ground" x1="0" :y1="BASE" :x2="WIDTH" :y2="BASE" />
        <path class="route-profile__ahead" :d="ahead" />
        <path class="route-profile__flown" :d="flown" />
      </svg>
      <i class="route-profile__plane" :style="{ left: `${(x / WIDTH) * 100}%`, top: `${(planeY / HEIGHT) * 100}%` }" aria-hidden="true"></i>
    </div>
    <p v-if="note" class="route-profile__note">{{ note }}</p>
    <div class="route-profile__ends">
      <AirportLink :code="from" class="route-profile__end"><strong>{{ from }}</strong><small v-if="fromPlace">{{ fromPlace }}</small></AirportLink>
      <AirportLink :code="to" class="route-profile__end"><strong>{{ to }}</strong><small v-if="toPlace">{{ toPlace }}</small></AirportLink>
    </div>
  </section>
</template>
