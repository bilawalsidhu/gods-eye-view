<script setup>
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import {
  applicationUnitSystem,
  chooseUnitSystem,
  otherUnitSystem,
} from '../../unitSystem.js';

// The metric / imperial switch in the bottom-right corner row, beside the
// language picker. One press shows the other system everywhere a quantity is
// formatted for a person, and keeps it for the next visit (src/units.js).
const system = applicationUnitSystem();
const imperial = computed(() => system.value === 'imperial');
const label = computed(() =>
  imperial.value ? t('Units: imperial') : t('Units: metric'),
);
const title = computed(() =>
  imperial.value
    ? t('Switch to metric units (°C, km, m, km/h)')
    : t('Switch to imperial units (°F, mi, ft, mph)'),
);

function toggle() {
  chooseUnitSystem(otherUnitSystem(system.value));
}
</script>

<template>
  <button id="unit-system-toggle" class="unit-system-button" type="button" :data-unit-system="system" :aria-label="label" :title="title" @click="toggle">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="unit-system-icon"><path d="M3 8.5h18v7H3z M7 8.5v3.2 M11 8.5v2.2 M15 8.5v3.2 M19 8.5v2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
    <span class="unit-system-code" translate="no" aria-hidden="true">{{ imperial ? '°F' : '°C' }}</span>
  </button>
</template>
