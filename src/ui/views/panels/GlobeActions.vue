<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { useGlobeActionsStore } from '../../stores/globeActions.js';
import GlobeCompass from './GlobeCompass.vue';
import { useHudStore } from '../../stores/hud.js';

// The top-center camera and share actions. The shell answers the buttons
// through the store and publishes a clear under way, which keeps the button
// focusable and marks it busy, and the camera's tilt and heading. The heading
// changes on every frame a rotating camera draws, so only the compass reads
// it; the bar renders again only when the tilt changes.
const globe = useGlobeActionsStore();
const { clearBusy, resetBusy, camera } = storeToRefs(globe);
const { act } = globe;
const tilted = computed(() => Boolean(camera.value?.tilted));
const hud = useHudStore();
const minimal = computed(() => hud.hud?.variant === 'minimal');
</script>

<template>
<nav id="top-center-actions" :aria-label="t('Globe actions')">
  <button id="clear-selected-layers" type="button" :aria-label="clearBusy ? t('Clearing selected data layers') : t('Clear selected data layers')" :aria-disabled="clearBusy == null ? undefined : String(clearBusy)" :aria-busy="clearBusy == null ? undefined : String(clearBusy)" :title="t('Turn off all selected data layers')" @click="act('clear')">
    <svg v-if="minimal" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5M3 2l18 20" /></svg>
    <span v-else class="material-symbols-outlined" aria-hidden="true">layers_clear</span>
  </button>
  <button id="share-btn" type="button" :aria-label="t('Copy share link')" :title="t('Copy share link')" @click="act('share')">
    <svg v-if="minimal" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m10 13 4-4M8 15l-2 2a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0m2 1 3-3a3 3 0 0 1 4 4l-5 5a3 3 0 0 1-4 0" /></svg>
    <span v-else class="share-icon" aria-hidden="true">&#x1F517;</span>
  </button>
  <button id="tilt-map-view" type="button" :aria-label="tilted ? t('Return map to straight-down view') : t('Tilt map to oblique view')" :aria-pressed="String(tilted)" :title="t('Toggle straight-down and tilted map views')" @click="act('tilt')">
    <svg v-if="minimal" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 8 9-5 9 5-9 5-9-5Zm0 0v8l9 5 9-5V8m-9 5v8" /></svg>
    <span v-else class="material-symbols-outlined" aria-hidden="true">view_in_ar</span>
  </button>
  <GlobeCompass @click="act('northUp')" />
  <button id="reset-globe-view" type="button" :aria-label="resetBusy ? t('Resetting to full globe view') : t('Reset to full globe view')" :title="t('Reset camera and return to full globe view')" @click="act('reset')">
    <svg v-if="minimal" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>
    <span v-else class="material-symbols-outlined" aria-hidden="true">public</span>
  </button>
</nav>
</template>
