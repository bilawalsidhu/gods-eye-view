<script setup>
import { storeToRefs } from 'pinia';
import UiButton from '../../kit/UiButton.vue';
import { useStreetLevelPhotoStore } from '../../stores/streetLevelPhoto.js';

// The Street Level photo viewer of the providers whose photos are plain
// files (KartaView, Panoramax), in the viewer host the layer mounts it in.
// The viewer (src/layers/streetLevel/photoViewer.js) keeps every decision:
// which photo shows and how, its loading, the panorama it draws, the keys,
// drag and zoom. This view draws what it presents, forwards the events and
// hands each element back: the canvas it draws on, the frame and picture
// it measures, the root and buttons it keeps focus with. Each mount and each
// canvas has its own key, so a viewer never gets another one's elements.
const { photo } = storeToRefs(useStreetLevelPhotoStore());

/** Hand `name`'s element back to the viewer that presented it. */
const keep = (name) => (element) => {
  if (element) photo.value?.actions.attach(name, element.$el ?? element);
};
// One function per element: a new one on each render would hand it back
// again each time.
const refs = {
  root: keep('root'),
  picture: keep('picture'),
  canvas: keep('canvas'),
  prev: keep('prev'),
  next: keep('next'),
};
</script>

<template>
  <Teleport v-if="photo" :to="photo.host"
    ><div
      :key="photo.mountKey"
      :ref="refs.root"
      class="sl-photo-viewer"
      :data-provider="photo.providerId"
      tabindex="0"
      role="group"
      :aria-label="photo.label"
      :data-kind="photo.kind"
      @keydown="photo.actions.keydown"
      ><img
        :ref="refs.picture"
        class="sl-photo-flat"
        :alt="photo.alt"
        draggable="false"
        :hidden="photo.kind !== 'flat'"
        :src="photo.src ?? undefined"
        :style="{ objectFit: photo.fit }" /><canvas
        :key="photo.canvasKey"
        :ref="refs.canvas"
        class="sl-photo-pano"
        :class="{ 'sl-photo-dragging': photo.dragging }"
        :hidden="photo.kind !== 'pano'"
        @pointerdown="photo.actions.pointerdown"
        @pointermove="photo.actions.pointermove"
        @pointerup="photo.actions.pointerup"
        @pointercancel="photo.actions.pointerup"
        @wheel="photo.actions.wheel"
        @webglcontextlost="photo.actions.contextLost"
      ></canvas
      ><UiButton
        :ref="refs.prev"
        class="sl-photo-step sl-photo-step-prev"
        :label="photo.prevLabel"
        :disabled="photo.prevDisabled"
        @click="photo.actions.step(-1, $event)"
        >‹</UiButton
      ><UiButton
        :ref="refs.next"
        class="sl-photo-step sl-photo-step-next"
        :label="photo.nextLabel"
        :disabled="photo.nextDisabled"
        @click="photo.actions.step(1, $event)"
        >›</UiButton
      ></div
    ></Teleport
  >
</template>
