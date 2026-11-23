<script setup>
import { computed, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, ref, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { contextNeedle, contextSearchText } from '../../contextSearch.js';
import { formatNumber, t, tn } from '../../../i18n/index.js';
import { countryName, nearestCity } from '../../../data/wikidataCities.js';
import { countryCodeAt } from '../../../data/placeBelow.js';
import { INSPECTOR_PULSE_MS, isGlobeView, useEntityCardStore } from '../../stores/entityCard.js';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import { shownLayerName, sourceLabel } from '../../layerNames.js';
import { translateFeedError, translateStatusMessage } from '../../statusText.js';
import { entityKind } from '../../../data/entityContext.js';
import { CONTEXT_RADIUS_STEPS, contextRadiusKm, setContextRadiusKm } from '../../contextRadius.js';
import { compassName, weatherLook } from '../../spotConditions.js';
import { clockLine, dayLengthMinutes, daylightShare, utcClock } from '../../contextTime.js';
import { distanceText } from '../../distanceText.js';
import { suggestLayers } from '../../layerSuggestions.js';
import { useLayerFinderStore } from '../../stores/layerFinder.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import EntityMark from './EntityMark.vue';
import SunDial from './SunDial.vue';
import UiSlider from '../../kit/UiSlider.js';
import NearbyLists from './NearbyLists.vue';
import AltitudeGraph from './AltitudeGraph.vue';
import SuggestedLayers from './SuggestedLayers.vue';
import { CONTEXT_EXEMPT, MISSIONS_LAYER, inspectorHasLayers, inspectorLayerRows, presentLayerRow, shownApart } from '../../layerRowState.js';
import { COUNT_TILE_LAYERS } from '../../layerCounts.js';
import { useLayerCountsStore } from '../../stores/layerCounts.js';
import { useSpaceMissionsStore } from '../../stores/spaceMissions.js';

// What the Context panel shows while nothing is picked: situational
// awareness of the layers that are on. Where the camera is looking (place,
// region and local time) and, zoomed in, the weather there, then the radius,
// a count per layer that is on within it, and what is nearby, one list per
// layer, nearest first. At globe
// view it shows the totals each enabled provider has loaded. With no layer on it
// shows a few facts about the place (or the globe) and points to Data
// Layers; layers are turned on and off there, never here. Any row opens that
// item's card. It reads again when the camera settles, and every few seconds
// so moving things stay current.
const store = useEntityCardStore();
const finder = useLayerFinderStore();
const chrome = usePanelChromeStore();
const { panels } = storeToRefs(chrome);
const hasDataLayers = computed(() => Boolean(panels.value['data-panel']));
const { view, viewWeather } = storeToRefs(store);
const counts = useLayerCountsStore();
const emit = defineEmits(['mounted', 'unmounting']);
const tick = ref(0);
const ageResume = ref(0);
const doc = globalThis.document;
const visible = () => doc?.visibilityState !== 'hidden';
function onVisibilityChange() {
  if (visible()) ageResume.value++;
}
let timer = null;
// Keep the presentation clock and share its eligible pulses with the bridge.
onMounted(() => {
  doc?.addEventListener('visibilitychange', onVisibilityChange);
  timer = setInterval(() => {
    if (!visible() || !store.inspector.shown) return;
    tick.value++;
    store.pulseInspector();
  }, INSPECTOR_PULSE_MS);
  emit('mounted');
});
onBeforeUnmount(() => {
  emit('unmounting');
  doc?.removeEventListener('visibilitychange', onVisibilityChange);
  clearInterval(timer);
});

// Globe view: the whole globe in view, not zoomed in. It goes by the
// camera's height: a tilted view near the ground sees the horizon, so the
// view's extent reads as the whole globe there too.
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
    if (placeRequest === request) place.value = city;
  },
  { immediate: true },
);
const placeName = computed(() => place.value?.name || t('This view'));
const placeCountry = computed(() => countryName(place.value?.country));
const weather = computed(() => viewWeather.value?.reading ?? null);
const weatherFailed = computed(() => Boolean(viewWeather.value?.failed && !viewWeather.value.pending));
const zone = computed(() => viewWeather.value?.zone ?? null);
const samePoint = (a, b) => a.lat === b.lat && a.lon === b.lon;
// The weather endpoint rounds request coordinates to five decimal places.
const sameWeatherPoint = (a, b) =>
  Number(a.lat?.toFixed(5)) === Number(b.lat?.toFixed(5)) &&
  Number(a.lon?.toFixed(5)) === Number(b.lon?.toFixed(5));
