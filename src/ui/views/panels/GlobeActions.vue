<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { useGlobeActionsStore } from '../../stores/globeActions.js';
import GlobeCompass from './GlobeCompass.vue';

// The top-center camera and share actions. The shell answers the buttons
// through the store and publishes a clear under way, which keeps the button
// focusable and marks it busy, and the camera's tilt and heading. The heading
// changes on every frame a rotating camera draws, so only the compass reads
// it; the bar renders again only when the tilt changes.
const globe = useGlobeActionsStore();
const { clearBusy, camera } = storeToRefs(globe);
const { act } = globe;
const tilted = computed(() => Boolean(camera.value?.tilted));
</script>

<template>
<nav id="top-center-actions" aria-label="Globe actions" data-i18n-aria-label>
  <button id="clear-selected-layers" type="button" :aria-label="clearBusy ? t('Clearing selected data layers') : t('Clear selected data layers')" :aria-disabled="clearBusy == null ? undefined : String(clearBusy)" :aria-busy="clearBusy == null ? undefined : String(clearBusy)" title="Turn off all selected data layers" data-i18n-title @click="act('clear')">
    <span class="material-symbols-outlined" aria-hidden="true">layers_clear</span>
  </button>
  <button id="share-btn" type="button" aria-label="Copy share link" title="Copy share link" data-i18n-aria-label data-i18n-title @click="act('share')">
    <span class="share-icon" aria-hidden="true">&#x1F517;</span>
  </button>
  <button id="tilt-map-view" type="button" :aria-label="tilted ? t('Return map to straight-down view') : t('Tilt map to oblique view')" :aria-pressed="String(tilted)" title="Toggle straight-down and tilted map views" data-i18n-title @click="act('tilt')">
    <span class="material-symbols-outlined" aria-hidden="true">view_in_ar</span>
  </button>
  <GlobeCompass @click="act('northUp')" />
  <button id="reset-globe-view" type="button" aria-label="Reset to full globe view" title="Reset camera and return to full globe view" data-i18n-aria-label data-i18n-title>
    <span class="material-symbols-outlined" aria-hidden="true">public</span>
  </button>
</nav>
</template>
