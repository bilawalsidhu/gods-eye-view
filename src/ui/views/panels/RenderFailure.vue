<script setup>
import { nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { msg, t } from '../../../i18n/index.js';
import { useStatusStore } from '../../stores/status.js';
import UiButton from '../../kit/UiButton.vue';

// The notice installRenderFailureNotice() (src/ui/renderFailure.js) publishes
// while the globe cannot draw, with the actions it offers.
const { renderFailure: failure } = storeToRefs(useStatusStore());
const panel = ref(null);
const MESSAGES = {
  'context-lost': msg(
    "The browser took back the globe's 3D graphics. Layers and controls still work, but the map cannot draw until the page reloads.",
  ),
  'render-error': msg(
    'Rendering stopped after an error. Layers and controls still work, but the map is not updating.',
  ),
};
// Focus moves to the first action each time the notice appears, so a
// keyboard user can act on it at once.
watch(
  () => failure.value?.shown,
  async (shown) => {
    if (!shown) return;
    await nextTick();
    panel.value?.querySelector('button')?.focus();
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="failure" id="render-failure" ref="panel" role="alertdialog" aria-labelledby="render-failure-title" aria-describedby="render-failure-message">
    <h2 id="render-failure-title">{{ t('The globe stopped drawing') }}</h2>
    <p id="render-failure-message">{{ t(MESSAGES[failure.reason] ?? MESSAGES['render-error']) }}</p>
    <p v-if="failure.detail" class="render-failure-detail" translate="no">{{ failure.detail }}</p>
    <p v-if="failure.reset" class="render-failure-hint">{{ t('Reset view reloads the app without the view restored from the address bar.') }}</p>
    <div v-if="failure.retry || failure.reset" class="render-failure-actions">
      <UiButton v-if="failure.retry" class="gev-action-button render-failure-retry" :onClick="failure.retry">{{ failure.reason === 'context-lost' ? t('Reload') : t('Retry') }}</UiButton>
      <UiButton v-if="failure.reset" class="gev-action-button render-failure-reset" :onClick="failure.reset">{{ t('Reset view') }}</UiButton>
    </div>
  </div>
</template>
