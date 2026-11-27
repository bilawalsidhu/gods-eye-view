<script setup>
import { STREET_LEVEL_LAYER } from '../../streetLevelEvents.js';
import { computed, inject, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, reactive, ref, unref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { sayWords, useEntityCardStore } from '../../stores/entityCard.js';
import { useDisplayStore } from '../../stores/display.js';
import { useCockpitStore } from '../../stores/cockpit.js';
import { useDockedStore } from '../../stores/docked.js';
import AircraftModelHero from './AircraftModelHero.vue';
import CctvPreview from './CctvPreview.vue';
import { onTileMap } from '../../mapTiles.js';
import StreetViewHero from './StreetViewHero.vue';
import CloseUpMap from './CloseUpMap.vue';
import FlightCockpitView from './FlightCockpitView.vue';
import FeedDot from './FeedDot.vue';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import RouteGlobe from './RouteGlobe.vue';
import SatelliteGroundView from './SatelliteGroundView.vue';
import { PLACE_LAYER } from '../../placeCard.js';
import { streetPhotoCredit } from '../../streetPhotoCredit.js';
import { greatCircleKm } from '../../../geoDistance.js';
import { fleetModelSet, fleetModelSetLoading } from '../../../data/fleetModels.js';
import {
  HERO_AUTOPLAY_MS,
  HERO_READY_WAIT_MS,
  heroKindOf,
  heroModelReady,
  heroViews,
  nextHeroView,
  shownHeroView,
} from '../../entityHeroViews.js';

const props = defineProps({
  card: { type: Object, default: null },
  title: { type: String, default: '' },
  positionWithheld: Boolean,
  /** A satellite's swath width, drawn on its ground view. */
  swathKm: { type: Number, default: null },
});
const card = computed(() => props.card);
const cards = useEntityCardStore();

const callouts = computed(() =>
  (card.value?.insights || []).map((item) => ({ label: t(item.label), value: sayWords(item.words, item.value) })),
);

// Play cycles through the available views (entityHeroViews.js). Picking a
// view or pressing Pause stops playback. Items without a precise position,
// including obscured wildlife sightings, use a placeholder if they lack
// imagery.
const mapsAllowed = inject('contextMapsAllowed', ref(true));
const routeFailed = ref(false);
const routeKnown = computed(() => mapsAllowed.value && !props.positionWithheld && Boolean(card.value?.route?.fromAt && card.value?.route?.toAt) && !routeFailed.value);
const modelFailed = ref(false);
const cockpitFailed = ref(false);
const hasPosition = computed(() => !props.positionWithheld && !card.value?.obscured && Number.isFinite(card.value?.lat) && Number.isFinite(card.value?.lon));
const mapPosition = computed(() => mapsAllowed.value && hasPosition.value && onTileMap(card.value.lat));

// A docked cockpit view is not shown on its card a second time.
const docked = useDockedStore();
const cockpitKnown = computed(
  () => mapsAllowed.value && card.value?.kind === 'aircraft' && hasPosition.value && !cockpitFailed.value && !docked.isDocked(`cockpit:${card.value.key}`),
);
// A model shows for any item drawn with a fleet model (card.modelSubject)
// whose bytes the set holds, or while the set is still loading; it is read
// again as the card refreshes.
const modelKnown = computed(
  () => !modelFailed.value && heroModelReady(card.value?.modelSubject, { set: fleetModelSet(), loading: fleetModelSetLoading() }),
);
// The view picked, or reached by the turns; null shows the first.
const chosen = ref(null);
// The photo the item's layer looked up (Planespotters for a tracked
// airliner, Open Vessel Photos for a selected vessel), with its credit.
const failedPhoto = ref('');
const photo = computed(() => {
  const found = card.value?.photo;
  if (!found?.src || found.src === failedPhoto.value) return null;
  const { photographer, licence } = found;
  const credit = licence
    ? photographer
      ? t('Photo: {photographer} · {licence}', { photographer, licence })
      : t('Photo · {licence}', { licence })
    : photographer
      ? t('Photo © {photographer}', { photographer })
      : '';
  return { ...found, credit };
});
const photoAvailable = computed(() => Boolean(photo.value));
const onPhotoError = (event) => (failedPhoto.value = event.currentTarget.getAttribute('src'));
/** Set by a switch asked for within one item: the next change of view holds the last one. */
let holdNext = false;
const views = computed(() =>
  heroKind.value === 'flight' || heroKind.value === 'model'
    ? heroViews({
        photo: photoAvailable.value,
        route: heroKind.value === 'flight' && routeKnown.value,
        model: modelKnown.value,
        cockpit: heroKind.value === 'flight' && cockpitKnown.value,
        position: mapPosition.value,
      })
    : [],
);
const activeFlightPreview = computed(() => shownHeroView(views.value, chosen.value));
// The views shown so far for this item; only these are mounted.
const made = reactive(new Set());

// A place: a street-level photo on top where Street Level has a photo a
// short walk away, one the layer remembers from this session (nothing is
// looked up for it); otherwise the close-up map. Never an icon.
const PLACE_PHOTO_KM = 0.15;
const failedPlaceStills = reactive(new Set());
function rejectPlaceStill(event) {
  failedPlaceStills.add(event.currentTarget.getAttribute('src'));
}
watch(() => card.value?.key, () => failedPlaceStills.clear(), { flush: 'sync' });
const placePhoto = computed(() => {
  const current = card.value;
  if (current?.layerId !== PLACE_LAYER || !hasPosition.value) return null;
  void cards.tick;
  if (cards.layerOff(STREET_LEVEL_LAYER)) return null;
  let photos = [];
  try {
    photos = cards.layerModule(STREET_LEVEL_LAYER)?.getAnalystRecords?.() || [];
  } catch {
    photos = [];
  }
  let best = null;
  for (const photo of photos) {
    if (!photo?.still || failedPlaceStills.has(photo.still) || !Number.isFinite(photo.lat) || !Number.isFinite(photo.lon)) continue;
    const km = greatCircleKm(current, photo);
    if (km <= PLACE_PHOTO_KM && (!best || km < best.km)) best = { ...photo, km };
  }
  return best;
});
const placePhotoCredit = computed(() => (placePhoto.value ? streetPhotoCredit(cards.layerModule(STREET_LEVEL_LAYER), placePhoto.value.id) : ''));
function openPlacePhoto() {
  const photo = placePhoto.value;
  if (photo) cards.open({ layerId: STREET_LEVEL_LAYER, id: photo.id, lat: photo.lat, lon: photo.lon });
}

const heroKind = computed(() =>
  heroKindOf({
    kind: card.value?.kind,
    layerId: card.value?.layerId,
    placeStreet: Boolean(placePhoto.value),
    photo: photoAvailable.value,
    route: routeKnown.value,
    model: modelKnown.value,
    position: mapsAllowed.value && hasPosition.value,
    mapped: mapPosition.value,
  }),
);

// Switching views goes straight to the next one: the view that was showing
// stays behind the next one during the crossfade.
const behind = ref(null);
const waiting = ref(false);
let revealTimer = 0;
let behindTimer = 0;
function reveal() {
  clearTimeout(revealTimer);
  waiting.value = false;
  clearTimeout(behindTimer);
  behindTimer = setTimeout(() => (behind.value = null), 260);
}
// Only a switch asked for within one item (a pick of a view, or the views'
// own turns) holds the last view; a new pick starts clean.
watch(activeFlightPreview, (now, was) => {
  clearTimeout(revealTimer);
  clearTimeout(behindTimer);
  const asked = holdNext;
  holdNext = false;
  if (!now || !was || now === was || !asked) {
    behind.value = null;
    waiting.value = false;
    return;
  }
  behind.value = was;
  waiting.value = true;
  if (drawn.has(now)) reveal();
  else revealTimer = setTimeout(reveal, now === 'cockpit' ? 2500 : 350);
});
const layerClass = (name) => ({
  'is-shown': activeFlightPreview.value === name || behind.value === name,
  'is-behind': behind.value === name && activeFlightPreview.value !== name,
  'is-waiting': activeFlightPreview.value === name && waiting.value,
});
// Only the view on show takes the keyboard: the one fading out under it, the
// one still drawing over it and those kept mounted out of sight are inert,
// so their links (a photo's, a map's credits) are not reached by Tab.
const layerInert = (name) => (activeFlightPreview.value !== name || waiting.value ? true : undefined);

// Keyboard focus inside the view on show (its photo link, its map credits, the
// corner icon) holds the turns. If a preview update removes a focused
// control or makes it inert, recovery goes to the selected switch or tile.
const focusHeld = ref(false);
const inView = (node) => Boolean(node?.closest?.('.entity-hero__layer, .entity-hero__corner'));
const onFocusIn = (event) => (focusHeld.value = inView(event.target));
const onFocusOut = (event) => (focusHeld.value = inView(event.relatedTarget));
let heldFocus = null;
onBeforeUpdate(() => {
  const hero = heroElement.value;
  const active = hero?.ownerDocument.activeElement;
  heldFocus = hero?.contains(active) ? active : null;
});
onUpdated(() => {
  const previous = heldFocus;
  heldFocus = null;
  const hero = heroElement.value;
  if (!previous || !hero) return;
  const doc = hero.ownerDocument;
  const active = doc.activeElement;
  if (active && active !== doc.body && !(active === previous && active.closest('[inert]'))) return;

  focusHeld.value = false;
  const selected = hero.querySelector('.entity-card__preview-switch [aria-pressed="true"]');
  selected?.focus();
  if (!selected || doc.activeElement !== selected) hero.focus();
});
function onDrawn(view, ready = true) {
  if (!ready) {
    drawn.delete(view);
    return;
  }
  drawn.add(view);
  if (activeFlightPreview.value === view && waiting.value) reveal();
}

// The TR-3B Easter egg: a small icon in the corner of the 3D model view,
// for a followed aircraft only (it swaps the followed craft, cockpit.js).
const cockpitStore = useCockpitStore();
const { presence: cockpit } = storeToRefs(cockpitStore);
const tr3b = computed(() =>
  heroKind.value === 'flight' && activeFlightPreview.value === 'model' && cards.isFollowing() ? cockpit.value?.tr3b ?? null : null,
);
const toggleTr3b = () => cockpitStore.act('toggleTr3b');

// A flight's cockpit view docks from the button on its image. Docking
// leaves the item's pin state unchanged.
const dockable = computed(() => {
  const current = card.value;
  if (!current?.identity?.id) return null;
  // A flight's cockpit view: while it shows, and while it is docked, so the
  // button that undocks it does not go with the views' turns.
  const key = `cockpit:${current.key}`;
  if (heroKind.value === 'flight' && (activeFlightPreview.value === 'cockpit' || docked.isDocked(key))) return { key, kind: 'cockpit' };
  return null;
});
const isDocked = computed(() => Boolean(dockable.value && docked.isDocked(dockable.value.key)));
// A docked camera or photo shows in the dock only: its card has a slim
// Docked bar instead of the same feed again, and Show here undocks it.
const dockedHere = computed(() => ['camera', 'street'].includes(heroKind.value) && docked.isDocked(card.value?.key));
// The docked bar shows the dock's own state and wording (stores/docked.js):
// never live over a stalled or failed stream. Until the dock has shown its
// feed, it is loading.
const dockFeed = computed(() => docked.feedOf(card.value?.key) || { dot: 'loading', text: '' });
function toggleDock() {
  const current = card.value;
  const target = dockable.value;
  if (!current || !target) return;
  docked.toggle({
    ...target,
    title: props.title || current.title,
    // Its layer and id only: the dock reads the live record, so an item the
    // feed has dropped reads as out of feed, not as where it was docked.
    identity: { layerId: current.layerId, id: current.identity.id },
  });
}
// Each turn starts with the current image or renderer frame. A view that
// never draws hands over after HERO_READY_WAIT_MS.
const drawn = reactive(new Set());
const onPhotoLoad = () => onDrawn('photo');
watch(
  () => photo.value?.src,
  () => drawn.delete('photo'),
);
function onMapState(state) {
  if (state === 'ready') onDrawn('map');
}

function onMapEntered(state) {
  onDrawn('map', state === 'ready');
}
// Every card holds its first view until Play. The same control starts the
// model's rotation and the timer that advances through the views; on a
// satellite's card, it starts the ground view's rings and HUD.
const playing = ref(false);
const display = useDisplayStore();
watch(() => display.phoneShell?.enabled, (phone) => {
  if (!phone) return;
  playing.value = false;
  chosen.value = null;
});
const motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
const reducedMotion = ref(Boolean(motionQuery?.matches));
const onMotionChange = (event) => {
  reducedMotion.value = Boolean(event.matches);
  if (event.matches) playing.value = false;
};
const turns = computed(() => views.value.length > 1);
const currentDrawn = computed(() => drawn.has(activeFlightPreview.value));
// Picking a view shows it at once and stops the turns there.
function choosePreview(which) {
  holdNext = true;
  chosen.value = which;
  playing.value = false;
}
// With reduced motion on, nothing plays: an aircraft's views do not take
// turns and a satellite's ground view stays still, so Play is unavailable
// for both rather than showing Pause over a still picture.
const togglePlaying = () => {
  if (reducedMotion.value) return;
  playing.value = !playing.value;
};

// No turns while the tile is off screen or the page is hidden.
const heroElement = ref(null);
const contextViewShown = inject('contextViewShown', true);
const onScreen = ref(true);
const pageShown = ref(globalThis.document?.visibilityState !== 'hidden');
const previewVisible = computed(() => unref(contextViewShown) && onScreen.value && pageShown.value);
// A satellite's ground view takes its still either way; its rings and HUD
// move only while playing and seen, never with reduced motion.
const groundMoving = computed(() => playing.value && onScreen.value && pageShown.value && !reducedMotion.value);
const onVisibility = () => (pageShown.value = globalThis.document?.visibilityState !== 'hidden');
let observer = null;
watch(heroElement, (element) => {
  observer?.disconnect();
  observer = null;
  onScreen.value = true;
  if (!element || typeof globalThis.IntersectionObserver !== 'function') return;
  observer = new globalThis.IntersectionObserver((entries) => {
    const last = entries[entries.length - 1];
    if (last) onScreen.value = last.isIntersecting;
  });
  observer.observe(element);
});
onMounted(() => {
  globalThis.document?.addEventListener('visibilitychange', onVisibility);
  motionQuery?.addEventListener?.('change', onMotionChange);
});
// Show here takes the Docked bar (and its button) away: focus goes to the
// view that replaces it, so it does not fall back to the page.
async function showHere() {
  docked.close();
  await nextTick();
  const hero = heroElement.value;
  const control = hero?.querySelector('button:not([disabled]), a[href]');
  (control || hero)?.focus?.();
}

watch(activeFlightPreview, (view) => view && made.add(view), { immediate: true });
watch(
  () => card.value?.key,
  () => {
    holdNext = false;
    behind.value = null;
    waiting.value = false;
    chosen.value = null;
    playing.value = false;
    routeFailed.value = false;
    modelFailed.value = false;
    cockpitFailed.value = false;
    focusHeld.value = false;
    made.clear();
    drawn.clear();
    if (activeFlightPreview.value) made.add(activeFlightPreview.value);
  },
);

// One timer: the view showing hands over HERO_AUTOPLAY_MS after it has
// drawn. It is set again whenever the view, its drawing, the turns or the
// tile's visibility change, and for a new item.
let turnTimer = 0;
function nextTurn() {
  turnTimer = 0;
  const next = nextHeroView(views.value, activeFlightPreview.value);
  if (!next || next === activeFlightPreview.value) return;
  holdNext = true;
  chosen.value = next;
}
watch(
  [playing, turns, activeFlightPreview, currentDrawn, previewVisible, focusHeld, () => card.value?.key],
  () => {
    clearTimeout(turnTimer);
    turnTimer = 0;
    if (!playing.value || !turns.value || !previewVisible.value || focusHeld.value) return;
    turnTimer = setTimeout(nextTurn, currentDrawn.value ? HERO_AUTOPLAY_MS : HERO_READY_WAIT_MS);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  clearTimeout(turnTimer);
  clearTimeout(revealTimer);
  clearTimeout(behindTimer);
  observer?.disconnect();
  globalThis.document?.removeEventListener('visibilitychange', onVisibility);
  motionQuery?.removeEventListener?.('change', onMotionChange);
});
</script>

<template>
  <div v-if="dockedHere" class="entity-hero entity-hero--docked" data-hero="docked">
    <FeedDot :state="dockFeed.dot" :label="dockFeed.text" />
    <span>{{ dockFeed.dot === 'live' ? t('Docked · bottom right') : dockFeed.text || t('Docked · bottom right') }}</span>
    <UiButton class="entity-hero__docked-show" :title="t('Show it here instead of docked')" @click="showHere">
      <UiIcon name="open_in_full" :size="null" />{{ t('Show here') }}
    </UiButton>
  </div>
  <div v-else-if="heroKind !== 'none' || $slots.placeholder" ref="heroElement" class="entity-hero" :data-hero="heroKind" tabindex="-1" @focusin="onFocusIn" @focusout="onFocusOut">
    <template v-if="heroKind === 'flight' || heroKind === 'model'">
      <a
        v-if="photoAvailable && made.has('photo')"
        :key="photo.src"
        class="entity-hero__layer entity-hero__photo"
        :class="layerClass('photo')"
        :inert="layerInert('photo')"
        :href="photo.link || undefined"
        target="_blank"
        rel="noopener"
      >
        <img :src="photo.src" :alt="t('Photo of {name}', { name: title })" v-on="{ error: onPhotoError, load: onPhotoLoad }" />
        <small v-if="photo.credit">{{ photo.credit }}</small>
      </a>
      <RouteGlobe v-if="views.includes('route') && made.has('route')" :key="`route-${card.key}`" class="entity-hero__layer" :class="layerClass('route')" :inert="layerInert('route')" :shown="activeFlightPreview === 'route' && previewVisible" :active="activeFlightPreview === 'route' && playing && previewVisible" :from="card.route.fromAt" :to="card.route.toAt" :at="{ lat: card.lat, lon: card.lon }" @ready="onDrawn('route')" @failed="routeFailed = true" />
      <AircraftModelHero v-if="modelKnown && made.has('model')" :key="card.key" class="entity-hero__layer" :class="layerClass('model')" :inert="layerInert('model')" :active="activeFlightPreview === 'model' && playing && previewVisible" :subject="card.modelSubject" :heading="card.heading || 0" :callouts="callouts" @pending="drawn.delete('model')" @ready="onDrawn('model')" @failed="modelFailed = true" />
      <FlightCockpitView v-if="views.includes('cockpit') && made.has('cockpit')" :key="`cockpit-${card.key}`" class="entity-hero__layer" :class="layerClass('cockpit')" :inert="layerInert('cockpit')" :shown="activeFlightPreview === 'cockpit' && previewVisible" :active="activeFlightPreview === 'cockpit' && playing && previewVisible" :lat="card.lat" :lon="card.lon" :altitude-m="card.altitudeM" :heading="card.heading" :speed-mps="card.speedMps" @failed="cockpitFailed = true" @ready="onDrawn('cockpit')" />
      <CloseUpMap v-if="views.includes('map') && made.has('map')" :key="`map-${card.key}`" class="entity-hero__layer" :class="layerClass('map')" :inert="layerInert('map')" :active="activeFlightPreview === 'map' && previewVisible" :lat="card.lat" :lon="card.lon" :icon="card.icon" :card="card" @state="onMapState" @entered="onMapEntered" />
      <div v-if="turns || views.includes('model')" class="entity-card__preview-switch" role="group" :aria-label="t('Preview')">
        <UiButton v-if="views.includes('photo')" :pressed="activeFlightPreview === 'photo'" pressed-class="active" :label="t('Photos')" @click="choosePreview('photo')"><UiIcon name="photo_camera" :size="null" /></UiButton>
        <UiButton v-if="views.includes('route')" :pressed="activeFlightPreview === 'route'" pressed-class="active" :label="t('Route')" @click="choosePreview('route')"><UiIcon name="timeline" :size="null" /></UiButton>
        <UiButton v-if="views.includes('model')" :pressed="activeFlightPreview === 'model'" pressed-class="active" :title="t('3D model')" @click="choosePreview('model')">{{ t('3D') }}</UiButton>
        <UiButton v-if="views.includes('cockpit')" :pressed="activeFlightPreview === 'cockpit'" pressed-class="active" :label="t('Cockpit view')" @click="choosePreview('cockpit')"><UiIcon name="visibility" :size="null" /></UiButton>
        <UiButton v-if="views.includes('map')" :pressed="activeFlightPreview === 'map'" pressed-class="active" :label="t('Map')" @click="choosePreview('map')"><UiIcon name="map" :size="null" /></UiButton>
        <UiButton class="entity-card__preview-play" :disabled="reducedMotion" :label="playing ? t('Pause preview') : t('Play preview')" @click="togglePlaying"><UiIcon :name="playing ? 'pause' : 'play_arrow'" :size="null" /></UiButton>
      </div>
    </template>
    <a v-else-if="heroKind === 'photo'" :key="photo.src" class="entity-hero__layer entity-hero__photo is-shown" :href="photo.link || undefined" target="_blank" rel="noopener">
      <img :src="photo.src" :alt="t('Photo of {name}', { name: title })" v-on="{ error: onPhotoError }" />
      <small v-if="photo.credit">{{ photo.credit }}</small>
    </a>
    <template v-else-if="heroKind === 'satellite'">
      <SatelliteGroundView :key="`ground-${card.key}`" class="entity-hero__layer is-shown" :active="previewVisible" :moving="groundMoving" :lat="card.lat" :lon="card.lon" :swath-km="swathKm" />
      <div class="entity-card__preview-switch" role="group" :aria-label="t('Preview')">
        <UiButton class="entity-card__preview-play" :disabled="reducedMotion" :label="playing ? t('Pause preview') : t('Play preview')" @click="togglePlaying"><UiIcon :name="playing ? 'pause' : 'play_arrow'" :size="null" /></UiButton>
      </div>
    </template>
    <CctvPreview v-else-if="heroKind === 'camera'" :camera-id="card.identity?.id || ''" :shown="contextViewShown && onScreen" :page-shown="pageShown" />
    <StreetViewHero v-else-if="heroKind === 'street'" :card="card" />
    <UiButton v-else-if="heroKind === 'place-street'" :key="`place-street-${placePhoto.id}`" class="entity-hero__layer entity-hero__photo entity-hero__place-street is-shown" :title="t('Street-level photo')" :label="t('Open street-level photo')" :aria-describedby="placePhotoCredit ? 'place-street-credit' : undefined" @click="openPlacePhoto">
      <img crossorigin="anonymous" :src="placePhoto.still" alt="" referrerpolicy="no-referrer" v-on="{ error: rejectPlaceStill }" />
      <small v-if="placePhotoCredit" id="place-street-credit">{{ placePhotoCredit }}</small>
    </UiButton>
    <CloseUpMap v-else-if="heroKind === 'map'" :key="`map-${card.key}`" class="entity-hero__layer is-shown" :active="previewVisible" :lat="card.lat" :lon="card.lon" :icon="card.icon" :card="card" />
    <slot v-else name="placeholder" />
    <!-- Small icons in the top corner of the image, never in the button row. -->
    <div v-if="tr3b || dockable" class="entity-hero__corner">
      <UiButton v-if="tr3b" class="entity-hero__corner-button entity-hero__ufo" :pressed="!!tr3b.converted" pressed-class="is-on" :label="t('Reclassify the followed aircraft as TR-3B')" :title="tr3b.converted ? t('Restore real aircraft') : t('Reclassify as TR-3B')" @click="toggleTr3b">🛸</UiButton>
      <UiButton v-if="dockable" class="entity-hero__corner-button entity-hero__dock" :pressed="isDocked" pressed-class="is-on" :label="t('Dock this view bottom right')" @click="toggleDock">
        <UiIcon name="picture_in_picture_alt" :size="null" />
      </UiButton>
    </div>
  </div>
  <slot />
</template>
