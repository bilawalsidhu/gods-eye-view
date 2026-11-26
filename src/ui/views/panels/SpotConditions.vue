<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onLocaleChange, t } from '../../../i18n/index.js';
import { weatherFacts, hazardsNear, regionalBrief, weatherLook } from '../../spotConditions.js';
import { approximatePosition, distanceText } from '../../distanceText.js';
import { contextAgeText } from '../../contextTime.js';
import { greatCircleKm } from '../../../geoDistance.js';
import { CONTEXT_RADIUS_STEPS, contextRadiusKm, contextRadiusText as radiusText, contextRadiusIndex as radiusIndex, pickContextRadius as pickRadius } from '../../contextRadius.js';
import { contextNeedle, matchesContextSearch } from '../../contextSearch.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import UiSlider from '../../kit/UiSlider.js';
import { sayWords, useEntityCardStore } from '../../stores/entityCard.js';
import { useOmnibarStore } from '../../stores/omnibar.js';
import { shownLayerName } from '../../layerNames.js';

// A selected item's weather and solar time, then flights, vessels, hazards,
// alerts and other loaded items within the radius. Moving the item refreshes them.
const props = defineProps({
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  withContacts: Boolean,
  /** Distances from a selected privacy cell or rounded observation are approximate. */
  approximate: Boolean,
  /** The selected item's own key, left out of the nearby lists. */
  excludeKey: { type: String, default: '' },
  /** How far the spot moves before the weather and hazards are read again. */
  settleKm: { type: Number, default: 1 },
});

const store = useEntityCardStore();
const omnibar = useOmnibarStore();

const brief = ref(null);
const hazards = ref([]);
const loading = ref(true);
/** Where the weather and hazards were last read for. */
let readAt = null;
let reading = 0;
/** Hazard reads count apart, so moving the radius never drops a weather read. */
let readingHazards = 0;
let settle = null;

const radiusKm = contextRadiusKm;

// Satellite fire hits come only while the FIRMS layer is on (spotConditions.js).
const firesOn = () =>
  Boolean((omnibar.controls?.layers() || []).find((layer) => layer.id === HAZARD_LAYER.hotspots)?.enabled);

async function read(lat, lon, { force = false } = {}) {
  if (!force && readAt && greatCircleKm(readAt, { lat, lon }) <= props.settleKm) return;
  readAt = { lat, lon };
  const mine = ++reading;
  const mineHazards = ++readingHazards;
  // A forced re-read keeps what is shown until the new reading lands.
  if (!force) loading.value = true;
  const [nextBrief, nextHazards] = await Promise.all([
    regionalBrief(lat, lon, store.readWeather, { force }),
    hazardsNear(lat, lon, radiusKm.value, { fires: firesOn(), force }).catch(() => []),
  ]);
  if (reading !== mine) return;
  if (nextBrief || !force) brief.value = nextBrief;
  // A radius change meanwhile has its own, newer hazard read.
  if (readingHazards === mineHazards) hazards.value = nextHazards;
  loading.value = false;
}
watch(
  () => `${props.lat},${props.lon}`,
  () => {
    clearTimeout(settle);
    settle = setTimeout(() => void read(props.lat, props.lon), 350);
  },
  { immediate: true },
);
// A new radius only re-filters the hazard feeds, which are already cached.
async function rereadHazards(km) {
  const at = readAt || { lat: props.lat, lon: props.lon };
  const mine = ++readingHazards;
  const next = await hazardsNear(at.lat, at.lon, km, { fires: firesOn() }).catch(() => []);
  if (readingHazards !== mine) return;
  hazards.value = next;
}
watch(radiusKm, (km) => void rereadHazards(km));
// A spot that stays put (a parked selection, a still view) reads its weather
// and hazards again once the kept copies are old.
const REREAD_MS = 5 * 60_000;
let rereadTimer = 0;
onMounted(() => {
  rereadTimer = setInterval(() => void read(props.lat, props.lon, { force: true }), REREAD_MS);
});
onBeforeUnmount(() => clearInterval(rereadTimer));
// Hazard rows are worded as they are read, so a new language reads them again.
const stopLocale = onLocaleChange(() => void rereadHazards(radiusKm.value));

