<script setup>
import { computed, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { formatNumber, getLocale, t, tn } from '../../../i18n/index.js';
import { greatCircleKm } from '../../../geoDistance.js';
import { normalizeRadioCountryInput } from '../../../data/radioCountry.js';
import { loadCities, nearestCityIn } from '../../../data/wikidataCities.js';
import { contextNeedle, matchesContextSearch } from '../../contextSearch.js';
import { inspectorFeedLabel } from '../../layerRowState.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { useOmnibarStore } from '../../stores/omnibar.js';
import { usePinnedStore } from '../../stores/pinned.js';
import { useRadioStore } from '../../stores/radio.js';
import { stationCategory, stationFailureText, stationPin, stationPinKey, stationPlayback, toggleStation } from '../../radioContext.js';
import { pinnedStationMiss } from '../../pinnedStation.js';
import ContextListCard, { listCardMemory } from '../../kit/ContextListCard.vue';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import CityFilterChips from './CityFilterChips.vue';
import RadioVolume from './RadioVolume.vue';
import MarqueeText from './MarqueeText.vue';

// Radio in Context: while the Radio layer is on and nothing is picked,
// Context shows its stations directly, under Inspect when something is
// pinned. The station that is selected leads, with Pause, Fly to and Pin
// (only it can be pinned; its pin is a still on the Pinned tab). Tag chips and
// Context search narrow the loaded directory at any zoom. Choosing a row plays it.
const props = defineProps({
  /** The Radio layer module and its UI state (see useRadioLayer). */
  module: { type: Object, default: null },
  ui: { type: Object, default: null },
});

const cards = useEntityCardStore();
const { view } = storeToRefs(cards);
const omnibar = useOmnibarStore();
const pinned = usePinnedStore();
const radio = useRadioStore();

const selected = computed(() => props.ui?.selected || null);
// The selected station's playback, read as the mini player reads it
// (stationPlayback), so the two never disagree.
const playback = computed(() => stationPlayback(props.ui, selected.value?.id));
const playingHere = computed(() => playback.value === 'live' || playback.value === 'loading');
// A stream that failed says so, and why under the name, as the Radio fold
// does, instead of "Paused".
const failedHere = computed(() => playback.value === 'lost');
const stateText = computed(
  () =>
    ({ live: t('Playing'), loading: t('Loading'), lost: t('No feed'), paused: t('Paused') })[playback.value] ||
    t('Ready'),
);
const failure = computed(() =>
  failedHere.value ? stationFailureText(props.ui) : '',
);

const center = computed(() => view.value?.center || null);
const away = (station) =>
  center.value && Number.isFinite(station?.lat) ? greatCircleKm(center.value, { lat: station.lat, lon: station.lon }) : null;
const distance = (km) =>
  km === null ? '' : t('{n} km', { n: formatNumber(km < 10 ? Number(km.toFixed(1)) : Math.round(km)) });
const placeOf = (station) => [station.state, station.country].filter(Boolean).join(', ');
const tagOf = (station) => (Array.isArray(station.tags) ? station.tags[0] : '') || '';
// A station's category, coloured as its marker; its first tag follows on
// the meta line unless it only repeats the category.
const categoryOf = (station) => stationCategory(props.module, props.ui, station);
const selectedCategory = computed(() => (selected.value ? categoryOf(selected.value) : null));
const selectedTag = computed(() => {
  const tag = selected.value ? tagOf(selected.value) : '';
  return tag && tag.toLowerCase() !== selectedCategory.value?.label.toLowerCase() ? tag : '';
});

const EMPTY_STATIONS = Object.freeze([]);
const catalog = computed(() => {
  const { module, ui } = props;
  if (!module || !ui?.enabled) return EMPTY_STATIONS;
  return module.getLoadedRadioStations?.() ??
    module.getRadioAcceptedCatalogSnapshot?.()?.stations ?? EMPTY_STATIONS;
});
// The directory carries state and country, but no verified city. Only a
// nearby city in its own country earns a chip. Other stations stay in All.
const memory = listCardMemory('radio');
const selectedCity = computed({
  get: () => memory.cityId || '',
  set: (id) => { memory.cityId = id; },
});
const cityIndex = shallowRef(null);
let previousPoints = new Map();
const STATION_CITY_RANGE = { radiusKm: 8, nearKm: 4 };
watch([
  catalog,
  () => props.module,
  () => props.ui?.source,
  () => !catalog.value.length && props.ui?.enabled && !props.ui.loading && !props.ui.error &&
    (props.ui.acceptedCatalogGeneration != null || Boolean(props.ui.updatedAt)),
], async ([list, module, source, settledEmpty], [, lastModule, lastSource], onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  if (!list.length || module !== lastModule || source !== lastSource) {
    cityIndex.value = null;
  }
  if (!list.length) {
    if (settledEmpty) selectedCity.value = '';
    return;
  }
  const pack = await loadCities().catch(() => null);
  if (!pack || !current) return;
  const points = new Map();
  const countries = new Map();
  const cities = new Map();
  const places = new Map();
  let deadline = performance.now() + 4;
  for (const station of list) {
    if (performance.now() >= deadline) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!current) return;
      deadline = performance.now() + 4;
    }
    const providerCountry = station.countryCode || station.country;
    if (!providerCountry) continue;
    if (!countries.has(providerCountry))
      countries.set(providerCountry, normalizeRadioCountryInput(providerCountry).code);
    const country = countries.get(providerCountry);
    if (!country) continue;
    const key = `${country}:${station.lat}:${station.lon}`;
    if (!points.has(key)) {
      const place = previousPoints.has(key) ? previousPoints.get(key) :
        nearestCityIn(pack.cells, station.lat, station.lon, { ...STATION_CITY_RANGE, country });
      points.set(key, place);
    }
    const place = points.get(key);
    if (place) {
      const id = place.wikidata || `${place.country}:${place.name}:${place.latitude}:${place.longitude}`;
      cities.set(station.id, { providerCountry, id, name: place.name });
      places.set(id, place);
    }
  }
  previousPoints = points;
  const counts = new Map();
  for (const { name, country } of places.values()) {
    counts.set(name, (counts.get(name) || 0) + 1);
    const qualified = `${name} · ${country}`;
    counts.set(qualified, (counts.get(qualified) || 0) + 1);
  }
  const labels = new Map();
  const ids = new Map();
  for (const [id, { name, country, latitude, longitude }] of places) {
    const qualified = `${name} · ${country}`;
    const label = counts.get(name) === 1 ? name :
      counts.get(qualified) === 1 ? qualified :
        `${qualified} · ${latitude}°, ${longitude}°`;
    ids.set(label, id);
    labels.set(id, label);
  }
  cityIndex.value = { cities, labels, ids };
  if (selectedCity.value && !labels.has(selectedCity.value)) selectedCity.value = '';
}, { immediate: true });
const selectedCityLabel = computed(() => cityIndex.value?.labels.get(selectedCity.value) || '');
function setCityFilter(label) {
  selectedCity.value = cityIndex.value?.ids.get(label) || '';
  if (!label && stationFilter.value !== 'all') setFilter('all');
}
function cityOf(station) {
  const city = cityIndex.value?.cities.get(station.id);
  // Keep a row's settled membership until the refreshed coordinates are indexed.
  // The list still uses the current station records and their current tags.
  return city && (station.countryCode || station.country) === city.providerCountry ? city : null;
}
const searchedStations = computed(() => {
  const rows = catalog.value;
  if (!contextNeedle.value) return rows;
  return rows.filter((station) => matchesContextSearch(
    station.id, station.name, station.state, station.country, station.countryCode, cityOf(station)?.name,
    ...(Array.isArray(station.tags) ? station.tags : []),
  ));
});
const cityNames = computed(() => {
  const index = cityIndex.value;
  if (!index) return [];
  const cities = contextNeedle.value
    ? new Set(searchedStations.value.map((station) => cityOf(station)?.id))
    : new Set(index.labels.keys());
  if (selectedCity.value) cities.add(selectedCity.value);
  return [...cities].map((id) => index.labels.get(id)).filter(Boolean)
    .sort(new Intl.Collator(getLocale()).compare);
});
const stationFilter = computed(() => props.ui?.filter || 'all');
const stations = computed(() => {
  const rows = searchedStations.value;
  const filtered = props.module?.filterRadioStations?.(rows, stationFilter.value) ?? rows;
  const city = selectedCity.value;
  return city ? filtered.filter((station) => cityOf(station)?.id === city) : filtered;
});
const foldSlot = shallowRef(null);
defineExpose({ stations, foldSlot });
// Only a page of the directory reaches the list's row and focus watchers.
const pageWindow = computed(() => {
  const total = stations.value.length;
  const page = Math.min(memory.page, Math.max(0, Math.ceil(total / memory.size) - 1));
  const first = page * memory.size;
  return { total, items: stations.value.slice(first, first + memory.size) };
});
const listState = computed(() => {
  if (catalog.value.length) return 'ready';
  if (props.ui?.loading) return 'loading';
  if (props.ui?.error) return 'failed';
  return props.ui?.acceptedCatalogGeneration == null && !props.ui?.updatedAt
    ? 'loading'
    : 'ready';
});
const emit = defineEmits(['has-matches']);
watch(
  () => Boolean(props.ui?.enabled && contextNeedle.value && stations.value.length),
  (matches) => emit('has-matches', matches),
  { immediate: true },
);
const tone = computed(() => {
  if (listState.value === 'failed') return 'unavailable';
  if (listState.value === 'loading') return 'loading';
  if (props.ui?.stale) return 'stale';
  if (props.ui?.degraded) return 'degraded';
  return 'nominal';
});
const toneText = computed(() => tone.value === 'nominal' ? '' : inspectorFeedLabel(tone.value));
const listQuery = computed(() => [props.ui?.source, stationFilter.value, selectedCity.value, contextNeedle.value].join('\u0000'));
const nothingFound = () => tn(0, '{n} results', '{n} results', { n: formatNumber(0) });

