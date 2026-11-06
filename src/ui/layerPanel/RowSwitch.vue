<script setup>
import UiSegmented from '../kit/UiSegmented.vue';

// A row's one-of-many switch (e.g. Active Fires confidence). Options carry
// the same fields as chips, so the owner resolves a choice the way it
// resolves a chip; `label` is an optional caption beside the group.
defineProps({
  segmented: { type: Object, required: true },
  onSelect: { type: Function, default: () => {} },
});

const options = (segmented) =>
  (segmented.options || []).map((option) => ({
    value: option.id,
    label: option.label,
    disabled: Boolean(option.disabled),
    attrs: { 'data-chip-id': option.id, title: option.title || undefined },
  }));
const activeId = (segmented) =>
  (segmented.options || []).find((option) => option.active)?.id;
</script>

<template>
  <span
    v-if="segmented.label"
    class="data-toggle-segmented-label"
    :data-segmented-caption-for="segmented.id"
    >{{ segmented.label }}</span
  ><UiSegmented
    class="data-toggle-segmented"
    :data-segmented-id="segmented.id"
    :model-value="activeId(segmented)"
    :options="options(segmented)"
    :label="segmented.ariaLabel || segmented.label || ''"
    item-class="data-toggle-segment"
    @update:model-value="onSelect"
  />
</template>
