<script setup>
import { storeToRefs } from 'pinia';
import { useMissionReplayStore } from '../../stores/missionReplay.js';

// The replay vehicle, its orbit dot and callout over the globe, where the
// launches layer places them after each rendered frame.
const { overlay } = storeToRefs(useMissionReplayStore());
</script>

<template>
  <Teleport v-if="overlay" defer to="#cesiumContainer">
    <div class="mission-replay-vehicle-overlay" :class="{ 'is-thrusting': overlay.thrusting, 'is-paused': overlay.paused }" :hidden="!overlay.visible" aria-hidden="true" :data-mode="overlay.mode ?? undefined" :style="{ transform: overlay.transform ?? undefined, '--mission-replay-rotation': overlay.rotation ?? undefined }"><div class="mission-replay-flight-symbol" :style="{ opacity: overlay.iconOpacity ?? undefined }"><svg class="mission-replay-rocket" viewBox="0 0 48 72" aria-hidden="true"><path class="mission-replay-rocket-body" d="M24 5C16 14 14 27 15 45L9 54L18 51L24 58L30 51L39 54L33 45C34 27 32 14 24 5Z"></path><circle class="mission-replay-rocket-port" cx="24" cy="29" r="3.4"></circle></svg><svg class="mission-replay-thrust" viewBox="0 0 72 72" aria-hidden="true"><ellipse style="--thrust-index:0" cx="36" cy="7" rx="5" ry="1.8"></ellipse><ellipse style="--thrust-index:1" cx="36" cy="15" rx="8" ry="2.4"></ellipse><ellipse style="--thrust-index:2" cx="36" cy="24" rx="11" ry="3"></ellipse><ellipse style="--thrust-index:3" cx="36" cy="35" rx="15" ry="3.8"></ellipse><ellipse style="--thrust-index:4" cx="36" cy="48" rx="20" ry="4.7"></ellipse><ellipse style="--thrust-index:5" cx="36" cy="63" rx="26" ry="5.8"></ellipse></svg></div><div class="mission-replay-orbit-dot" aria-hidden="true" :style="{ opacity: overlay.iconOpacity ?? undefined }"></div><div class="mission-replay-overlay-callout" :style="{ opacity: overlay.labelOpacity ?? undefined }"><strong data-replay-overlay-title="">{{ overlay.title }}</strong><span data-replay-overlay-detail="">{{ overlay.detail }}</span></div></div>
  </Teleport>
</template>
