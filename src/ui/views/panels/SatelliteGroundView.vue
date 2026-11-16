<script setup>
import { computed, ref, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import { nearestCity } from '../../../data/wikidataCities.js';
import { ESRI_IMAGERY_CREDIT, ESRI_TILES } from '../../../maps/attribution.js';
import PreviewHud from './PreviewHud.vue';

// What lies under a satellite: a dark, grey top-down image of the ground at
// the point beneath it, with rings on that spot. It is a still taken each
// time the view comes round, and its tiles load only while it shows (the craft moves several kilometres a second, so
// a live view would only blur), and it drifts in slowly while it shows.
// Near a town it looks close in, at street-block scale; over open water or
// empty land, where a close view would be a blank, it stands well back so
// coasts and terrain show. The image is Esri World Imagery, the app's
// keyless basemap, from its classic tile endpoint; its credit line sits in
// the corner.
const props = defineProps({
  lat: { type: Number, default: null },
  lon: { type: Number, default: null },
  /** Whether the view is the one showing; each showing takes a new still. */
  active: { type: Boolean, default: false },
});

const CLOSE_ZOOM = 13;
const WIDE_ZOOM = 4;
const TILE = 256;

/** The spot the still was taken at, how close it looks and what is near. */
const spot = ref(null);
let taking = 0;
async function take() {
  if (!Number.isFinite(props.lat) || !Number.isFinite(props.lon)) return;
  const lat = props.lat;
  const lon = props.lon;
  const turn = ++taking;
  spot.value = null;
  let city = null;
  try {
    city = await nearestCity(lat, lon, { radiusKm: 40, nearKm: 15 });
  } catch {
    city = null;
  }
  if (turn !== taking) return;
  spot.value = { lat, lon, zoom: city ? CLOSE_ZOOM : WIDE_ZOOM, near: city?.name || '' };
}
watch(
  () => props.active,
  (now) => now && take(),
  { immediate: true },
);

// Web Mercator tile position of the spot, in tiles.
const at = computed(() => {
  if (!spot.value) return null;
  const n = 2 ** spot.value.zoom;
  const lat = Math.max(-85, Math.min(85, spot.value.lat));
  const x = ((spot.value.lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return { x, y, n, zoom: spot.value.zoom };
});

// A 3 by 3 block of tiles round the spot, placed so the spot is at the centre.
const tiles = computed(() => {
  const here = at.value;
  if (!here) return [];
  const cx = Math.floor(here.x);
  const cy = Math.floor(here.y);
  const list = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const y = cy + dy;
      if (y < 0 || y >= here.n) continue;
      const x = (((cx + dx) % here.n) + here.n) % here.n;
      list.push({
        key: `${x}/${y}`,
        src: ESRI_TILES.replace('{z}', here.zoom).replace('{y}', y).replace('{x}', x),
        left: (cx + dx - here.x) * TILE,
        top: (cy + dy - here.y) * TILE,
      });
    }
  return list;
});

const where = computed(() => {
  if (!spot.value) return '';
  const { lat, lon } = spot.value;
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
});
</script>

<template>
  <div class="satellite-ground" aria-hidden="true">
    <div :key="where" class="satellite-ground__map" :class="{ 'is-drifting': active }">
      <img v-for="tile in active ? tiles : []" :key="tile.key" class="satellite-ground__tile" :src="tile.src" alt="" draggable="false" :style="{ transform: `translate(${tile.left}px, ${tile.top}px)` }" />
    </div>
    <svg class="satellite-ground__rings" viewBox="-100 -100 200 200">
      <circle r="88" class="satellite-ground__ring satellite-ground__ring--outer" />
      <circle r="56" class="satellite-ground__ring satellite-ground__ring--middle" />
      <circle r="34" class="satellite-ground__ring satellite-ground__ring--inner" />
    </svg>
    <PreviewHud variant="ground" :running="active" />
    <span class="satellite-ground__label">{{ spot?.near ? t('Over {place}', { place: spot.near }) : t('Below') }}<strong>{{ where }}</strong></span>
    <span class="satellite-ground__credit">{{ ESRI_IMAGERY_CREDIT }}</span>
  </div>
</template>
