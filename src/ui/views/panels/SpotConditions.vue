<script setup>
import { computed, inject, unref, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { formatNumber, onLocaleChange, t } from '../../../i18n/index.js';
import { contextAgeText } from '../../contextTime.js';
import { hazardReadNear } from '../../spotConditions.js';
import { useOmnibarStore } from '../../stores/omnibar.js';
import { shownLayerName } from '../../layerNames.js';
import { CONTEXT_EXEMPT, inspectorFeedLabel, presentLayerRow, splitBar } from '../../layerRowState.js';
import { FIELD_ICONS, fieldReading } from '../../fieldReading.js';
import { entityKind } from '../../../data/entityContext.js';
import { greatCircleKm } from '../../../geoDistance.js';
import { contextRadiusKm } from '../../contextRadius.js';
import { contextNeedle, matchesContextSearch } from '../../contextSearch.js';
import { sayWords, supportsLocalScopes, useEntityCardStore } from '../../stores/entityCard.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import NearbyLists from './NearbyLists.vue';
import ContextBreakdownBar from './ContextBreakdownBar.vue';
import { inspectorScopeLabel } from '../../inspectorSpatialIndex.js';
import ContextRadius from './ContextRadius.vue';
import { focusCardTitle } from '../../cardFocus.js';

// Conditions here, then Nearby, at the foot of every card. Conditions here
// reads each field layer that is on (wind, GNSS integrity, air quality,
// recent imagery) at the item itself, worded as the Inspector's value tiles.
// Nearby groups items by enabled layer, the selected item's layer first,
// and sorts each group by distance. The radius control sits above the list.
// A satellite's card lists what is inside its swath instead: the ground it
// sees right now. Natural hazards near the item follow (earthquakes, tropical
// storms and wildfire perimeters from their public feeds, also while those
// layers are off; satellite fire hits only while FIRMS is on), then warnings
// broadcast by things nearby.
const props = defineProps({
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  /** The selected item's own key, left out of the lists. */
  excludeKey: { type: String, default: '' },
  /** The selected item's layer, listed first. */
  ownLayer: { type: String, default: '' },
  approximate: Boolean,
  embedded: Boolean,
  /** A satellite's swath width: the lists look inside it instead. */
  swathKm: { type: Number, default: null },
  /**
   * How far the item moves before its hazards are read again: 1 km for
   * something that stays put (a correction of its position), 25 km for one
   * that moves.
   */
  settleKm: { type: Number, default: 1 },
});

const store = useEntityCardStore();
const omnibar = useOmnibarStore();
const shown = inject('contextViewShown', true);
const scopeOwner = () => unref(shown) && globalThis.document?.visibilityState !== 'hidden';
const releaseScope = store.setSelectedScopeOwner(scopeOwner);
onBeforeUnmount(releaseScope);
const spatialLayers = computed(() => {
  void tick.value;
  void store.layerRevision;
  return scopeOwner() && !inSwath.value && !contextNeedle.value && store.view?.center
    ? store.liveLayers().filter(row => supportsLocalScopes(row.id))
    : [];
});
const scopedGroups = computed(() => spatialLayers.value.map(row => {
  const group = store.inspectorGroup(row.id, radiusKm.value, {
    row, anchor: {lat: props.lat, lon: props.lon}, excludeKey: row.id === props.ownLayer ? props.excludeKey : '',
  });
  return group && { ...group, bar: splitBar(group.breakdown, 1), layerId: row.id, layerName: shownLayerName(row.name, row.id) };
}).filter(Boolean));
const groupLabel = scope => inspectorScopeLabel(scope, radiusKm.value, store.card?.title);


// What the layers have nearby moves with their records; read it often.
const tick = ref(0);
let timer = null;
onMounted(() => {
  timer = setInterval(() => tick.value++, 4000);
});
onBeforeUnmount(() => clearInterval(timer));

const inSwath = computed(() => Number.isFinite(props.swathKm) && props.swathKm > 0);
const radiusKm = computed(() => (inSwath.value ? props.swathKm / 2 : contextRadiusKm.value));
const km = (n) => t('{n} km', { n: formatNumber(n) });
const title = computed(() =>
  inSwath.value
    ? t('Inside the swath · {width} wide', { width: km(Math.round(props.swathKm)) })
    : t('Nearby · {radius}', { radius: km(contextRadiusKm.value) }),
);

// Each field layer that is on, read at the item on the same poll as the
// lists: a layer that is off, or outside its coverage here, has no row, and
// none left leaves the group out.
const fields = computed(() => {
  void tick.value;
  void store.managerVersion;
  void store.layerRevision;
  return store
    .liveLayers()
    // The item's own layer is the card itself: no second reading of it.
    .filter((row) => !CONTEXT_EXEMPT.includes(row.id) && row.id !== props.ownLayer)
    .flatMap((row) => {
      const { tone } = presentLayerRow(row);
      const layer = { id: row.id, tone, toneText: inspectorFeedLabel(tone) };
      const reading = fieldReading(store.valueAt(row.id, props.lat, props.lon), layer, { emptyValue: t('No reading here'), omitOutsideCoverage: true });
      if (!reading) return [];
      return [{ ...layer, ...reading, name: shownLayerName(row.name, row.id), icon: FIELD_ICONS[row.id] || entityKind(row.id).icon }];
    });
});

// The Context search narrows every list below to what holds its text.
const searching = computed(() => Boolean(contextNeedle.value));
const shownFields = computed(() =>
  fields.value.filter((field) => matchesContextSearch(field.name, field.value, field.detail)),
);
const lists = computed(() => {
  void tick.value;
  void store.layerRevision;
  if (!scopeOwner()) return [];
  const found = store.nearbyLayers(props.lat, props.lon, {
    radiusKm: radiusKm.value,
    limit: searching.value ? 12 : 3,
    excludeKey: props.excludeKey,
    query: contextNeedle.value,
    excludeLayers: ['radio', ...spatialLayers.value.map(row => row.id)],
    closestLayers: searching.value || inSwath.value ? [] : ['flights'],
  });
  if (!props.ownLayer) return found;
  return [...found.filter((list) => list.layerId === props.ownLayer), ...found.filter((list) => list.layerId !== props.ownLayer)];
});

// Flights always answers in the card, from the item: aircraft within the
// radius sit in the lists; with none there, the closest three with their
// distance; with none loaded, why.
const FLIGHTS = 'flights';
const flightsBlock = computed(() => {
  void tick.value;
  void store.managerVersion;
  void store.layerRevision;
  if (searching.value || inSwath.value || !scopeOwner()) return null;
  const row = store.allLayers().find((layer) => layer.id === FLIGHTS && layer.enabled);
  if (!row) return null;
  const group = lists.value.find((list) => list.layerId === FLIGHTS);
  if (group?.items.length && group.scope !== 'closest') return null;
  const name = shownLayerName(row.name, row.id);
  if (group?.scope === 'closest') return { name, group, status: '' };
  const { tone, updatedAt } = presentLayerRow(row);
  const status = group?.readFailed || tone === 'unavailable'
    ? inspectorFeedLabel('unavailable')
    : tone === 'loading' || (updatedAt === null && !row.stats?.count)
      ? inspectorFeedLabel('loading')
      : t('No nearby aircraft');
  return { name, group: null, status };
});
const shownLists = computed(() => lists.value.filter((list) => list !== flightsBlock.value?.group));

const alerts = computed(() => {
  void tick.value;
  return store
    .alertsAt(props.lat, props.lon, {
      radiusKm: radiusKm.value,
      limit: searching.value ? 40 : 4,
      excludeKey: props.excludeKey,
    })
    .filter((alert) => matchesContextSearch(alert.title, sayWords(alert.words, alert.text), alert.text));
});

// Hazards near the item, from the feeds the hazard layers read, kept for
// five minutes whichever spot asks (spotConditions.js): the same cache
// guards every read here, the scheduled ones included, so a feed is asked at
// most once every five minutes. They look out as far as the Context radius,
// also on a satellite's card (whose Nearby lists keep to its swath). They
// are read again once the item has moved more than `settleKm` (after a
// short settle), when the radius or FIRMS changes, in a new language, and
// every five minutes while the card stays open.
const HAZARD_LAYER = {
  quake: 'earthquakes',
  storm: 'weather-cyclones',
  wildfire: 'fire-perimeters',
  hotspots: 'local-firms',
};
// Far enough out to see the markers (and pick one), not just the ground.
const HAZARD_RANGE_M = { quake: 120000, storm: 1500000, wildfire: 40000, hotspots: 180000 };
const SETTLE_MS = 350;
const REREAD_MS = 5 * 60_000;
const hazards = ref([]);
const hazardsPending = ref(true);
const hazardsFailed = ref([]);
let hazardsAt = null;
let readingHazards = 0;
let settleTimer = 0;
const layerRows = () => omnibar.controls?.layers() || [];
// Satellite fire hits need FIRMS on: read live wherever it decides a request
// or a row, never from a copy that may be seconds old.
const firmsLive = () => Boolean(layerRows().find((layer) => layer.id === HAZARD_LAYER.hotspots)?.enabled);
// What the template follows to notice FIRMS turning on or off: at once, from
// manager changes, layer updates and the poll.
const firesOn = computed(() => {
  void store.managerVersion;
  void store.layerRevision;
  void tick.value;
  return firmsLive();
});
async function readHazards() {
  hazardsAt = { lat: props.lat, lon: props.lon };
  const mine = ++readingHazards;
  const { rows, failed } = await hazardReadNear(props.lat, props.lon, contextRadiusKm.value, { fires: firmsLive() })
    .catch(() => ({ rows: [], failed: Object.keys(HAZARD_LAYER) }));
  if (readingHazards !== mine) return;
  hazards.value = rows;
  hazardsFailed.value = failed;
  hazardsPending.value = false;
}
watch(
  () => [props.lat, props.lon],
  () => {
    if (!hazardsAt) return void readHazards();
    if (greatCircleKm(hazardsAt, { lat: props.lat, lon: props.lon }) <= props.settleKm) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => void readHazards(), SETTLE_MS);
  },
  { immediate: true },
);
watch([contextRadiusKm, firesOn], () => void readHazards());
const stopLocale = onLocaleChange(() => void readHazards());
let rereadTimer = 0;
onMounted(() => {
  rereadTimer = setInterval(() => void readHazards(), REREAD_MS);
});
onBeforeUnmount(() => {
  clearInterval(rereadTimer);
  clearTimeout(settleTimer);
  stopLocale();
});
const hazardLayers = computed(() => {
  void store.managerVersion;
  void store.layerRevision;
  void tick.value;
  const rows = layerRows();
  return Object.fromEntries(
    Object.entries(HAZARD_LAYER).map(([kind, id]) => {
      const row = rows.find((layer) => layer.id === id);
      return [kind, row ? { id, name: shownLayerName(row.name, id), on: Boolean(row.enabled) } : null];
    }),
  );
});
// Fire hits show only while FIRMS is on now, whatever a read found earlier.
const liveHazards = computed(() =>
  hazards.value.filter((hazard) => hazard.kind !== 'hotspots' || firesOn.value),
);
const matchingHazards = computed(() =>
  liveHazards.value.filter((hazard) => matchesContextSearch(hazard.title, hazard.detail, hazardLayers.value[hazard.kind]?.name)),
);
const shownHazards = computed(() => matchingHazards.value.slice(0, searching.value ? 12 : 5).map(hazard => ({
  ...hazard,
  detail: [hazard.detail, Number.isFinite(hazard.time) ? contextAgeText(Date.now() - hazard.time) : ''].filter(Boolean).join(' · '),
})));
const failedKinds = computed(() => hazardsFailed.value.filter((kind) => kind !== 'hotspots' || firesOn.value));
const hazardState = computed(() => {
  if (searching.value || shownHazards.value.length) return null;
  if (hazardsPending.value) return { mark: '…', label: t('Loading') };
  return failedKinds.value.length ? { mark: '—', label: t('Unavailable') } : null;
});
// Picking a hazard turns its layer on (when it is off), so its marker is
// there to select, and flies to it.
function flyToHazard(hazard) {
  // A fire-hit row left over from before FIRMS went off does nothing.
  if (hazard.kind === 'hotspots' && !firmsLive()) return;
  const layer = hazardLayers.value[hazard.kind];
  if (layer && !layer.on) void omnibar.controls?.setLayer(layer.id, true);
  omnibar.runner?.('fly_to_location', {
    latitude: hazard.at.lat,
    longitude: hazard.at.lon,
    viewMode: 'overview',
    rangeM: HAZARD_RANGE_M[hazard.kind] ?? 100000,
  });
}

