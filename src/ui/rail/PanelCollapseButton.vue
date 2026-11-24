<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import UiPanelToggle from '../kit/UiPanelToggle.vue';
import { usePanelChromeStore } from '../stores/panelChrome.js';

// The collapse button of a panel not built on UiPanel: it follows the panel's
// state in the panel chrome store, and a click asks PanelChrome to toggle it.
// Until PanelChrome presents the panel it follows the markup's state.
const props = defineProps({
  target: { type: String, required: true },
  /** The panel's name in "Expand {name}", already translated. */
  name: { type: String, default: undefined },
  sideways: { type: Boolean, default: false },
  /** Whether the panel's markup starts collapsed. */
  startCollapsed: { type: Boolean, default: false },
});

const chrome = usePanelChromeStore();
const { panels } = storeToRefs(chrome);
const collapsedNow = computed(
  () => panels.value[props.target]?.collapsed ?? props.startCollapsed,
);
</script>

<template>
  <UiPanelToggle
    :target="target"
    :name="name"
    :sideways="sideways"
    :collapsed="collapsedNow"
    @update:collapsed="chrome.act('toggle', target)"
  />
</template>
