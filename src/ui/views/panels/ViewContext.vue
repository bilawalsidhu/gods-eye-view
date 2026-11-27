<script setup>
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, ref, shallowRef, watch } from 'vue';
import { focusedRow, replacementRow } from '../../cardFocus.js';
import { storeToRefs } from 'pinia';
import { contextNeedle, contextSearchText, matchesMissionSearch } from '../../contextSearch.js';
import { formatNumber, getLocale, t, tn } from '../../../i18n/index.js';
import { nearestCity } from '../../../data/wikidataCities.js';
import { weatherPoint } from '../../viewWeather.js';
import { INSPECTOR_PULSE_MS, sayWords, supportsLocalScopes, useEntityCardStore } from '../../stores/entityCard.js';
import { useOmnibarStore } from '../../stores/omnibar.js';
import { revealDataLayers, usePanelChromeStore } from '../../stores/panelChrome.js';
import { PANEL_LABEL_KEYS, layerSourceText, shownLayerName } from '../../layerNames.js';
import { translateFeedError, translateStatusMessage } from '../../statusText.js';
import { entityKind, recordRow } from '../../../data/entityContext.js';
import { missionSitePin, placeIdentity, viewPin, viewPlaceName } from '../../placeCard.js';
import { contextRadiusKm, overheadRangeKm } from '../../contextRadius.js';
import { isAircraftLayer } from '../../../data/aircraftLayerIds.js';
import { weatherFacts, weatherLook } from '../../spotConditions.js';
import { clockLine, contextAgeText, dayLengthMinutes, utcClock } from '../../contextTime.js';
import { approximatePosition, distanceText } from '../../distanceText.js';
import { suggestLayers } from '../../layerSuggestions.js';
import { FIELD_ICONS, fieldReading } from '../../fieldReading.js';
import { useLayerFinderStore } from '../../stores/layerFinder.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import EntityMark from './EntityMark.vue';
import ContextRadius from './ContextRadius.vue';
import NearbyLists from './NearbyLists.vue';
import ContextBreakdownBar from './ContextBreakdownBar.vue';
import ContextSummary from './ContextSummary.vue';
import FieldPill from './FieldPill.vue';
import NearbyMissions from './NearbyMissions.vue';
import AltitudeGraph from './AltitudeGraph.vue';
import SuggestedLayers from './SuggestedLayers.vue';
import { CONTEXT_EXEMPT, MISSIONS_LAYER, inspectorFeedLabel, inspectorHasLayers, inspectorLayerRows, presentLayerRow, splitBar, shownApart } from '../../layerRowState.js';
import { inspectorScopeLabel } from '../../inspectorSpatialIndex.js';
import { COUNT_TILE_LAYERS, LAYER_COUNTS_REFETCH_MS } from '../../layerCounts.js';
import { formatCockpitCoordinatePair } from '../../cockpitPresentation.js';
import { useLayerCountsStore } from '../../stores/layerCounts.js';
import { usePinnedStore } from '../../stores/pinned.js';
import { useSpaceMissionsStore } from '../../stores/spaceMissions.js';

// The Inspector refreshes after the camera settles and while it is visible.
// Data Layers owns layer switches.
const store = useEntityCardStore();
const finder = useLayerFinderStore();
const chrome = usePanelChromeStore();
const { panels } = storeToRefs(chrome);
const hasDataLayers = computed(() => Boolean(panels.value['data-panel']));
const { view, viewWeather } = storeToRefs(store);
const counts = useLayerCountsStore();
const missions = useSpaceMissionsStore();
const props = defineProps({ listSearchMatches: Boolean, inlineCamera: Boolean, inlineSpatialCard: Boolean });
const emit = defineEmits(['keyboardSelection']);
const tick = ref(0);
// Resample when Context becomes visible, before the next periodic tick.
const inspectorNow = computed(() => {
  void tick.value;
  void store.inspector.shown;
  return Date.now();
});
const doc = globalThis.document;
const visible = () => doc?.visibilityState !== 'hidden';
let timer = null;
// Inspect mounts this view while nothing is selected. Other tabs unmount it,
// and a hidden page skips its ticks.
onMounted(() => {
  timer = setInterval(() => {
    if (!visible() || !store.inspector.shown) return;
    tick.value++;
    store.pulseInspector();
  }, INSPECTOR_PULSE_MS);
});
onBeforeUnmount(() => {
  clearInterval(timer);
});

// The summary uses camera height. A tilted local view can also see the horizon.
const globeView = computed(() => store.scopeTier?.globe ?? false);

// The city at (or nearest to) the middle of the view, from the bundled cities
// pack: no place service is asked.
const place = shallowRef(null);
let placeRequest = null;
const placeKey = (center) => `${center.lat.toFixed(2)},${center.lon.toFixed(2)}`;
watch(
  view,
  async (current) => {
    if (!current) return;
    const key = placeKey(current.center);
    if (key === placeRequest?.key) return;
    const request = { key };
    placeRequest = request;
    const city = await nearestCity(current.center.lat, current.center.lon).catch(() => null);
    if (placeRequest === request) place.value = { key, city };
  },
  { immediate: true },
);
const viewPlace = computed(() => {
  const at = view.value?.center;
  const lookup = place.value;
  return at && lookup?.key === placeKey(at) ? lookup.city : null;
});
const placeName = computed(() => viewPlaceName(viewPlace.value));
const centerCoordinates = computed(() => {
  const at = view.value?.center;
  if (!at) return '';
  return formatCockpitCoordinatePair(at.lat, at.lon);
});
// A selected mission pins its launch site even while the camera chases the
// rocket. Otherwise this control saves the camera's current view.
const pinned = usePinnedStore();
const selectedMission = computed(() => missions.enabled ? missions.mission : null);
const headerPin = computed(() => selectedMission.value
  ? missionSitePin(selectedMission.value)
  : viewPin(store.view, viewPlace.value));
const headerPinned = computed(() => Boolean(headerPin.value && pinned.isPinned(headerPin.value.key)));
const headerPinLabel = computed(() => {
  if (!selectedMission.value) return headerPinned.value ? t('Unpin this view') : t('Pin this view');
  const name = headerPin.value?.title;
  return headerPinned.value ? t('Unpin {name}', { name }) : t('Pin {name} to the Pinned tab', { name });
});
function toggleHeaderPin() {
  if (headerPin.value) pinned.toggle(headerPin.value);
}

