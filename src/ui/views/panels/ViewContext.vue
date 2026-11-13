<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { contextNeedle, contextSearchText, matchesContextSearch } from '../../contextSearch.js';
import { t } from '../../../i18n/index.js';
import { citiesAround, countryName, nearestCity } from '../../../data/wikidataCities.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { useOmnibarStore } from '../../stores/omnibar.js';
import { shownLayerName } from '../../layerNames.js';
import { entityKind } from '../../../data/entityContext.js';
import SpotConditions from './SpotConditions.vue';
import SunDial from './SunDial.vue';
import AltitudeGraph from './AltitudeGraph.vue';

// What the Context panel shows while nothing is picked: where the camera is
// looking (place, region, local solar time, daylight, how wide the view is),
// the towns in it, what the loaded layers have in view closest to the middle
// first, and switches for the most used layers that are off. Any row opens
// that item's card. It reads again when the camera settles, and every few
// seconds so moving things stay current.
const store = useEntityCardStore();
const { view } = storeToRefs(store);
const tick = ref(0);
let timer = null;
onMounted(() => {
  timer = setInterval(() => tick.value++, 4000);
});
onBeforeUnmount(() => clearInterval(timer));

const groups = computed(() => {
  void tick.value;
  void view.value;
  return store.inView({ perLayer: contextNeedle.value ? 12 : 3, query: contextNeedle.value });
});
const shownTowns = computed(() => towns.value.filter((town) => matchesContextSearch(town.name)));
const total = computed(() => groups.value.reduce((sum, group) => sum + group.count, 0));
const totalLine = computed(() => {
  const things = total.value === 1 ? t('1 thing') : t('{n} things', { n: total.value });
  const layers = groups.value.length === 1 ? t('1 layer') : t('{n} layers', { n: groups.value.length });
  return t('{things} in view from {layers}', { things, layers });
});

// The city at (or nearest to) the middle of the view, from the bundled cities
// pack: no place service is asked.
const place = ref(null);
let placeFor = '';
watch(
  view,
  async (current) => {
    if (!current) return;
    const key = `${current.center.lat.toFixed(2)},${current.center.lon.toFixed(2)}`;
    if (key === placeFor) return;
    placeFor = key;
    try {
      const city = await nearestCity(current.center.lat, current.center.lon);
      if (placeFor === key) place.value = city ? { name: city.name, state: null, country: countryName(city.country) } : null;
    } catch {
      if (placeFor === key) place.value = null;
    }
  },
  { immediate: true },
);

const where = computed(() => {
  const at = view.value?.center;
  if (!at) return '';
  return `${Math.abs(at.lat).toFixed(3)}°${at.lat >= 0 ? 'N' : 'S'}  ${Math.abs(at.lon).toFixed(3)}°${at.lon >= 0 ? 'E' : 'W'}`;
});
const height = computed(() => {
  const m = view.value?.heightM ?? 0;
  return m >= 10_000 ? t('{n} km up', { n: Math.round(m / 1000) }) : t('{n} m up', { n: Math.round(m) });
});
const placeName = computed(() => {
  const found = place.value;
  if (!found) return t('This view');
  return [found.name, found.state || found.country].filter(Boolean).join(', ');
});
// The sun at the middle of the view, from the usual low-precision formula
// (good to a fraction of a degree): its elevation, and the local solar time.
function sunElevation(lat, lon, when) {
  const rad = Math.PI / 180;
  const d = (when - Date.UTC(2000, 0, 1, 12)) / 86_400_000;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const ecliptic = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const tilt = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(tilt) * Math.sin(ecliptic), Math.cos(ecliptic));
  const dec = Math.asin(Math.sin(tilt) * Math.sin(ecliptic));
  const sidereal = ((18.697374558 + 24.06570982441908 * d) % 24) * 15;
  const hourAngle = (sidereal + lon) * rad - ra;
  return (
    Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(hourAngle)) / rad
  );
}

// The sundial shows only with the whole globe in view, not zoomed in. It
// goes by the camera's height: a tilted view near the ground sees the
// horizon, so the view's extent reads as the whole globe there too.
const GLOBE_HEIGHT_M = 5_000_000;
const globeView = computed(() => {
  const current = view.value;
  return Boolean(current?.center) && (current.heightM ?? 0) >= GLOBE_HEIGHT_M;
});

