<script setup>
import { computed } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';
import { CONTEXT_RADIUS_STEPS, contextRadiusKm, overheadRangeKm, setContextRadiusKm, setOverheadRangeKm } from '../../contextRadius.js';
import UiButton from '../../kit/UiButton.vue';
import UiSlider from '../../kit/UiSlider.js';

const props = defineProps({
  label: { type: String, required: true },
  overhead: Boolean,
  toggle: Boolean,
});
const emit = defineEmits(['toggle']);
const distance = computed(() => props.overhead ? overheadRangeKm.value : contextRadiusKm.value);

const radiusText = computed(() => t('{n} km', { n: formatNumber(distance.value) }));
const radiusIndex = computed(() => CONTEXT_RADIUS_STEPS.indexOf(distance.value));
const pickRadius = (index) => (props.overhead ? setOverheadRangeKm : setContextRadiusKm)(CONTEXT_RADIUS_STEPS[index]);
</script>

<template>
  <div class="view-context__radius">
    <UiButton v-if="toggle" class="view-context__radius-label view-context__radius-toggle" :pressed="overhead" @click="emit('toggle')">{{ label }} <span aria-hidden="true">↔</span></UiButton>
    <span v-else class="view-context__radius-label">{{ label }}</span>
    <UiSlider class="view-context__radius-slider" min="0" :max="CONTEXT_RADIUS_STEPS.length - 1" step="1" :model-value="radiusIndex" :aria-label="label" :aria-valuetext="radiusText" :title="label" @update:model-value="pickRadius" />
    <output class="view-context__radius-value">{{ radiusText }}</output>
    <div class="view-context__radius-steps" aria-hidden="true">
      <span v-for="step in CONTEXT_RADIUS_STEPS" :key="step" :class="{ 'is-on': step === distance }">{{ formatNumber(step) }}</span>
    </div>
  </div>
</template>
