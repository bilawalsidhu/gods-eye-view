<script setup>
import { STREET_LEVEL_LAYER } from '../../streetLevelEvents.js';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { usePinnedStore } from '../../stores/pinned.js';
import { useStreetLevelStore } from '../../stores/streetLevel.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import PausedChip from './PausedChip.vue';
import { isStreetViewerExpanded, placeStreetLevelViewer, returnStreetLevelViewerHome } from '../../streetLevelViewerPlacement.js';
import { savedStillShown, streetPhotoCredit } from '../../streetPhotoCredit.js';

// The accepted photo uses the persistent viewer from Context's home. A
// selected Nearby row opens its photo; failures stay with the row for Retry.
const props = defineProps({
  card: { type: Object, required: true },
});

const streetLevel = useStreetLevelStore();
const { view, expanded } = storeToRefs(streetLevel);
const cards = useEntityCardStore();
const { tick } = storeToRefs(cards);
const pinned = usePinnedStore();
const viewerSlot = ref(null);

const photoId = computed(() => props.card.identity?.id || '');
const open = computed(() =>
  !view.value?.dockPhotoUnavailable && view.value?.viewer.photo?.id === photoId.value,
);
const layerOn = computed(() => {
  void tick.value;
  return view.value?.enabled === true && !cards.layerOff(STREET_LEVEL_LAYER);
});
const provider = computed(() => {
  const id = photoId.value.replace(/^near:/, '').split(':')[0];
  return view.value?.providers?.find((provider) => provider.id === id);
});
const providerOn = computed(() => !view.value?.providers || provider.value?.active === true);
const billed = computed(() => provider.value?.billed === true);
const brokenStill = ref('');
function rejectStill(event) {
  brokenStill.value = event.currentTarget.getAttribute('src');
}
const still = computed(() => {
  void tick.value;
  const url = layerOn.value
    ? cards.layerModule(STREET_LEVEL_LAYER)?.photo?.(photoId.value)?.still || pinned.stillOf(props.card.key)
    : pinned.stillOf(props.card.key);
  // The Pinned tile's rule: with Street Level off a remote still would ask its provider again.
  return url && url !== brokenStill.value && savedStillShown(url, !layerOn.value) ? url : '';
});

// The still carries the photo's credit (its provider's, who took it, its
// licence) while it shows, as a pinned tile and the dock do; the open
// viewer's caption credits it otherwise.
const pausedReason = computed(() =>
  !layerOn.value
    ? still.value
      ? t('Street Level off · last image')
      : pinned.isPinned(props.card.key)
        ? t('{layer} off', { layer: t('Street Level') })
        : ''
    : layerOn.value && !providerOn.value
      ? t('Source off')
      : '',
);
// A pin keeps the credit it was made with: it stands in once the layer has
// forgotten the photo (Street Level off, or past its history).
const savedCredit = computed(() => pinned.pinFor(props.card.key)?.photoCredit || null);
const credit = computed(() => {
  void tick.value;
  if (!still.value && !savedCredit.value) return '';
  const module = cards.layerModule(STREET_LEVEL_LAYER);
  const live = layerOn.value && module?.photo?.(photoId.value);
  return streetPhotoCredit(module, photoId.value, live ? null : savedCredit.value);
});

// Keep this card's request failure separate from a later provider message.
const request = ref('');
const failure = ref(null);
const noImagery = () => t('No imagery');
function failureFromView(fallback) {
  const snapshot = view.value;
  return snapshot?.error ? () => snapshot.error : fallback;
}
let requestSeq = 0;
async function openThisPhoto() {
  const seq = ++requestSeq;
  request.value = 'loading';
  failure.value = null;
  const opened = await streetLevel.act('openPhoto', photoId.value);
  if (seq !== requestSeq) return;
  if (opened || open.value) {
    request.value = '';
    return;
  }
  request.value = 'failed';
  // A superseded request cannot use the error from the lookup that took over.
  failure.value = opened === null ? () => t('Photo unavailable') : failureFromView(noImagery);
}
// Retry unmounts its own button while the photo loads: focus waits on the
// hero, then goes to Retry again if the photo still cannot open.
const hero = ref(null);
async function retry() {
  hero.value?.focus({ preventScroll: true });
  await openThisPhoto();
  await nextTick();
  if (request.value !== 'failed' || !hero.value?.contains(document.activeElement)) return;
  hero.value.querySelector('.sl-hero__retry')?.focus({ preventScroll: true });
}

