<script setup>
// A row's start and end pickers on one line (e.g. the Shipwrecks period).
// Both ends share one option list; `onSelect` reports which end moved
// ('from' or 'to') and the chosen option value.
defineProps({
  range: { type: Object, required: true },
  onSelect: { type: Function, default: () => {} },
});
</script>

<template>
  <div class="data-toggle-range" :data-range-id="range.id"
    ><div class="data-toggle-slider-head"
      ><span class="data-toggle-slider-label">{{ range.label }}</span
      ><span class="data-toggle-slider-value gev-slider-value">{{
        range.valueText
      }}</span></div
    ><div class="data-toggle-range-ends"
      ><label
        v-for="end in ['from', 'to']"
        :key="end"
        class="data-toggle-range-end"
        ><span class="data-toggle-range-caption">{{ range[end].label }}</span
        ><select
          class="data-toggle-range-select"
          :data-range-end="end"
          :aria-label="range[end].ariaLabel || undefined"
          :value="String(range[end].value)"
          @change="onSelect(end, $event.target.value)"
          ><option
            v-for="option in range.options"
            :key="option.value"
            :value="String(option.value)"
            >{{ option.label }}</option
          ></select
        ></label
      ></div
    ></div
  >
</template>