const readCountry = (center) => countryCodeAt(center.lat, center.lon).catch(() => null);
const confirmedZone = shallowRef(null);
let zoneOrigin;
watch(
  [() => view.value?.center?.lat, () => view.value?.center?.lon, zone, globeView],
  async ([lat, lon, reading, globe], _, onCleanup) => {
    const center = { lat, lon };
    if (globe || !reading || sameWeatherPoint(center, reading.center)) return;
    let current = true;
    onCleanup(() => { current = false; });
    if (zoneOrigin?.reading !== reading)
      zoneOrigin = { reading, country: readCountry(reading.center) };
    const [origin, country] = await Promise.all([zoneOrigin.country, readCountry(center)]);
    if (current) confirmedZone.value = origin && country === origin ? { center, reading } : null;
  },
  { immediate: true },
);

// "10:14 local, 16:14 UTC" where the view looks; UTC alone until its time
// zone is known, and at globe view.
const clock = computed(() => {
  void tick.value;
  const center = view.value?.center;
  const reading = zone.value;
  if (globeView.value || !center || !reading) return clockLine(null);
  if (sameWeatherPoint(center, reading.center)) return clockLine(reading);
  const hint = confirmedZone.value;
  const confirmed = hint?.reading === reading && samePoint(center, hint.center);
  return clockLine(confirmed ? reading : null);
});
const placeLine = computed(() =>
  [placeCountry.value !== placeName.value ? placeCountry.value : null, clock.value].filter(Boolean).join(' · '),
);
const cameraText = computed(() => {
  const m = view.value?.heightM ?? 0;
  return m >= 10_000 ? t('{n} km', { n: formatNumber(Math.round(m / 1000)) }) : t('{n} m', { n: formatNumber(Math.round(m)) });
});

// The layers that are on, with their feed state: a dot on each count tile,
// and a line under the tiles for a feed in trouble.
const FEED_WORDS = {
  nominal: () => t('Live'),
  loading: () => t('Loading'),
  stale: () => t('Stale'),
  fallback: () => t('FALLBACK'),
  partial: () => t('PARTIAL'),
  degraded: () => t('DEGRADED'),
  unavailable: () => t('UNAVAILABLE'),
};
// These scenes count the incident itself rather than the separate evidence
// and place rows they contribute to Nearby.
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
// Every layer that is on, with its feed state, Space Missions' row included.
const layerRows = computed(() =>
  inspectorLayerRows(store.inspectorRows).map((row) => {
    const presentation = presentLayerRow(row);
    const { tone } = presentation;
    const stats = row.stats || {};
    const source = stats.sourceVerbatim ? stats.source : sourceLabel(stats.source || row.source);
    const status = translateStatusMessage(stats.statusMessage || stats.loadingLabel || stats.coverage);
    const error = translateFeedError(stats.error || stats.lastError || stats.managerRefreshError);
    const words = (FEED_WORDS[tone] || FEED_WORDS.nominal)();
    return {
      ...presentation,
      name: shownLayerName(row.name, row.id),
      icon: TILE_ICONS[row.id] || entityKind(row.id).icon,
      toneText: words,
      problem: ['nominal', 'loading'].includes(tone)
        ? ''
        : [...new Set([source, words, status, error].filter(Boolean))].join(' · '),
      statusText: stats.status && stats.status !== 'ok' ? status : '',
    };
  }),
);
// The layers that get a tile or block of their own.
const liveLayers = computed(() => layerRows.value.filter((layer) => !shownApart(layer.id, missions.enabled)));
const layerById = computed(() => Object.fromEntries(liveLayers.value.map((layer) => [layer.id, layer])));
// A feed in trouble keeps its line, Space Missions' index included.
const problems = computed(() => layerRows.value.filter((layer) => layer.problem));
const anyOn = computed(() => inspectorHasLayers(store.inspectorRows, missions.enabled));

