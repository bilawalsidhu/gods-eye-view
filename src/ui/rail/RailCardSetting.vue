<script setup>
import { computed, ref, watch } from 'vue';
import RailChips from './RailChips.vue';
import UiSlider from '../kit/UiSlider.js';

// One setting: a chip group and an optional range. The handle's value is held
// until the owner's next update; a range that commits on change keeps it
// across updates until its descriptor changes.
const props = defineProps({
  setting: { type: Object, required: true },
  dispatch: { type: Function, required: true },
});
const draft = ref(null);

watch(
  () => props.setting,
  () => {
    const range = props.setting.range;
    const held = draft.value;
    if (
      held &&
      (held.committed ||
        !range ||
        range.disabled ||
        !range.commitOnChange ||
        ['id', 'param', 'min', 'max', 'step', 'value'].some(
          (key) => range[key] !== held.range[key],
        ))
    )
      draft.value = null;
  },
  { flush: 'sync' },
);

const range = computed(() => props.setting.range);
const value = computed(() => {
  const { min, max } = range.value;
  const candidate = Number(draft.value?.value ?? range.value.value);
  return Math.min(
    Number(max),
    Math.max(Number(min), Number.isFinite(candidate) ? candidate : Number(min)),
  );
});
const valueText = computed(() => `${value.value}${range.value.unit || ''}`);

function rangeParams(input) {
  const current = range.value;
  const next = Number(input.value);
  if (
    !current?.param ||
    current.disabled ||
    !Number.isFinite(next) ||
    next < Number(current.min) ||
    next > Number(current.max)
  )
    return null;
  return { params: { [current.param]: next } };
}

// The handle shows the value again once the owner has answered: an owner
// that clamps or refuses may leave the slider's model where it last
// rendered, and then it would not render.
function place(input) {
  if (!range.value) return;
  const next = String(value.value);
  if (input.value !== next) input.value = next;
}

function onInput(event) {
  const params = rangeParams(event.target);
  if (!params) return;
  // The readout follows the handle at once, whether or not the owner redraws.
  draft.value = { range: range.value, value: Number(event.target.value) };
  if (range.value.commitOnChange) return;
  props.dispatch(params);
  place(event.target);
}

function onChange(event) {
  if (!range.value?.commitOnChange) return;
  const params = rangeParams(event.target);
  // Committed: the next update shows the owner's value, as before.
  if (draft.value) draft.value = { ...draft.value, committed: true };
  if (params) props.dispatch(params);
  place(event.target);
}
</script>

<template>
  <span class="rail-card-setting-label panel-title">{{ setting.label }}</span
  ><div class="rail-card-chips" role="group" :aria-label="setting.label"
    ><RailChips :chips="setting.chips" :on-select="dispatch" /></div
  ><div class="rail-card-setting-range-row" :hidden="!range"
    ><template v-if="range"
      ><span class="rail-card-setting-range-label" :hidden="!range.label">{{
        range.label || ''
      }}</span
      ><UiSlider
        class="rail-card-setting-range"
        :data-range-id="range.id || setting.id"
        :min="String(Number(range.min))"
        :max="String(Number(range.max))"
        :step="String(Number(range.step))"
        :model-value="String(value)"
        :disabled="Boolean(range.disabled)"
        :aria-label="range.ariaLabel || setting.label"
        :aria-valuetext="valueText"
        @input="onInput"
        @change="onChange"
      /><span class="rail-card-setting-range-value">{{
        valueText
      }}</span></template
    ></div
  >
</template>