// Local time and daylight at the middle of the view. With the whole globe in
// view they say little, so they are left out there. The camera's height has
// its own graph.
const facts = computed(() => {
  void tick.value;
  const current = view.value;
  if (!current || globeView.value) return [];
  const { lat, lon } = current.center;
  const now = Date.now();
  const solar = new Date(now + (lon / 15) * 3_600_000);
  const time = `${String(solar.getUTCHours()).padStart(2, '0')}:${String(solar.getUTCMinutes()).padStart(2, '0')}`;
  const sun = sunElevation(lat, lon, now);
  const light = sun > 6 ? t('Day') : sun > -6 ? t('Twilight') : t('Night');
  return [
    { label: t('Local solar time'), value: time },
    { label: t('Daylight'), value: `${light} · ${t('sun {n}°', { n: Math.round(sun) })}` },
  ];
});
// A reading of the camera's height each time the view settles, and on the
// timer, for its graph.
const cameraTick = ref(0);
watch([view, tick], () => cameraTick.value++);

// Towns in the view, nearest the middle first.
const towns = ref([]);
let townsFor = '';
watch(
  view,
  async (current) => {
    if (!current || current.heightM > 400_000) {
      towns.value = [];
      return;
    }
    const key = `${current.center.lat.toFixed(2)},${current.center.lon.toFixed(2)},${Math.round(current.heightM / 1000)}`;
    if (key === townsFor) return;
    townsFor = key;
    try {
      // The most populous places in view; only larger cities from high up.
      const found = await citiesAround({
        latitude: current.center.lat,
        longitude: current.center.lon,
        radiusKm: Math.round(Math.min(150, Math.max(15, current.heightM / 1500))),
        minPopulation: current.heightM > 60_000 ? 50_000 : 0,
        limit: 8,
      });
      if (townsFor === key) towns.value = found.filter((town) => town.name !== place.value?.name).slice(0, 5);
    } catch {
      if (townsFor === key) towns.value = [];
    }
  },
  { immediate: true },
);
const goToTown = (town) =>
  omnibar.runner
    ? omnibar.runner('fly_to_location', { latitude: town.latitude, longitude: town.longitude, query: town.name })
    : null;

// What each layer that is on is made of (aircraft: civilian, military and on
// the ground, then by type; vessels by type; and so on): of everything it has
// at globe view, of what is in view once zoomed in. Each split is a bar whose
// segments are its parts.
const SPLIT_COLORS = ['#36dcff', '#ffb547', '#8f9aa3', '#c792ff', '#4be3a0'];
function breakdownOf(layerId, loaded) {
  const found = store.breakdown(layerId, globeView.value ? {} : { rect: view.value?.rect });
  if (!found) return null;
  const basis = globeView.value
    ? loaded !== null && loaded > found.total
      ? t('Of {n} read, {total} loaded', { n: found.total.toLocaleString(), total: loaded.toLocaleString() })
      : t('Of all {n}', { n: found.total.toLocaleString() })
    : t('Of {n} in view', { n: found.total.toLocaleString() });
  return {
    basis,
    splits: found.splits.map((split) => ({
      title: t(split.title),
      parts: split.parts.map((part, index) => ({
        label: t(part.label),
        count: part.count.toLocaleString(),
        share: `${((part.count / found.total) * 100).toFixed(1)}%`,
        color: SPLIT_COLORS[index % SPLIT_COLORS.length],
      })),
    })),
  };
}

// The layers that are on: their state, how many items each holds and how
// many of those are in view, so the card reflects what Data Layers has on.
const liveLayers = computed(() => {
  void tick.value;
  const inViewCount = Object.fromEntries(groups.value.map((g) => [g.layerId, g.count]));
  const now = Date.now();
  return store.liveLayers().map((row) => {
    const stats = row.stats || {};
    const state = stats.error
      ? { tone: 'error', text: t('Error') }
      : stats.loading && !stats.count
        ? { tone: 'loading', text: t('Loading') }
        : stats.stale
          ? { tone: 'stale', text: t('Stale') }
          : { tone: 'live', text: t('Live') };
    const age = Number.isFinite(stats.lastUpdate) ? Math.max(0, Math.round((now - stats.lastUpdate) / 1000)) : null;
    const updated =
      age === null ? '' : age < 60 ? t('{n} s ago', { n: age }) : age < 3600 ? t('{n} min ago', { n: Math.round(age / 60) }) : t('{n} h ago', { n: Math.round(age / 3600) });
    return {
      id: row.id,
      icon: row.icon || '',
      name: shownLayerName(row.name, row.id),
      state,
      total: Number.isFinite(stats.count) ? stats.count : null,
      inView: inViewCount[row.id] ?? 0,
      updated,
      breakdown: breakdownOf(row.id, Number.isFinite(stats.count) ? stats.count : null),
    };
  });
});
// With the whole globe in view, what a point has nearby says little; the
// panel shows worldwide counts instead, one tile per layer: how many each
// layer that is on has loaded, and the most used layers that are off as
// tiles that turn them on. A count is kept while its layer reloads, so the
// tiles hold steady, and it does not change as the camera moves.
const lastCounts = new Map();
const TILE_ICONS = { cctv: 'videocam', traffic: 'traffic', fires: 'local_fire_department' };
const tileIcon = (id) => TILE_ICONS[id] || entityKind(id).icon;
const worldTiles = computed(() => {
  void tick.value;
  const on = liveLayers.value
    .map((layer) => {
      if (layer.total !== null) lastCounts.set(layer.id, layer.total);
      return { id: layer.id, name: layer.name, icon: tileIcon(layer.id), on: true, count: lastCounts.get(layer.id) ?? null };
    })
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
  const off = offLayers.value.map((layer) => ({ id: layer.id, name: layer.name, icon: tileIcon(layer.id), on: false, count: null }));
  return [...on, ...off].slice(0, 8);
});

