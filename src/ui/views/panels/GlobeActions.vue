<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { useGlobeActionsStore } from '../../stores/globeActions.js';
import GlobeCompass from './GlobeCompass.vue';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// The top-center camera and share actions. The shell answers the buttons
// through the store and publishes a clear under way, which keeps the button
// focusable and marks it busy, and the camera's tilt and heading. The heading
// changes on every frame a rotating camera draws, so only the compass reads
// it; the bar renders again only when the tilt changes.
const globe = useGlobeActionsStore();
const { clearBusy, resetBusy, camera } = storeToRefs(globe);
const { act } = globe;
const tilted = computed(() => Boolean(camera.value?.tilted));
</script>

<template>
<nav id="top-center-actions" :aria-label="t('Globe actions')">
  <UiButton id="clear-selected-layers" :aria-label="clearBusy ? t('Clearing selected data layers') : t('Clear selected data layers')" :aria-disabled="clearBusy == null ? undefined : String(clearBusy)" :aria-busy="clearBusy == null ? undefined : String(clearBusy)" :title="t('Turn off all selected data layers')" @click="act('clear')">
    <UiIcon name="layers_clear" :size="null" />
  </UiButton>
  <UiButton id="share-btn" :aria-label="t('Copy share link')" :title="t('Copy share link')" @click="act('share')">
    <span class="share-icon" aria-hidden="true">&#x1F517;</span>
  </UiButton>
  <UiButton id="tilt-map-view" :aria-label="tilted ? t('Return map to straight-down view') : t('Tilt map to oblique view')" :pressed="tilted" :title="t('Toggle straight-down and tilted map views')" @click="act('tilt')">
    <UiIcon name="view_in_ar" :size="null" />
  </UiButton>
  <GlobeCompass @click="act('northUp')" />
  <UiButton id="reset-globe-view" :aria-label="resetBusy ? t('Resetting to full globe view') : t('Reset to full globe view')" :title="t('Reset camera and return to full globe view')" @click="act('reset')">
    <UiIcon name="public" :size="null" />
  </UiButton>
</nav>
</template>