// The radius sits just above the counts, because it sets them. It only
// filters what the layers have loaded: no feed is asked for more.
const radiusText = computed(() => t('{n} km', { n: formatNumber(contextRadiusKm.value) }));
const radiusIndex = computed(() => Math.max(0, CONTEXT_RADIUS_STEPS.indexOf(contextRadiusKm.value)));
const pickRadius = (index) => setContextRadiusKm(CONTEXT_RADIUS_STEPS[index]);

// A field layer (wind, GNSS integrity, recent imagery, air quality) has a
// value at a point rather than items: one tile with its value at the centre
// of the view, and nothing under Nearby.
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
    // A reason (a coverage limit, a map-only product) in place of a value;
    // "No value" only for a real empty reading.
    return [{ ...layer, value: found?.value || '—', detail: found?.reason || found?.detail || (found?.value ? '' : t('No value at the centre of the view')) }];
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
const sideTiles = computed(() => [...valueTiles.value, ...overlayTiles.value]);
// What a layer is for its tile, the same at every zoom: items it counts, a
// value at a point (a field), or a picture on the map (an overlay).
function layerKind(layerId) {
  const module = store.layerModule(layerId);
  if (typeof module?.getValueAt === 'function') return 'field';
  const hasItems = typeof module?.getAnalystRecords === 'function' && module.supportsAnalystRecords !== false;
  return hasItems ? 'items' : 'overlay';
}
// A field or an overlay has no count worth showing: its state instead, and
// how fresh its picture is.
function stateText(layer) {
  if (layer.tone === 'loading') return '…';
  if (layer.updatedAt) return t('Updated {age}', { age: agoText(Date.now() - layer.updatedAt) });
  return layer.toneText;
}