function turnOff(layer) {
  void omnibar.controls?.setLayer(layer.id, false);
  setTimeout(() => tick.value++, 800);
}

// The most used layers that are off, as switches.
const omnibar = useOmnibarStore();
const POPULAR = ['flights', 'ais-live-vessels', 'satellites', 'earthquakes', 'cctv', 'fires', 'traffic', 'weather-cyclones'];
const offLayers = computed(() => {
  void tick.value;
  return (omnibar.controls?.layers() || [])
    .filter((layer) => POPULAR.includes(layer.id) && !layer.enabled)
    .sort((a, b) => POPULAR.indexOf(a.id) - POPULAR.indexOf(b.id))
    .slice(0, 4)
    .map((layer) => ({ id: layer.id, name: shownLayerName(layer.name, layer.id) }));
});
function turnOn(layer) {
  void omnibar.controls?.setLayer(layer.id, true);
  setTimeout(() => tick.value++, 1500);
}

const distance = (km) =>
  km < 1 ? t('{n} m', { n: Math.round(km * 1000) }) : t('{n} km', { n: km < 10 ? km.toFixed(1) : Math.round(km) });
</script>

<template>
  <section class="view-context" :aria-label="t('In view')">
    <!-- With the whole globe in view there is no place to name. -->
    <h3 v-if="globeView" class="view-context__title">{{ t('Globe view') }}</h3>
    <template v-else>
    <header class="view-context__head">
      <span class="material-symbols-outlined view-context__icon" aria-hidden="true">visibility</span>
      <div class="view-context__kind">
        <span>{{ t('In view') }}</span>
        <span class="view-context__sub">{{ t('Nothing selected') }}</span>
      </div>
    </header>
    <h3 class="view-context__title">{{ placeName }}</h3>
    <p v-if="place && place.country && place.country !== place.name" class="view-context__region">{{ [place.state !== place.name ? place.state : null, place.country].filter(Boolean).join(' · ') }}</p>
    <p v-if="where" class="view-context__where">{{ where }}</p>
    </template>

    <div v-if="globeView && worldTiles.length" class="view-context__world">
      <h4>{{ t('Worldwide now') }}</h4>
      <div class="view-context__world-grid">
        <component :is="tile.on ? 'div' : 'button'" v-for="tile in worldTiles" :key="tile.id" :type="tile.on ? undefined : 'button'" class="view-context__world-tile" :class="{ 'is-off': !tile.on }" :title="tile.on ? undefined : t('Turn on {name}', { name: tile.name })" @click="tile.on ? undefined : turnOn(tile)">
          <span class="material-symbols-outlined" aria-hidden="true">{{ tile.icon }}</span>
          <strong>{{ tile.on ? (tile.count === null ? '…' : tile.count.toLocaleString()) : t('Off') }}</strong>
          <span>{{ tile.name }}</span>
        </component>
      </div>
    </div>

    <!-- The sun dial fills the globe view only while no layer is on; once one is, its counts lead. -->
    <SunDial v-if="globeView && !liveLayers.length" :lat="view.center.lat" :lon="view.center.lon" />

    <!-- The layers that are on, and what each is made of, lead. -->
    <div v-if="liveLayers.length" class="view-context__live">
      <h4>{{ t('Layers on') }} <span class="view-context__count">{{ liveLayers.length }}</span></h4>
      <ul>
        <li v-for="layer in liveLayers" :key="layer.id" class="view-context__live-item">
          <div class="view-context__live-row">
          <span class="view-context__live-icon" aria-hidden="true">{{ layer.icon }}</span>
          <span class="view-context__live-main">
            <span class="view-context__live-name">{{ layer.name }}</span>
            <span class="view-context__live-meta">
              <template v-if="layer.total !== null">{{ t('{n} loaded', { n: layer.total.toLocaleString() }) }} · </template>{{ t('{n} in view', { n: layer.inView }) }}<template v-if="layer.updated"> · {{ layer.updated }}</template>
            </span>
          </span>
          <span class="view-context__live-state" :class="`view-context__live-state--${layer.state.tone}`">{{ layer.state.text }}</span>
          <button type="button" class="view-context__live-off" :aria-label="t('Turn off {name}', { name: layer.name })" :title="t('Turn off {name}', { name: layer.name })" @click="turnOff(layer)">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
          </div>
          <div v-if="layer.breakdown" class="view-context__split">
            <p class="view-context__split-basis">{{ layer.breakdown.basis }}</p>
            <div v-for="split in layer.breakdown.splits" :key="split.title" class="view-context__split-set">
              <div class="view-context__split-bar" role="img" :aria-label="split.parts.map((part) => `${part.label} ${part.count}`).join(', ')">
                <i v-for="part in split.parts" :key="part.label" :style="{ width: part.share, background: `linear-gradient(to right, ${part.color}, ${part.color}99)` }"></i>
              </div>
              <ul class="view-context__split-legend">
                <li v-for="part in split.parts" :key="part.label"><i :style="{ background: part.color }" aria-hidden="true"></i><span>{{ part.label }}</span><strong>{{ part.count }}</strong></li>
              </ul>
            </div>
          </div>
        </li>
      </ul>
    </div>

    <AltitudeGraph v-if="Number.isFinite(view?.heightM)" class="view-context__camera" :altitude-m="view.heightM" :tick="cameraTick" :label="t('Camera height')" unit="metric" compact />

    <SpotConditions v-if="view?.center && !globeView" :lat="view.center.lat" :lon="view.center.lon">
      <template #before-weather>
      <div v-if="facts.length" class="view-context__facts">
        <div v-for="fact in facts" :key="fact.label" class="view-context__fact">
          <span>{{ fact.label }}</span>
          <strong>{{ fact.value }}</strong>
        </div>
      </div>
      </template>
      <template #after-weather>
      <div v-if="groups.length" class="view-context__groups">
        <p class="view-context__total">{{ totalLine }}</p>
        <div v-for="group in groups" :key="group.layerId" class="view-context__group">
          <h4>
            <span class="material-symbols-outlined" aria-hidden="true">{{ group.icon }}</span>
            <span>{{ group.layerName }}</span>
            <span class="view-context__count">{{ group.count }}</span>
          </h4>
          <ul>
            <li v-for="item in group.items" :key="item.key">
              <button type="button" @click="store.select(item.identity, { fly: true })">
                <span class="view-context__row-title">{{ item.title }}</span>
                <span class="view-context__row-meta">{{ distance(item.distanceKm) }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
      <p v-else-if="contextNeedle" class="view-context__empty">{{ t('Nothing in view matches “{text}”.', { text: contextSearchText.trim() }) }}</p>
      <p v-else-if="liveLayers.length" class="view-context__empty">{{ t('Nothing from the layers that are on is in view here. Zoom out to see more.') }}</p>
      <p v-else class="view-context__empty">{{ t('No loaded layer has anything in view. Turn some on in Data Layers.') }}</p>
      </template>
    </SpotConditions>

    <div v-if="shownTowns.length" class="view-context__towns">
      <h4>{{ t('Places in view') }}</h4>
      <div class="view-context__chips">
        <button v-for="town in shownTowns" :key="town.name" type="button" @click="goToTown(town)">{{ town.name }}</button>
      </div>
    </div>



    <div v-if="offLayers.length && !globeView" class="view-context__towns">
      <h4>{{ t('Show here') }}</h4>
      <div class="view-context__chips">
        <button v-for="layer in offLayers" :key="layer.id" type="button" class="view-context__chip--layer" @click="turnOn(layer)">
          <span class="material-symbols-outlined" aria-hidden="true">add</span>{{ layer.name }}
        </button>
      </div>
    </div>

    <div class="view-context__actions">
      <button type="button" class="entity-card__action entity-card__action--ask" @click="store.askAboutView(groups)">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>{{ t("Ask GEV what's here") }}
      </button>
    </div>
  </section>
</template>