// Use the layer's tag membership on text matches, before city or tag
// selection. Keep the chosen tag accessible when its match count is zero.
const chips = computed(() => {
  const options = (props.ui?.categories || []).filter(({ id }) => id !== 'all');
  const module = props.module;
  if (!contextNeedle.value || !module) return options;
  const rows = searchedStations.value;
  const canMatch = typeof module.stationMatchesRadioCategory === 'function';
  return options.filter(({ id }) => id === stationFilter.value || (canMatch
    ? rows.some((station) => module.stationMatchesRadioCategory(station, id))
    : Boolean(module.filterRadioStations?.(rows, id)?.length)));
});
const setFilter = (id) => radio.act('setRadioFilter', id);

const play = (station) => props.module?.selectStation?.(station.id, { autoplay: true, origin: 'user' });
const togglePlayback = () => selected.value && void toggleStation(props.module, props.ui, selected.value.id);
function flyTo() {
  const station = selected.value;
  if (!station || !omnibar.runner) return;
  void omnibar.runner('fly_to_location', { latitude: station.lat, longitude: station.lon });
}
const isPinned = computed(() => Boolean(selected.value && pinned.isPinned(stationPinKey(selected.value.id))));
function togglePin() {
  const station = selected.value;
  if (!station) return;
  pinned.toggle(stationPin(station));
}
// Now playing's one line: what the station is and where, shortened with an
// ellipsis when long, then its distance, which always stays on the line.
const metaText = computed(() => {
  const station = selected.value;
  if (!station) return '';
  return [selectedTag.value, placeOf(station), station.codec, station.bitrate ? t('{n}k', { n: station.bitrate }) : ''].filter(Boolean).join(' · ');
});
const metaDistance = computed(() => (selected.value ? distance(away(selected.value)) : ''));
</script>