// One list per layer that is on, within the radius, nearest first; narrowed
// by the Context search like everything else here. It follows the layers
// turned on or off at once, and refreshes on the 4 s tick; the store keeps
// each layer's list until the view, the ask or that layer's data change.
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
        if (layer.total !== null) lastCounts.set(layer.id, layer.total);
        else if (layer.updatedAt === null) lastCounts.delete(layer.id);
        return { ...layer, count: lastCounts.get(layer.id) ?? null, bar: kindBar(layer.id) };
      }),
      ...(missionTile.value ? [missionTile.value] : []),
    ].sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
  // Every layer with items gets a tile, also with none of them within the
  // radius (0, or why it holds none), so a layer that is on never goes
  // missing.
  const listed = new Set(lists.value.map((list) => list.layerId));
  const fields = new Set(sideTiles.value.map((tile) => tile.id));
  const quiet = liveLayers.value
    .filter((layer) => !listed.has(layer.id) && !fields.has(layer.id) && layerKind(layer.id) === 'items')
    .map((layer) => ({ ...layer, count: layer.total === null ? null : 0 }));
  return [...lists.value.map((list) => ({
    ...(layerById.value[list.layerId] || {
      id: list.layerId,
      name: shownLayerName(list.layerName, list.layerId),
      icon: list.icon,
      tone: 'nominal',
      toneText: t('Live'),
    }),
    // Still loading with nothing in: … rather than 0.
    count: list.count === 0 && layerById.value[list.layerId]?.total === null ? null : list.count,
  })), ...quiet, ...(missionTile.value ? [missionTile.value] : [])];
});
// A 0 from a layer that says why it holds nothing reads as that reason.
const countText = (tile) => (tile.count === null ? '…' : tile.count === 0 && tile.statusText ? tile.statusText : formatNumber(tile.count));
// At globe view each layer's block splits its count by kind (airliners,
// military, cargo; container ships, tankers), as a bar with its leading kinds
// named under it.
const BAR_SPLITS = ['Type', 'Class', 'Magnitude', 'Mode'];
// Splitting a layer reads every record it holds (a satellite catalogue is
// propagated to do it), so each layer's bar is worked out at most every 30 s.
const BAR_KEEP_MS = 30_000;
function kindBar(layerId) {
  const kept = bars.get(layerId);
  if (kept && Date.now() - kept.at < BAR_KEEP_MS) return kept.bar;
  const bar = splitBar(layerId);
  bars.set(layerId, { at: Date.now(), bar });
  return bar;
}
function splitBar(layerId) {
  const found = store.breakdown(layerId);
  if (!found?.total) return null;
  const split = BAR_SPLITS.map((title) => found.splits.find((one) => one.title === title)).find(Boolean) || found.splits[0];
  if (!split?.parts?.length || split.parts.length < 2) return null;
  // English labels; translated where they show, so a language switch shows
  // at once.
  return split.parts.map((part, index) => ({
    label: part.label,
    count: part.count,
    share: part.count / found.total,
    tone: index,
  }));
}
// The bar's parts read as a list in the page's language.
function listOf(parts) {
  try {
    return new Intl.ListFormat(document.documentElement.lang || 'en', { type: 'unit' }).format(parts);
  } catch {
    return parts.join(', ');
  }
}
// At globe view, under each layer's block: the three of its items nearest
// the centre of the view on the visible hemisphere, to pick from when the
// globe's icons are too small to click. The store's in-view answer, shared
// with the omnibar and worked out again only when the camera settles or a
// layer's data refreshes.
const nearCentre = computed(() => {
  if (!store.inspector.shown) return {};
  void tick.value;
  if (!globeView.value) return {};
  void onIds.value;
  const query = contextNeedle.value;
  return Object.fromEntries(store.inView({ perLayer: query ? 12 : 3, query }).map((group) => [group.layerId, group.items]));
});
const globeTiles = computed(() => contextNeedle.value
  ? tiles.value.filter((tile) => nearCentre.value[tile.id]?.length)
  : tiles.value);
// Own row focus in the view so it survives a switch between list layouts.
const viewBox = ref(null);
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

const nothingNearby = computed(() => lists.value.every((list) => !list.items.length));

