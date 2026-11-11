<script setup>
import { storeToRefs } from 'pinia';
import { useWindInspectionStore } from '../../stores/windInspection.js';

// The inspected wind point, inside the container the wind layer renders in,
// where the marker owner (src/layers/wind/inspectionMarker.js) places it.
const { marker } = storeToRefs(useWindInspectionStore());

const markerStyle =
  'position:absolute;width:18px;height:18px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 2px #153440,0 0 0 5px rgba(102,225,242,.35);transform:translate(-50%,-50%);pointer-events:none;z-index:150;';
</script>

<template>
  <Teleport v-if="marker" :to="marker.container">
    <div class="gev-wind-inspection-marker" aria-hidden="true" :hidden="!marker.visible" :style="[markerStyle, { left: `${marker.left}px`, top: `${marker.top}px` }]"></div>
  </Teleport>
</template>
