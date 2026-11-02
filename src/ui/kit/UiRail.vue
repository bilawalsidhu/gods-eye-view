<script setup>
import UiIcon from './UiIcon.vue';
import UiTooltip from './UiTooltip.vue';
import { RAIL_PANEL_OPEN_TOOLTIP_DELAY_MS } from './rail.js';

defineProps({
  /** @type {import('vue').PropType<import('./rail.js').UiRailItem[]>} */
  items: { type: Array, required: true },
  /** The selected item's id, or null. */
  active: { type: String, default: null },
  /** `left` or `right`: the screen edge the rail sits on. */
  side: { type: String, required: true },
  /** The nav's accessible name. */
  label: { type: String, required: true },
  /**
   * A panel is open beside the rail: the open item's tip is redundant with the
   * panel's title, and the other tips wait for the pointer to rest.
   */
  panelOpen: { type: Boolean, default: false },
});
const emit = defineEmits(['select']);
</script>

<template>
  <nav class="ui-rail" :class="`ui-rail--${side}`" :aria-label="label">
    <template v-for="item in items" :key="item.id">
      <i v-if="item.separatorBefore" class="ui-rail__sep" aria-hidden="true" />
      <UiTooltip
        :text="item.label"
        :side="side === 'left' ? 'right' : 'left'"
        :disabled="panelOpen && item.id === active"
        :delay="panelOpen ? RAIL_PANEL_OPEN_TOOLTIP_DELAY_MS : 0"
      >
        <button
          type="button"
          class="ui-rail__item"
          :class="{ 'ui-rail__item--on': item.id === active }"
          :data-rail-item="item.id"
          :aria-label="item.label"
          :aria-pressed="item.id === active"
          :disabled="item.disabled"
          @click="emit('select', item.id)"
        >
          <UiIcon :name="item.icon" />
          <span v-if="item.badge !== undefined" class="ui-rail__badge">{{
            item.badge
          }}</span>
        </button>
      </UiTooltip>
    </template>
  </nav>
</template>