// The feeds behind the hazard rows, credited in the card: their layers may
// be off, so the map's own credits do not name them.
const HAZARD_SOURCE = { quake: 'USGS', storm: 'NOAA NHC', wildfire: 'NIFC WFIGS', hotspots: 'NASA FIRMS' };
const hazardSources = computed(() => {
  if (hazardsPending.value) return t('Loading');
  const sources = new Set(liveHazards.value.map((hazard) => HAZARD_SOURCE[hazard.kind]).filter(Boolean));
  for (const kind of failedKinds.value) {
    if (HAZARD_SOURCE[kind]) sources.add(`${HAZARD_SOURCE[kind]}: ${t('Unavailable')}`);
  }
  return [...sources].join(' · ');
});

const distance = (n) => {
  const value = t('{n} km', { n: n < 10 ? formatNumber(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : formatNumber(Math.round(n)) });
  return props.approximate ? `${value} (${t('approximate')})` : value;
};
</script>

<template>
  <section class="spot-conditions" :aria-label="title">
    <div v-if="shownFields.length" class="spot-conditions__block spot-conditions__fields">
      <h4>
        <UiIcon name="location_on" :size="null" />
        <span>{{ t('Conditions here') }}</span>
      </h4>
      <ul>
        <li
          v-for="field in shownFields"
          :key="field.id"
          class="spot-conditions__field"
          :class="{ 'spot-conditions__field--empty': field.empty, 'spot-conditions__field--failed': field.failed }"
          :data-layer="field.id"
          :data-level="field.level || undefined"
          :style="field.color ? { '--field-band': field.color } : undefined"
          :title="field.detail || undefined"
        >
          <UiIcon :name="field.icon" :size="null" />
          <span class="spot-conditions__field-main">
            <span class="spot-conditions__field-head">
              <span class="spot-conditions__field-name">{{ field.name }}</span>
              <small v-if="!field.empty && !field.failed && ['stale', 'degraded', 'unavailable'].includes(field.tone)">{{ field.toneText }}</small>
              <small v-if="field.age" class="spot-conditions__field-age">{{ field.age }}</small>
            </span>
            <strong class="spot-conditions__field-value">
              <i v-if="field.color" class="spot-conditions__field-swatch" aria-hidden="true"></i>
              <i v-else-if="field.failed" class="view-context__dot" :class="`view-context__dot--${field.failedTone}`" aria-hidden="true"></i>
              <span>{{ field.value }}</span>
            </strong>
            <span v-if="field.detail" class="spot-conditions__field-detail">{{ field.detail }}</span>
          </span>
        </li>
      </ul>
    </div>

    <ContextRadius v-if="!inSwath" class="spot-conditions__radius" :label="t('Radius')" />
    <section v-for="group in scopedGroups" :key="group.layerId" class="spot-conditions__block" :data-spatial-layer="group.layerId">
      <h4>{{ group.layerName }} · {{ group.readFailed ? t('Unavailable') : group.loading ? t('Loading') : formatNumber(group.count) }}</h4>
      <template v-if="!group.readFailed && !group.loading">
        <p>{{ groupLabel(group.scope) }}</p>
        <ContextBreakdownBar v-if="group.bar" :parts="group.bar.parts" />
        <NearbyLists :lists="[group]" :title="group.layerName" rows-only :approximate="approximate" @focus-lost="focusCardTitle()" />
      </template>
    </section>
    <NearbyLists :lists="shownLists" :title="title" :approximate="approximate" @focus-lost="focusCardTitle()" />
    <section v-if="flightsBlock" class="spot-conditions__block" data-spatial-layer="flights">
      <h4>{{ flightsBlock.name }} · {{ flightsBlock.group ? formatNumber(flightsBlock.group.count) : flightsBlock.status }}</h4>
      <template v-if="flightsBlock.group">
        <p>{{ groupLabel('closest') }}</p>
        <NearbyLists :lists="[flightsBlock.group]" :title="flightsBlock.name" rows-only :approximate="approximate" @focus-lost="focusCardTitle()" />
      </template>
    </section>

    <div v-if="shownHazards.length || hazardState" class="spot-conditions__block spot-conditions__hazards">
      <h4>
        <UiIcon name="warning" :size="null" />
        <span>{{ t('Hazards within {radius}', { radius: km(contextRadiusKm) }) }}</span>
        <span class="spot-conditions__count spot-conditions__count--hot" :title="hazardState?.label">{{ hazardState?.mark ?? matchingHazards.length }}</span>
      </h4>
      <ul>
        <li v-for="hazard in shownHazards" :key="`${hazard.kind}-${hazard.title}-${hazard.distanceKm}`" :class="`spot-conditions__hazard--${hazard.kind}`">
          <UiButton @click="flyToHazard(hazard)">
            <UiIcon :name="hazard.icon" :size="null" />
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ hazard.title }}</span>
              <span v-if="hazard.detail" class="spot-conditions__row-detail">{{ hazard.detail }}</span>
              <span v-if="hazardLayers[hazard.kind]" class="spot-conditions__row-layer" :class="{ 'is-on': hazardLayers[hazard.kind].on }" :title="hazardLayers[hazard.kind].on ? t('Layer on') : t('Turns the layer on')">
                <span class="spot-conditions__row-dot" aria-hidden="true"></span>{{ hazardLayers[hazard.kind].name }}
              </span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(hazard.distanceKm) }}<template v-if="hazard.distanceKm >= 0.05 && hazard.direction"> {{ t(hazard.direction) }}</template></span>
          </UiButton>
        </li>
      </ul>
      <p v-if="hazardSources" class="spot-conditions__source">{{ hazardSources }}</p>
    </div>

    <div v-if="alerts.length" class="spot-conditions__block">
      <h4>
        <UiIcon name="emergency_home" :size="null" />
        <span>{{ t('Broadcast alerts') }}</span>
        <span class="spot-conditions__count spot-conditions__count--hot">{{ alerts.length }}</span>
      </h4>
      <ul>
        <li v-for="alert in alerts" :key="alert.key" class="spot-conditions__hazard--alert">
          <UiButton @click="store.open(alert.identity)">
            <UiIcon :name="alert.icon" :size="null" />
            <span class="spot-conditions__row-main">
              <span class="spot-conditions__row-title">{{ sayWords(alert.titleWords, alert.title) }}</span>
              <span class="spot-conditions__row-detail">{{ sayWords(alert.words, alert.text) }}</span>
            </span>
            <span class="spot-conditions__row-meta">{{ distance(alert.distanceKm) }}</span>
          </UiButton>
        </li>
      </ul>
    </div>
  </section>
</template>
