<script setup>
import { ref } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';

// The player belongs to the selected card. The separately positioned marker stays over the globe.
defineProps({
  playerHost: { type: Object, required: true },
  view: { type: Object, required: true },
});
const emit = defineEmits([
  'play',
  'refresh',
  'liveError',
  'liveLoadeddata',
  'stillError',
  'stillLoadeddata',
]);

const live = ref(null);
const marker = ref(null);
const still = ref(null);
defineExpose({ live, marker, still });
// Each video's load and failure go to the owner, which marks the source.
const liveListeners = {
  error: () => emit('liveError'),
  loadeddata: () => emit('liveLoadeddata'),
};
const stillListeners = {
  error: () => emit('stillError'),
  loadeddata: () => emit('stillLoadeddata'),
};
</script>

<!-- Only line breaks inside tags: the markup has no whitespace between elements. -->
<template>
  <Teleport :to="playerHost"
    ><section
      class="qci-panel"
      :hidden="view.panelHidden"
      :aria-label="view.title"
      ><p class="qci-coordinates">{{ view.coordinates }}</p
      ><p class="qci-credit" :hidden="view.creditHidden">{{ view.credit }}</p
      ><video
        ref="live"
        class="qci-live"
        controls
        muted
        autoplay
        loop
        playsinline
        :hidden="view.liveHidden"
        :aria-label="t('CCTV camera')"
        v-on="liveListeners"
      ></video
      ><div class="qci-actions" :hidden="view.actionsHidden"
        ><UiButton
          class="qci-play"
          :hidden="view.playHidden"
          @click="emit('play')"
          >{{ t('Play') }}</UiButton
        ><UiButton :hidden="view.refreshHidden" @click="emit('refresh')">{{
          t('Refresh map still')
        }}</UiButton></div
      ><p class="qci-note" :hidden="view.noteHidden">{{ view.note }}</p
      ><a
        target="_blank"
        rel="noopener noreferrer"
        :href="view.sourceHref"
        :hidden="view.sourceHidden"
        >{{ t("Open this image on the provider's site") }}</a
      ></section
    ></Teleport
  ><Teleport to="body"
    ><div
      ref="marker"
      class="qci-marker"
      :class="{ 'qci-marker-link-only': view.markerLinkOnly }"
      hidden
      ><video
        ref="still"
        class="qci-marker-still"
        muted
        playsinline
        preload="none"
        :hidden="view.stillHidden"
        aria-hidden="true"
        v-on="stillListeners"
      ></video
      ><span class="qci-marker-label">{{ view.markerLabel }}</span></div
    ></Teleport
  >
</template>