// Warnings from the loaded layers move with their records; read them often.
const tick = ref(0);
let timer = null;
onMounted(() => {
  timer = setInterval(() => tick.value++, 4000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  clearTimeout(settle);
  stopLocale();
});
// The Context search narrows every list below to what holds its text.
const searching = computed(() => Boolean(contextNeedle.value));
const alerts = computed(() => {
  void tick.value;
  return store
    .alertsAt(props.lat, props.lon, { radiusKm: radiusKm.value, limit: searching.value ? 40 : 4 })
    .filter((alert) => matchesContextSearch(alert.title, sayWords(alert.words, alert.text), alert.text));
});
const shownHazards = computed(() =>
  hazards.value.filter((hazard) => matchesContextSearch(hazard.title, hazard.detail, hazardLayers.value[hazard.kind]?.name)).slice(0, searching.value ? 12 : 5),
);

// The merged card gets these cohorts and their coverage from Awareness.
const CONTACT_LAYERS = ['flights', 'military', 'ais-live-vessels', 'military-installations'];
const groups = computed(() => {
  void tick.value;
  return store.nearbyGroups(props.lat, props.lon, {
    radiusKm: radiusKm.value,
    limit: searching.value ? 12 : 4,
    excludeKey: props.excludeKey,
    excludeLayers: props.withContacts ? CONTACT_LAYERS : undefined,
    query: contextNeedle.value,
  });
});
const trafficBlocks = computed(() => {
  if (props.withContacts)
    return groups.value.flights.count
      ? [{ id: 'local-adsb', icon: 'flight', title: t('Local ADS-B'), ...groups.value.flights }]
      : [];
  return [
    { id: 'flights', icon: 'flight', title: t('Flights within {radius}', { radius: radiusText.value }), none: t('No flights within {radius} from the layers that are on.', { radius: radiusText.value }), ...groups.value.flights },
    { id: 'vessels', icon: 'directions_boat', title: t('Vessels within {radius}', { radius: radiusText.value }), none: t('No vessels within {radius} from the layers that are on.', { radius: radiusText.value }), ...groups.value.vessels },
  ];
});

// Local solar time at the spot, from its longitude: no time zone lookup.
const localTime = computed(() => {
  void tick.value;
  const solar = new Date(Date.now() + (props.lon / 15) * 3_600_000);
  return `${String(solar.getUTCHours()).padStart(2, '0')}:${String(solar.getUTCMinutes()).padStart(2, '0')}`;
});

const weather = computed(() => brief.value?.weather || null);
const look = computed(() => weatherLook(weather.value?.weatherCode));
const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
const facts = computed(() => weatherFacts(weather.value));

function distance({ distanceKm: km, identity }) {
  return distanceText(km, props.approximate || approximatePosition(identity?.record));
}

// The layer each kind of hazard comes from. Picking a hazard turns its layer
// on (when it is off) so the marker and its label are there to select.
const HAZARD_LAYER = {
  quake: 'earthquakes',
  storm: 'weather-cyclones',
  wildfire: 'fire-perimeters',
  hotspots: 'local-firms',
};
// Far enough out to see the markers (and pick one), not just the ground.
const HAZARD_RANGE_M = { quake: 120000, storm: 1500000, wildfire: 40000, hotspots: 180000 };
const layerTick = ref(0);
const hazardLayers = computed(() => {
  void layerTick.value;
  void hazards.value;
  const rows = omnibar.controls?.layers() || [];
  return Object.fromEntries(
    Object.entries(HAZARD_LAYER).map(([kind, id]) => {
      const row = rows.find((layer) => layer.id === id);
      return [kind, row ? { id, name: shownLayerName(row.name, id), on: Boolean(row.enabled) } : null];
    }),
  );
});
// Turning FIRMS on or off adds or drops its fire hits at once.
watch(
  () => Boolean(hazardLayers.value.hotspots?.on),
  () => void rereadHazards(radiusKm.value),
);
let layerTimer = 0;
onMounted(() => {
  layerTimer = setInterval(() => layerTick.value++, 1500);
});
onBeforeUnmount(() => clearInterval(layerTimer));

function flyTo(hazard) {
  const layer = hazardLayers.value[hazard.kind];
  if (layer && !layer.on) {
    void omnibar.controls?.setLayer(layer.id, true);
    setTimeout(() => layerTick.value++, 800);
  }
  omnibar.runner?.('fly_to_location', {
    latitude: hazard.at.lat,
    longitude: hazard.at.lon,
    query: hazard.title,
    viewMode: 'overview',
    rangeM: HAZARD_RANGE_M[hazard.kind] ?? 100000,
  });
}

const sources = computed(() => {
  const list = [];
  if (weather.value) list.push('Open-Meteo');
  if (hazards.value.some((h) => h.kind === 'quake')) list.push('USGS');
  if (hazards.value.some((h) => h.kind === 'storm')) list.push('NOAA NHC');
  if (hazards.value.some((h) => h.kind === 'wildfire')) list.push('NIFC WFIGS');
  if (hazards.value.some((h) => h.kind === 'hotspots')) list.push('NASA FIRMS');
  return list.join(' · ');
});
</script>

<template>
  <section class="spot-conditions" :aria-label="t('Conditions here')" :aria-busy="String(loading)">
    <!-- A selected item leads with the weather and the time there. -->
    <div class="spot-conditions__weather spot-conditions__weather--timed">
      <template v-if="weather">
        <UiIcon class="spot-conditions__weather-icon" :name="look.icon" :size="null" />
        <div class="spot-conditions__weather-now">
          <strong>{{ round(weather.temperatureC) }}°C</strong>
          <span>{{ t(look.label) }}<template v-if="Number.isFinite(weather.apparentTemperatureC)"> · {{ t('feels {n}°', { n: round(weather.apparentTemperatureC) }) }}</template></span>
        </div>
      </template>
      <p v-else class="spot-conditions__loading spot-conditions__weather-wait">{{ loading ? t('Reading conditions here…') : t('No weather reading here.') }}</p>
      <div class="spot-conditions__time">
        <strong>{{ localTime }}</strong>
        <span>{{ t('Local solar time') }}</span>
      </div>
      <dl v-if="weather" class="spot-conditions__weather-facts">
        <div v-for="fact in facts" :key="fact.label">
          <dt>{{ fact.label }}</dt>
          <dd>{{ fact.value }}</dd>
        </div>
      </dl>
    </div>

    <!-- One distance for every nearby block below. -->
    <div class="spot-conditions__radius">
      <span class="spot-conditions__radius-label">{{ t('Nearby radius') }}</span>
      <UiSlider class="spot-conditions__radius-slider" min="0" :max="CONTEXT_RADIUS_STEPS.length - 1" step="1" :model-value="radiusIndex" :aria-label="t('Nearby radius')" :aria-valuetext="radiusText" :title="t('How far out the nearby lists look')" @update:model-value="pickRadius" />
      <output class="spot-conditions__radius-value">{{ radiusText }}</output>
    </div>

    <div v-for="block in trafficBlocks" v-show="!searching || block.items.length" :key="block.id" class="spot-conditions__block">
      <h4>
        <UiIcon :name="block.icon" :size="null" />
        <span>{{ block.title }}</span>
        <span class="spot-conditions__count">{{ block.count }}</span>
      </h4>
      <ul v-if="block.items.length">
        <li v-for="item in block.items" :key="item.key">
          <UiButton @click="store.select(item.identity, { fly: true })">
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ item.title }}</span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(item) }}</span>
          </UiButton>
        </li>
      </ul>
      <p v-else class="spot-conditions__none">{{ block.none }}</p>
    </div>

    <div v-show="!searching || shownHazards.length" class="spot-conditions__block">
      <h4>
        <UiIcon name="warning" :size="null" />
        <span>{{ t('Hazards within {radius}', { radius: radiusText }) }}</span>
        <span class="spot-conditions__count" :class="{ 'spot-conditions__count--hot': hazards.length }">{{ loading ? '…' : searching ? shownHazards.length : hazards.length }}</span>
      </h4>
      <ul v-if="shownHazards.length">
        <li v-for="hazard in shownHazards" :key="`${hazard.kind}-${hazard.title}-${hazard.distanceKm}`" :class="`spot-conditions__hazard--${hazard.kind}`">
          <UiButton @click="flyTo(hazard)">
            <UiIcon :name="hazard.icon" :size="null" />
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ hazard.title }}</span>
              <span v-if="hazard.detail || hazard.time" class="spot-conditions__row-detail">{{ [hazard.detail, Number.isFinite(hazard.time) ? contextAgeText(Date.now() - hazard.time) : ''].filter(Boolean).join(' · ') }}</span>
              <span v-if="hazardLayers[hazard.kind]" class="spot-conditions__row-layer" :class="{ 'is-on': hazardLayers[hazard.kind].on }" :title="hazardLayers[hazard.kind].on ? t('Layer on') : t('Turns the layer on')">
                <span class="spot-conditions__row-dot" aria-hidden="true"></span>{{ hazardLayers[hazard.kind].name }}
              </span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(hazard) }} {{ t(hazard.direction) }}</span>
          </UiButton>
        </li>
      </ul>
      <p v-else-if="!loading" class="spot-conditions__none">{{ t('No earthquakes, tropical storms or wildfires reported within {radius}.', { radius: radiusText }) }}</p>
    </div>

    <div v-if="alerts.length" class="spot-conditions__block">
      <h4>
        <UiIcon name="emergency_home" :size="null" />
        <span>{{ t('Broadcast alerts within {radius}', { radius: radiusText }) }}</span>
        <span class="spot-conditions__count spot-conditions__count--hot">{{ alerts.length }}</span>
      </h4>
      <ul>
        <li v-for="alert in alerts" :key="alert.key" class="spot-conditions__hazard--alert">
          <UiButton @click="store.select(alert.identity, { fly: true })">
            <UiIcon :name="alert.icon" :size="null" />
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ alert.title }}</span>
              <span class="spot-conditions__row-detail">{{ sayWords(alert.words, alert.text) }}</span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(alert) }}</span>
          </UiButton>
        </li>
      </ul>
    </div>

    <div v-if="groups.other.length" class="spot-conditions__block">
      <h4>
        <UiIcon name="layers" :size="null" />
        <span>{{ t('Also within {radius}', { radius: radiusText }) }}</span>
        <span class="spot-conditions__count">{{ groups.other.length }}</span>
      </h4>
      <ul>
        <li v-for="item in groups.other" :key="item.key">
          <UiButton @click="store.select(item.identity, { fly: true })">
            <UiIcon :name="item.icon" :size="null" />
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ item.title }}</span>
              <span class="spot-conditions__row-detail">{{ shownLayerName(item.layerName, item.layerId) }}</span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(item) }}</span>
          </UiButton>
        </li>
      </ul>
    </div>

    <p v-if="sources" class="spot-conditions__source">{{ sources }}</p>
  </section>
</template>
