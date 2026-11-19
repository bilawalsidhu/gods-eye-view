<script setup>
import { ref } from 'vue';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import UiCloseButton from '../../kit/UiCloseButton.vue';

// The Québec 511 camera's floating player and its map preview, teleported to
// the end of the page. `createQuebecCctvOverlay()` owns every decision: it
// renders this with the `view` it computes and keeps the imperative parts,
// which the template never binds: each video's source, playback and load, the
// panel's dragged position, and the marker's per-frame visibility and place.
// The elements those parts need are exposed.
defineProps({
  view: { type: Object, required: true },
});
const emit = defineEmits([
  'close',
  'play',
  'refresh',
  'keydown',
  'headerPointerdown',
  'liveError',
  'liveLoadeddata',
  'stillError',
  'stillLoadeddata',
]);

const panel = ref(null);
const header = ref(null);
const close = ref(null);
const live = ref(null);
const marker = ref(null);
const still = ref(null);
defineExpose({ panel, header, close, live, marker, still });
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
<template><Teleport to="body"
    ><section
      ref="panel"
      class="qci-panel"
      :hidden="view.panelHidden"
      role="region"
      :aria-label="t('CCTV camera')"
      @keydown="emit('keydown', $event)"
      ><header
        ref="header"
        class="qci-header"
        @pointerdown="emit('headerPointerdown', $event)"
        ><strong>{{ view.title }}</strong
        ><UiCloseButton
          ref="close"
          :label="t('Close camera preview')"
          @click="emit('close')" /></header
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
        v-on="liveListeners"></video
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
        v-on="stillListeners"></video
      ><span class="qci-marker-label">{{ view.markerLabel }}</span></div
  ></Teleport
></template>
