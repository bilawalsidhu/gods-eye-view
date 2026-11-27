<script setup>
import { computed, nextTick, watch } from 'vue';
import { t } from '../i18n/index.js';
import UiRail from './kit/UiRail.vue';
import {
  PANEL_RAIL_FALLBACK_ICON,
  PANEL_RAIL_ITEMS,
} from './panelRailCatalog.js';
import { usePanelStore } from './stores/panels.js';

const props = defineProps({
  /** `left` or `right`. */
  side: { type: String, required: true },
  /** Open or close a panel; receives the panel id. */
  onSelect: { type: Function, required: true },
});

const panels = usePanelStore();
const items = computed(() =>
  panels.sides[props.side]
    .filter((panel) => panel.available)
    .map((panel) => {
      const item = PANEL_RAIL_ITEMS[panel.id];
      return {
        id: panel.id,
        icon: item?.icon ?? PANEL_RAIL_FALLBACK_ICON,
        // Static markup is translated at boot, so a host's title already is.
        label: item
          ? t(item.label, item.context && { context: item.context })
          : panel.title,
      };
    }),
);
const active = computed(() => panels.openPanelId(props.side));
// A rail with one entry whose panel is open has nothing to offer: it hides,
// and the panel's own header closes it (its ▶, Esc and the shortcut). Folded,
// the panel's tab and the icon show again. Focus on the hidden icon moves to
// the panel's header.
const soleOpen = computed(
  () => items.value.length === 1 && active.value !== null,
);
watch(soleOpen, async (hidden) => {
  if (!hidden) return;
  const doc = globalThis.document;
  const id = active.value;
  if (!doc?.activeElement?.closest?.(`[data-rail-item="${id}"]`)) return;
  await nextTick();
  doc
    .getElementById(id)
    ?.querySelector('.panel-header button, .ui-panel__header button, button')
    ?.focus({ preventScroll: true });
});
const label = computed(() =>
  props.side === 'left' ? t('Left panels') : t('Right panels'),
);
</script>

<template>
  <UiRail
    :items="items"
    :active="active"
    :side="side"
    :label="label"
    :panel-open="active !== null"
    collapsible
    :class="{ 'ui-rail--sole-open': soleOpen }"
    @select="onSelect"
  />
</template>
