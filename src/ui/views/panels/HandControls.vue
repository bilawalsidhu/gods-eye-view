<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import { useDisplayStore } from '../../stores/display.js';

// UTILITIES ▸ Hands: turns the webcam hand control on and off. The panel
// itself (preview, status, gesture list) belongs to src/handControl/panel.js,
// which publishes whether it is on and answers the toggle through the store.
const display = useDisplayStore();
const { hands } = storeToRefs(display);
</script>

<template>
  <div class="pp-toggle-group" id="hand-control-group">
    <UiButton class="pp-toggle-btn" :pressed="hands?.active ?? false" pressed-class="active" id="hand-control-toggle" @click="display.act('toggleHands')" :title="t('Hand control — steer the map with gestures seen by the webcam')">
      <span class="pp-icon material-symbols-outlined" aria-hidden="true">back_hand</span>
      <span class="pp-label">{{ t('Hands') }}</span>
    </UiButton>
  </div>
</template>