const weather = computed(() => viewWeather.value?.reading ?? null);
const weatherFailed = computed(() => Boolean(viewWeather.value?.failed && !viewWeather.value.pending));
const viewZone = computed(() => {
  const point = weatherPoint(view.value?.center);
  const zone = viewWeather.value?.zone;
  return point && zone?.point === point ? zone : null;
});
const clock = computed(() => {
  const now = inspectorNow.value;
  const point = weatherPoint(view.value?.center);
  if (globeView.value || !point) return clockLine(null, now);
  const observation = viewWeather.value;
  const loading = observation?.pending || (!observation?.reading && !observation?.failed);
  return clockLine(viewZone.value, now, loading);
});
const cameraText = computed(() => {
  const m = view.value?.heightM ?? 0;
  return m >= 10_000 ? t('{n} km', { n: formatNumber(Math.round(m / 1000)) }) : t('{n} m', { n: formatNumber(Math.round(m)) });
});

// These scenes show state on their tiles. Evidence and places appear in Nearby.
const INCIDENT_SCENES = new Set(['bhote-koshi-2026', 'bhote-koshi-locator']);
const TILE_ICONS = {
  cctv: 'videocam',
  traffic: 'traffic',
  ...FIELD_ICONS,
  'weather-radar': 'radar',
  'weather-lightning': 'thunderstorm',
  'weather-satellite': 'cloud',
};
const tileIcon = (id) => TILE_ICONS[id] || entityKind(id).icon;
// Every layer that is on, with its feed state, Space Missions' row included.
const layerRows = computed(() =>
  inspectorLayerRows(store.inspectorRows).map((row) => {
    const presentation = presentLayerRow(row);
    const { tone } = presentation;
    const stats = row.stats || {};
    const source = layerSourceText(row);
    const coverage = typeof stats.coverage === 'string' ? stats.coverage.trim() : '';
    const status = translateStatusMessage(stats.statusMessage || stats.loadingLabel || coverage);
    const error = translateFeedError(stats.error || stats.lastError || stats.managerRefreshError);
    const words = inspectorFeedLabel(tone);
    return {
      ...presentation,
      name: shownLayerName(row.name, row.id),
      icon: tileIcon(row.id),
      toneText: words,
      problem: ['nominal', 'loading'].includes(tone)
        ? ''
        : [...new Set([source, words, status, error].filter(Boolean))].join(' · '),
      statusText: typeof stats.status === 'string' && stats.status !== 'ok' ? status : '',
    };
  }),
);
const missionsFeed = computed(() => layerRows.value.find(({ id }) => id === MISSIONS_LAYER));
// The layers that get a tile or block of their own.
const liveLayers = computed(() => layerRows.value.filter((layer) => {
  if (props.inlineSpatialCard && !contextNeedle.value && (supportsLocalScopes(layer.id) || (layer.id !== 'satellites' && store.selectedRowLayers.has(layer.id)))) return false;
  if (layer.id === 'cctv' || shownApart(layer.id, missions.enabled)) return false;
  // The catalog that Missions enables for its own telemetry has no standalone points.
  return layer.id !== 'satellites' || !missions.enabled ||
    store.layerModule('satellites')?.getParams?.()?.showPoints !== false;
}));
const layerById = computed(() => Object.fromEntries(liveLayers.value.map((layer) => [layer.id, layer])));
// A feed in trouble keeps its line, Space Missions' index included.
const problems = computed(() => layerRows.value.filter((layer) => layer.problem));
const anyOn = computed(() => inspectorHasLayers(store.inspectorRows, missions.enabled));
// The local Inspect view uses the same explicit switch as Data Layers.
const omnibar = useOmnibarStore();
const flightsOff = computed(() => store.inspectorRows.some(row => row.id === 'flights' && !row.enabled && !row.stats?.sourceUnavailable));
const showFlightsOff = computed(() => flightsOff.value && omnibar.controls?.setLayer && !store.card && !contextNeedle.value && !globeView.value && view.value?.center && view.value.groundFootprint !== false);
const enablingFlights = ref(false);
const flightsEnableFailed = ref(false);
watch(showFlightsOff, () => { flightsEnableFailed.value = false; });
async function turnOnFlights(event) {
  if (enablingFlights.value || !showFlightsOff.value) return;
  const button = event.currentTarget;
  const focused = button === doc.activeElement;
  enablingFlights.value = true;
  flightsEnableFailed.value = false;
  try {
    flightsEnableFailed.value = (await omnibar.controls.setLayer('flights', true)) === false;
  } catch {
    flightsEnableFailed.value = true;
  } finally {
    enablingFlights.value = false;
  }
  await nextTick();
  if (focused && !button.isConnected && doc.activeElement === doc.body) viewBox.value?.focus({ preventScroll: true });
}
const radiusText = computed(() => t('{n} km', { n: formatNumber(contextRadiusKm.value) }));

// Layers with a point reading show its value at the centre of the view.
// Air Quality also has station records that belong in Nearby.
const valueTiles = computed(() => {
  if (!store.inspector.shown) return [];
  void tick.value;
  const center = view.value?.center;
  if (globeView.value || !center) return [];
  return liveLayers.value.flatMap((layer) => {
    const reading = fieldReading(store.valueAt(layer.id, center.lat, center.lon), layer, {
      emptyDetail: t('No value at the centre of the view'),
    });
    if (!reading) return [];
    const status = reading.failed ? { tone: reading.failedTone, toneText: reading.value } : {};
    return [{ ...layer, ...reading, ...status }];
  });
});
// Keep the non-item layer list stable through ordinary refreshes.
const nonItemKey = computed(() =>
  liveLayers.value
    .filter((layer) => layerKind(layer.id) !== 'items')
    .map((layer) => layer.id)
    .join('|'),
);
const nonItemIds = computed(() => (nonItemKey.value ? nonItemKey.value.split('|') : []));
// A map overlay (sea marks, ski pistes) has neither items nor a value at a
// point: one tile says it is on the map.
const overlayTiles = computed(() => {
  if (globeView.value || !view.value?.center) return [];
  return liveLayers.value
    .filter((layer) => layerKind(layer.id) === 'overlay')
    .map((layer) => ({ ...layer, value: stateText(layer), detail: t('On the map') }));
});
// A layer with both items and a reading here (Air Quality) has one tile:
// the reading leads, its count goes under it. With no reading, the count
// tile and the reading's own tile, as for any layer.
const hasReading = (reading) => Boolean(reading && !reading.empty && !reading.failed);
const readingById = computed(() => Object.fromEntries(valueTiles.value.filter(hasReading).map((tile) => [tile.id, tile])));
const localTiles = computed(() =>
  globeView.value ? [] : tiles.value.map((tile) => {
    const reading = readingById.value[tile.id];
    return reading ? { ...tile, reading, tone: reading.tone, toneText: reading.toneText } : tile;
  }),
);
const merged = computed(() => new Set(localTiles.value.filter((tile) => tile.reading).map((tile) => tile.id)));
const sideGroups = computed(() => [
  { key: 'values', tiles: valueTiles.value.filter((tile) => !merged.value.has(tile.id)) },
  { key: 'overlays', tiles: overlayTiles.value },
].filter((group) => group.tiles.length));
// What a merged tile's count is of.
const COUNT_WORDS = {
  'air-quality': (n) => tn(n, '{n} station', '{n} stations', { n: formatNumber(n) }),
};
const countLine = (tile) =>
  Number.isFinite(tile.count) ? (COUNT_WORDS[tile.id]?.(tile.count) ?? formatNumber(tile.count)) : '';
