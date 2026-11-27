<script setup>
import { computed, ref, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import { greatCircleKm } from '../../../geoDistance.js';
import { nearestCity } from '../../../data/wikidataCities.js';
import { ESRI_IMAGERY_PLACES_CARD_CREDIT, ESRI_IMAGERY_PLACES_CREDIT, ESRI_PLACES_TILES } from '../../../maps/attribution.js';
import { onTileMap, tileBlock } from '../../mapTiles.js';
import { GROUND_VIEW_WIDTH_PX, groundFrame, swathPaths } from '../../satelliteSwath.js';
import PreviewHud from './PreviewHud.vue';

// A greyscale Esri image with place names shows the ground beneath the
// satellite. The still is retaken as the satellite moves, and its tiles
// load only while the view shows. The image drifts in at first.
// With a swath, the view stands back so the swath, drawn to scale as a
// faint outline, takes about half its width, with the coast and
// places round it. Without one, near a town it looks close in, at
// street-block scale; over open water or empty land, where a close view
// would be a blank, it stands well back so coasts and terrain show. The
// image is Esri World Imagery, the app's keyless basemap, from its classic
// tile endpoint; its credit, naming every source, sits at the foot, the
// long form in its title.
const props = defineProps({
  lat: { type: Number, default: null },
  lon: { type: Number, default: null },
  /** Whether the view is the one showing; each showing takes a new still. */
  active: { type: Boolean, default: false },
  /**
   * Whether its rings and HUD move: only while the card's preview plays
   * (EntityPreview.vue). They hold still otherwise, and always with reduced
   * motion (entity-card.css).
   */
  moving: { type: Boolean, default: false },
  /** The swath it sees, in km: drawn to scale on the ground when known. */
  swathKm: { type: Number, default: null },
});

const hasSwath = computed(() => Number.isFinite(props.swathKm) && props.swathKm > 0);

const CLOSE_ZOOM = 13;
const WIDE_ZOOM = 4;

const root = ref(null);
/** The view's laid-out width, or the usual one before layout. */
function viewWidth() {
  const width = root.value?.getBoundingClientRect?.().width;
  return Number.isFinite(width) && width > 0 ? width : GROUND_VIEW_WIDTH_PX;
}

/** The spot the still was taken at, how close it looks and what is near. */
const spot = ref(null);
let taking = 0;
let takenAt = 0;
let framedWidth = 0;
async function take() {
  if (!Number.isFinite(props.lat) || !Number.isFinite(props.lon)) return;
  const lat = props.lat;
  const lon = props.lon;
  const turn = ++taking;
  takenAt = Date.now();
  let city = null;
  try {
    city = await nearestCity(lat, lon, { radiusKm: 40, nearKm: 15 });
  } catch {
    city = null;
  }
  if (turn !== taking) return;
  framedWidth = hasSwath.value ? viewWidth() : 0;
  const frame = hasSwath.value ? groundFrame(lat, props.swathKm, framedWidth) : null;
  const zoom = frame ? frame.zoom : city ? CLOSE_ZOOM : WIDE_ZOOM;
  spot.value = { lat, lon, zoom, scale: frame?.scale ?? 1, near: city?.name || '' };
}
watch(
  () => props.active,
  (shown) => {
    if (shown) void take();
    else taking++; // Discard a city lookup that started while this card was visible.
  },
  { immediate: true },
);
// Resizing changes the scale of the current still, not its location or age.
watch(
  () => props.active && hasSwath.value && root.value,
  (element, _, onCleanup) => {
    if (!element || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (!spot.value || !props.active || !hasSwath.value || width <= 0 || width === framedWidth) return;
      const { zoom, scale } = groundFrame(spot.value.lat, props.swathKm, width);
      framedWidth = width;
      spot.value = { ...spot.value, zoom, scale };
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  },
);
// A swath that only becomes known after the still was taken reframes it.
watch(hasSwath, (now) => now && props.active && take());
// The ground under the craft moves on (several kilometres a second), so the
// still is taken again while it shows once the craft has gone a quarter of
// its swath (25 km without one) from it, at most every RETAKE_MS: the
// picture and its label stay on the ground it sees now, as Nearby does.
const RETAKE_MS = 30_000;
watch(
  () => [props.lat, props.lon],
  ([lat, lon]) => {
    const was = spot.value;
    if (!props.active || !was || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const reach = hasSwath.value ? props.swathKm / 4 : 25;
    if (greatCircleKm(was, { lat, lon }) <= reach) return;
    if (Date.now() - takenAt < RETAKE_MS) return;
    void take();
  },
);

// A 3 by 3 block of tiles round the spot, placed so the spot is at the
// centre, and the same block of place names over it.
const onMap = computed(() => Boolean(spot.value) && onTileMap(spot.value.lat));
const tiles = computed(() => (onMap.value ? tileBlock(spot.value.lat, spot.value.lon, spot.value.zoom) : []));
const labels = computed(() => (onMap.value ? tileBlock(spot.value.lat, spot.value.lon, spot.value.zoom, ESRI_PLACES_TILES) : []));

// The geographic boundary uses the same origin, zoom and scale as the tiles.
const swath = computed(() => {
  if (!hasSwath.value || !onMap.value) return null;
  const { lat, lon, zoom } = spot.value;
  return swathPaths(lat, lon, props.swathKm, zoom);
});

const where = computed(() => {
  if (!spot.value) return '';
  const { lat, lon } = spot.value;
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
});
</script>

<template>
  <div ref="root" class="satellite-ground" :class="{ 'is-still': !active || !moving }">
    <div :key="where" class="satellite-ground__map" aria-hidden="true" :class="{ 'is-drifting': active }">
      <div class="satellite-ground__scale" :style="spot && spot.scale !== 1 ? { transform: `scale(${spot.scale})` } : undefined">
        <div class="satellite-ground__imagery">
          <img v-for="tile in tiles" :key="tile.key" class="satellite-ground__tile" :src="tile.src" alt="" draggable="false" :style="{ transform: `translate(${tile.left}px, ${tile.top}px)` }" />
          <img v-for="tile in labels" :key="`labels-${tile.key}`" class="satellite-ground__tile satellite-ground__tile--labels" :src="tile.src" alt="" draggable="false" :style="{ transform: `translate(${tile.left}px, ${tile.top}px)` }" />
        </div>
        <svg v-if="swath" class="satellite-ground__swath" aria-hidden="true">
          <path class="satellite-ground__swath-fill" :d="swath.fill" />
          <path class="satellite-ground__swath-edge" :d="swath.outline" />
        </svg>
      </div>
    </div>
    <svg v-if="onMap && !swath" class="satellite-ground__rings" aria-hidden="true" viewBox="-100 -100 200 200">
      <circle r="88" class="satellite-ground__ring satellite-ground__ring--outer" />
      <circle r="56" class="satellite-ground__ring satellite-ground__ring--middle" />
      <circle r="34" class="satellite-ground__ring satellite-ground__ring--inner" />
    </svg>
    <PreviewHud variant="ground" :running="active && moving" />
    <span class="satellite-ground__label" aria-hidden="true">{{ hasSwath ? t('Swath · the ground it sees now') : spot?.near ? t('Over {place}', { place: spot.near }) : t('Below') }}<strong>{{ hasSwath && spot?.near ? `${spot.near} · ${where}` : where }}</strong></span>
    <!-- The picture is decoration; its credit is not. -->
    <div class="satellite-ground__foot map-foot">
      <small class="satellite-ground__credit map-credit" tabindex="0" :title="ESRI_IMAGERY_PLACES_CREDIT">{{ ESRI_IMAGERY_PLACES_CARD_CREDIT }}</small>
    </div>
  </div>
</template>
