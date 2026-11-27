<script setup>
import UiButton from '../kit/UiButton.vue';
import UiIcon from '../kit/UiIcon.vue';

// Keyed chips shared by rail cards; the owner decides what a click does.
// An `icon` chip shows a Material Symbol (named in index.html's `icon_names`
// subset) with its label as the accessible name and tip; an `action` chip
// (Zoom, Remove) is a plain button, not an on/off toggle. A `swatch` chip
// (a CSS colour) keys what it turns on: the colour before its label and, with
// `countText`, how many after it; the owner leaves both off a chip that is off.
defineProps({
  chips: { type: Array, default: () => [] },
  onSelect: { type: Function, default: () => {} },
});

const chipClass = (chip) =>
  `data-toggle-chip chip-${chip.state || (chip.active ? 'active' : 'idle')}${chip.icon ? ' chip-icon' : ''}${chip.swatch && !chip.icon ? ' chip-keyed' : ''}`;
</script>

<template>
  <UiButton
    v-for="chip in chips"
    :key="chip.id"
    :data-chip-id="chip.id"
    :data-chip-icon="chip.icon || undefined"
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
    ><UiIcon v-if="chip.icon" :name="chip.icon" :size="null" /><template
      v-else-if="chip.swatch"
      ><span
        class="data-toggle-chip-swatch"
        aria-hidden="true"
        :style="{ background: chip.swatch }"
      ></span
      ><span>{{ chip.label }}</span
      ><template v-if="chip.countText"
        >{{ ' '
        }}<span class="data-toggle-chip-count">{{
          chip.countText
        }}</span></template
      ></template
    ><template v-else>{{ chip.label }}</template></UiButton
  >
</template>