// What a layer says of itself in Context (getContextSummary): its items by
// legend band, the ones worth a look, and its coverage.
const summaries = computed(() => {
  if (!store.inspector.shown || (globeView.value && contextNeedle.value)) return {};
  void tick.value;
  void view.value;
  void store.layerRevision;
  return Object.fromEntries(
    liveLayers.value.flatMap((layer) => {
      let summary = null;
      try {
        const module = store.layerModule(layer.id);
        if (typeof module?.getContextPopulation === 'function') {
          const group = displayedByLayer.value.get(layer.id)
            ?? store.inspectorGroup(layer.id, contextRadiusKm.value);
          summary = group?.summary ?? null;
          if (summary && layer.id === 'air-quality' && group.scope !== 'view') {
            const scope = inspectorScopeLabel(group.scope, contextRadiusKm.value);
            if (scope) summary = { ...summary, itemsLabel: [layer.name, scope].join(' · ') };
          }
        }
      } catch {
        summary = null;
      }
      return summary && typeof summary === 'object' ? [[layer.id, summary]] : [];
    }),
  );
});
// Zoomed in, show the layer's sampled bands even when there are no worst readings.
const localSummaries = computed(() => {
  if (globeView.value || contextNeedle.value) return [];
  return liveLayers.value.filter(({ id }) => {
    const summary = summaries.value[id];
    return !supportsLocalScopes(id) && (summary?.items?.length || summary?.bands?.some(band => band.count > 0));
  });
});
// A summary row opens where it is: an item's own card, or the spot itself,
// flying there as Nearby's rows do.
function openSummaryItem(layerId, item, event) {
  const rowKey = event.currentTarget?.dataset?.rowKey;
  const keyboard = event.detail === 0 && event.currentTarget === globalThis.document?.activeElement;
  const row = item.record ? recordRow(layerId, item.record) : null;
  const opened = row
    ? store.open(row.identity)
    : Number.isFinite(item.lat) && Number.isFinite(item.lon) &&
      store.select(placeIdentity({ lat: item.lat, lon: item.lon, from: 'spot' }), { fly: true, explicit: true });
  if (opened && keyboard && store.card?.key) emit('keyboardSelection', rowKey || store.card.key);
}
// Layers with records get counts even if they also have a point reading.
// Without records, a layer is a field or an overlay.
function layerKind(layerId) {
  const module = store.layerModule(layerId);
  if (typeof module?.getAnalystRecords === 'function' && module.supportsAnalystRecords !== false) return 'items';
  return typeof module?.getValueAt === 'function' ? 'field' : 'overlay';
}
// A field or an overlay has no count worth showing: its state instead, and
// how fresh its picture is.
function stateText(layer) {
  if (layer.tone === 'loading') return '…';
  if (layer.updatedAt) return t('Updated {age}', { age: contextAgeText(Date.now() - layer.updatedAt) });
  return layer.toneText;
}

