<script setup>
import { storeToRefs } from 'pinia';
import { useAwarenessDirectionStore } from '../../stores/awarenessDirection.js';

// The Global Context compass and the nearest contacts' bearings, inside the
// viewer's container, as the awareness layer presents them.
const { overlay } = storeToRefs(useAwarenessDirectionStore());

// A part keeps no inline placement until the layer first places it.
const place = (part) =>
  part.left === null ? undefined : { left: part.left, top: part.top };
</script>

<template>
  <Teleport v-if="overlay" :to="overlay.container">
    <div id="military-awareness-direction-overlay" :hidden="overlay.hidden" aria-hidden="true"><span v-for="label in overlay.labels" :key="label.label" :class="`military-awareness-compass-label cardinal-${label.label.toLowerCase()}`" :data-bearing="String(label.bearing)" :style="place(label)">{{ label.label }}</span><div class="military-awareness-compass-ring" :style="overlay.ring ?? undefined"></div><span class="military-awareness-compass-heading" :style="place(overlay.heading)">{{ overlay.heading.text }}</span><div v-for="(marker, index) in overlay.markers" :key="index" class="military-awareness-direction-marker" :hidden="marker.hidden" :style="marker.style ?? undefined"><span class="military-awareness-direction-arrow" :style="marker.arrow ?? undefined">➜</span><span class="military-awareness-direction-label" :style="marker.caption.style ?? undefined">{{ marker.caption.text }}</span></div></div>
  </Teleport>
</template>
