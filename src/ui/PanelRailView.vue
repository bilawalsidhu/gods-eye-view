<script setup>
import { computed } from 'vue';
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
        label: item ? t(item.label) : panel.title,
      };
    }),
);
const active = computed(() => panels.openPanelId(props.side));
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
    @select="onSelect"
  />
</template>
