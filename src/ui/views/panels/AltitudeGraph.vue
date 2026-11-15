<script setup>
import { computed, ref, watch } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';

// A height as a filled graph (an aircraft's altitude, the camera's height):
// each reading since it opened, left to right. The scale fits the readings (never less than about
// 2,000 ft tall), so a climb or descent shows as a slope, and the fill
// fades from the line down to the baseline.
const props = defineProps({
  /** The current altitude in metres, or null when unknown. */
  altitudeM: { type: Number, default: null },
  /** Bumped on each card refresh; a reading is taken on every bump. */
  tick: { type: Number, default: 0 },
  /** The caption; 'Altitude' when not given. */
  label: { type: String, default: '' },
  /** 'feet' for aircraft; 'metric' reads in metres and kilometres. */
  unit: { type: String, default: 'feet' },
  /** Only the caption, the current figure and the line: no scale or change. */
  compact: { type: Boolean, default: false },
});

const MAX_READINGS = 450;
const MIN_RANGE_M = 600;
const WIDTH = 100;
const HEIGHT = 36;

const readings = ref([]);
watch(
  () => props.tick,
  () => {
    if (!Number.isFinite(props.altitudeM)) return;
    const next = [...readings.value, { at: Date.now(), m: Math.max(0, props.altitudeM) }];
    readings.value = next.length > MAX_READINGS ? next.slice(-MAX_READINGS) : next;
  },
  { immediate: true },
);

const feet = (m) => Math.round((m * 3.28084) / 100) * 100;
const number = (value) => formatNumber(value, { maximumFractionDigits: 1 });
const metric = (m) =>
  m >= 100_000
    ? t('{n} km', { n: number(Math.round(m / 1000)) })
    : m >= 1000
      ? t('{n} km', { n: formatNumber(m / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
      : t('{n} m', { n: number(Math.round(m)) });
const shown = (m) => (props.unit === 'metric' ? metric(m) : t('{n} ft', { n: number(feet(m)) }));

const graph = computed(() => {
  const list = readings.value;
  if (!list.length) return null;
  const last = list[list.length - 1];
  const first = list[0];
  const span = Math.max(1, last.at - first.at);
  // The camera ranges from metres to the whole globe, so its heights are
  // drawn on a log scale: each zoom step is a similar rise or fall.
  const log = props.unit === 'metric';
  const scaled = (m) => (log ? Math.log10(Math.max(1, m)) : m);
  const heights = list.map((item) => scaled(item.m));
  const high = Math.max(...heights);
  const low = Math.min(...heights);
  // The least the scale spans: about 2,000 ft for aircraft, half a decade
  // for the camera.
  const least = log ? 0.5 : MIN_RANGE_M;
  const pad = Math.max((least - (high - low)) / 2, (high - low) * 0.15);
  const bottom = Math.max(0, low - pad);
  const top = Math.max(high + pad, bottom + least);
  const x = (at) => WIDTH - ((last.at - at) / span) * WIDTH;
  const y = (m) => HEIGHT - ((scaled(m) - bottom) / (top - bottom)) * (HEIGHT - 2) - 1;
  // The readings span the full width; a single reading (a card that has
  // just opened) draws as a level line instead of a dot.
  const points = list.length > 1 ? list.map((item) => [x(item.at), y(item.m)]) : [[0, y(first.m)], [WIDTH, y(first.m)]];
  const line = points.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(2)} ${py.toFixed(2)}`).join(' ');
  const moved = last.m - first.m;
  const change = props.unit === 'metric' ? (Math.abs(moved) >= Math.max(1, last.m * 0.005) ? moved : 0) : feet(last.m) - feet(first.m);
  const changeText = props.unit === 'metric' ? metric(Math.abs(moved)) : t('{n} ft', { n: number(Math.abs(change)) });
  const minutes = Math.floor((last.at - first.at) / 60_000);
  return {
    line,
    area: `${line} L${WIDTH} ${HEIGHT} L0 ${HEIGHT} Z`,
    headY: y(last.m),
    now: shown(last.m),
    top: shown(log ? 10 ** top : top),
    bottom: shown(log ? 10 ** bottom : bottom),
    trend: change > 0 ? 'up' : change < 0 ? 'down' : 'level',
    change: change ? `${change > 0 ? '+' : '−'}${changeText}` : t('Level', { context: 'altitude' }),
    since: minutes >= 1 ? t('Last {n} min', { n: minutes }) : props.unit === 'metric' ? t('Just now') : t('Since selected'),
  };
});
</script>

<template>
  <figure v-if="graph" class="altitude-graph" :class="{ 'altitude-graph--compact': compact }" :data-trend="graph.trend">
    <figcaption class="altitude-graph__head">
      <span class="altitude-graph__label">{{ label || t('Altitude') }}</span>
      <strong class="altitude-graph__now">{{ graph.now }}</strong>
    </figcaption>
    <div class="altitude-graph__plot">
      <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" preserveAspectRatio="none" role="img" :aria-label="`${label || t('Altitude')} ${graph.now}, ${graph.change}`">
        <defs>
          <linearGradient id="altitude-graph-fill" gradientUnits="userSpaceOnUse" x1="0" :y1="0" x2="0" :y2="HEIGHT">
            <stop offset="0" class="altitude-graph__stop altitude-graph__stop--high" />
            <stop offset="0.5" class="altitude-graph__stop altitude-graph__stop--mid" />
            <stop offset="1" class="altitude-graph__stop altitude-graph__stop--low" />
          </linearGradient>
        </defs>
        <path class="altitude-graph__area" :d="graph.area" fill="url(#altitude-graph-fill)" />
        <path class="altitude-graph__line" :d="graph.line" />
      </svg>
      <span class="altitude-graph__head-dot" :style="{ top: `${(graph.headY / HEIGHT) * 100}%` }" aria-hidden="true"></span>
      <template v-if="!compact">
        <span class="altitude-graph__scale" aria-hidden="true">{{ graph.top }}</span>
        <span class="altitude-graph__scale altitude-graph__scale--low" aria-hidden="true">{{ graph.bottom }}</span>
      </template>
    </div>
    <p v-if="!compact" class="altitude-graph__foot">
      <span>{{ graph.since }}</span>
      <span class="altitude-graph__change">{{ graph.change }}</span>
    </p>
  </figure>
</template>
