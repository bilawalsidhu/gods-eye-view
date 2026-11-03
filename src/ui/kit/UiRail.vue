<script setup>
import { computed, onBeforeUnmount, reactive } from 'vue';
import UiIcon from './UiIcon.vue';
import UiTooltip from './UiTooltip.vue';
import { RAIL_PANEL_OPEN_TOOLTIP_DELAY_MS } from './rail.js';

const props = defineProps({
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
  /**
   * Show each item as a labelled pill while no panel is open, and collapse to
   * icons once one is, making room for the panel.
   */
  collapsible: { type: Boolean, default: false },
});
const emit = defineEmits(['select']);
const expanded = computed(() => props.collapsible && !props.panelOpen);

// A label cut short by the pill's width keeps its tip, so the full name can
// still be read. Each label is measured whenever its box changes size, which
// includes the moment it settles after expanding.
const truncated = reactive(new Set());
const labelIds = new WeakMap();
const labelElements = new Map();
const labelObserver =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        for (const { target } of entries) {
          const id = labelIds.get(target);
          if (target.scrollWidth > target.clientWidth) truncated.add(id);
          else truncated.delete(id);
        }
      })
    : null;
function trackLabel(id, element) {
  const previous = labelElements.get(id);
  if (previous === element) return;
  if (previous) {
    labelObserver?.unobserve(previous);
    labelElements.delete(id);
    truncated.delete(id);
  }
  if (!element) return;
  labelElements.set(id, element);
  labelIds.set(element, id);
  labelObserver?.observe(element);
}
onBeforeUnmount(() => labelObserver?.disconnect());
const tipHidden = (item) =>
  (expanded.value && !truncated.has(item.id)) ||
  (props.panelOpen && item.id === props.active);
</script>

<template>
  <nav
    class="ui-rail"
    :class="[
      `ui-rail--${side}`,
      { 'ui-rail--collapsible': collapsible, 'ui-rail--expanded': expanded },
    ]"
    :aria-label="label"
  >
    <template v-for="item in items" :key="item.id">
      <i v-if="item.separatorBefore" class="ui-rail__sep" aria-hidden="true" />
      <UiTooltip
        :text="item.label"
        :side="side === 'left' ? 'right' : 'left'"
        :disabled="tipHidden(item)"
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
          <span
            v-if="collapsible"
            :ref="(element) => trackLabel(item.id, element)"
            class="ui-rail__label"
            aria-hidden="true"
            >{{ item.label }}</span
          >
          <span v-if="item.badge !== undefined" class="ui-rail__badge">{{
            item.badge
          }}</span>
        </button>
      </UiTooltip>
    </template>
  </nav>
</template>
