<script setup>
// Keyed chips shared by rail cards; the owner decides what a click does.
defineProps({
  chips: { type: Array, default: () => [] },
  onSelect: { type: Function, default: () => {} },
});

const chipClass = (chip) =>
  `data-toggle-chip chip-${chip.state || (chip.active ? 'active' : 'idle')}${chip.active ? ' active' : ''}`;
</script>

<template>
  <button
    v-for="chip in chips"
    :key="chip.id"
    type="button"
    :data-chip-id="chip.id"
    :class="chipClass(chip)"
    :style="chip.color ? `--chip-color: ${chip.color}` : undefined"
    :data-chip-color="chip.color || undefined"
    :title="chip.title || undefined"
    :disabled="Boolean(chip.disabled)"
    :aria-pressed="String(Boolean(chip.active))"
    :aria-busy="String(Boolean(chip.busy))"
    @click="onSelect(chip)"
    >{{ chip.label }}</button
  >
</template>
