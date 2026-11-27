<script setup>
import { storeToRefs } from 'pinia';
import { computed, shallowRef, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import UiCloseButton from '../../kit/UiCloseButton.vue';
import UiButton from '../../kit/UiButton.vue';
import UiSegmented from '../../kit/UiSegmented.vue';
import { useStreetLevelStore } from '../../stores/streetLevel.js';

// Providers mount into this persistent viewer. Context places it on the photo card.
const store = useStreetLevelStore();
const { view, expanded, expandAvailable, embedOverlay } = storeToRefs(store);

const viewer = computed(
  () =>
    view.value?.viewer ?? {
      open: false,
      loading: false,
      renderMode: 'letterbox',
      renderModes: true,
    },
);

const renderModeOptions = computed(() => [
  {
    value: 'letterbox',
    label: t('FIT'),
    attrs: {
      'data-sl-render': 'letterbox',
      title: t('Fit: show the whole photo, with dark bars where its shape differs from the frame'),
    },
  },
  {
    value: 'fill',
    label: t('FILL'),
    attrs: {
      'data-sl-render': 'fill',
      title: t('Fill: fill the frame edge to edge, cropping the photo'),
    },
  },
]);

// The image line keeps what it last showed while hidden.
const image = shallowRef({ captionLeft: '', captionRight: '', captionDate: '', link: null, href: '#', linkLabel: '' });
watch(
  view,
  (next) => {
    if (!next?.viewer.open) return;
    const { captionLeft, captionRight, captionDate, link, linkLabel } = next.viewer;
    image.value = {
      captionLeft,
      captionRight,
      captionDate,
      link,
      href: link || image.value.href,
      linkLabel: linkLabel || image.value.linkLabel,
    };
  },
  { flush: 'sync' },
);
</script>

<template>
  <div id="sl-viewer-root" class="sl-viewer-root">
    <div id="sl-viewer-wrap" class="sl-viewer-wrap" :hidden="!viewer.open">
      <div class="sl-viewer-bar">
        <div class="sl-viewer-tools">
          <UiCloseButton v-if="embedOverlay" id="sl-viewer-close" class="scene-btn" :label="t('Close')" @click="store.act('closeViewer')" />
          <UiButton id="sl-viewer-expand" class="scene-btn" :hidden="!expandAvailable || (viewer.openingPaidPhoto && !expanded)" :pressed="Boolean(expanded)" :aria-label="expanded === null ? undefined : expanded ? t('Shrink') : t('Expand')" :title="t('Show the street-level view full screen (Esc shrinks it)')"><span class="sl-btn-icon" aria-hidden="true">{{ expanded ? '⤡' : '⤢' }}</span><span class="sl-btn-text">{{ expanded ? t('SHRINK') : t('EXPAND') }}</span></UiButton>
          <UiSegmented class="sl-seg" item-class="sl-seg-btn" active-class="is-active" keyboard="radio" :hidden="!viewer.renderModes" :label="t('Image fit')" :options="renderModeOptions" :model-value="viewer.renderMode" @update:model-value="store.act('setRenderMode', $event)" />
        </div>
      </div>
      <div id="sl-viewer-error" class="sl-error" role="alert" :hidden="!view?.error"><span aria-hidden="true">⚠</span> {{ view?.error || '' }}</div>
      <div class="sl-viewer-stage">
        <div id="sl-viewer-placeholder" class="sl-viewer-placeholder" :hidden="!viewer.loading"></div>
        <div id="sl-viewer" class="sl-viewer" :aria-label="t('Street-level viewer')"></div>
      </div>
      <div id="sl-image-meta" class="sl-image-meta">
        <span id="sl-image-by" class="sl-image-by">{{ image.captionLeft }}</span>
        <span class="sl-image-right">
          <span id="sl-image-when" class="sl-image-when">{{ image.captionRight }}</span>
          <span class="sl-image-date" :hidden="!image.captionDate">{{ image.captionDate }}</span>
          <a id="sl-image-link" class="sl-image-link" :href="image.href" target="_blank" rel="noopener noreferrer" :title="t('Open this image on the provider\'s site')" :hidden="!image.link">{{ image.linkLabel }}</a>
        </span>
      </div>
    </div>
  </div>
</template>
