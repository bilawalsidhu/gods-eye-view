<script setup>
import { formatCockpitCoordinatePair } from '../../cockpitPresentation.js';
import { computed, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, ref, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { contextNeedle, contextSearchText } from '../../contextSearch.js';
import { formatNumber, getLocale, t, tn } from '../../../i18n/index.js';
import { countryName, nearestCity } from '../../../data/wikidataCities.js';
import { weatherPoint } from '../../viewWeather.js';
import { INSPECTOR_PULSE_MS, isGlobeView, useEntityCardStore } from '../../stores/entityCard.js';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import { PANEL_LABEL_KEYS, shownLayerName, layerSourceText } from '../../layerNames.js';
import { translateFeedError, translateStatusMessage } from '../../statusText.js';
import { entityKind } from '../../../data/entityContext.js';
import { CONTEXT_RADIUS_STEPS, contextRadiusKm, contextRadiusText as radiusText, contextRadiusIndex as radiusIndex, pickContextRadius as pickRadius } from '../../contextRadius.js';
import { weatherFacts, weatherLook } from '../../spotConditions.js';
import { clockLine, contextAgeText, dayLengthMinutes, utcClock } from '../../contextTime.js';
import { approximatePosition, distanceText } from '../../distanceText.js';
import { suggestLayers } from '../../layerSuggestions.js';
import { useLayerFinderStore } from '../../stores/layerFinder.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import EntityMark from './EntityMark.vue';
import UiSlider from '../../kit/UiSlider.js';
import NearbyLists from './NearbyLists.vue';
import AltitudeGraph from './AltitudeGraph.vue';
import SuggestedLayers from './SuggestedLayers.vue';
import { layerFeedState } from '../../../data/feedState.js';
import { FEED_STATE_LABEL_KEYS, inspectorHasLayers } from '../../layerRowState.js';
import { COUNT_TILE_LAYERS } from '../../layerCounts.js';
import { useLayerCountsStore } from '../../stores/layerCounts.js';
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
// Keep the presentation clock and share its eligible pulses with the bridge.
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
const globeView = computed(() => isGlobeView(view.value));

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
const placeName = computed(() => {
  const at = view.value?.center;
  const lookup = place.value;
  const city = lookup?.city;
  if (!at || !city || lookup.key !== placeKey(at)) return t('This view');
  const country = countryName(city.country, getLocale());
  const label = country && country !== city.name ? `${city.name}, ${country}` : city.name;
  return t('Near {place}', { place: label });
});
const centerCoordinates = computed(() => {
  const at = view.value?.center;
  if (!at) return '';
  return formatCockpitCoordinatePair(at.lat, at.lon);
});
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

// At globe view these scenes show their state on their tile, not a count.
const INCIDENT_SCENES = new Set(['bhote-koshi-2026', 'bhote-koshi-locator']);
// Space Missions keeps its own list (the roster), not the layer manager's:
// while it is on, its one tile counts that list, and the Space Missions
// layer's own row (rocket-launches) gets no second tile or Nearby group.
const missions = useSpaceMissionsStore();
const TILE_ICONS = {
  cctv: 'videocam',
  traffic: 'traffic',
  // Field layers have no item kind of their own.
  wind: 'air',
  'gnss-integrity': 'my_location',
  'recent-imagery': 'satellite_alt',
  'air-quality': 'eco',
  'weather-radar': 'radar',
  'weather-lightning': 'thunderstorm',
  'weather-satellite': 'cloud',
};
const tileIcon = (id) => TILE_ICONS[id] || entityKind(id).icon;
function inspectorFeedLabel(tone) {
  if (tone === 'nominal') return t('Live');
  if (tone === 'loading') return t('Loading');
  if (tone === 'stale') return t('Stale');
  const locale = getLocale();
  const label = t(FEED_STATE_LABEL_KEYS[tone]).toLocaleLowerCase(locale);
  return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
}

const CONTEXT_EXEMPT = Object.freeze(['radio', 'directions']);
const MISSIONS_LAYER = 'rocket-launches';

function inspectorLayerRows(rows) {
  return rows.filter((row) => row.enabled && !CONTEXT_EXEMPT.includes(row.id));
}

function presentLayerRow(row) {
  const stats = row.stats || {};
  // A refresh of a layer holding items keeps its feed state and total.
  const tone = layerFeedState(
    stats.loading && stats.count ? { ...stats, loading: false } : stats,
  );
  return {
    id: row.id,
    tone,
    total:
      Number.isFinite(stats.count) && !(stats.loading && !stats.count)
        ? stats.count
        : null,
    updatedAt: Number.isFinite(stats.lastUpdate) ? stats.lastUpdate : null,
  };
}

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
// The layers that get a tile or block of their own.
const liveLayers = computed(() => layerRows.value.filter((layer) => !(missions.enabled && layer.id === MISSIONS_LAYER)));
const layerById = computed(() => Object.fromEntries(liveLayers.value.map((layer) => [layer.id, layer])));
// A feed in trouble keeps its line, Space Missions' index included.
const problems = computed(() => layerRows.value.filter((layer) => layer.problem));
const anyOn = computed(() => inspectorHasLayers(store.inspectorRows, missions.enabled));

// Layers with a point reading show its value at the centre of the view.
// Air Quality also has station records that belong in Nearby.
const valueTiles = computed(() => {
  if (!store.inspector.shown) return [];
  void tick.value;
  const center = view.value?.center;
  if (globeView.value || !center) return [];
  return liveLayers.value.flatMap((layer) => {
    const found = store.valueAt(layer.id, center.lat, center.lon);
    if (found === undefined) return [];
    // Still loading: no reading yet, which is not "no value".
    if (found === null && layer.tone === 'loading') return [{ ...layer, value: '…', detail: '' }];
    if (found?.readFailed || (found === null && ['unavailable', 'degraded'].includes(layer.tone))) {
      const tone = found?.readFailed ? 'unavailable' : layer.tone;
      const toneText = inspectorFeedLabel(tone);
      return [{ ...layer, tone, toneText, value: toneText, detail: '' }];
    }
    // A reason (a coverage limit, a map-only product) in place of a value;
    // "No value" only for a real empty reading.
    const observed = layer.id === 'air-quality' || layer.id === 'gnss-integrity';
    const age = observed && Number.isFinite(found?.at)
      ? t('Updated {age}', { age: contextAgeText(Date.now() - found.at) })
      : '';
    const tone = found?.stale && layer.tone === 'nominal' ? 'stale' : layer.tone;
    return [{ ...layer, tone, toneText: inspectorFeedLabel(tone), value: found?.value || '—', detail: found?.reason || found?.detail || (found?.value ? '' : t('No value at the centre of the view')), age }];
  });
});
// Keep the enabled and non-item layer sets stable through ordinary refreshes.
const onIds = computed(() => liveLayers.value.map((layer) => layer.id).join('|'));
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
const sideGroups = computed(() => [
  { key: 'values', heading: true, tiles: valueTiles.value },
  { key: 'overlays', tiles: overlayTiles.value },
].filter((group) => group.tiles.length));
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
const lists = computed(() => {
  if (!store.inspector.shown) return [];
  void tick.value;
  void onIds.value;
  const center = view.value?.center;
  if (globeView.value || !center) return [];
  return store.nearbyLayers(center.lat, center.lon, {
    radiusKm: contextRadiusKm.value,
    limit: contextNeedle.value ? 12 : 3,
    query: contextNeedle.value,
    excludeLayers: [...CONTEXT_EXEMPT, ...(missions.enabled ? [MISSIONS_LAYER] : []), ...nonItemIds.value],
  });
});
// A count tile per layer: what it has within the radius, or, at globe view,
// everything it has loaded. A worldwide count is kept while its layer
// reloads, so the tiles hold steady.
const lastCounts = new Map();
const bars = new Map();
watch([onIds, () => store.managerVersion], ([ids, manager], [, previousManager]) => {
  if (manager !== previousManager) {
    // The initial version can arrive after this owner has already rendered.
    if (previousManager !== 0) lastCounts.clear();
    bars.clear();
    return;
  }
  const enabled = new Set(ids.split('|'));
  for (const cache of [lastCounts, bars])
    for (const id of cache.keys())
      if (!enabled.has(id)) cache.delete(id);
});
// The Space Missions tile counts the roster, worldwide at every zoom, with
// the feed state of the layer's mission index: a failed index reads its
// state, never "0 · Live".
const missionTile = computed(() => {
  if (!missions.enabled) return null;
  const count = missions.roster?.entries?.length;
  const feed = layerRows.value.find((layer) => layer.id === MISSIONS_LAYER);
  const troubled = feed && !['nominal', 'loading'].includes(feed.tone);
  return {
    id: 'space-missions',
    name: t('Space Missions'),
    icon: 'rocket_launch',
    tone: troubled ? feed.tone : Number.isFinite(count) ? 'nominal' : 'loading',
    toneText: troubled ? feed.toneText : Number.isFinite(count) ? t('Live') : t('Loading'),
    count: Number.isFinite(count) ? count : null,
    statusText: troubled && !count ? feed.toneText : '',
    worldwide: true,
  };
});
const tiles = computed(() => {
  if (!store.inspector.shown) return [];
  if (globeView.value)
    return [
      ...liveLayers.value.map((layer) => {
        // CCTV reports a loaded camera count without providing analyst rows.
        if (layer.id === 'cctv' && layer.total !== null) return { ...layer, count: layer.total };
        // Fields, overlays and incident scenes use their state here.
        if (INCIDENT_SCENES.has(layer.id) || layerKind(layer.id) !== 'items') return { ...layer, count: null, state: stateText(layer) };
        // The density grid loads separately, so the tile counts only selectable observations.
        if (layer.id === 'wildlife-sightings') {
          const count = store.layerModule(layer.id)?.getInspectableCount?.() ?? null;
          return { ...layer, count };
        }
        if (layer.total !== null) lastCounts.set(layer.id, layer.total);
        else if (layer.updatedAt === null) lastCounts.delete(layer.id);
        const count = lastCounts.get(layer.id) ?? null;
        return { ...layer, count, bar: kindBar(layer.id, count) };
      }),
      ...(missionTile.value ? [missionTile.value] : []),
    ].sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
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
    readFailed: list.readFailed,
    // Still loading with nothing in: … rather than 0.
    count: list.count === 0 && layerById.value[list.layerId]?.total === null ? null : list.count,
  })), ...quiet, ...(missionTile.value ? [missionTile.value] : [])];
});
const countStatus = (tile) => {
  if (tile.readFailed) return inspectorFeedLabel('unavailable');
  if (tile.count) return '';
  if (['unavailable', 'degraded', 'stale'].includes(tile.tone)) return tile.toneText;
  return tile.statusText || '';
};
const countText = (tile) => countStatus(tile) || (tile.count === null ? '…' : formatNumber(tile.count));
// At globe view each layer's block splits its count by kind (airliners,
// military, cargo; container ships, tankers), with a label for each segment.
const BAR_SPLITS = ['Type', 'Class', 'Magnitude', 'Mode'];
// Splitting a layer reads every record it holds (a satellite catalogue is
// propagated to do it), so reuse the bar for 30 s while its count holds.
const BAR_KEEP_MS = 30_000;
function kindBar(layerId, count) {
  const kept = bars.get(layerId);
  if (kept && kept.count === count && Date.now() - kept.at < BAR_KEEP_MS) return kept.bar;
  const found = store.breakdown(layerId);
  const bar = found && (found.total === count || (layerId === 'satellites' && found.total < count))
    ? splitBar(found)
    : null;
  bars.set(layerId, { at: Date.now(), bar, count });
  return bar;
}
function splitBar(found) {
  if (!found?.total) return null;
  const usable = found.splits.filter((one) => one.parts?.length >= 2);
  const split = BAR_SPLITS.map((title) => usable.find((one) => one.title === title)).find(Boolean) || usable[0];
  if (!split) return null;
  const total = split.parts.reduce((sum, part) => sum + part.count, 0);
  return {
    total,
    parts: split.parts.map((part, index) => ({
      label: part.label,
      count: part.count,
      share: part.count / total,
      tone: index,
    })),
  };
}
const listFormatter = computed(() => new Intl.ListFormat(getLocale(), { type: 'unit' }));
function listOf(parts) {
  try {
    return listFormatter.value.format(parts);
  } catch {
    return parts.join(', ');
  }
}
// At globe view, each layer lists its nearest visible items (three, or up to
// 12 while searching) for selection when the icons are small. The omnibar
// uses the viewport instead.
const globeGroups = computed(() => {
  if (!store.inspector.shown) return {};
  void tick.value;
  if (!globeView.value) return {};
  void onIds.value;
  const query = contextNeedle.value;
  return Object.fromEntries(store.inView({ perLayer: query ? 12 : 3, query }).map((group) => [group.layerId, group]));
});
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
  if (store.select(item.identity, { fly: true }) && keyboard)
    emit('keyboardSelection', item.key);
}
let heldRow = null;
onBeforeUpdate(() => {
  const row = globalThis.document?.activeElement?.closest?.('[data-row-key]');
  heldRow = row && viewBox.value?.contains(row) ? { key: row.dataset.rowKey, layer: row.dataset.rowLayer, index: Number(row.dataset.rowIndex) } : null;
});
onUpdated(() => {
  const was = heldRow;
  heldRow = null;
  const box = viewBox.value;
  const active = globalThis.document?.activeElement;
  if (!was || !box || (active && active !== globalThis.document.body)) return;
  const rows = [...box.querySelectorAll('[data-row-key]')];
  const sameRow = rows.find((row) => row.dataset.rowKey === was.key);
  const group = rows.filter((row) => row.dataset.rowLayer === was.layer);
  const block = [...box.querySelectorAll('.view-context__block')].find((node) => node.dataset.layer === was.layer);
  const fallback = box.querySelector('.view-context__blocks, .nearby-lists__title') || box.querySelector('.view-context__radius input') || box;
  (sameRow || group[Math.min(was.index, group.length - 1)] || block || fallback)?.focus?.();
});