// With nothing on: a few facts about the place, or the globe, and a pointer
// to Data Layers.
const look = computed(() => weatherLook(weather.value?.weatherCode));
// The weather block with layers on, zoomed in, from the same reading (no
// read of its own): the temperature and conditions, then wind, cloud,
// visibility and rain, as a selected item's card shows them. A reading older
// than half an hour (the server keeps one through an outage) says its age.
const WEATHER_STALE_MS = 30 * 60_000;
const weatherAge = computed(() => {
  void tick.value;
  void ageResume.value;
  void store.inspector.shown;
  const at = viewWeather.value?.freshnessAt;
  if (!Number.isFinite(at)) return '';
  const age = Date.now() - at;
  return age > WEATHER_STALE_MS ? t('Updated {age}', { age: agoText(age) }) : '';
});
const roundOf = (n) => (Number.isFinite(n) ? Math.round(n) : null);
const weatherNow = computed(() => {
  const now = weather.value;
  if (!Number.isFinite(now?.temperatureC)) return null;
  const facts = [];
  if (Number.isFinite(now.windKph)) {
    const speed = t('{n} km/h', { n: formatNumber(roundOf(now.windKph)) });
    facts.push({
      label: t('Wind'),
      value: Number.isFinite(now.windDirectionDeg) ? t('{speed} {direction}', { speed, direction: t(compassName(now.windDirectionDeg)) }) : speed,
    });
  }
  if (Number.isFinite(now.cloudCoverPct)) facts.push({ label: t('Cloud'), value: t('{n}%', { n: formatNumber(roundOf(now.cloudCoverPct)) }) });
  if (Number.isFinite(now.visibilityM))
    facts.push({
      label: t('Visibility'),
      value: t('{n} km', { n: formatNumber(now.visibilityM >= 10_000 ? roundOf(now.visibilityM / 1000) : Number((now.visibilityM / 1000).toFixed(1))) }),
    });
  if (Number.isFinite(now.precipitationMm))
    facts.push({ label: t('Rain'), value: t('{n} mm', { n: formatNumber(now.precipitationMm, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) });
  return {
    temperature: t('{n} °C', { n: formatNumber(roundOf(now.temperatureC)) }),
    conditions: [t(look.value.label), Number.isFinite(now.apparentTemperatureC) ? t('feels {n}°', { n: formatNumber(roundOf(now.apparentTemperatureC)) }) : null].filter(Boolean).join(' · '),
    facts,
    stale: weatherAge.value,
  };
});
// With nothing on, display-only tiles say what each layer would show,
// worldwide and last known: from server caches and worldwide layer reads.
// On later entry, retry only when half an hour has passed since the last
// attempt. Enabled layers show the provider's loaded counts. Turning layers on stays in
// Data Layers.
function agoText(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t('{n} s ago', { n: formatNumber(Math.max(1, Math.round(ms / 1000))) });
  if (minutes < 60) return t('{n} min ago', { n: formatNumber(minutes) });
  return t('{n} h ago', { n: formatNumber(Math.round(minutes / 60)) });
}
const countTiles = computed(() => {
  void tick.value;
  const now = Date.now();
  return COUNT_TILE_LAYERS.map((layer) => ({ layer, known: counts.state.counts[layer.id] }))
    .filter(({ known }) => known?.count > 0)
    .slice(0, 6)
    .map(({ layer, known }) => {
      const age = Number.isFinite(known.at) ? Math.max(0, now - known.at) : null;
      return {
        id: layer.id,
        icon: layer.icon,
        name: t(layer.label),
        count: formatNumber(known.count),
        age: age === null ? '' : agoText(age),
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
  void tick.value;
  if (globeView.value)
    return [
      { label: t('UTC'), value: utcClock() },
      { label: t('Daylight'), value: t('{n}%', { n: formatNumber(Math.round(daylightShare() * 100)) }) },
    ];
  const facts = [];
  const now = weather.value;
  facts.push({
    label: t('Weather'),
    value: Number.isFinite(now?.temperatureC)
      ? t('{n} °C', { n: formatNumber(Math.round(now.temperatureC)) })
      : weatherFailed.value ? t('No weather reading here.') : '…',
    title: now ? t(look.value.label) : '',
    weatherCredit: now?.source === 'open-meteo' && Number.isFinite(now.temperatureC),
    age: Number.isFinite(now?.temperatureC) ? weatherAge.value : '',
    busy: !Number.isFinite(now?.temperatureC) && !weatherFailed.value,
  });
  const center = view.value?.center;
  if (center) {
    const minutes = dayLengthMinutes(center.lat);
    facts.push({ label: t('Daylight'), value: dayLength(minutes, 'narrow'), title: dayLength(minutes, 'long') });
  }
  return facts;
});
function openDataLayers() {
  chrome.act('reveal', 'data-panel');
  if (panels.value['data-panel']?.collapsed !== false) chrome.act('toggle', 'data-panel');
}

// Up to three suggested layers, by simple rules and only
// where a layer declares coverage. Open shows Data Layers with them picked
// out; nothing is switched on.
const suggestions = computed(() => {
  if (!finder.controlsMounted) return [];
  const rows = store.inspectorRows;
  const ids = suggestLayers(rows, { globe: globeView.value });
  return ids.map((id) => {
    const row = rows.find((layer) => layer.id === id);
    return { id, name: shownLayerName(row?.name, id), icon: TILE_ICONS[id] || entityKind(id).icon };
  });
});
function openSuggested() {
  openDataLayers();
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
      <p class="view-context__region">{{ placeLine }}</p>
    </template>

    <!-- Nothing on: a few facts, and a pointer to Data Layers. Any layer on,
         Radio included, has its own content instead. -->
    <template v-if="!anyOn">
      <template v-if="countTiles.length">
        <h4 class="view-context__label">{{ t('Worldwide, last known') }}</h4>
        <div class="view-context__tiles view-context__tiles--counts">
          <div v-for="tile in countTiles" :key="tile.id" class="view-context__tile" :data-layer="tile.id" :title="tile.age ? t('Last known {age}', { age: tile.age }) : undefined">
            <span class="view-context__tile-name">
              <UiIcon :name="tile.icon" :size="null" />
              <span>{{ tile.name }}</span>
            </span>
            <strong>{{ tile.count }}</strong>
            <small v-if="tile.age" class="view-context__tile-age">{{ tile.age }}</small>
          </div>
        </div>
        <p class="view-context__hint view-context__hint--counts">{{ t('No live requests') }}</p>
      </template>
      <div class="view-context__tiles view-context__tiles--facts">
        <div v-for="fact in emptyFacts" :key="fact.label" class="view-context__tile" :title="fact.title || undefined" :aria-busy="fact.busy || undefined">
          <span class="view-context__tile-name">{{ fact.label }}</span>
          <strong>{{ fact.value }}</strong>
          <small v-if="fact.age" class="view-context__tile-age">{{ fact.age }}</small>
          <a v-if="fact.weatherCredit" class="view-context__weather-credit" href="https://open-meteo.com/" target="_blank" rel="noopener">{{ t('Weather data by Open-Meteo.com') }}</a>
        </div>
      </div>
      <!-- The sun dial fills the globe view while no layer is on. -->
      <SunDial v-if="globeView && view?.center" :lat="view.center.lat" :lon="view.center.lon" />
      <AltitudeGraph v-if="Number.isFinite(view?.heightM)" class="view-context__camera" :altitude-m="view.heightM" :tick="cameraTick" :label="t('Camera height')" unit="metric" compact />
      <!-- Suggested layers: open Data Layers with them picked out. -->
      <SuggestedLayers v-if="hasDataLayers" :layers="suggestions" @open="openSuggested" />
      <UiButton v-if="hasDataLayers && !suggestions.length" class="view-context__pointer" @click="openDataLayers">
        <UiIcon name="layers" :size="null" />
        <span class="view-context__pointer-text">{{ globeView ? t('Turn on layers to see the world now') : t('Turn on layers to see what is around') }}</span>
        <span class="view-context__pointer-go">{{ t('Open') }} ›</span>
      </UiButton>
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

      <!-- The radius, just above the counts it sets. -->
      <div v-if="!globeView" class="view-context__radius">
        <span class="view-context__radius-label">{{ t('Radius') }}</span>
        <UiSlider class="view-context__radius-slider" min="0" :max="CONTEXT_RADIUS_STEPS.length - 1" step="1" :model-value="radiusIndex" :aria-label="t('Nearby radius')" :aria-valuetext="radiusText" :title="t('How far out the counts and nearby lists look')" @update:model-value="pickRadius" />
        <output class="view-context__radius-value">{{ radiusText }}</output>
        <div class="view-context__radius-steps" aria-hidden="true">
          <span v-for="step in CONTEXT_RADIUS_STEPS" :key="step" :class="{ 'is-on': step === contextRadiusKm }">{{ formatNumber(step) }}</span>
        </div>
      </div>

      <h4 v-if="tiles.length || sideTiles.length" class="view-context__label">{{ globeView ? t('Layers on') : t('Within {radius}', { radius: radiusText }) }}</h4>
      <!-- Globe view: each layer once, its name, count and feed state, and
           what its count is made of. -->
      <div v-if="globeView" class="view-context__blocks" tabindex="-1">
        <p v-if="contextNeedle && !globeTiles.length" class="view-context__empty" role="status">{{ tn(0, '{n} results', '{n} results', { n: formatNumber(0) }) }}</p>
        <div v-for="tile in globeTiles" :key="tile.id" class="view-context__block" :data-layer="tile.id" tabindex="-1">
          <div class="view-context__block-head">
            <i class="view-context__dot" :class="`view-context__dot--${tile.tone}`" role="img" :aria-label="tile.toneText" :title="tile.toneText"></i>
            <EntityMark :layer="tile.id" :icon="tile.icon" />
            <span class="view-context__block-name">{{ tile.name }}</span>
            <strong>{{ tile.state ?? countText(tile) }}</strong>
          </div>
          <template v-if="tile.bar">
            <div class="view-context__bar" role="img" :aria-label="listOf(tile.bar.map((part) => `${t(part.label)} ${formatNumber(part.count)}`))">
              <span v-for="part in tile.bar" :key="part.label" :data-tone="part.tone" :style="{ flexGrow: part.share }"></span>
            </div>
            <p class="view-context__bar-key">
              <span v-for="part in tile.bar.slice(0, 3)" :key="part.label" :data-tone="part.tone">{{ t(part.label) }} {{ formatNumber(part.count) }}</span>
            </p>
          </template>
          <div v-if="nearCentre[tile.id]?.length" class="nearby-lists view-context__block-rows">
            <ul :aria-label="t('Nearest the centre of the view: {layer}', { layer: tile.name })">
              <li v-for="(item, index) in nearCentre[tile.id]" :key="item.key">
                <UiButton :data-row-key="item.key" :data-row-layer="tile.id" :data-row-index="index" @click="store.select(item.identity, { fly: true })">
                  <span class="nearby-lists__name">{{ item.title }}</span>
                  <span class="nearby-lists__meta">{{ distanceText(item.distanceKm) }}</span>
                </UiButton>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div v-else class="view-context__tiles">
        <div v-for="tile in tiles" :key="tile.id" class="view-context__tile" :data-layer="tile.id">
          <span class="view-context__tile-name">
            <i class="view-context__dot" :class="`view-context__dot--${tile.tone}`" role="img" :aria-label="tile.toneText" :title="tile.toneText"></i>
            <UiIcon :name="tile.icon" :size="null" />
            <span>{{ tile.name }}</span>
          </span>
          <strong :class="{ 'view-context__tile-status': tile.count === 0 && tile.statusText }">{{ countText(tile) }}</strong>
          <small v-if="tile.worldwide" class="view-context__tile-age">{{ t('Worldwide') }}</small>
        </div>
        <!-- Field layers: their value at the centre of the view. -->
        <div v-for="tile in sideTiles" :key="tile.id" class="view-context__tile view-context__tile--value" :data-layer="tile.id" :title="tile.detail || undefined">
          <span class="view-context__tile-name">
            <i class="view-context__dot" :class="`view-context__dot--${tile.tone}`" role="img" :aria-label="tile.toneText" :title="tile.toneText"></i>
            <UiIcon :name="tile.icon" :size="null" />
            <span>{{ tile.name }}</span>
          </span>
          <strong>{{ tile.value }}</strong>
          <small v-if="tile.detail" class="view-context__tile-age">{{ tile.detail }}</small>
        </div>
      </div>
      <p v-for="layer in problems" :key="layer.id" class="view-context__problem">{{ layer.name }} · {{ layer.problem }}</p>

      <p v-if="globeView" class="view-context__hint">{{ t('Click anything on the globe to see its card.') }}</p>
      <template v-else>
        <NearbyLists :lists="lists" :title="t('Nearby · {radius}', { radius: radiusText })" />
        <p v-if="contextNeedle && nothingNearby" class="view-context__empty">{{ t('Nothing nearby matches “{text}”.', { text: contextSearchText.trim() }) }}</p>

      </template>
      <!-- Suggested layers: open Data Layers with them picked out. -->
      <SuggestedLayers v-if="hasDataLayers" :layers="suggestions" @open="openSuggested" />
    </template>
  </section>
</template>
