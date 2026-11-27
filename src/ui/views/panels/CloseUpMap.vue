<script setup>
import { computed, ref, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import { nearestCity } from '../../../data/wikidataCities.js';
import {
  ESRI_IMAGERY_CARD_CREDIT,
  ESRI_IMAGERY_CREDIT,
  OPENFREEMAP_CARD_CREDIT,
  OPENFREEMAP_CARD_CREDIT_FULL,
} from '../../../maps/attribution.js';
import CardMapCanvas from './CardMapCanvas.vue';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import { cardMapTheme, toggleCardMapTheme } from '../../cardMap.js';
import EntityMark from './EntityMark.vue';
import { markKind } from '../../entityMark.js';
import { cityCaption, closeUpPlace, closeUpZoom, onTileMap, tileBlock } from '../../mapTiles.js';

// A close-up of where an item is, with its mark on the spot. Hazard cards
// show aerial imagery; other cards use the styled OpenFreeMap vector map.
const HAZARD_LAYERS = new Set([
  'earthquakes',
  'local-firms',
  'fire-perimeters',
  'weather-cyclones',
]);

const props = defineProps({
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  /** The glyph where the item's layer has no sprite (a Material Symbols name). */
  icon: { type: String, default: 'location_on' },
  /** The item's card: its kind sets the zoom, and a place's own name captions the map. */
  card: { type: Object, default: null },
  /**
   * Whether it is the view shown. A finished map kept behind another view
   * stays as it is; one still loading stops its requests, and draws again
   * when shown.
   */
  active: { type: Boolean, default: true },
});

const emit = defineEmits(['state', 'entered']);
const zoom = computed(() => closeUpZoom(props.card));
const imagery = computed(() => HAZARD_LAYERS.has(props.card?.layerId));
// A moving item is drawn where it was when the map was taken, so the map is
// taken again only once it has moved about 0.01° (about 1 km).
const spot = ref(null);
watch(
  () => [props.lat, props.lon, props.active, imagery.value, zoom.value],
  ([lat, lon, active, useImagery, level]) => {
    if (!active) return;
    const at = spot.value;
    if (
      at &&
      at.imagery === useImagery &&
      at.zoom === level &&
      Math.abs(at.lat - lat) < 0.01
    ) {
      const span = Math.abs(at.lon - lon);
      if (Math.min(span, 360 - span) < 0.01) return;
    }
    spot.value = { lat, lon, imagery: useImagery, zoom: level };
  },
  { immediate: true },
);

const imageryTiles = computed(() => {
  const at = spot.value;
  return at?.imagery && onTileMap(at.lat) ? tileBlock(at.lat, at.lon, at.zoom) : [];
});

// The caption names the place itself when the card does, else the city
// nearest the spot.
const ownPlace = computed(() => closeUpPlace(props.card));
const near = ref(null);
watch(
  [spot, ownPlace],
  async ([at, own]) => {
    near.value = null;
    if (!at || own) return;
    const city = await nearestCity(at.lat, at.lon, { radiusKm: 60, nearKm: 25 }).catch(() => null);
    if (spot.value === at && !ownPlace.value) near.value = city;
  },
  { immediate: true },
);
const place = computed(() => ownPlace.value || cityCaption(near.value));

// The same mark the item has everywhere in Context (EntityMark.vue).
// What of the map shows, measured when it draws: the hero round the spot,
// the attribution bar and foot kept free of names.
const root = ref(null);
const foot = ref(null);
const attribution = ref(null);
function measure() {
  const box = root.value?.getBoundingClientRect?.();
  if (!box?.width || !box?.height) return null;
  const top = foot.value?.getBoundingClientRect?.().top;
  const clearBottom = Number.isFinite(top) && top > box.top ? box.bottom - top : 0;
  const bottom = attribution.value?.getBoundingClientRect?.().bottom;
  const clearTop = Number.isFinite(bottom) ? Math.max(0, bottom - box.top) : 0;
  return { width: box.width, height: box.height, clearTop, clearBottom };
}

const markLayer = computed(() => props.card?.layerId || '');
const mark = computed(() => (markLayer.value ? markKind(markLayer.value, props.card) : ''));
</script>

<template>
  <div ref="root" class="close-up-map">
    <div class="close-up-map__map" aria-hidden="true">
      <template v-if="imagery">
        <img
          v-for="tile in imageryTiles"
          :key="tile.key"
          class="close-up-map__tile"
          :src="tile.src"
          :style="{ transform: `translate(${tile.left}px, ${tile.top}px)` }"
          width="257"
          height="257"
          alt=""
          decoding="async"
          draggable="false"
        />
      </template>
      <CardMapCanvas
        v-else-if="spot"
        class="close-up-map__canvas"
        :lat="spot.lat"
        :lon="spot.lon"
        :zoom="zoom"
        :active="active"
        :measure="measure"
        :resize-targets="[root, foot, attribution]"
        @state="emit('state', $event)"
        @entered="emit('entered', $event)"
      />
    </div>
    <div ref="attribution" class="close-up-map__top">
      <small
        class="close-up-map__credit map-credit"
        :class="{ 'close-up-map__credit--imagery': imagery }"
        tabindex="0"
        :title="imagery ? ESRI_IMAGERY_CREDIT : OPENFREEMAP_CARD_CREDIT_FULL"
      ><bdi dir="ltr">{{ imagery ? ESRI_IMAGERY_CARD_CREDIT : OPENFREEMAP_CARD_CREDIT }}</bdi></small>
      <UiButton
        v-if="!imagery"
        class="close-up-map__theme"
        :label="t('Light map')"
        :pressed="cardMapTheme === 'toner'"
        @click.stop="toggleCardMapTheme"
      >
        <UiIcon name="light_mode" :size="null" />
      </UiButton>
    </div>
    <span class="close-up-map__icon" aria-hidden="true"><EntityMark :layer="markLayer" :kind="mark" :icon="icon" /></span>
    <div ref="foot" class="close-up-map__foot map-foot">
      <span v-if="place" class="close-up-map__label" :title="place">{{ place }}</span>
    </div>
  </div>
</template>

<style scoped>
.close-up-map__tile {
  position: absolute;
  top: 0;
  left: 0;
  max-width: none;
  user-select: none;
}

.close-up-map__credit--imagery {
  min-inline-size: 0;
  overflow-x: auto;
  white-space: nowrap;
}
</style>
