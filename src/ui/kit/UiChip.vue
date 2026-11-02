<script setup>
// Core's chip: a label that says what something is, never a control.
// Core styles it through the classes its callers pass; the kit classes carry
// no Core styles yet. A chip that presses is a UiButton with pressedClass.
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
