<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiSegmented from '../../kit/UiSegmented.vue';
import { useDisplayStore } from '../../stores/display.js';
import DrawMarkList from './DrawMarkList.vue';
import DrawSwatches from './DrawSwatches.vue';

// UTILITIES ▸ Draw: the toggle, the shape and the colour for the next shape,
// the hint with Clear, and the drawn shapes' rows. The draw tool publishes
// what they show and answers them through the display store.
const display = useDisplayStore();
const { draw } = storeToRefs(display);
const act = (name, ...args) => display.act(name, ...args);
const drawShape = computed(() => draw.value?.shape ?? 'area');

// Icons, named for screen readers and tooltips.
const shapeOptions = computed(() => [
  { value: 'area', label: t('Area'), icon: 'pentagon', attrs: { 'data-shape': 'area' } },
  { value: 'line', label: t('Line'), icon: 'timeline', attrs: { 'data-shape': 'line' } },
  { value: 'pin', label: t('Pin'), icon: 'location_on', attrs: { 'data-shape': 'pin' } },
]);
</script>

<template>
  <div class="pp-toggle-group" id="draw-group">
    <UiButton class="pp-toggle-btn" :pressed="draw?.active ?? false" pressed-class="active" id="draw-toggle" @click="act('toggleDraw')" :title="t('Draw on the world — click vertices, double-click or Enter to finish, Esc to cancel')">
      <span class="pp-icon material-symbols-outlined" aria-hidden="true">draw</span>
      <span class="pp-label">{{ t('Draw') }}</span>
    </UiButton>
    <div class="pp-slider-row" :class="{ visible: draw?.active }" id="draw-mode-row">
      <UiSegmented class="pp-mode-seg draw-shape-seg" item-class="pp-mode-btn" keyboard="none" :label="t('Shape to draw')" :options="shapeOptions" :model-value="drawShape" @update:model-value="act('setDrawShape', $event)" />
      <DrawSwatches id="draw-colors" :label="t('Colour of the next shape')" :model-value="draw?.color ?? 'primary'" @update:model-value="act('setDrawColor', $event)" />
    </div>
    <div class="pp-slider-row" :class="{ visible: draw?.active }" id="draw-label-row">
      <span class="draw-hint" id="draw-hint" aria-live="polite">{{ draw?.hint ?? '' }}</span>
      <button class="pp-mode-btn draw-clear-btn" id="draw-clear" type="button" @click="act('clearDraw')" :title="t('Remove every mark from the board')">{{ t('Clear') }}</button>
    </div>
    <DrawMarkList />
  </div>
</template>