<template>
  <ContextListCard
    v-if="ui?.enabled"
    id="radio"
    class="radio-stations"
    :title="playback === 'live' ? t('Radio · now playing') : t('Radio')"
    :page-size="5"
    :stable-page="true"
    icon="radio"
    :tone="tone"
    :tone-text="toneText"
    :state="listState"
    :items="pageWindow.items"
    :page-window="pageWindow"
    :query="listQuery"
    @select="play"
  >
    <template #filter>
      <div class="radio-stations__controls">
        <CityFilterChips
          :model-value="selectedCityLabel"
          :cities="cityNames"
          :label="t('Filters')"
          :all-selected="!selectedCity && stationFilter === 'all'"
          :all-disabled="stationFilter !== 'all' && !ui.presentationActive"
          @update:model-value="setCityFilter"
        >
          <template #before-cities>
            <UiButton v-for="chip in chips" :key="chip.id" class="city-filter__chip" :pressed="stationFilter === chip.id" :disabled="!ui.presentationActive" @click="setFilter(chip.id)">{{ chip.label }}</UiButton>
          </template>
        </CityFilterChips>
        <!-- A pinned station played from its tile that is not in the directory. -->
        <p v-if="pinnedStationMiss" class="radio-stations__miss" role="status">{{ t('{name} is not in the station directory right now', { name: pinnedStationMiss.name }) }}</p>
        <p v-if="!selected" class="radio-stations__idle">{{ t('No station selected · pick one to play') }}</p>
        <div v-if="selected" class="radio-stations__now">
          <div class="radio-stations__now-head">
            <UiIcon name="radio" :size="null" />
            <strong><MarqueeText :text="selected.name" /></strong>
            <span class="radio-stations__state" :class="{ 'is-on': playingHere, 'is-error': failedHere }">{{ stateText }}</span>
          </div>
          <p v-if="failure" class="radio-stations__error" role="status">{{ failure }}</p>
          <p class="radio-stations__meta">
            <span v-if="selectedCategory" class="radio-category" :style="{ '--radio-category': selectedCategory.color }">{{ selectedCategory.label }}</span>
            <span class="radio-stations__meta-text" :title="metaText">{{ metaText }}</span>
            <span v-if="metaDistance" class="radio-stations__meta-distance">{{ metaDistance }}</span>
          </p>
          <RadioVolume class="radio-stations__volume" :ui="ui" />
          <div class="radio-stations__actions">
            <UiButton class="entity-card__action" @click="togglePlayback">
              <UiIcon :name="playingHere ? 'pause' : 'play_arrow'" :size="null" />{{ playingHere ? t('Pause') : t('Play') }}
            </UiButton>
            <UiButton class="entity-card__action" @click="flyTo">
              <UiIcon name="my_location" :size="null" />{{ t('Fly to') }}
            </UiButton>
            <UiButton class="entity-card__action entity-card__action--pin" :pressed="isPinned" pressed-class="entity-card__action--on" :title="isPinned ? t('Unpin from the Pinned tab') : t('Pin to the Pinned tab')" @click="togglePin">
              <UiIcon name="keep" :size="null" />{{ isPinned ? t('Pinned') : t('Pin') }}
            </UiButton>
          </div>
        </div>

      </div>
    </template>

    <template #row="{ item: station }">
      <span v-if="categoryOf(station)" class="radio-category-dot" :style="{ '--radio-category': categoryOf(station).color }" role="img" :aria-label="categoryOf(station).label" :title="categoryOf(station).label"></span>
      <span class="nearby-lists__name radio-stations__name" :aria-current="station.id === selected?.id ? 'true' : undefined" :title="station.name">{{ station.name }}<template v-if="tagOf(station)"> · {{ tagOf(station) }}</template></span>
      <UiIcon v-if="station.id === selected?.id && playingHere" class="radio-stations__playing" name="play_arrow" :size="null" />
    </template>
    <template #loading>{{ t('Reading the station directory…') }}</template>
    <template #empty>{{ nothingFound() }}</template>
    <template #footer>
      <!-- The privacy note applies to every entry point, including rows and voice. -->
      <p class="radio-stations__privacy">{{ t('Stations play straight from their broadcasters, who see your IP address.') }}</p>
      <!-- Radio's tuner, transport and volume (RadioFold) move in here. -->
      <div id="radio-fold-slot" ref="foldSlot"></div>
    </template>
  </ContextListCard>
</template>
