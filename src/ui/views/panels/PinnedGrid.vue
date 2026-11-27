<script setup>
import { computed, inject, nextTick, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { formatNumber, t } from '../../../i18n/index.js';
import { usePinnedStore } from '../../stores/pinned.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { OPENFREEMAP_CARD_CREDIT, OPENFREEMAP_CARD_CREDIT_FULL } from '../../../maps/attribution.js';
import { legacyPinMap } from '../../mapTiles.js';
import { pinTitle } from '../../placeCard.js';
import { savedStillShown, streetPhotoCredit } from '../../streetPhotoCredit.js';
import { cameraCredit } from '../../cameraCredit.js';
import { useDockedStore } from '../../stores/docked.js';
import { stationFailureText, stationPlayback, useRadioLayer } from '../../radioContext.js';
import { pinnedStationMiss, playPinnedStation } from '../../pinnedStation.js';
import CardMapCanvas from './CardMapCanvas.vue';
import EntityMark from './EntityMark.vue';
import FeedDot from './FeedDot.vue';
import PausedChip from './PausedChip.vue';
import UiButton from '../../kit/UiButton.vue';
import UiCloseButton from '../../kit/UiCloseButton.vue';
import UiIcon from '../../kit/UiIcon.vue';

// The Pinned tab: what was pinned, two to a row, as many as were pinned;
// the panel scrolls. Every pin is a still: the picture a camera or a photo
// showed when it was pinned, a station's name, a place's map, where a
// moving item was. Nothing here plays or refreshes until it is tapped; a
// map still reads its tiles when it scrolls into view. Tapping a tile
// opens that item's card on Inspect, and tapping a station plays it; the
// pin stays until it is unpinned, and unpinning offers Undo.
const props = defineProps({
  /** Whether Radio is on; a pinned station plays either way, Radio left as it is. */
  radioOn: { type: Boolean, default: true },
});

const pinned = usePinnedStore();
const { pins } = storeToRefs(pinned);
const cards = useEntityCardStore();
const hasStation = computed(() => pins.value.some(pin => pin.kind === 'station'));

// A pin whose layer is off is paused, its reason in the chip's tooltip. A
// camera that is also docked follows the dock: its tile shows the dock's
// latest frame (the same feed) and the dock's own dot and wording, live only
// while the dock is (stores/docked.js). Read when the grid draws; nothing
// re-reads it on a timer.
const docked = useDockedStore();
// A place (an airport, a spot, a search, a pinned view) wears its own
// marker, the badge its card's map draws, not an item's icon. An item wears
// its mark (EntityMark.vue): the sprite the map drew it with, as it was
// pinned, or its layer's glyph.
const PLACE_PINS = new Set(['place', 'view']);
const withDock = (pin) => pin.kind === 'camera' && docked.isDocked(pin.key);
// Until the dock has shown its feed, the pin says it is loading.
const dockFeed = (pin) => docked.feedOf(pin.key) || { dot: 'loading', text: '' };
// A station's tile is paused until that station plays, then shows the live
// dot, read as the mini player reads it (stationPlayback); its chip says
// why while Radio is off, the stream loads or failed, or the catalogue has
// no such station. A pinned station plays on with Radio off, so it stays
// live.
const { ui: radio } = useRadioLayer();
const stationState = (pin) => stationPlayback(radio.value, pin.identity?.id);
const stationLive = (pin) => pin.kind === 'station' && stationState(pin) === 'live';
const stationNote = (pin) => {
  const state = stationState(pin);
  if (pinnedStationMiss.value?.id === pin.identity?.id)
    return t('{name} is not in the station directory right now', { name: pin.title });
  if (state === 'loading') return t('Loading');
  if (state === 'lost') return stationFailureText(radio.value);
  if (state === 'idle' && !props.radioOn) return t('Radio off');
  return '';
};
const isPaused = (pin) => !withDock(pin) && !stationLive(pin) && (pin.kind === 'station' || Boolean(offNote(pin)));
const offNote = (pin) => {
  if (withDock(pin)) return '';
  if (pin.kind === 'station') return stationNote(pin);
  if (pin.kind === 'camera') return cards.layerOff('cctv') ? t('Cameras off · last frame') : '';
  if (pin.kind === 'street') return cards.layerOff('street-level') ? t('{layer} off', { layer: t('Street Level') }) : '';
  return '';
};

// OpenFreeMap card maps share one credit below the grid.
const mapsAllowed = inject('contextMapsAllowed', ref(true));
const MAP_FRAME = Object.freeze({ width: 256, height: 160 });
const tiles = computed(() => pins.value.map((pin) => {
  const still = pinned.stillOf(pin.key);
  // A remote street-photo URL is a fresh provider request even for a saved pin.
  const hideStreetImage = pin.kind === 'street' && !savedStillShown(still, cards.layerOff('street-level'));
  const legacyMap = still.startsWith('card-map:');
  return { pin, title: pinTitle(pin), map: mapsAllowed.value && !cards.privatePositionWithheld(pin.identity?.layerId) ? pin.map || (legacyMap && legacyPinMap(still)) : null, image: pin.map || legacyMap || hideStreetImage ? '' : still };
}));
const mapShown = () => tiles.value.some((tile) => tile.map);
// A street-level still carries its provider's credit on its tile, as long
// as the picture shows; a camera's still, its provider and a partner feed's
// owner, read from the layer or, with Cameras off, kept with the pin. A pin
// that kept none credits its camera once the layer knows it again.
const photoCredit = (pin) => {
  if (pin.kind === 'street') return streetPhotoCredit(cards.layerModule('street-level'), pin.identity?.id, pin.photoCredit);
  return pin.kind === 'camera' ? cameraCredit(cards.cameraDetails(pin.identity?.id), pin.source) : '';
};

// A pin opens its card on Inspect, and the card stays while its layer is
// off. A station plays, and Radio stays as it is: with the layer off the
// stream comes from the station catalogue already read, with no markers
// drawn, and the mini player holds it (pinnedStation.js). With Radio on,
// Context shows Inspect, where the station list holds the station.
// A pinned view flies back to the camera as it was; Context then describes
// that view, its place header first.
const refused = ref(null);
const refusalText = computed(() => {
  const failure = refused.value;
  if (!failure || !pinned.isPinned(failure.key)) return '';
  if (failure.local) return radio.value?.source === 'local' ? t('Choose Internet stations to play this pin.') : '';
  if (failure.street && docked.stowed) return t('Shrink Context to show the photo dock.');
  if (failure.street && cards.layerModule('street-level')?.dockedPhotoRestoring?.()) return t('Still restoring the photo');
  return t('Could not open this in Context');
});
function playStation(pin) {
  const id = pin.identity?.id;
  const module = cards.layerModule('radio');
  // Without a Radio layer there is nothing to play, and the tile stays.
  if (!id || !module) {
    refused.value = { key: pin.key };
    return false;
  }
  const result = playPinnedStation({ id, name: pin.title }, { module: () => module });
  if (result === 'unavailable') {
    refused.value = { key: pin.key, local: module.getUIState?.()?.source === 'local' };
    return false;
  }
  if (props.radioOn) {
    cards.clear();
    pinned.show('inspect');
  }
  return true;
}
// Unpinning from the keyboard keeps focus in reach: on the next pin's
// unpin button (the previous one's when it was the last in the list), or on
// Undo once no pin is left, the Pinned tab gone with it. The notice holds
// while focus is on it. A pointer unpin leaves focus be.
const root = ref(null);
async function focusAfter(event, index) {
  if (event?.detail !== 0) return;
  const panel = root.value?.closest('#global-context-panel') || root.value?.ownerDocument;
  await nextTick();
  const buttons = root.value?.isConnected ? [...root.value.querySelectorAll('.pinned-grid__unpin')] : [];
  const next = buttons.length ? buttons[Math.min(index, buttons.length - 1)] : panel?.querySelector('.pin-undo-notice button');
  next?.focus();
}
function unpin(pin, event) {
  const index = pins.value.findIndex((entry) => entry.key === pin.key);
  pinned.unpin(pin.key);
  void focusAfter(event, index);
}
function clearAll(event) {
  pinned.clearAll();
  void focusAfter(event, 0);
}
// Opening a pin from the keyboard: Inspect takes the grid's place, the
// focused tile with it, so focus moves to the card's first action, or with
// no card (a pinned view, a station) to Context's body. A tile still there
// (a station played with Radio off) keeps it; a pointer open leaves focus be.
async function focusOpened(event) {
  const tile = event?.currentTarget;
  if (event?.detail !== 0 || !tile) return;
  const body = root.value?.closest('[tabindex="-1"]');
  // After the change the open made has rendered.
  await nextTick();
  if (tile.isConnected) return;
  const card = tile.ownerDocument.getElementById('entity-card');
  (card?.querySelector('.entity-card__actions button:not(:disabled)') ?? card?.querySelector('button:not(:disabled)') ?? body)?.focus({ preventScroll: true });
}
function open(pin, event) {
  refused.value = null;
  if (pin.kind === 'station') {
    if (!playStation(pin)) return;
  } else {
    if (pin.kind === 'view') {
      cards.clear();
      cards.flyToPose(pin.pose);
    } else if (!cards.open(pin.identity, { fromPin: true })) {
      refused.value = { key: pin.key, street: pin.kind === 'street' && docked.view?.kind === 'street' };
      return;
    }
    pinned.show('inspect');
  }
  void focusOpened(event);
}
</script>

<template>
  <section ref="root" class="pinned-grid" :aria-label="t('Pinned')">
    <div class="pinned-grid__head">
      <h4 class="pinned-grid__title">{{ t('Pinned · {n}', { n: formatNumber(pins.length) }) }}</h4>
      <UiButton class="pinned-grid__clear" @click="clearAll">{{ t('Clear all') }}</UiButton>
    </div>
    <p v-if="refusalText" role="status">{{ refusalText }}</p>
    <ul class="pinned-grid__tiles">
      <li v-for="{ pin, title, map, image } in tiles" :key="pin.key" class="pinned-grid__tile" :data-kind="pin.kind" :data-pin-key="pin.key">
        <UiButton class="pinned-grid__open" :title="pin.kind === 'station' ? t('Play {name}', { name: title }) : t('Show {name} on Inspect', { name: title })" @click="open(pin, $event)">
          <CardMapCanvas v-if="map" class="pinned-grid__frame" :lat="map.lat" :lon="map.lon" :zoom="map.zoom" :frame="MAP_FRAME" :clear-bottom="28" lazy />
          <img v-else-if="image" class="pinned-grid__frame" :src="image" alt="" />
          <EntityMark v-if="pin.kind === 'item' && pin.identity?.layerId" class="pinned-grid__icon" :class="{ 'pinned-grid__icon--over': Boolean(map || image) }" :layer="pin.identity.layerId" :kind="pin.mark || ''" :icon="pin.icon" />
          <UiIcon v-else class="pinned-grid__icon" :class="{ 'pinned-grid__icon--over': Boolean(map || image), 'pinned-grid__icon--place': PLACE_PINS.has(pin.kind) }" :name="pin.icon" :size="null" />
          <span class="pinned-grid__name">
            <span>{{ title }}</span>
            <small v-if="image && photoCredit(pin)" class="pinned-grid__photo-credit">{{ photoCredit(pin) }}</small>
          </span>
          <FeedDot v-if="withDock(pin)" class="pinned-grid__state" :state="dockFeed(pin).dot" :label="dockFeed(pin).text" />
          <FeedDot v-else-if="stationLive(pin)" class="pinned-grid__state" state="live" />
          <PausedChip v-else-if="isPaused(pin)" :reason="offNote(pin)" />
        </UiButton>
        <UiCloseButton class="pinned-grid__unpin" glyph="icon" :label="t('Unpin {name}', { name: title })" :title="t('Unpin')" @click="unpin(pin, $event)" />
      </li>
    </ul>
    <!-- Keep the map credits at the foot of the scrolling list while a map pin is present. -->
    <div v-if="mapShown()" class="pinned-grid__credits">
      <p class="pinned-grid__credit" :title="OPENFREEMAP_CARD_CREDIT_FULL"><bdi dir="ltr">{{ OPENFREEMAP_CARD_CREDIT }}</bdi></p>
    </div>
    <p v-if="hasStation" class="pinned-grid__hint">{{ t('Stations play straight from their broadcasters, who see your IP address.') }}</p>
    <p class="pinned-grid__hint">{{ hasStation ? t('Tap a station to play it. Other pins open on Inspect.') : t('Tap a pin to open it on Inspect.') }}</p>
  </section>
</template>
