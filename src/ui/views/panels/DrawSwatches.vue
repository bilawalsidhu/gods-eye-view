<script setup>
import { onMounted } from 'vue';
import { t } from '../../../i18n/index.js';
import {
  DRAW_COLORS,
  DRAW_COLOR_CSS,
  DRAW_COLOR_NAMES,
} from '../../../annotations/drawMarks.js';

// Draw's five colours as one radio group: the next shape's colour and a
// drawn shape's picker. Only the checked colour is a tab stop; the arrows,
// Home and End move to and choose another, as a radio group's do. Each swatch
// shows its colour from DRAW_COLOR_CSS, the same value the shape is drawn in.
// The template is one line: templates keep whitespace.
const props = defineProps({
  modelValue: { type: String, default: 'primary' },
  /** The group's accessible name, already translated. */
  label: { type: String, required: true },
  /** Focus the checked colour once shown (a picker that just opened). */
  autofocus: { type: Boolean, default: false },
});
// `choose` is a click: a picker closes on it, and stays open for the arrows.
const emit = defineEmits(['update:modelValue', 'choose']);
const buttons = [];
const STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function onKey(event) {
  const from = Math.max(0, DRAW_COLORS.indexOf(props.modelValue));
  let to;
  if (STEPS[event.key])
    to = (from + STEPS[event.key] + DRAW_COLORS.length) % DRAW_COLORS.length;
  else if (event.key === 'Home') to = 0;
  else if (event.key === 'End') to = DRAW_COLORS.length - 1;
  else return;
  event.preventDefault();
  buttons[to]?.focus();
  if (to !== from) emit('update:modelValue', DRAW_COLORS[to]);
}

onMounted(() => {
  if (props.autofocus)
    buttons[Math.max(0, DRAW_COLORS.indexOf(props.modelValue))]?.focus();
});
</script>

<template>
  <div class="draw-colors" role="radiogroup" :aria-label="props.label" @keydown="onKey"><button v-for="(color, index) in DRAW_COLORS" :key="color" :ref="(el) => (buttons[index] = el)" type="button" class="draw-color" :class="{ active: color === props.modelValue }" role="radio" :data-color="color" :data-control="`color-${color}`" :aria-checked="String(color === props.modelValue)" :tabindex="color === props.modelValue ? 0 : -1" :style="{ background: DRAW_COLOR_CSS[color] }" :title="t(DRAW_COLOR_NAMES[color])" :aria-label="t(DRAW_COLOR_NAMES[color])" @click="emit('update:modelValue', color), emit('choose', color)"></button></div>
</template>