// A card picked from a list opens its photo; the photo's own announcement
// (entityContextBridge) picks the card it already shows, so nothing reopens.
watch(
  [() => props.card.key, providerOn, layerOn],
  () => {
    requestSeq++;
    request.value = '';
    failure.value = null;
    brokenStill.value = '';
    if (!layerOn.value || !photoId.value) return;
    // Its source switched off: the card stays and says so (pausedReason); it opens again with its source.
    if (!providerOn.value) return;
    if (open.value || billed.value) return;
    void openThisPhoto();
  },
  { immediate: true },
);

watch(
  open,
  (shown, wasShown) => {
    if (!shown) {
      returnStreetLevelViewerHome();
      if (wasShown && !request.value && providerOn.value && layerOn.value) {
        request.value = 'lost';
        failure.value = noImagery;
      }
    } else {
      request.value = '';
      failure.value = null;
    }
    void nextTick(placeStreetLevelViewer);
  },
  { immediate: true, flush: 'pre' },
);
watch(view, () => {
  if (request.value !== 'lost') return;
  const ui = cards.layerModule(STREET_LEVEL_LAYER)?.getUIState?.()?.street;
  if (ui?.error && `${ui.providerId}:${ui.imageId}` === photoId.value) {
    failure.value = failureFromView(failure.value);
    request.value = 'failed';
  }
});
// Keep the slot attached throughout fullscreen transitions, even when a
// panorama step temporarily has no accepted frame.
const keepSlot = computed(() => open.value || (expanded.value && isStreetViewerExpanded(viewerSlot.value?.firstElementChild)));
// The slot goes with the card: the viewer goes back to its home.
onBeforeUnmount(() => {
  requestSeq++;
  // The card's exit animation can leave its slot in the DOM after unmount.
  if (viewerSlot.value) viewerSlot.value.hidden = true;
  returnStreetLevelViewerHome();
  void nextTick(placeStreetLevelViewer);
});
</script>

<template>
  <div ref="hero" class="sl-hero" tabindex="-1">
    <div v-if="keepSlot" id="sl-viewer-slot" ref="viewerSlot" class="sl-hero__slot"></div>
    <div v-if="!keepSlot" class="sl-hero__still">
      <img v-if="still" :src="still" :alt="t('Street-level photo')" referrerpolicy="no-referrer" v-on="{ error: rejectStill }" />
      <UiIcon v-else class="sl-hero__glyph" name="streetview" :size="null" />
      <p v-if="layerOn && request === 'loading'" class="sl-hero__state" role="status">{{ t('Loading photo...') }}</p>
      <div v-else-if="layerOn && failure" class="sl-hero__state" role="alert">
        <span>{{ failure() }}</span>
        <UiButton class="sl-hero__retry" @click="retry">{{ t('Retry') }}</UiButton>
      </div>
      <div v-else-if="layerOn && providerOn && billed && photoId" class="sl-hero__state">
        <UiButton class="sl-hero__retry" @click="retry">{{ t('Open') }}</UiButton>
      </div>
      <div v-if="pausedReason || credit" class="sl-hero__foot">
        <PausedChip v-if="pausedReason" :reason="pausedReason" />
        <small v-if="credit" class="sl-hero__credit">{{ credit }}</small>
      </div>
    </div>
  </div>
</template>
