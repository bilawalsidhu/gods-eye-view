<script setup>
import { storeToRefs } from 'pinia';
import { computed, shallowRef, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import RailPanel from '../../rail/RailPanel.vue';
import RailChips from '../../rail/RailChips.vue';
import { useStreetLevelStore } from '../../stores/streetLevel.js';

// The Street Level panel, rendered from what StreetLevelControls presents.
// Until it renders, the panel shows its initial markup. The viewer element
// belongs to the layer and EXPAND to the controls.
const store = useStreetLevelStore();
const { view, expanded, expandAvailable } = storeToRefs(store);

const status = computed(
  () =>
    view.value?.status ?? {
      text: t('OFF'),
      tone: '',
      pressed: false,
      title: t('Turn Street Level on or off'),
    },
);
const viewer = computed(
  () =>
    view.value?.viewer ?? {
      open: false,
      loading: false,
      renderMode: 'letterbox',
      renderModes: true,
    },
);
const shows = computed(
  () => view.value?.filterControls ?? { pano: true, since: true },
);
const pano = computed(() => view.value?.filter.pano ?? 'all');

/** A radio segment; the chosen one is the group's tab stop once rendered. */
const segment = (value, option) => ({
  class: `gev-segment sl-seg-btn${value === option ? ' is-active' : ''}`,
  'aria-checked': String(value === option),
  tabindex: value === option ? (view.value ? '0' : undefined) : '-1',
});

// The image line and OPEN keep what they last showed while hidden.
const image = shallowRef({
  captionLeft: '',
  captionRight: '',
  link: null,
  href: '#',
  linkLabel: '',
});
// The page's placeholder, hidden until the controls name the providers.
const nearest = shallowRef({
  label: 'OPEN STREET VIEW', // i18n-ignore: never shown before it is replaced
  title: '',
  disabled: false,
});
watch(
  view,
  (next) => {
    if (next?.viewer.open) {
      const { captionLeft, captionRight, link, linkLabel } = next.viewer;
      image.value = {
        captionLeft,
        captionRight,
        link,
        href: link || image.value.href,
        linkLabel: linkLabel || image.value.linkLabel,
      };
    }
    if (next?.nearest.visible) nearest.value = next.nearest;
  },
  { flush: 'sync' },
);

// SINCE: the readout follows the thumb; the window is recorded on release.
const sinceLabel = shallowRef(t('ANY DATE'));
const stop = (input) => Number(input.value) || 0;
function onSinceInput(event) {
  // Without controls attached the readout stays as it is.
  sinceLabel.value =
    store.describeSinceStop(stop(event.target)) || sinceLabel.value;
}
function onSinceChange(event) {
  store.act('setSinceStop', stop(event.target));
}
/**
 * Each new presentation places the thumb, as the controls' renders did, but
 * never under the user's hand; the readout's own updates leave it alone.
 * Once the thumb is at the presented window, the readout shows it in full.
 */
const placeThumb = (el, { value: since, oldValue }) => {
  if (!since || since === oldValue) return;
  const index = String(since.index);
  if (el.ownerDocument.activeElement !== el && el.value !== index)
    el.value = index;
  if (el.value === index) sinceLabel.value = since.label;
};
const vThumb = { mounted: placeThumb, updated: placeThumb };
</script>

<template>
<RailPanel id="street-level-panel" start-collapsed :data-sl-enabled="view ? String(view.enabled) : undefined" :title="t('STREET LEVEL')" sideways scroll rail-scroller>
  <template #actions><button id="sl-status" :class="`sl-status${status.tone ? ` is-${status.tone}` : ''}`" type="button" :aria-pressed="String(status.pressed)" :title="status.title">{{ status.text }}</button></template>
    <div id="sl-body" class="sl-body">
      <div id="sl-viewer-wrap" class="sl-viewer-wrap" :hidden="!viewer.open">
        <div class="sl-viewer-bar">
          <div class="sl-viewer-tools">
            <button id="sl-viewer-expand" class="scene-btn" type="button" :hidden="!expandAvailable" :aria-pressed="String(Boolean(expanded))" :aria-label="expanded === null ? undefined : expanded ? t('Shrink') : t('Expand')" title="Show the street-level view full screen (Esc shrinks it)" data-i18n-title><span class="sl-btn-icon" aria-hidden="true">{{ expanded ? '⤡' : '⤢' }}</span><span class="sl-btn-text">{{ expanded ? t('SHRINK') : t('EXPAND') }}</span></button>
            <div class="gev-segmented sl-seg" role="radiogroup" aria-label="Image fit" data-i18n-aria-label :hidden="!viewer.renderModes">
              <button type="button" v-bind="segment(viewer.renderMode, 'letterbox')" data-sl-render="letterbox" role="radio" title="Fit: show the whole photo, with dark bars where its shape differs from the frame" data-i18n-title data-i18n>FIT</button>
              <button type="button" v-bind="segment(viewer.renderMode, 'fill')" data-sl-render="fill" role="radio" title="Fill: fill the frame edge to edge, cropping the photo" data-i18n-title data-i18n>FILL</button>
            </div>
          </div>
          <div class="sl-viewer-tools sl-viewer-tools-right">
            <button id="sl-viewer-close" class="sl-viewer-x" type="button" title="Close the image and deselect it on the map" aria-label="Close the street-level image" data-i18n-title data-i18n-aria-label>×</button>
          </div>
        </div>
        <div class="sl-viewer-stage">
          <div id="sl-viewer-placeholder" class="sl-viewer-placeholder" :hidden="!viewer.loading"></div>
          <div id="sl-viewer" class="sl-viewer" aria-label="Street-level viewer" data-i18n-aria-label></div>
        </div>
        <div id="sl-image-meta" class="sl-image-meta">
          <span id="sl-image-by" class="sl-image-by">{{ image.captionLeft }}</span>
          <span class="sl-image-right">
            <span id="sl-image-when" class="sl-image-when">{{ image.captionRight }}</span>
            <a id="sl-image-link" class="sl-image-link" :href="image.href" target="_blank" rel="noopener noreferrer" title="Open this image on the provider's site" data-i18n-title :hidden="!image.link">{{ image.linkLabel }}</a>
          </span>
        </div>
      </div>
      <div class="sl-providers" role="group" aria-label="Imagery providers" data-i18n-aria-label>
        <span class="cctv-summary-label" data-i18n>PROVIDERS</span>
        <div id="sl-provider-chips" class="sl-chips"><RailChips :chips="view ? view.providers : []" /></div>
      </div>
      <div id="sl-error" class="sl-error" role="alert" :hidden="!view?.error"><span aria-hidden="true">⚠</span> <span id="sl-error-text">{{ view?.error || '' }}</span></div>
      <!-- A missing key gates the filters only: the chips above stay
           focusable so their tooltip can say how to add the key. -->
      <fieldset id="sl-controls" class="sl-controls" :disabled="Boolean(view?.controlsDisabled)" :hidden="!shows.pano && !shows.since">
        <div id="sl-pano-row" class="sl-filters" :hidden="!shows.pano" role="group" aria-label="Imagery filters" data-i18n-aria-label>
          <span class="cctv-summary-label" data-i18n>IMAGERY</span>
          <div class="gev-segmented sl-seg" role="radiogroup" aria-label="Panorama filter" data-i18n-aria-label>
            <button type="button" v-bind="segment(pano, 'all')" data-sl-pano="all" role="radio" data-i18n>ALL</button>
            <button type="button" v-bind="segment(pano, 'pano')" data-sl-pano="pano" role="radio">360°</button>
            <button type="button" v-bind="segment(pano, 'flat')" data-sl-pano="flat" role="radio" data-i18n>FLAT</button>
          </div>
        </div>
        <div id="sl-since-row" class="sl-since" :hidden="!shows.since">
          <label class="cctv-summary-label" for="sl-since" data-i18n>SINCE</label>
          <input id="sl-since" v-thumb="view?.since" class="sl-range gev-quantitative-slider" type="range" min="0" max="8" step="1" value="0" :aria-valuetext="sinceLabel" aria-describedby="sl-since-label sl-since-note" @input="onSinceInput" @change="onSinceChange" />
          <span class="sl-since-value">
            <output id="sl-since-label" class="sl-since-label" for="sl-since">{{ sinceLabel }}</output>
            <small id="sl-since-note" class="sl-since-note" :hidden="!view?.sinceNote">{{ view?.sinceNote || '' }}</small>
          </span>
        </div>
      </fieldset>
      <!-- The hint says how to open imagery; the button does it without a pointer. -->
      <div class="sl-meta-row">
        <div id="sl-coverage-meta" class="sl-meta">{{ view?.meta ?? '' }}</div>
        <button id="sl-nearest-btn" class="scene-btn sl-nearest-btn" type="button" :hidden="!view?.nearest.visible" :title="nearest.title || undefined" :disabled="nearest.disabled" data-i18n-runtime>{{ nearest.label }}</button>
      </div>
    </div>
</RailPanel>
</template>
