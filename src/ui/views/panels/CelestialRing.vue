<script setup>
import { storeToRefs } from 'pinia';
import { useCelestialRingStore } from '../../stores/celestialRing.js';

// The full-globe sun/moon ring, inside the viewer's container, as the ring
// owner (src/celestialRing.js) presents it.
const { ring, controls } = storeToRefs(useCelestialRingStore());

// Each canvas goes to the owner it was rendered for, which paints it.
const vRingCanvas = {
  mounted(el, { value }) {
    controls.value?.attach(value.owner, value.kind, el);
  },
  beforeUnmount(el, { value }) {
    controls.value?.attach(value.owner, value.kind, null);
  },
};
const px = (value) => `${value}px`;
const layerStyle = (layer) => ({
  ...(ring.value.size && {
    width: px(ring.value.size.width),
    height: px(ring.value.size.height),
  }),
  ...(layer && { transform: layer.transform, opacity: layer.opacity }),
});
// The outline is hidden before it has ever been placed.
const outlineStyle = (outline) =>
  outline && {
    display: outline.hidden ? 'none' : '',
    ...(outline.width != null && {
      left: px(outline.left),
      top: px(outline.top),
      width: px(outline.width),
      height: px(outline.height),
    }),
  };
const markerStyle = (marker) =>
  marker && {
    left: px(marker.left),
    top: px(marker.top),
    opacity: marker.opacity,
  };
</script>

<template>
  <Teleport v-if="ring" :to="ring.container">
    <div :key="ring.id" id="celestial-ring-overlay" class="celestial-ring-overlay" :class="{ visible: ring.visible, disabled: !ring.enabled }" aria-hidden="true" :data-globe-visible="ring.globeVisible ?? undefined" :data-ephemeris-updates="ring.ephemerisUpdates ?? undefined"><div class="celestial-ring-outline" :style="outlineStyle(ring.outline)"></div><canvas v-ring-canvas="{ owner: ring.owner, kind: 'sun' }" class="celestial-ring-canvas celestial-sun-canvas" :style="layerStyle(ring.sun)"></canvas><canvas v-ring-canvas="{ owner: ring.owner, kind: 'moon' }" class="celestial-ring-canvas celestial-moon-canvas" :style="layerStyle(ring.moon)"></canvas><span class="celestial-marker celestial-sun material-symbols-outlined" :style="markerStyle(ring.sunMarker)">light_mode</span><span class="celestial-marker celestial-moon material-symbols-outlined" :style="markerStyle(ring.moonMarker)">dark_mode</span></div>
  </Teleport>
</template>
