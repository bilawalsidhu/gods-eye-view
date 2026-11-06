<script setup>
import UiButton from '../kit/UiButton.vue';

// Keyed chips shared by rail cards; the owner decides what a click does.
// An `icon` chip shows a Material Symbol (named in index.html's `icon_names`
// subset) with its label as the accessible name and tip; an `action` chip
// (Zoom, Remove) is a plain button, not an on/off toggle.
defineProps({
  chips: { type: Array, default: () => [] },
  onSelect: { type: Function, default: () => {} },
});

const chipClass = (chip) =>
  `data-toggle-chip chip-${chip.state || (chip.active ? 'active' : 'idle')}${chip.icon ? ' chip-icon' : ''}`;
</script>

<template>
  <UiButton
    v-for="chip in chips"
    :key="chip.id"
    :data-chip-id="chip.id"
    :class="chipClass(chip)"
    :pressed="chip.action ? undefined : Boolean(chip.active)"
    pressed-class="active"
    :style="chip.color ? `--chip-color: ${chip.color}` : undefined"
    :data-chip-color="chip.color || undefined"
    :label="chip.icon ? chip.label : undefined"
    :title="chip.title || (chip.icon ? chip.label : undefined)"
    :disabled="Boolean(chip.disabled)"
    :aria-busy="String(Boolean(chip.busy))"
    @click="onSelect(chip)"
    ><span
      v-if="chip.icon"
      class="material-symbols-outlined"
      aria-hidden="true"
      >{{ chip.icon }}</span
    ><template v-else>{{ chip.label }}</template></UiButton
  >
</template>