// Refresh the enabled layers' nearest rows on the Inspector tick. The
// store's readLayers owns the per-layer cache and expiry.
const satellitesOn = computed(() => liveLayers.value.some(({ id }) => id === 'satellites'));
const aircraftOverhead = computed(() => store.scopeTier?.city && view.value?.groundFootprint !== false);
const overheadLayer = (id) => id === 'satellites' || (aircraftOverhead.value && isAircraftLayer(id));
const hasOverhead = computed(() => liveLayers.value.some(({ id }) => overheadLayer(id)));
const hasNearby = computed(() => liveLayers.value.some(({ id }) =>
  !overheadLayer(id) && !CONTEXT_EXEMPT.includes(id) && layerKind(id) === 'items'
));
const preferOverhead = ref(false);
const showOverhead = computed(() => hasOverhead.value && (!hasNearby.value || preferOverhead.value));
const radiusLabel = computed(() => showOverhead.value ? t('Overhead range') : t('Radius'));
function readGroups(query) {
  if (!store.inspector.shown) return [];
  void store.layerRevision;
  void tick.value;
  const excluded = new Set([...CONTEXT_EXEMPT, ...nonItemIds.value, 'satellites', 'cctv']);
  if (missions.enabled) excluded.add(MISSIONS_LAYER);
  if ((query || globeView.value) && satellitesOn.value) excluded.delete('satellites');
  const ids = liveLayers.value.map(({ id }) => id).filter((id) => !excluded.has(id));
  // Search uses the viewport; browsing uses the enabled layers’ local scopes.
  const groups = query
    ? store.inView({ perLayer: 12, query, breakdown: true, includeEmpty: true, includeDrawnCoverage: true, viewport: true, excludeLayers: excluded })
    : store.inspectorGroups(ids, contextRadiusKm.value, {
      overheadIds: globeView.value ? [] : ids.filter(overheadLayer),
      overheadRadius: overheadRangeKm.value,
    });
  const center = view.value?.center;
  const satellites = !query && !globeView.value && satellitesOn.value && center
    ? store.nearbyLayers(center.lat, center.lon, {
      onlyLayers: ['satellites'],
      overheadRange: true,
      radiusKm: overheadRangeKm.value,
      breakdown: true,
      limit: 3,
    })
    : [];
  return [...groups, ...satellites].map(group => ({
    ...group,
    inView: !['overhead', 'closest'].includes(group.scope) && (query || ['view', 'nearest'].includes(group.scope)),
  }));
}
const displayedGroups = computed(() => readGroups(''));
const lists = computed(() => contextNeedle.value ? readGroups(contextNeedle.value) : displayedGroups.value);
const globeGroups = computed(() => Object.fromEntries(lists.value.map(group => [group.layerId, group])));
const displayedByLayer = computed(() => new Map(displayedGroups.value.map(group => [group.layerId, group])));
const inlineGroup = group => !contextNeedle.value && supportsLocalScopes(group.layerId);
const radiusRows = computed(() => lists.value.filter(group => group.scope === 'nearby' && !inlineGroup(group)));
const overheadRows = computed(() => lists.value.filter(group => group.scope === 'overhead'));
const closestRows = computed(() => lists.value.filter(group => group.scope === 'closest' && !inlineGroup(group)));
const scopeLabel = (scope) => inspectorScopeLabel(scope, scope === 'overhead' ? overheadRangeKm.value : contextRadiusKm.value);
function tileScopeLabel(tile) {
  if (tile.scope !== 'total' && (tile.readFailed || tile.loading || (!tile.count && ['unavailable', 'loading'].includes(tile.tone)))) return '';
  if (tile.id === 'flights' && !tile.count && countStatus(tile)) return '';
  if (tile.id === 'flights' && aircraftOverhead.value && !contextNeedle.value && tile.scope === 'none' && tile.count === 0 && Number.isFinite(tile.updatedAt) && tile.tone === 'nominal') return t('No nearby aircraft');
  const scope = scopeLabel(tile.scope);
  if (tile.scope === 'total' && Number.isFinite(tile.totalAt)) {
    const age = inspectorNow.value - tile.totalAt;
    if (age >= LAYER_COUNTS_REFETCH_MS) return [scope, t('Last known {age}', { age: contextAgeText(age) })].join(' · ');
  }
  return scope;
}
const localTileGroups = computed(() => {
  const items = [];
  const closest = [];
  const empty = [];
  for (const tile of localTiles.value) {
    if (tile.scope === 'closest' && overheadLayer(tile.id)) closest.push(tile);
    else if (tile.scope === 'none' && tile.count === 0 && !tile.reading && !countStatus(tile)) empty.push(tile);
    else items.push(tile);
  }
  if (!closest.length) return [{ key: 'items', tiles: localTiles.value }].filter(group => group.tiles.length);
  return [{ key: 'items', tiles: items }, { key: 'closest', tiles: closest }, { key: 'empty', tiles: empty }].filter(group => group.tiles.length);
});
const layerTileHeading = computed(() =>
  globeView.value || localTileGroups.value[0]?.tiles.some(tile => ['nearby', 'overhead'].includes(tile.scope))
    ? t('Layers')
    : t('In view')
);
const scopeRank = (tile) => tile.scope === 'none' ? 2 : tile.scope === 'closest' ? 1 : 0;
const tileOrder = (a, b) => scopeRank(a) - scopeRank(b) || (b.count ?? -1) - (a.count ?? -1);
const visibleRows = computed(() => lists.value.filter(group => group.inView && !inlineGroup(group)));
const tiles = computed(() => {
  if (!store.inspector.shown) return [];
  if (globeView.value)
    return [
      ...liveLayers.value.map((layer) => {
        if (contextNeedle.value) {
          const matches = globeGroups.value[layer.id];
          return {
            ...layer,
            scope: 'view',
            count: matches?.count ?? null,
            readFailed: matches?.readFailed,
            bar: splitBar(matches?.breakdown, 1),
          };
        }
        const group = displayedByLayer.value.get(layer.id);
        if (!group && (INCIDENT_SCENES.has(layer.id) || layerKind(layer.id) !== 'items'))
          return { ...layer, count: null, state: stateText(layer) };
        const known = counts.state.counts[layer.id];
        const total = known?.count;
        const count = total ?? group?.count ?? null;
        return {
          ...layer,
          readFailed: total == null && group?.readFailed,
          sampleFailed: total != null && group?.readFailed,
          loading: total == null && group?.loading,
          count: total ?? (count === 0 && layer.tone === 'loading' ? null : count),
          scope: total != null ? 'total' : group?.scope,
          totalAt: known?.at,
          bar: splitBar(group?.breakdown, 1),
        };
      }),
    ].sort(tileOrder);
  // Every layer with items gets a tile, also with none of them within the
  // radius (0, or why it holds none), so a layer that is on never goes
  // missing.
  const listed = new Set(lists.value.map((list) => list.layerId));
  const quiet = liveLayers.value
    .filter((layer) => !listed.has(layer.id) && layerKind(layer.id) === 'items')
    .map((layer) => ({ ...layer, count: null }));
  return [...lists.value.map((list) => ({
    ...(layerById.value[list.layerId] || {
      id: list.layerId,
      name: shownLayerName(list.layerName, list.layerId),
      icon: list.icon,
      tone: 'nominal',
      toneText: t('Live'),
    }),
    inView: list.inView,
    scope: list.scope,
    group: inlineGroup(list) ? list : null,
    loading: list.loading,
    readFailed: list.readFailed,
    // Still loading with nothing in: … rather than 0.
    count: list.count === 0 && layerById.value[list.layerId]?.tone === 'loading' ? null : list.count,
    bar: splitBar(list.breakdown, 1),
  })), ...quiet].sort(tileOrder);
});
const countStatus = (tile) => {
  if (tile.scope === 'total') return '';
  if (tile.readFailed) return inspectorFeedLabel('unavailable');
  if (tile.loading || (tile.id === 'flights' && tile.tone === 'loading' && !tile.count)) return inspectorFeedLabel('loading');
  if (tile.count) return '';
  if (['unavailable', 'degraded', 'stale'].includes(tile.tone)) return tile.toneText;
  if (tile.id === 'flights' && tile.count === 0 && tile.updatedAt === null) return inspectorFeedLabel('unavailable');
  return tile.statusText || '';
};
const countText = (tile) => countStatus(tile) || (tile.count === null ? '…' : formatNumber(tile.count));
// At globe view, under each layer's block: the three of its items nearest
// the centre of the view on the visible hemisphere, to pick from when the
// globe's icons are too small to click. At this height the Inspector uses
// the visible hemisphere, while the omnibar uses the viewport bounds.
const globeTiles = computed(() => {
  if (!globeView.value) return [];
  return contextNeedle.value
    ? tiles.value.filter((tile) => globeGroups.value[tile.id]?.items.length)
    : tiles.value;
});
// Own row focus in the view so it survives a switch between list layouts.
const viewBox = ref(null);
function selectRow(item, event) {
  const keyboard = event.detail === 0 && event.currentTarget === globalThis.document?.activeElement;
  if (store.open(item.identity) && keyboard)
    emit('keyboardSelection', item.key);
}
let heldFocus = null;
let awaitingRow = null;
onBeforeUpdate(() => {
  const active = globalThis.document?.activeElement;
  heldFocus = null;
  if (awaitingRow && active === awaitingRow.fallback && viewBox.value?.contains(active)) {
    heldFocus = awaitingRow.row;
    return;
  }
  awaitingRow = null;
  if (!active || !viewBox.value?.contains(active)) return;
  heldFocus = focusedRow(viewBox.value, active);
  if (!heldFocus && active.matches('.view-context__block, .view-context__blocks, .nearby-lists__title, .view-context__radius input')) {
    heldFocus = { fallback: active };
  }
});
onUpdated(() => {
  const was = heldFocus;
  heldFocus = null;
  const box = viewBox.value;
  const active = globalThis.document?.activeElement;
  if (!was || !box || (active && active !== globalThis.document.body && active !== awaitingRow?.fallback)) return;
  if (was.fallback) {
    (box.contains(was.fallback) ? was.fallback : rowFallback(box))?.focus?.();
    return;
  }
  const next = replacementRow(box, was, '[data-via-key]');
  const block = [...box.querySelectorAll('.view-context__block')].find((node) => node.dataset.layer === was.layer);
  const fallback = block || rowFallback(box);
  const loading = displayedByLayer.value.get(was.layer)?.loading;
  awaitingRow = !next && loading && fallback ? { row: was, fallback } : null;
  (next || fallback)?.focus?.();
});
// Where a row's focus lands when its list is gone.
function rowFallback(box) {
  return box.querySelector('.view-context__blocks, .nearby-lists__title') || box.querySelector('.view-context__radius input') || box;
}
const nearbyLists = computed(() => lists.value.filter((list) => !list.readFailed));
const listFormatter = computed(() => new Intl.ListFormat(getLocale(), { type: 'unit' }));
function listOf(parts) {
  try {
    return listFormatter.value.format(parts);
  } catch {
    return parts.join(', ');
  }
}
const searchStatus = computed(() => {
  if (!contextNeedle.value) return '';
  const globe = globeView.value;
  const unavailable = tiles.value.filter((tile) =>
    (!globe || layerKind(tile.id) === 'items') &&
    (tile.tone === 'unavailable' || (globe ? globeGroups.value[tile.id]?.readFailed : tile.readFailed)),
  );
  if (unavailable.length)
    return t('Unavailable layers: {layers}', { layers: listOf(unavailable.map((tile) => tile.name)) });
  if (props.listSearchMatches) return '';
  if (missions.enabled && missions.roster?.entries?.some(matchesMissionSearch)) return '';
  if (globe ? globeTiles.value.length : nearbyLists.value.some((list) => list.items.length)) return '';
  if (globe || view.value?.groundFootprint === false)
    return tn(0, '{n} results', '{n} results', { n: formatNumber(0) });
  return t('Nothing matches “{text}”.', { text: contextSearchText.value.trim() });
});

