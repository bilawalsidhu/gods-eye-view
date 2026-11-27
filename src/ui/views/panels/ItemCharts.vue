<script setup>
import { computed, ref, watch } from 'vue';
import { formatDate, formatNumber, t, tn } from '../../../i18n/index.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { contextRadiusKm } from '../../contextRadius.js';

// Small charts of how a picked item is changing, from what the layers have
// loaded: for a fire, the satellite hits around it by the hour over the last
// day and their fire power; for a quake, the quakes around it over the feed's
// window by magnitude; for anything that moves and reports its speed (a
// vessel), its speed while the card is open. Nothing is fetched for them.
const props = defineProps({
  card: { type: Object, required: true },
  active: { type: Boolean, default: true },
  /** Bumped by the card on every refresh. */
  tick: { type: Number, default: 0 },
});

const store = useEntityCardStore();
const HOUR = 3_600_000;
const FIRE_LAYERS = new Set(['local-firms', 'fire-perimeters']);
// The hits that count as this fire's: within this distance of it.
const FIRE_KM = 25;

const fire = computed(() => {
  void props.tick;
  const card = props.card;
  if (!FIRE_LAYERS.has(card.layerId) || !Number.isFinite(card.lat)) return null;
  const snapshotEnd = store.layerModule('local-firms')?.getStats?.()?.at;
  const now = Number.isFinite(snapshotEnd) ? snapshotEnd : Date.now();
  const counts = Array(24).fill(0);
  const power = Array(24).fill(null);
  for (const { record } of store.recordsNear('local-firms', card.lat, card.lon, FIRE_KM)) {
    const age = now - record.acqTime;
    if (!Number.isFinite(age) || age < 0 || age >= 24 * HOUR) continue;
    const slot = 23 - Math.floor(age / HOUR);
    counts[slot]++;
    if (Number.isFinite(record.frp)) power[slot] = Math.max(power[slot] ?? -Infinity, record.frp);
  }
  const total = counts.reduce((sum, n) => sum + n, 0);
  const measured = power.filter((value) => value !== null);
  const peak = measured.length ? Math.max(...measured) : null;
  return total ? { counts, power, peak, total, snapshotEnd } : null;
});

