<script setup>
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps({
  text: { type: String, required: true },
  /** Which side of the trigger the tip opens on. */
  side: { type: String, default: 'right' },
  disabled: { type: Boolean, default: false },
  /** Milliseconds the pointer rests before the tip shows. */
  delay: { type: Number, default: 0 },
});

const open = ref(false);
let timer = null;

function show() {
  if (props.disabled) return;
  clearTimeout(timer);
  if (props.delay > 0)
    timer = setTimeout(() => (open.value = true), props.delay);
  else open.value = true;
}

function hide() {
  clearTimeout(timer);
  timer = null;
  open.value = false;
}

onBeforeUnmount(hide);
</script>

<template>
  <span
    class="ui-tooltip"
    @pointerenter="show"
    @pointerleave="hide"
    @focusin="show"
    @focusout="hide"
  >
    <slot />
    <span
      v-if="open && !disabled"
      class="ui-tooltip__tip"
      :class="`ui-tooltip__tip--${side}`"
      role="tooltip"
      >{{ text }}</span
    >
  </span>
</template>
