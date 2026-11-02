<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import UiPanel from '../kit/UiPanel.vue';
import { usePanelChromeStore } from '../stores/panelChrome.js';
import { vPanelState } from './panelState.js';

// A panel PanelChrome owns: a collapsible UiPanel whose state classes
// (vPanelState) and collapse button follow the panel chrome store, with the
// button's clicks forwarded to PanelChrome. Every other prop, attribute and
// slot passes through to UiPanel.
defineOptions({ inheritAttrs: false });
const props = defineProps({
  id: { type: String, required: true },
  /** Whether the markup starts collapsed, until PanelChrome presents it. */
  startCollapsed: { type: Boolean, default: false },
});

const chrome = usePanelChromeStore();
const { panels } = storeToRefs(chrome);
const collapsedNow = computed(
  () => panels.value[props.id]?.collapsed ?? props.startCollapsed,
);
</script>

<template>
  <UiPanel
    v-panel-state="props.id"
    v-bind="$attrs"
    :id="props.id"
    :class="{ collapsed: props.startCollapsed }"
    :data-panel-id="props.id"
    collapsible
    :collapsed="collapsedNow"
    @update:collapsed="chrome.act('toggle', props.id)"
  >
    <template v-for="(_, name) in $slots" #[name]
      ><slot :name="name"
    /></template>
  </UiPanel>
</template>
