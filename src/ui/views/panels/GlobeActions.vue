<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useGlobeActionsStore } from '../../stores/globeActions.js';

// The top-center camera and share actions. The shell answers the clear and
// share buttons through the store and publishes a clear under way, which
// keeps the button focusable and marks it busy.
const globe = useGlobeActionsStore();
const { clearBusy } = storeToRefs(globe);
const { act } = globe;
</script>

<template>
<nav id="top-center-actions" aria-label="Globe actions" data-i18n-aria-label>
  <button id="clear-selected-layers" type="button" :aria-label="clearBusy ? t('Clearing selected data layers') : t('Clear selected data layers')" :aria-disabled="clearBusy == null ? undefined : String(clearBusy)" :aria-busy="clearBusy == null ? undefined : String(clearBusy)" title="Turn off all selected data layers" data-i18n-title @click="act('clear')">
    <span class="material-symbols-outlined" aria-hidden="true">layers_clear</span>
  </button>
  <button id="share-btn" type="button" aria-label="Copy share link" title="Copy share link" data-i18n-aria-label data-i18n-title @click="act('share')">
    <span class="share-icon" aria-hidden="true">&#x1F517;</span>
  </button>
  <button id="tilt-map-view" type="button" aria-label="Tilt map to oblique view" aria-pressed="false" title="Toggle straight-down and tilted map views" data-i18n-aria-label data-i18n-title>
    <span class="material-symbols-outlined" aria-hidden="true">view_in_ar</span>
  </button>
  <button id="north-up-view" type="button" aria-label="Reset map to north up" title="Reset map bearing to north" data-i18n-aria-label data-i18n-title>
    <span class="camera-compass-n" aria-hidden="true">N</span>
    <span class="camera-compass-needle material-symbols-outlined" aria-hidden="true">navigation</span>
  </button>
  <button id="reset-globe-view" type="button" aria-label="Reset to full globe view" title="Reset camera and return to full globe view" data-i18n-aria-label data-i18n-title>
    <span class="material-symbols-outlined" aria-hidden="true">public</span>
  </button>
</nav>
</template>