const quakes = computed(() => {
  void props.tick;
  const card = props.card;
  if (card.layerId !== 'earthquakes' || !Number.isFinite(card.lat)) return null;
  const all = store
    .recordsNear('earthquakes', card.lat, card.lon, contextRadiusKm.value)
    .map(({ record }) => record)
    .filter((record) => Number.isFinite(record.magnitude) && Number.isFinite(record.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
  const list = all.slice(-24);
  return list.length > 1 ? { list, total: all.length } : null;
});

// Undated records can only establish a new reading when their speed changes.
const speeds = ref([]);
let lastObservedAt = null;
watch(
  () => [props.card.key, props.active, store.lost, props.card.observedAtMs, props.card.speedMps],
  ([key, active, lost, observedAt, speed], previous) => {
    if (key !== previous?.[0]) {
      speeds.value = [];
      lastObservedAt = null;
    }
    if (!active || lost || !Number.isFinite(speed)) return;
    const card = props.card;
    if (!card.moving || card.kind === 'aircraft' || card.kind === 'satellite') return;
    const knots = speed * 1.943844;
    if (Number.isFinite(observedAt)) {
      if (lastObservedAt !== null && observedAt <= lastObservedAt) return;
      lastObservedAt = observedAt;
    } else if (speeds.value.at(-1) === knots) return;
    speeds.value = [...speeds.value, knots].slice(-40);
  },
  { immediate: true },
);

const W = 160;
const H = 28;
const bars = (values) => {
  const top = Math.max(...values, 1);
  const width = W / values.length;
  return values.map((value, index) => ({
    x: index * width + 0.5,
    width: Math.max(1, width - 1.5),
    height: Math.max(value ? 2 : 0.5, (value / top) * H),
  }));
};
function gappedLines(values) {
  const measured = values.filter((value) => value !== null);
  const low = Math.min(...measured);
  const span = Math.max(...measured) - low || 1;
  const lines = [];
  let points = [];
  values.forEach((value, index) => {
    if (value === null) return;
    const x = (index / (values.length - 1)) * W;
    const y = (H - ((value - low) / span) * (H - 2) - 1).toFixed(1);
    points.push(`${x.toFixed(1)},${y}`);
    if (values[index + 1] != null) return;
    lines.push(points.length === 1
      ? `${Math.max(0, x - 1)},${y} ${Math.min(W, x + 1)},${y}`
      : points.join(' '));
    points = [];
  });
  return lines;
}
const fireWindow = computed(() => {
  const at = fire.value?.snapshotEnd;
  return Number.isFinite(at)
    ? t('24 h to {day} {time} UTC', { day: formatDate(at, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }), time: new Date(at).toISOString().slice(11, 16) })
    : t('Last 24 hours');
});
const fireLabel = computed(() => {
  const { total, snapshotEnd } = fire.value;
  if (!Number.isFinite(snapshotEnd)) return tn(total, '{count} satellite fire hit within {km} km in the last 24 hours', '{count} satellite fire hits within {km} km in the last 24 hours', { km: FIRE_KM });
  return [tn(total, '{count} satellite fire hit', '{count} satellite fire hits'), t('WITHIN {km} KM', { km: FIRE_KM }), fireWindow.value].join(' · ');
});
const fireBars = computed(() => (fire.value ? bars(fire.value.counts) : []));
const powerLines = computed(() => (fire.value && fire.value.peak !== null ? gappedLines(fire.value.power) : []));
const quakeBars = computed(() => (quakes.value ? bars(quakes.value.list.map((quake) => quake.magnitude)) : []));
const quakeLabel = computed(() => {
  const { list, total } = quakes.value;
  const count = formatNumber(total);
  const label = tn(total, '{count} quake nearby, oldest first', '{count} quakes nearby, oldest first', { count });
  return total > list.length
    ? label + ' · ' + t('{shown} of {total} shown', { shown: formatNumber(list.length), total: count })
    : label;
});
const speedLine = computed(() => (speeds.value.length > 1 ? gappedLines(speeds.value)[0] : ''));
const shown = computed(() => Boolean(fire.value || quakes.value || speeds.value.length > 1));
</script>

<template>
  <section v-if="active && shown" class="item-charts" :aria-label="t('How it is changing')">
    <h4>{{ fire ? fireWindow : t('How it is changing') }}</h4>
    <template v-if="fire">
      <div class="item-charts__row">
        <span class="item-charts__label">{{ t('Hotspots') }}</span>
        <svg class="item-charts__chart" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="fireLabel">
          <rect v-for="(bar, index) in fireBars" :key="index" :x="bar.x" :y="H - bar.height" :width="bar.width" :height="bar.height" :class="{ 'is-last': index === fireBars.length - 1 }" />
        </svg>
        <strong>{{ formatNumber(fire.total) }}</strong>
      </div>
      <div v-if="powerLines.length" class="item-charts__row">
        <span class="item-charts__label">{{ t('Fire power') }}</span>
        <svg class="item-charts__chart" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
          <polyline v-for="(points, index) in powerLines" :key="index" :points="points" />
        </svg>
        <strong>{{ t('{n} MW', { n: formatNumber(Math.round(fire.peak)) }) }}</strong>
      </div>
    </template>
    <div v-if="quakes" class="item-charts__row">
      <span class="item-charts__label">{{ t('Magnitudes nearby') }}</span>
      <svg class="item-charts__chart" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="quakeLabel">
        <rect v-for="(bar, index) in quakeBars" :key="index" :x="bar.x" :y="H - bar.height" :width="bar.width" :height="bar.height" :class="{ 'is-last': card.identity?.id != null && quakes.list[index].id === card.identity.id }" />
      </svg>
      <strong>{{ formatNumber(quakes.total) }}</strong>
    </div>
    <div v-if="speeds.length > 1" class="item-charts__row">
      <span class="item-charts__label">{{ t('Speed') }}</span>
      <svg class="item-charts__chart" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
        <polyline :points="speedLine" />
      </svg>
      <strong>{{ t('{n} kt', { n: formatNumber(Math.round(speeds[speeds.length - 1])) }) }}</strong>
    </div>
  </section>
</template>
