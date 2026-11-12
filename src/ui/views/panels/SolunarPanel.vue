<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useSolunarStore } from '../../stores/solunar.js';
import UiButton from '../../kit/UiButton.vue';
import { dayCard, formatLatLon, ruleLines } from '../../../solunar/format.js';

// The SOLUNAR card as the view renders it: the card owner
// (src/solunar/panel.js) publishes the week, and the buttons call the
// owner's controls back.
const { panel, controls } = storeToRefs(useSolunarStore());
const call = (name, ...args) => controls.value?.[name]?.(...args);

const spot = computed(() => panel.value?.spot ?? null);
const zone = computed(() => spot.value?.zone ?? '');
const hour12 = computed(() => panel.value?.hour12 ?? true);
const spotText = computed(() =>
  spot.value
    ? `${formatLatLon(spot.value.latDeg, spot.value.lonDeg)} · ${zone.value}`
    : '',
);
const days = computed(() =>
  (panel.value?.days ?? []).map((day) =>
    dayCard(day, zone.value, hour12.value, panel.value?.rule?.maxStars ?? 4),
  ),
);
const rule = computed(() =>
  panel.value?.rule ? ruleLines(panel.value.rule) : [],
);
const clockOptions = computed(() => [
  { value: true, label: t('12 h') },
  { value: false, label: t('24 h') },
]);
</script>

<template>
  <div
    id="gev-solunar-body"
    class="gev-sl-body"
    role="group"
    :aria-label="t('Solunar')"
  >
    <template v-if="panel && spot">
      <div class="gev-sl-head">
        <div class="gev-sl-spot">{{ spotText }}</div>
        <p class="gev-sl-hint">{{ t('Click the map to choose a spot') }}</p>
        <div class="gev-sl-controls">
          <UiButton
            class="data-toggle-chip gev-sl-center"
            @click="call('useCenter')"
          >{{ t('Use map centre') }}</UiButton>
          <UiButton
            v-for="option in clockOptions"
            :key="String(option.value)"
            class="data-toggle-chip gev-sl-clock"
            :pressed="option.value === hour12"
            pressed-class="active"
            :data-hour12="String(option.value)"
            @click="call('setHour12', option.value)"
          >{{ option.label }}</UiButton>
        </div>
        <div class="gev-sl-zone">{{
          t('Times are local to the spot ({zone})', { zone })
        }}</div>
      </div>
      <section
        v-for="day in days"
        :key="day.date"
        class="gev-sl-day"
        :data-date="day.date"
      >
        <div class="gev-sl-day-head">
          <strong>{{ day.title }}</strong>
          <span class="gev-sl-phase">{{ day.phase }}</span>
        </div>
        <div class="gev-sl-stars">
          <span
            v-for="rate in day.stars"
            :key="rate.key"
            class="gev-sl-rate"
            :class="`gev-sl-${rate.key}`"
            :data-stars="rate.count"
            :aria-label="rate.aria"
          ><span>{{ rate.label }}</span><span class="gev-sl-star-glyphs">{{
              rate.glyphs
            }}</span></span>
        </div>
        <div class="gev-sl-windows">
          <div
            v-for="row in day.windows"
            :key="row.key"
            class="gev-sl-row"
            :class="row.cls"
          ><span class="gev-sl-label">{{ row.label }}</span><span
              class="gev-sl-value"
              :class="{ 'gev-sl-none': row.none }"
            >{{ row.value }}</span></div>
        </div>
        <div class="gev-sl-times">
          <div
            v-for="row in day.times"
            :key="row.key"
            class="gev-sl-row"
            :class="row.cls"
          ><span class="gev-sl-label">{{ row.label }}</span><span
              class="gev-sl-value"
              :class="{ 'gev-sl-none': row.none }"
            >{{ row.value }}</span></div>
        </div>
      </section>
      <details class="gev-sl-rule" open>
        <summary>{{ t('How the stars are rated') }}</summary>
        <ul>
          <li v-for="(line, index) in rule" :key="index">{{ line }}</li>
        </ul>
      </details>
    </template>
    <template v-else-if="panel">
      <div class="gev-sl-head">
        <p class="gev-sl-hint">{{ t('Click the map to choose a spot') }}</p>
      </div>
    </template>
  </div>
</template>
