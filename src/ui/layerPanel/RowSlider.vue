<script setup>
import { computed, ref, shallowRef } from 'vue';
import UiSlider from '../kit/UiSlider.js';

// A row's quantitative slider (e.g. the Active Fires minimum-FRP filter).
// `track` is a CSS background painting the runnable track, so a color ramp
// doubles as the legend; each tick sits at `at` (0..1) along it. The input
// holds its position while focused, so a refresh from its own tick never
// moves the thumb under the pointer.
const props = defineProps({
  slider: { type: Object, required: true },
  onInput: { type: Function, default: () => {} },
});

const draft = ref(null);
const focusedInput = shallowRef(null);
const valueText = computed((previous) => {
  const { value, valueText, previewText, commitOnChange } = props.slider;
  if (draft.value != null) return previewText?.(draft.value) ?? valueText;
  // UiSlider holds the focused thumb through external changes. Keep its full
  // readout until the owner presents that stop again or the thumb loses focus.
  if (
    commitOnChange &&
    focusedInput.value &&
    focusedInput.value.value !== String(value)
  )
    return previous;
  return valueText;
});

function update(value) {
  if (props.slider.commitOnChange) draft.value = value;
  else props.onInput(value);
}

function commit(event) {
  if (!props.slider.commitOnChange) return;
  const value = event.currentTarget.valueAsNumber;
  draft.value = null;
  if (value !== props.slider.value) props.onInput(value);
}
</script>

<template>
  <div class="data-toggle-slider" :data-slider-id="slider.id"
    ><div class="data-toggle-slider-head"
      ><span class="data-toggle-slider-label">{{ slider.label }}</span
      ><span class="data-toggle-slider-value gev-slider-value">{{
        valueText
      }}</span></div
    ><UiSlider
      class="data-toggle-slider-input"
      :data-slider-id="slider.id"
      :min="slider.min"
      :max="slider.max"
      :step="slider.step ?? 1"
      :model-value="draft ?? slider.value"
      hold
      :aria-label="slider.ariaLabel || undefined"
      :aria-valuetext="valueText || undefined"
      :style="slider.track ? { '--slider-track': slider.track } : undefined"
      @update:model-value="update"
      @change="commit"
      @focus="focusedInput = $event.currentTarget"
      @blur="focusedInput = draft = null"
    /><div class="data-toggle-slider-ticks"
      ><span
        v-for="tick in slider.ticks || []"
        :key="tick.at"
        class="data-toggle-slider-tick"
        :style="{ '--at': `${(tick.at * 100).toFixed(2)}%` }"
        >{{ tick.label }}</span
      ></div
    ></div
  >
</template>
