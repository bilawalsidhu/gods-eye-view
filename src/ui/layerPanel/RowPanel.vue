<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { lendRowPanel, returnRowPanel } from './rowPanelPlacement.js';

// A part of the page lent to a layer's row while the row shows it: Radio's
// local receiver card (its RTL-SDR controls, read once at start-up by id) is
// one element that lives in Radio's fold and moves here, the same element,
// so its controls keep working. It goes back before this slot leaves.
const props = defineProps({
  /** The id of the element the row borrows. */
  elementId: { type: String, required: true },
});
const slot = ref(null);
onMounted(() => lendRowPanel(props.elementId, slot.value));
onBeforeUnmount(() => returnRowPanel(props.elementId, slot.value));
</script>

<template>
  <div ref="slot" class="data-toggle-panel" :data-row-panel="elementId"></div>
</template>