const searchStatus = computed(() => {
  if (!contextNeedle.value) return '';
  const globe = globeView.value;
  const unavailable = tiles.value.filter((tile) =>
    (!globe || layerKind(tile.id) === 'items') &&
    (tile.tone === 'unavailable' || (globe ? globeGroups.value[tile.id]?.readFailed : tile.readFailed)));
  if (unavailable.length)
    return t('Unavailable layers: {layers}', { layers: listOf(unavailable.map((tile) => tile.name)) });
  if (globe)
    return globeTiles.value.length ? '' : tn(0, '{n} results', '{n} results', { n: formatNumber(0) });
  return lists.value.some((list) => list.items.length)
    ? ''
    : t('Nothing nearby matches “{text}”.', { text: contextSearchText.value.trim() });
});

const look = computed(() => weatherLook(weather.value?.weatherCode));
// The Inspector's reading, laid out as a card's weather. An observation older
// than 30 minutes shows its age.
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
  };
});
// Display-only counts from the server cache.
const countTiles = computed(() => {
  const now = inspectorNow.value;
  const available = new Set(store.inspectorRows.filter((row) => row.stats?.sourceUnavailable !== true).map((row) => row.id));
  return COUNT_TILE_LAYERS.map((layer) => ({ layer, known: counts.state.counts[layer.id] }))
    .filter(({ layer, known }) => available.has(layer.id) && known?.count > 0)
    .map(({ layer, known }) => {
      return {
        id: layer.id,
        icon: layer.icon,
        name: t(layer.label),
        hint: layer.hint ? t(layer.hint) : '',
        count: formatNumber(known.count),
        age: Number.isFinite(known.at) ? contextAgeText(now - known.at) : '',
      };
    });
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
  return facts;
});
function revealDataLayers() {
  chrome.act('reveal', 'data-panel');
  if (panels.value['data-panel']?.collapsed !== false) chrome.act('toggle', 'data-panel');
}
function openDataLayers() {
  finder.clearAll();
  revealDataLayers();
}

