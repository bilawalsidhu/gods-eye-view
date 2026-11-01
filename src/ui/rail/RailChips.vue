<script setup>
import UiButton from '../kit/UiButton.vue';

// Keyed chips shared by rail cards; the owner decides what a click does.
defineProps({
  chips: { type: Array, default: () => [] },
  onSelect: { type: Function, default: () => {} },
});

const chipClass = (chip) =>
  `data-toggle-chip chip-${chip.state || (chip.active ? 'active' : 'idle')}`;
</script>

<template>
  <UiButton
    v-for="chip in chips"
    :key="chip.id"
    :data-chip-id="chip.id"
    :class="chipClass(chip)"
    :pressed="Boolean(chip.active)"
    pressed-class="active"
    :style="chip.color ? `--chip-color: ${chip.color}` : undefined"
    :data-chip-color="chip.color || undefined"
    :title="chip.title || undefined"
    :disabled="Boolean(chip.disabled)"
    :aria-busy="String(Boolean(chip.busy))"
    @click="onSelect(chip)"
    >{{ chip.label }}</UiButton
  >
</template>
