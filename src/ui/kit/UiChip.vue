<script setup>
// Core's chip: a label that says what something is, never a control. It
// wears Core's read-only chip (chip.css: a pill of small uppercase mono
// text), and `selected` its accent; feature classes the caller passes
// restyle it. A chip that presses is a UiButton with pressedClass.
defineProps({
  selected: { type: Boolean, default: false },
  mono: { type: Boolean, default: false },
});
</script>

<template>
  <span
    class="ui-chip"
    :class="{ 'ui-chip--selected': selected, 'ui-mono': mono }"
  >
    <slot />
  </span>
</template>