const suggestions = computed(() => {
  if (!finder.controlsMounted) return [];
  const rows = store.inspectorRows;
  const ids = suggestLayers(rows, { globe: globeView.value });
  return ids.map((id) => {
    const row = rows.find((layer) => layer.id === id);
    const panelName = PANEL_LABEL_KEYS[id];
    return { id, name: panelName ? t(panelName) : shownLayerName(row?.name, id), icon: tileIcon(id) };
  });
});
function openSuggested() {
  revealDataLayers();
  finder.pick(suggestions.value.map((layer) => layer.id));
}

</script>

<template>
  <section ref="viewBox" class="view-context" :aria-label="t('In view')" tabindex="-1">
    <!-- Where the view looks: the place and its local time, or the globe. -->
    <template v-if="globeView">
      <h3 class="view-context__title">{{ t('Globe view') }}</h3>
      <p class="view-context__region">{{ anyOn ? `${clock} · ${t('camera {height}', { height: cameraText })}` : t('No layers on') }}</p>
    </template>
    <template v-else>
      <p class="view-context__eyebrow">{{ t('In view') }} · {{ t('Nothing selected') }}</p>
      <h3 class="view-context__title">
        <span>{{ placeName }}</span>
      </h3>
      <p class="view-context__region view-context__region--clock" :title="[centerCoordinates, clock].filter(Boolean).join(' · ')"><span v-if="centerCoordinates">{{ centerCoordinates }}</span><span>{{ clock }}</span></p>
    </template>

    <template v-if="!anyOn">
      <p v-if="contextNeedle" class="view-context__empty" role="status">{{ tn(0, '{n} results', '{n} results', { n: formatNumber(0) }) }}</p>
      <template v-if="countTiles.length">
        <h4 class="view-context__label">{{ t('Worldwide, last known') }}</h4>
        <div class="view-context__tiles view-context__tiles--counts">
          <div v-for="tile in countTiles" :key="tile.id" class="view-context__tile" :data-layer="tile.id" :title="[tile.hint, tile.age && t('Last known {age}', { age: tile.age })].filter(Boolean).join(' · ') || undefined">
            <span class="view-context__tile-name">
              <UiIcon :name="tile.icon" :size="null" />
              <span>{{ tile.name }}</span>
            </span>
            <strong>{{ tile.count }}</strong>
            <small v-if="tile.hint || tile.age" class="view-context__tile-age">{{ [tile.hint, tile.age].filter(Boolean).join(' · ') }}</small>
          </div>
        </div>
        <p class="view-context__hint view-context__hint--counts">{{ t('No live requests') }}</p>
      </template>
      <div class="view-context__tiles view-context__tiles--facts">
        <div v-for="fact in emptyFacts" :key="fact.label" class="view-context__tile" :title="fact.title || undefined" :aria-busy="fact.busy || undefined">
          <span class="view-context__tile-name">{{ fact.label }}</span>
          <strong :class="{ 'view-context__tile-status': fact.failure }">{{ fact.value }}</strong>
          <small v-if="fact.age" class="view-context__tile-age">{{ fact.age }}</small>
          <a v-if="fact.weatherCredit" class="view-context__weather-credit" href="https://open-meteo.com/" target="_blank" rel="noopener">{{ t('Weather data by Open-Meteo.com') }}</a>
        </div>
      </div>
      <AltitudeGraph v-if="Number.isFinite(view?.heightM)" class="view-context__camera" :altitude-m="view.heightM" :tick="cameraTick" :label="t('Camera height')" unit="metric" compact />
    </template>

    <template v-else>
      <!-- The weather where the view looks, from the reading that also gives
           the local time. -->
      <div v-if="!globeView" class="spot-conditions__weather view-context__weather" :aria-busy="String(!weatherNow && !weatherFailed)">
        <template v-if="weatherNow">
          <UiIcon class="spot-conditions__weather-icon" :name="look.icon" :size="null" />
          <div class="spot-conditions__weather-now">
            <strong>{{ weatherNow.temperature }}</strong>
            <span>{{ weatherNow.conditions }}<template v-if="weatherNow.stale"> · {{ weatherNow.stale }}</template></span>
            <a v-if="weather?.source === 'open-meteo'" class="view-context__weather-credit" href="https://open-meteo.com/" target="_blank" rel="noopener">{{ t('Weather data by Open-Meteo.com') }}</a>
          </div>
          <dl v-if="weatherNow.facts.length" class="spot-conditions__weather-facts">
            <div v-for="fact in weatherNow.facts" :key="fact.label">
              <dt>{{ fact.label }}</dt>
              <dd>{{ fact.value }}</dd>
            </div>
          </dl>
        </template>
        <p v-else class="spot-conditions__loading spot-conditions__weather-wait">{{ weatherFailed ? t('No weather reading here.') : t('Reading conditions here…') }}</p>
      </div>

      <!-- The radius sits above the counts it filters from data already loaded. -->
      <div v-if="!globeView && (tiles.length || lists.length)" class="view-context__radius">
        <span class="view-context__radius-label">{{ t('Radius') }}</span>
        <UiSlider class="view-context__radius-slider" min="0" :max="CONTEXT_RADIUS_STEPS.length - 1" step="1" :model-value="radiusIndex" :aria-label="t('Nearby radius')" :aria-valuetext="radiusText" :title="t('How far out the counts and nearby lists look')" @update:model-value="pickRadius" />
        <output class="view-context__radius-value">{{ radiusText }}</output>
        <div class="view-context__radius-steps" aria-hidden="true">
          <span v-for="step in CONTEXT_RADIUS_STEPS" :key="step" :class="{ 'is-on': step === contextRadiusKm }">{{ formatNumber(step) }}</span>
        </div>
      </div>

      <h4 v-if="tiles.length" class="view-context__label">{{ globeView ? t('Layers on') : t('Within {radius}', { radius: radiusText }) }}</h4>
      <!-- Search status stays visible when search hides the local tiles.
           In globe view this also contains the layer results and focus target. -->
      <div v-if="globeView || searchStatus" :class="{ 'view-context__blocks': globeView }" :tabindex="globeView ? -1 : undefined">
        <p v-if="searchStatus" class="view-context__empty" role="status">{{ searchStatus }}</p>
        <div v-for="tile in globeTiles" :key="tile.id" class="view-context__block" :data-layer="tile.id" tabindex="-1">
          <div class="view-context__block-head">
            <i class="view-context__dot" :class="`view-context__dot--${tile.tone}`" role="img" :aria-label="tile.toneText" :title="tile.toneText"></i>
            <EntityMark :layer="tile.id" :icon="tile.icon" />
            <span class="view-context__block-name">{{ tile.name }}</span>
            <strong>{{ tile.state ?? countText(tile) }}</strong>
          </div>
          <p v-if="tile.id === 'traffic' && Number.isFinite(tile.count) && !countStatus(tile)" class="view-context__count-unit">{{ t('Loaded traffic dots') }}</p>
          <template v-if="tile.bar">
            <div class="view-context__bar" role="img" :aria-label="listOf(tile.bar.parts.map((part) => `${t(part.label)} ${formatNumber(part.count)}`))">
              <span v-for="part in tile.bar.parts" :key="part.label" :data-tone="part.tone" :style="{ flexGrow: part.share }"></span>
            </div>
            <p class="view-context__bar-key">
              <span v-for="part in tile.bar.parts" :key="part.label" :data-tone="part.tone">{{ t(part.label) }} {{ formatNumber(part.count) }}</span>
            </p>
            <p v-if="tile.id === 'satellites' && tile.bar.total !== tile.count" class="view-context__bar-key">
              {{ t('Breakdown covers {n} of {total} loaded', { n: formatNumber(tile.bar.total), total: formatNumber(tile.count) }) }}
            </p>
          </template>
          <div v-if="globeGroups[tile.id]?.items.length" class="nearby-lists view-context__block-rows">
            <ul :aria-label="t('Nearest the centre of the view: {layer}', { layer: tile.name })">
              <li v-for="(item, index) in globeGroups[tile.id].items" :key="item.key">
                <UiButton :data-row-key="item.key" :data-row-layer="tile.id" :data-row-index="index" @click="selectRow(item, $event)">
                  <span class="nearby-lists__name">{{ item.title }}</span>
                  <span class="nearby-lists__meta">{{ distanceText(item.distanceKm, approximatePosition(item.identity.record)) }}</span>
                </UiButton>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div v-if="!globeView && tiles.length" class="view-context__tiles">
        <div v-for="tile in tiles" :key="tile.id" class="view-context__tile" :data-layer="tile.id">
          <span class="view-context__tile-name">
            <i class="view-context__dot" :class="`view-context__dot--${tile.tone}`" role="img" :aria-label="tile.toneText" :title="tile.toneText"></i>
            <UiIcon :name="tile.icon" :size="null" />
            <span>{{ tile.name }}</span>
          </span>
          <strong :class="{ 'view-context__tile-status': countStatus(tile) }" :role="tile.readFailed ? 'status' : undefined">{{ countText(tile) }}</strong>
          <small v-if="tile.worldwide" class="view-context__tile-age">{{ t('Worldwide') }}</small>
          <small v-else-if="tile.id === 'traffic' && Number.isFinite(tile.count) && !countStatus(tile)" class="view-context__tile-age">{{ t('Road segments') }}</small>
        </div>
      </div>
      <template v-if="!globeView">
        <template v-for="group in sideGroups" :key="group.key">
          <h4 v-if="group.heading" class="view-context__label">{{ t('At the centre of the view') }}</h4>
          <div class="view-context__tiles">
            <!-- Field and overlay layers show a local reading or feed state. -->
            <div v-for="tile in group.tiles" :key="tile.id" class="view-context__tile view-context__tile--value" :data-layer="tile.id" :title="tile.detail || undefined">
              <span class="view-context__tile-name">
                <i class="view-context__dot" :class="`view-context__dot--${tile.tone}`" role="img" :aria-label="tile.toneText" :title="tile.toneText"></i>
                <UiIcon :name="tile.icon" :size="null" />
                <span>{{ tile.name }}</span>
              </span>
              <strong>{{ tile.value }}</strong>
              <small v-if="tile.detail" class="view-context__tile-age">{{ tile.detail }}</small>
              <small v-if="tile.age" class="view-context__tile-age">{{ tile.age }}</small>
            </div>
          </div>
        </template>
      </template>
      <p v-for="layer in problems" :key="layer.id" class="view-context__problem">{{ layer.name }} · {{ layer.problem }}</p>

      <p v-if="globeView" class="view-context__hint">{{ t('Click anything on the globe to see its card.') }}</p>
      <NearbyLists v-else :lists="lists" :title="t('Nearby · {radius}', { radius: radiusText })" @select="selectRow" />
    </template>
    <SuggestedLayers v-if="hasDataLayers" :layers="suggestions" @open="openSuggested" />
    <UiButton v-if="hasDataLayers && (contextNeedle || !suggestions.length)" class="view-context__pointer" @click="openDataLayers">
      <UiIcon name="layers" :size="null" />
      <span class="view-context__pointer-text">{{ anyOn ? t('Open Data Layers') : globeView ? t('Turn on layers to see the world now') : t('Turn on layers to see what is around') }}</span>
      <span v-if="!anyOn" class="view-context__pointer-go">{{ t('Open') }} ›</span>
    </UiButton>
  </section>
</template>