const look = computed(() => weatherLook(weather.value?.weatherCode));
// The weather block with layers on, zoomed in, from the same reading (no
// read of its own): the temperature and conditions, then wind, cloud,
// visibility and rain, as a selected item's card shows them. A reading older
// than half an hour (the server keeps one through an outage) says its age.
const WEATHER_STALE_MS = 30 * 60_000;
const weatherAge = computed(() => {
  const at = viewWeather.value?.freshnessAt;
  if (!Number.isFinite(at)) return '';
  const age = inspectorNow.value - at;
  return age > WEATHER_STALE_MS ? t('Updated {age}', { age: contextAgeText(age) }) : '';
});
const roundOf = (n) => (Number.isFinite(n) ? Math.round(n) : null);
const weatherNow = computed(() => {
  const now = weather.value;
  if (!Number.isFinite(now?.temperatureC)) return null;
  return {
    temperature: t('{n} °C', { n: formatNumber(roundOf(now.temperatureC)) }),
    conditions: [t(look.value.label), Number.isFinite(now.apparentTemperatureC) ? t('feels {n}°', { n: formatNumber(roundOf(now.apparentTemperatureC)) }) : null].filter(Boolean).join(' · '),
    facts: weatherFacts(now),
    stale: weatherAge.value,
    weatherCredit: now.source === 'open-meteo',
  };
});
// Display-only counts from the server cache.
const countTiles = computed(() => {
  const now = inspectorNow.value;
  const available = new Set(store.inspectorRows.filter((row) => row.stats?.sourceUnavailable !== true).map((row) => row.id));
  return COUNT_TILE_LAYERS.map((layer) => ({ layer, known: counts.state.counts[layer.id] }))
    .filter(({ layer, known }) => available.has(layer.id) && known?.count > 0)
    .map(({ layer, known }) => {
      const age = Number.isFinite(known.at) ? Math.max(0, now - known.at) : null;
      return {
        id: layer.id,
        icon: layer.icon,
        name: t(layer.label),
        hint: layer.hint ? t(layer.hint) : '',
        count: formatNumber(known.count),
        age: age === null ? '' : contextAgeText(age),
      };
    });
});
const countSections = computed(() => {
  const worldwide = countTiles.value;
  const worldwideIds = new Set(worldwide.map(({ id }) => id));
  const loaded = [...store.inspectorLastLoaded.values()]
    .filter(({ id }) => !worldwideIds.has(id))
    .map(({ id, name, count, at }) => ({
      id, name: shownLayerName(name, id), icon: tileIcon(id), count: formatNumber(count),
      age: contextAgeText(Math.max(0, inspectorNow.value - at)),
    }));
  return [
    { heading: t('Worldwide, last known'), tiles: worldwide },
    { heading: t('Last loaded counts'), tiles: loaded },
  ].filter(({ tiles }) => tiles.length);
});
const cameraTick = ref(0);
watch([view, tick], () => cameraTick.value++);
// A day's length in the page's own units: "10h 32m" on the tile, "45m"
// under an hour, and "10 hours 32 minutes" in its title.
function dayLength(minutes, display) {
  const unit = (n, name) => formatNumber(n, { style: 'unit', unit: name, unitDisplay: display });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${unit(hours, 'hour')} ${unit(rest, 'minute')}` : unit(rest, 'minute');
}
const emptyFacts = computed(() => {
  const time = inspectorNow.value;
  if (globeView.value)
    return [{ label: t('UTC'), value: utcClock(time) }];
  const facts = [];
  const now = weather.value;
  const failure = weatherFailed.value ? t('No weather reading here.') : '';
  facts.push({
    label: t('Weather'),
    value: Number.isFinite(now?.temperatureC)
      ? t('{n} °C', { n: formatNumber(Math.round(now.temperatureC)) })
      : failure || '…',
    title: failure || (now ? t(look.value.label) : ''),
    failure,
    weatherCredit: now?.source === 'open-meteo' && Number.isFinite(now.temperatureC),
    age: Number.isFinite(now?.temperatureC) ? weatherAge.value : '',
    busy: !Number.isFinite(now?.temperatureC) && !weatherFailed.value,
  });
  const center = view.value?.center;
  if (center) {
    const minutes = dayLengthMinutes(center.lat, time, { lon: center.lon, zone: viewZone.value });
    facts.push({ label: t('Daylight'), value: dayLength(minutes, 'narrow'), title: dayLength(minutes, 'long') });
  }
  if (Number.isFinite(view.value?.groundM))
    facts.push({ label: t('Elevation'), value: t('{n} m', { n: formatNumber(Math.round(view.value.groundM)) }) });
  return facts;
});
function openDataLayers() {
  finder.clearAll();
  revealDataLayers(chrome);
}

const suggestions = computed(() => {
  if (!finder.controlsMounted) return [];
  const rows = store.inspectorRows;
  const grounded = Boolean(!anyOn.value && !contextNeedle.value && store.scopeTier &&
    view.value?.center && view.value.groundFootprint !== false);
  const ids = suggestLayers(rows, { globe: globeView.value, grounded });
  return ids.map((id) => {
    const row = rows.find((layer) => layer.id === id);
    const panelName = PANEL_LABEL_KEYS[id];
    return { id, name: panelName ? t(panelName) : shownLayerName(row?.name, id), icon: tileIcon(id) };
  });
});
function openSuggested() {
  revealDataLayers(chrome);
  finder.pick(suggestions.value.map((layer) => layer.id));
}

</script>

<template>
  <section ref="viewBox" class="view-context" :aria-label="globeView ? t('Globe view') : t('In view')" tabindex="-1">
    <!-- Where the view looks: the place and its local time, or the globe. -->
    <template v-if="globeView">
      <h3 class="view-context__title">{{ t('Globe view') }}</h3>
      <p class="view-context__region">{{ anyOn ? `${clock} · ${t('camera {height}', { height: cameraText })}` : t('No layers on') }}</p>
    </template>
    <template v-else>
      <p class="view-context__eyebrow">{{ t('In view') }}<template v-if="!store.card"> · {{ t('Nothing selected') }}</template></p>
      <h3 class="view-context__title view-context__title--place">
        <span>{{ placeName }}</span>
        <UiButton v-if="headerPin" class="view-context__pin" :pressed="headerPinned" pressed-class="is-on" :label="headerPinLabel" @click="toggleHeaderPin">
          <UiIcon name="keep" :size="null" />
        </UiButton>
      </h3>
      <p class="view-context__region view-context__region--clock" :title="[centerCoordinates, clock].filter(Boolean).join(' · ')"><span v-if="centerCoordinates">{{ centerCoordinates }}</span><span>{{ clock }}</span></p>
    </template>
    <!-- Keep the selected camera above the unselected Radio and Missions rosters. -->
    <template v-if="!inlineCamera">
      <slot name="lead" />
      <NearbyMissions :feed="missionsFeed" />
    </template>

    <div v-if="showFlightsOff" class="view-context__block" data-flights-off>
      <span>{{ t('{layer} off', { layer: shownLayerName('Live Flights', 'flights') }) }}</span>
      <UiButton class="view-context__pointer" :disabled="enablingFlights" @click="turnOnFlights">{{ t('Turn on Flights') }}</UiButton>
      <p v-if="flightsEnableFailed" class="view-context__problem" role="status">{{ t('Data source unavailable') }}</p>
    </div>
    <template v-if="!anyOn">
      <p v-if="contextNeedle" class="view-context__empty" role="status">{{ tn(0, '{n} results', '{n} results', { n: formatNumber(0) }) }}</p>
      <template v-for="section in countSections" :key="section.heading">
        <h4 class="view-context__label">{{ section.heading }}</h4>
        <div class="view-context__tiles view-context__tiles--counts">
          <div v-for="tile in section.tiles" :key="tile.id" class="view-context__tile" :data-layer="tile.id" :title="[tile.hint, tile.age && t('Last known {age}', { age: tile.age })].filter(Boolean).join(' · ') || undefined">
            <span class="view-context__tile-name">
              <UiIcon :name="tile.icon" :size="null" />
              <span>{{ tile.name }}</span>
            </span>
            <strong>{{ tile.count }}</strong>
            <small v-if="tile.age" class="view-context__tile-age">{{ tile.age }}</small>
          </div>
        </div>
      </template>
      <p v-if="countSections.length" class="view-context__hint view-context__hint--counts">{{ t('No live requests') }}</p>
      <div class="view-context__tiles view-context__tiles--facts">
        <div v-for="fact in emptyFacts" :key="fact.label" class="view-context__tile" :title="fact.title || undefined" :aria-busy="fact.busy || undefined">
          <span class="view-context__tile-name">{{ fact.label }}</span>
          <strong :class="{ 'view-context__tile-status': fact.failure }">{{ fact.value }}</strong>
          <small v-if="fact.age" class="view-context__tile-age">{{ fact.age }}</small>
          <a v-if="fact.weatherCredit" class="ui-chip view-context__weather-source" href="https://open-meteo.com/" target="_blank" rel="noopener" :aria-label="t('Weather data by Open-Meteo.com')" translate="no">Open-Meteo</a>
        </div>
      </div>
      <AltitudeGraph v-if="Number.isFinite(view?.heightM)" class="view-context__camera" :altitude-m="view.heightM" :tick="cameraTick" :label="t('Camera height')" unit="metric" compact />
    </template>

    <template v-else>
      <!-- The weather where the view looks, from the reading that also gives
           the local time. -->
      <div v-if="!globeView" class="spot-conditions__weather view-context__weather" :aria-busy="String(!weatherNow && !weatherFailed)">
        <template v-if="weatherNow">
          <div class="spot-conditions__weather-now">
            <div class="view-context__temperature">
              <UiIcon class="spot-conditions__weather-icon" :name="look.icon" :size="null" />
              <strong>{{ weatherNow.temperature }}</strong>
            </div>
            <span :title="[weatherNow.conditions, weatherNow.stale].filter(Boolean).join(' · ')">{{ weatherNow.conditions }}<template v-if="weatherNow.stale"> · {{ weatherNow.stale }}</template></span>
            <a v-if="weatherNow.weatherCredit" class="ui-chip view-context__weather-source" href="https://open-meteo.com/" target="_blank" rel="noopener" :aria-label="t('Weather data by Open-Meteo.com')" translate="no">Open-Meteo</a>
          </div>
          <dl v-if="weatherNow.facts.length" class="spot-conditions__weather-facts">
            <div v-for="fact in weatherNow.facts" :key="fact.label" :title="`${fact.label} · ${fact.value}`">
              <dt>{{ fact.label }}</dt>
              <dd>{{ fact.value }}</dd>
            </div>
          </dl>
        </template>
        <p v-else class="spot-conditions__loading spot-conditions__weather-wait">{{ weatherFailed ? t('No weather reading here.') : t('Reading conditions here…') }}</p>
      </div>

      <ContextRadius v-if="!globeView && (hasOverhead || hasNearby)" :label="radiusLabel" :overhead="showOverhead" :toggle="hasOverhead && hasNearby" @toggle="preferOverhead = !preferOverhead" />

      <slot name="cameras" />
      <h4 v-if="globeView ? tiles.length || overlayTiles.length : localTileGroups.some(group => group.key === 'items') || overlayTiles.length" class="view-context__label">{{ layerTileHeading }}</h4>
      <!-- Search status stays visible when search hides the local tiles.
           In globe view this also contains the layer results and focus target. -->
      <div v-if="globeView || searchStatus" :class="{ 'view-context__blocks': globeView }" :tabindex="globeView ? -1 : undefined">
        <p v-if="searchStatus" class="view-context__empty" role="status">{{ searchStatus }}</p>
        <div v-for="tile in globeTiles" :key="tile.id" class="view-context__block" :data-layer="tile.id" :aria-label="[tile.name, tileScopeLabel(tile), countText(tile)].filter(Boolean).join(' · ')" tabindex="-1">
          <div class="view-context__block-head">
            <i class="view-context__dot" :class="`view-context__dot--${tile.tone}`" role="img" :aria-label="tile.toneText" :title="tile.toneText"></i>
            <EntityMark :layer="tile.id" :icon="tile.icon" />
            <span class="view-context__block-name">{{ tile.name }}</span>
            <strong>{{ summaries[tile.id]?.headline || (tile.state ?? countText(tile)) }}</strong>
          </div>
          <p v-if="tileScopeLabel(tile)" class="view-context__tile-age">{{ tileScopeLabel(tile) }}</p>
          <p v-if="tile.sampleFailed" class="view-context__problem" role="status">{{ scopeLabel('loaded') }} · {{ inspectorFeedLabel('unavailable') }}</p>
          <p v-if="tile.id === 'traffic' && Number.isFinite(tile.count) && !countStatus(tile)" class="view-context__count-unit">{{ t('Road segments') }}</p>
          <ContextSummary
            v-if="summaries[tile.id]"
            :center="view?.center || null"
            :layer-id="tile.id"
            :summary="summaries[tile.id]"
            :caption="summaries[tile.id].caption || (summaries[tile.id].headline ? tile.state || '' : '')"
            @pick="(item, event) => openSummaryItem(tile.id, item, event)"
          />
          <template v-else-if="tile.bar">
            <p v-if="tile.scope === 'total'" class="view-context__count-unit">{{ scopeLabel('loaded') }}</p>
            <ContextBreakdownBar :parts="tile.bar.parts" />
            <p v-if="tile.id === 'satellites' && tile.scope !== 'total' && tile.bar.total !== tile.count" class="view-context__bar-key">
              {{ t('Breakdown covers {n} of {total} loaded', { n: formatNumber(tile.bar.total), total: formatNumber(tile.count) }) }}
            </p>
          </template>
          <div v-if="globeGroups[tile.id]?.items.length" class="nearby-lists view-context__block-rows">
            <p v-if="!contextNeedle" class="view-context__tile-age">{{ scopeLabel('loaded') }}</p>
            <ul :aria-label="t('Nearest the centre of the view: {layer}', { layer: tile.name })">
              <li v-for="(item, index) in globeGroups[tile.id].items" :key="item.key">
                <UiButton :data-row-key="item.key" :data-row-layer="tile.id" :data-row-index="index" @click="selectRow(item, $event)">
                  <span class="nearby-lists__name">{{ sayWords(item.titleWords, item.title) }}</span>
                  <span class="nearby-lists__meta">{{ distanceText(item.distanceKm, approximatePosition(item.identity.record)) }}</span>
                </UiButton>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <template v-if="!globeView" v-for="group in localTileGroups" :key="group.key">
      <h4 v-if="group.key === 'closest'" class="view-context__label">{{ t('Closest to view') }}</h4>
      <h4 v-if="group.key === 'empty'" class="view-context__label">{{ t('None in view') }}</h4>
      <div class="view-context__tiles">
        <div v-for="tile in group.tiles" :key="tile.id" class="view-context__tile" :class="{ 'view-context__tile--value': tile.reading }" :data-layer="tile.id" :aria-label="[tile.name, tileScopeLabel(tile), countText(tile)].filter(Boolean).join(' · ')" :title="tile.reading?.detail || undefined">
          <span class="view-context__tile-name">
            <i class="view-context__dot" :class="`view-context__dot--${tile.tone}`" role="img" :aria-label="tile.toneText" :title="tile.toneText"></i>
            <UiIcon :name="tile.icon" :size="null" />
            <span>{{ tile.name }}</span>
          </span>
          <template v-if="tile.reading">
            <FieldPill :text="tile.reading.short || tile.reading.value" :level="tile.reading.level || ''" :color="tile.reading.color || ''" />
            <small v-if="tile.reading.measure" class="view-context__tile-age">{{ tile.reading.measure }}</small>
            <small v-if="tile.reading.detail" class="view-context__tile-age">{{ tile.reading.detail }}</small>
            <small v-if="countLine(tile)" class="view-context__tile-age view-context__tile-count">{{ countLine(tile) }}</small>
            <small v-if="countStatus(tile)" class="view-context__tile-age" role="status">{{ countStatus(tile) }}</small>
            <small v-if="tile.reading.age" class="view-context__tile-age">{{ tile.reading.age }}</small>
          </template>
          <strong v-else :role="tile.readFailed ? 'status' : undefined" :class="{ 'view-context__tile-status': countStatus(tile) }">{{ countText(tile) }}</strong>
          <ContextBreakdownBar v-if="tile.bar && !tile.reading && !summaries[tile.id]?.bands?.length" :parts="tile.bar.parts" />
          <small v-if="tileScopeLabel(tile)" class="view-context__tile-age">{{ tileScopeLabel(tile) }}</small>
          <UiButton v-if="tile.group?.alternate" class="view-context__scope-switch" :data-scope-layer="tile.id" @click="store.toggleGroupScope(tile.id)">{{ scopeLabel(tile.group.alternate.scope) }} · {{ formatNumber(tile.group.alternate.count) }}</UiButton>
          <div v-if="tile.group && (summaries[tile.id]?.items?.length || (tile.id === 'air-quality' && summaries[tile.id]?.caption))" class="view-context__summary" :data-layer="tile.id">
            <span v-if="summaries[tile.id].items?.length" class="view-context__block-name">{{ summaries[tile.id].itemsLabel || tile.name }}</span>
            <ContextSummary :center="view?.center || null" :layer-id="tile.id" :summary="summaries[tile.id]" :caption="summaries[tile.id].caption || ''" @pick="(item, event) => openSummaryItem(tile.id, item, event)" />
          </div>
          <NearbyLists v-if="tile.group?.items.length && !summaries[tile.id]?.items?.length" :lists="[tile.group]" :title="tileScopeLabel(tile)" rows-only :select-item="selectRow" external-focus />
          <small v-if="tile.worldwide" class="view-context__tile-age">{{ t('Worldwide') }}</small>
          <small v-if="tile.id === 'traffic' && Number.isFinite(tile.count) && !countStatus(tile)" class="view-context__tile-age">{{ t('Road segments') }}</small>
        </div>
      </div>
      </template>
      <template v-if="!globeView">
        <template v-for="group in sideGroups" :key="group.key">
          <h4 v-if="group.key === 'values'" class="view-context__label">{{ t('At the centre of the view') }}</h4>
          <div class="view-context__tiles">
            <div v-for="tile in group.tiles" :key="tile.id" class="view-context__tile view-context__tile--value" :data-layer="tile.id" :title="tile.detail || undefined">
              <span class="view-context__tile-name">
                <i class="view-context__dot" :class="`view-context__dot--${tile.tone}`" role="img" :aria-label="tile.toneText" :title="tile.toneText"></i>
                <UiIcon :name="tile.icon" :size="null" />
                <span>{{ tile.name }}</span>
              </span>
              <FieldPill :text="tile.short || tile.value" :level="tile.level || ''" :color="tile.color || ''" />
              <small v-if="tile.measure" class="view-context__tile-age">{{ tile.measure }}</small>
              <small v-if="tile.detail" class="view-context__tile-age">{{ tile.detail }}</small>
              <small v-if="tile.age" class="view-context__tile-age">{{ tile.age }}</small>
            </div>
          </div>
        </template>
      </template>
      <!-- A layer's own list under the tiles: its worst readings, by band. -->
      <template v-if="!globeView">
        <div v-for="layer in localSummaries" :key="layer.id" class="view-context__block view-context__summary" :data-layer="layer.id">
          <div class="view-context__block-head">
            <EntityMark :layer="layer.id" :icon="layer.icon" />
            <span class="view-context__block-name">{{ summaries[layer.id].itemsLabel || layer.name }}</span>
          </div>
          <ContextSummary :center="view?.center || null" :layer-id="layer.id" :summary="summaries[layer.id]" :caption="summaries[layer.id].caption || ''" @pick="(item, event) => openSummaryItem(layer.id, item, event)" />
        </div>
      </template>
      <p v-for="layer in problems" :key="layer.id" class="view-context__problem">{{ layer.name }} · {{ layer.problem }}</p>

      <p v-if="globeView" class="view-context__hint">{{ t('Click anything on the globe to see its card.') }}</p>
      <NearbyLists v-if="!globeView" :lists="radiusRows" :title="t('Nearby · {radius}', { radius: radiusText })" :select-item="selectRow" external-focus />
      <NearbyLists v-if="!globeView && overheadRows.length" :lists="overheadRows" :title="scopeLabel('overhead')" :select-item="selectRow" external-focus />
      <NearbyLists v-if="!globeView && closestRows.length" :lists="closestRows" :title="t('Closest to view')" :select-item="selectRow" external-focus />
      <NearbyLists v-if="!globeView && visibleRows.length" :lists="visibleRows" :title="t('In view')" :select-item="selectRow" external-focus />
    </template>
    <SuggestedLayers v-if="hasDataLayers" :layers="suggestions" @open="openSuggested" />
    <UiButton v-if="hasDataLayers && (contextNeedle || (!anyOn && !suggestions.length))" class="view-context__pointer" @click="openDataLayers">
      <UiIcon name="layers" :size="null" />
      <span class="view-context__pointer-text">{{ anyOn ? t('Open Data Layers') : globeView ? t('Turn on layers to see the world now') : t('Turn on layers to see what is around') }}</span>
      <span v-if="!anyOn" class="view-context__pointer-go">{{ t('Open') }} ›</span>
    </UiButton>
  </section>
</template>
