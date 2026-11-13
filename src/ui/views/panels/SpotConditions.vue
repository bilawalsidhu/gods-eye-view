<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '../../../i18n/index.js';
import { compassName, hazardsNear, regionalBrief, weatherLook } from '../../spotConditions.js';
import { distanceKm } from '../../../data/entityContext.js';
import { CONTEXT_RADIUS_STEPS, contextRadiusKm, setContextRadiusKm } from '../../contextRadius.js';
import { contextNeedle, matchesContextSearch } from '../../contextSearch.js';
import UiSlider from '../../kit/UiSlider.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { useOmnibarStore } from '../../stores/omnibar.js';
import { shownLayerName } from '../../layerNames.js';

// Conditions around one spot. For the view when nothing is picked: the
// weather there now, natural hazards near it (earthquakes, tropical storms,
// wildfires), warnings broadcast by things the loaded layers have nearby, and
// the local headlines. For a selected item (`entity`) it is the standard set
// every card shows, in one order: weather and local time, then the flights,
// vessels and hazards nearby, then alerts and whatever else is loaded there.
// Every nearby block looks out to the same distance, set by the radius
// control here. It reads again when the spot moves; the feeds behind it are
// cached.
const props = defineProps({
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  /** Show the standard blocks for a selected item. */
  entity: { type: Boolean, default: false },
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
const radiusText = computed(() => `${radiusKm.value.toLocaleString()} km`);
const radiusIndex = computed(() => Math.max(0, CONTEXT_RADIUS_STEPS.indexOf(radiusKm.value)));
const pickRadius = (index) => setContextRadiusKm(CONTEXT_RADIUS_STEPS[index]);

async function read(lat, lon) {
  if (readAt && distanceKm(readAt, { lat, lon }) <= props.settleKm) return;
  readAt = { lat, lon };
  const mine = ++reading;
  const mineHazards = ++readingHazards;
  loading.value = true;
  const [nextBrief, nextHazards] = await Promise.all([
    regionalBrief(lat, lon),
    hazardsNear(lat, lon, radiusKm.value).catch(() => []),
  ]);
  if (reading !== mine) return;
  brief.value = nextBrief;
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
watch(radiusKm, async (km) => {
  const at = readAt || { lat: props.lat, lon: props.lon };
  const mine = ++readingHazards;
  const next = await hazardsNear(at.lat, at.lon, km).catch(() => []);
  if (readingHazards !== mine) return;
  hazards.value = next;
});

// Warnings from the loaded layers move with their records; read them often.
const tick = ref(0);
let timer = null;
onMounted(() => {
  timer = setInterval(() => tick.value++, 4000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  clearTimeout(settle);
});
// The Context search narrows every list below to what holds its text.
const searching = computed(() => Boolean(contextNeedle.value));
const alerts = computed(() => {
  void tick.value;
  return store
    .alertsAt(props.lat, props.lon, { radiusKm: radiusKm.value, limit: searching.value ? 40 : 4 })
    .filter((alert) => matchesContextSearch(alert.title, alert.text));
});
const shownHazards = computed(() =>
  hazards.value.filter((hazard) => matchesContextSearch(hazard.title, hazard.detail, hazardLayers.value[hazard.kind]?.name)).slice(0, searching.value ? 12 : 5),
);

// The standard nearby lists for a selected item, from the layers that are on.
const groups = computed(() => {
  void tick.value;
  if (!props.entity) return null;
  return store.nearbyGroups(props.lat, props.lon, {
    radiusKm: radiusKm.value,
    limit: searching.value ? 12 : 4,
    excludeKey: props.excludeKey,
    query: contextNeedle.value,
  });
});
const trafficBlocks = computed(() =>
  groups.value
    ? [
        { id: 'flights', icon: 'flight', title: t('Flights within {radius}', { radius: radiusText.value }), none: t('No flights within {radius} from the layers that are on.', { radius: radiusText.value }), ...groups.value.flights },
        { id: 'vessels', icon: 'directions_boat', title: t('Vessels within {radius}', { radius: radiusText.value }), none: t('No vessels within {radius} from the layers that are on.', { radius: radiusText.value }), ...groups.value.vessels },
      ]
    : [],
);

// Local solar time at the spot, from its longitude: no time zone lookup.
const localTime = computed(() => {
  void tick.value;
  const solar = new Date(Date.now() + (props.lon / 15) * 3_600_000);
  return `${String(solar.getUTCHours()).padStart(2, '0')}:${String(solar.getUTCMinutes()).padStart(2, '0')}`;
});

const weather = computed(() => brief.value?.weather || null);
const look = computed(() => weatherLook(weather.value?.weatherCode));
const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
const weatherFacts = computed(() => {
  const now = weather.value;
  if (!now) return [];
  const facts = [];
  if (Number.isFinite(now.windKph)) {
    const from = Number.isFinite(now.windDirectionDeg)
      ? ` ${compassName(now.windDirectionDeg)}`
      : '';
    facts.push({ label: t('Wind'), value: `${round(now.windKph)} km/h${from}` });
  }
  if (Number.isFinite(now.cloudCoverPct)) facts.push({ label: t('Cloud'), value: `${round(now.cloudCoverPct)}%` });
  if (Number.isFinite(now.visibilityM))
    facts.push({
      label: t('Visibility'),
      value: now.visibilityM >= 10_000 ? `${round(now.visibilityM / 1000)} km` : `${(now.visibilityM / 1000).toFixed(1)} km`,
    });
  if (Number.isFinite(now.precipitationMm)) facts.push({ label: t('Rain'), value: `${now.precipitationMm.toFixed(1)} mm` });
  return facts;
});

const articles = computed(() =>
  props.entity ? [] : (brief.value?.articles || []).filter((article) => matchesContextSearch(article.title, article.domain)).slice(0, 3),
);

const distance = (km) => (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`);
function ago(ms) {
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 60) return t('{n} min ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('{n} h ago', { n: hours });
  return t('{n} d ago', { n: Math.round(hours / 24) });
}
const host = (article) => article.domain || '';

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
  if (articles.value.length && brief.value?.newsSource) list.push(brief.value.newsSource);
  return list.join(' · ');
});
</script>

<template>
  <section class="spot-conditions" :aria-label="t('Conditions here')" :aria-busy="String(loading)">
    <!-- A selected item leads with the weather and the time there. -->
    <template v-if="entity">
      <div v-if="weather || entity" class="spot-conditions__weather" :class="{ 'spot-conditions__weather--timed': entity }">
        <template v-if="weather">
          <span class="material-symbols-outlined spot-conditions__weather-icon" aria-hidden="true">{{ look.icon }}</span>
          <div class="spot-conditions__weather-now">
            <strong>{{ round(weather.temperatureC) }}°C</strong>
            <span>{{ t(look.label) }}<template v-if="Number.isFinite(weather.apparentTemperatureC)"> · {{ t('feels {n}°', { n: round(weather.apparentTemperatureC) }) }}</template></span>
          </div>
        </template>
        <p v-else class="spot-conditions__loading spot-conditions__weather-wait">{{ loading ? t('Reading conditions here…') : t('No weather reading here.') }}</p>
        <div v-if="entity" class="spot-conditions__time">
          <strong>{{ localTime }}</strong>
          <span>{{ t('Local solar time') }}</span>
        </div>
        <dl v-if="weather" class="spot-conditions__weather-facts">
          <div v-for="fact in weatherFacts" :key="fact.label">
            <dt>{{ fact.label }}</dt>
            <dd>{{ fact.value }}</dd>
          </div>
        </dl>
      </div>
      <p v-else-if="loading" class="spot-conditions__loading">{{ t('Reading conditions here…') }}</p>
    </template>

    <!-- What the view's enabled layers have here. -->
    <slot name="after-weather" />

    <!-- One distance for every nearby block below. -->
    <div class="spot-conditions__radius">
      <span class="spot-conditions__radius-label">{{ t('Nearby radius') }}</span>
      <UiSlider class="spot-conditions__radius-slider" min="0" :max="CONTEXT_RADIUS_STEPS.length - 1" step="1" :model-value="radiusIndex" :aria-label="t('Nearby radius')" :aria-valuetext="radiusText" :title="t('How far out the nearby lists look')" @update:model-value="pickRadius" />
      <output class="spot-conditions__radius-value">{{ radiusText }}</output>
    </div>

    <div v-for="block in trafficBlocks" v-show="!searching || block.items.length" :key="block.id" class="spot-conditions__block">
      <h4>
        <span class="material-symbols-outlined" aria-hidden="true">{{ block.icon }}</span>
        <span>{{ block.title }}</span>
        <span class="spot-conditions__count">{{ block.count }}</span>
      </h4>
      <ul v-if="block.items.length">
        <li v-for="item in block.items" :key="item.key">
          <button type="button" @click="store.select(item.identity, { fly: true })">
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ item.title }}</span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(item.distanceKm) }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="spot-conditions__none">{{ block.none }}</p>
    </div>

    <div v-show="!searching || shownHazards.length" class="spot-conditions__block">
      <h4>
        <span class="material-symbols-outlined" aria-hidden="true">warning</span>
        <span>{{ t('Hazards within {radius}', { radius: radiusText }) }}</span>
        <span class="spot-conditions__count" :class="{ 'spot-conditions__count--hot': hazards.length }">{{ loading ? '…' : searching ? shownHazards.length : hazards.length }}</span>
      </h4>
      <ul v-if="shownHazards.length">
        <li v-for="hazard in shownHazards" :key="`${hazard.kind}-${hazard.title}-${hazard.distanceKm}`" :class="`spot-conditions__hazard--${hazard.kind}`">
          <button type="button" @click="flyTo(hazard)">
            <span class="material-symbols-outlined" aria-hidden="true">{{ hazard.icon }}</span>
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ hazard.title }}</span>
              <span v-if="hazard.detail || hazard.time" class="spot-conditions__row-detail">{{ [hazard.detail, ago(hazard.time)].filter(Boolean).join(' · ') }}</span>
              <span v-if="hazardLayers[hazard.kind]" class="spot-conditions__row-layer" :class="{ 'is-on': hazardLayers[hazard.kind].on }" :title="hazardLayers[hazard.kind].on ? t('Layer on') : t('Turns the layer on')">
                <span class="spot-conditions__row-dot" aria-hidden="true"></span>{{ hazardLayers[hazard.kind].name }}
              </span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(hazard.distanceKm) }} {{ hazard.direction }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="!loading" class="spot-conditions__none">{{ t('No earthquakes, tropical storms or wildfires reported within {radius}.', { radius: radiusText }) }}</p>
    </div>

    <div v-if="alerts.length" class="spot-conditions__block">
      <h4>
        <span class="material-symbols-outlined" aria-hidden="true">emergency_home</span>
        <span>{{ t('Broadcast alerts within {radius}', { radius: radiusText }) }}</span>
        <span class="spot-conditions__count spot-conditions__count--hot">{{ alerts.length }}</span>
      </h4>
      <ul>
        <li v-for="alert in alerts" :key="alert.key" class="spot-conditions__hazard--alert">
          <button type="button" @click="store.select(alert.identity, { fly: true })">
            <span class="material-symbols-outlined" aria-hidden="true">{{ alert.icon }}</span>
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ alert.title }}</span>
              <span class="spot-conditions__row-detail">{{ alert.text }}</span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(alert.distanceKm) }}</span>
          </button>
        </li>
      </ul>
    </div>

    <div v-if="groups?.other.length" class="spot-conditions__block">
      <h4>
        <span class="material-symbols-outlined" aria-hidden="true">layers</span>
        <span>{{ t('Also within {radius}', { radius: radiusText }) }}</span>
        <span class="spot-conditions__count">{{ groups.other.length }}</span>
      </h4>
      <ul>
        <li v-for="item in groups.other" :key="item.key">
          <button type="button" @click="store.select(item.identity, { fly: true })">
            <span class="material-symbols-outlined" aria-hidden="true">{{ item.icon }}</span>
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ item.title }}</span>
              <span class="spot-conditions__row-detail">{{ item.layerName }}</span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(item.distanceKm) }}</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- For the view, the time and weather there come last, above the news. -->
    <template v-if="!entity">
      <slot name="before-weather" />
      <div v-if="weather || entity" class="spot-conditions__weather" :class="{ 'spot-conditions__weather--timed': entity }">
        <template v-if="weather">
          <span class="material-symbols-outlined spot-conditions__weather-icon" aria-hidden="true">{{ look.icon }}</span>
          <div class="spot-conditions__weather-now">
            <strong>{{ round(weather.temperatureC) }}°C</strong>
            <span>{{ t(look.label) }}<template v-if="Number.isFinite(weather.apparentTemperatureC)"> · {{ t('feels {n}°', { n: round(weather.apparentTemperatureC) }) }}</template></span>
          </div>
        </template>
        <p v-else class="spot-conditions__loading spot-conditions__weather-wait">{{ loading ? t('Reading conditions here…') : t('No weather reading here.') }}</p>
        <div v-if="entity" class="spot-conditions__time">
          <strong>{{ localTime }}</strong>
          <span>{{ t('Local solar time') }}</span>
        </div>
        <dl v-if="weather" class="spot-conditions__weather-facts">
          <div v-for="fact in weatherFacts" :key="fact.label">
            <dt>{{ fact.label }}</dt>
            <dd>{{ fact.value }}</dd>
          </div>
        </dl>
      </div>
      <p v-else-if="loading" class="spot-conditions__loading">{{ t('Reading conditions here…') }}</p>
    </template>

    <div v-if="articles.length" class="spot-conditions__block">
      <h4>
        <span class="material-symbols-outlined" aria-hidden="true">newspaper</span>
        <span>{{ t('Local news') }}</span>
        <span v-if="brief?.newsQuery" class="spot-conditions__query">{{ brief.newsQuery }}</span>
      </h4>
      <ul>
        <li v-for="article in articles" :key="article.url">
          <a :href="article.url" target="_blank" rel="noopener noreferrer">
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title spot-conditions__row-title--wrap">{{ article.title }}</span>
              <span class="spot-conditions__row-detail">{{ [host(article), ago(Date.parse(article.publishedAt))].filter(Boolean).join(' · ') }}</span>
            </span>
          </a>
        </li>
      </ul>
    </div>

    <p v-if="sources" class="spot-conditions__source">{{ sources }}</p>
  </section>
</template>
