<script setup>
import UiSlider from '../kit/UiSlider.js';

// The opacity slider under a layer row, as LayerPanel presents it: the label,
// the position in percent, the readout and the accessible names arrive worded.
// Moving the handle reports a percent; a double-click reports a reset. The
// slider follows the presented value even while it has focus, so a reset moves
// the handle a drag left focused.
defineProps({
  opacity: { type: Object, required: true },
  onChange: { type: Function, default: () => {} },
  onReset: { type: Function, default: () => {} },
});
</script>

<template>
  <div class="data-toggle-opacity"
    ><span class="data-toggle-opacity-label">{{ opacity.label }}</span
    ><UiSlider
      class="data-toggle-opacity-slider"
      min="0"
      max="100"
      :step="String(opacity.step)"
      :model-value="String(opacity.percent)"
      :aria-label="opacity.ariaLabel"
      :aria-valuetext="opacity.valueText"
      @update:model-value="onChange"
      @dblclick="onReset"
    /><span class="data-toggle-opacity-value">{{
      opacity.valueText
    }}</span></div
  >
</template>
