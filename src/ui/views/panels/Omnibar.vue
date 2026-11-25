<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { getLocale, t, tn } from '../../../i18n/index.js';
import { EXCLUSIVE_SURFACE_CLASSES } from '../../../exclusiveSurfaces.js';
import { createOmnibar, drawAsked, escapeRegExp, readLine, VILLAGES } from '../../omnibarRows.js';
import { FEATURE_GUIDES, layerGuide, layerSettingsGuide, startGuide } from '../../omnibarGuide.js';
import { citiesInRegion, createPlaceSuggester, inExtent, mayBePrivate, minPlaceChars } from '../../../search/placeSuggestions.js';
import { greatCircleKm } from '../../../geoDistance.js';
import { PHOTON_SETTING } from '../../../search/photonSetting.js';
import { citiesAround, countryName, findPlace, nearestCity, placesNear } from '../../../data/wikidataCities.js';
import { CITY_POIS } from '../../../cityPois.js';
import { useDisplayStore } from '../../stores/display.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { useGlobeActionsStore } from '../../stores/globeActions.js';
import { useLocationStore } from '../../stores/location.js';
import { useOmnibarStore } from '../../stores/omnibar.js';
import { useVoiceStore } from '../../stores/voice.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import { vRootClass } from '../../rail/rootClass.js';

// One field for places, layers and questions. Places run through the location
// controls, layers through the shell's omnibar actions, and anything else can
// go to GEV's typed chat. The mic starts voice, as the dock's button does.
const { controls, runner } = storeToRefs(useOmnibarStore());

// A bundled city in the shape the place chips use, keyed by its Wikidata id
// (namesakes are common). Showing one credits the Wikidata packs (once; the
// shell makes it idempotent).
const asPlace = (city) => {
  controls.value?.creditPlaces?.();
  return { id: city.wikidata, name: city.name, latitude: city.latitude, longitude: city.longitude, state: null, country: countryName(city.country) };
};
/** A chip key for a place: its Wikidata id, else its name and spot. */
const placeKey = (place) => place.id || `${place.name}@${Number(place.latitude).toFixed(3)},${Number(place.longitude).toFixed(3)}`;
const globeActions = useGlobeActionsStore();
const locationStore = useLocationStore();
// The preset cities and the current city's landmarks, as LocationControls
// presents them: the omnibox offers them as the dock's location tray did.
const { view: locationView } = storeToRefs(locationStore);
// "here", "this spot": the selected item, else the view.
const HERE = /\b(here|there|this (spot|point|place|location|area)|around it|nearby)\b/i;
const PRESET_CITIES = Object.entries(CITY_POIS).map(([id, city]) => ({
  id,
  name: city.name,
  pois: city.pois,
}));
const voice = useVoiceStore();
const entityCard = useEntityCardStore();

const input = ref(null);
const results = ref(null);
const dismissed = ref(false);
const error = ref('');
const busy = ref(false);
let generation = 0;
let stopGuide;
// A search's error shows under the line it was for: one that fails after
// the line was edited says nothing under the new text.
const searchedFor = ref(null);
const searchError = computed(() =>
  locationView.value?.searchOrigin === 'omnibar' && searchedFor.value === query.value ? locationView.value.searchError : '',
);
const feedback = computed(() => error.value || searchError.value);
const voiceOn = computed(() => voice.view?.root?.assistantMode === 'voice');
// Voice taking over supersedes whatever the field was still running: a plan
// waiting on its flight changes nothing afterwards.
watch(voiceOn, (active) => {
  if (!active) return;
  generation++;
  busy.value = false;
});
const assistantOpen = computed(() => voice.view?.root?.chatOpen || voice.view?.voicePanel?.hidden === false);
watch(feedback, (message) => {
  if (message && results.value) results.value.scrollTop = 0;
}, { flush: 'post' });
function screenIsOwned() {
  return EXCLUSIVE_SURFACE_CLASSES.some((name) => document.body.classList.contains(name));
}
const query = ref('');
const focused = ref(false);
// The row Enter picks. Until the arrow keys choose one it is the default
// (see defaultRow), so it follows the list as suggestions arrive. A chosen
// row is kept by its key, so rows arriving above it do not move the choice;
// if it goes away, the default comes back. The pointer never chooses one.
const navigated = ref(false);
const chosenKey = ref(null);
const active = computed({
  get() {
    if (navigated.value && chosenKey.value !== null) {
      const index = items.value.findIndex((item) => item.key === chosenKey.value);
      if (index !== -1) return index;
    }
    return defaultRow.value;
  },
  set(index) {
    chosenKey.value = items.value[index]?.key ?? null;
    navigated.value = chosenKey.value !== null;
  },
});
// The arrow keys can also walk the first row: Up from the top suggestion
// (or Down past the last) moves into the strip, Left and Right step through
// its chips, Enter picks one, and Down goes back to the list.
const inStrip = ref(false);
const chipIndex = ref(0);
const stripChips = ref(null);
// The layers are read again when the field gains focus and after a choice
// (which may switch one), not on every keystroke.
const layerRevision = ref(0);


// Real places as you type, from the same keyless geocoder the place search
// uses (Photon); PHOTON_URL set empty turns it off here too.
const suggester = createPlaceSuggester(
  PHOTON_SETTING === undefined ? {} : { endpoint: PHOTON_SETTING || null },
);

// The one reader of typed lines (src/ui/omnibarRows.js), built afresh when
// the layers are read again: rows, the Enter default, what may go to the
// place service and count requests all come from it.
const reader = computed(() => {
  void layerRevision.value;
  return createOmnibar({ layers: controls.value?.layers() || [], isEntity });
});

/** Whether the text names something loaded on the map ("ISS"), to follow. */
function isEntity(text) {
  const wanted = String(text || '').toLowerCase();
  return Boolean(wanted) && entityCard.search(text, { limit: 3 }).some((found) => found.title.toLowerCase() === wanted);
}

const places = ref([]);
const placesFor = ref('');
let placesAbort = null;
let placesTimer = null;
watch(query, (value) => {
  const text = value.trim();
  clearTimeout(placesTimer);
  placesAbort?.abort();
  // Only text that may name a place goes to the place service, and only the
  // part that names it: never private text, a question, a sentence, a
  // command, a switch, coordinates or an aircraft code (see placeQuery).
  // Nothing is looked up for a field hidden under voice.
  const asked = suggester.enabled && !voiceOn.value ? reader.value.placeQuery(text) : null;
  if (!asked) {
    places.value = [];
    placesFor.value = '';
    return;
  }
  placesTimer = setTimeout(async () => {
    const controller = new AbortController();
    placesAbort = controller;
    try {
      const found = await suggester.suggest(asked, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      places.value = found.slice(0, 3);
      placesFor.value = text;
    } catch {
      if (!controller.signal.aborted) places.value = [];
    }
  }, 220);
});
onBeforeUnmount(() => {
  clearTimeout(placesTimer);
  placesAbort?.abort();
});

// ── Place strip ──────────────────────────────────────────────────────
// When the text names a place, a row of chips under the field offers
// somewhere in it: a preset city's landmarks, the cities of a state or
// country, and places you picked there before. The rows below keep the rest
// of the line ("tokyo traffic") for layers and GEV.
const RECENT_KEY = 'gev:omnibar:recent-places';
const REGION_TYPES = new Set(['state', 'country', 'province', 'region', 'state_district', 'county']);
const recentRevision = ref(0);

function readRecent() {
  void recentRevision.value;
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Keep a place you went to, newest first, for the strip, with where its
 * name came from (`photon`: OpenStreetMap data, `wikidata`: the bundled
 * packs), so its chip later shows that credit.
 */
function rememberPlace({ id, name, latitude, longitude, source }) {
  if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  try {
    const list = readRecent().filter((place) => placeKey(place) !== placeKey({ id, name, latitude, longitude }));
    list.unshift({ ...(id && { id }), name, latitude, longitude, ...(source && { source }) });
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20)));
    recentRevision.value++;
  } catch {
    // Without storage the strip simply has no recent places.
  }
}

/** A preset city named in the text, or begun as its only word ("tok"). */
function presetCityIn(text) {
  const low = text.toLowerCase();
  const single = /^\p{L}{3,}$/u.test(low);
  return (
    PRESET_CITIES.find((city) =>
      new RegExp(`(^|[^\\p{L}])${escapeRegExp(city.name.toLowerCase())}($|[^\\p{L}])`, 'u').test(low),
    ) ||
    (single ? PRESET_CITIES.find((city) => city.name.toLowerCase().startsWith(low)) : null)
  );
}

const inside = (extent, place) => Array.isArray(extent) && inExtent(extent, place);

const kmBetween = (a, b) =>
  greatCircleKm({ lat: a.latitude, lon: a.longitude }, { lat: b.latitude, lon: b.longitude });

/** The place the text is about: a preset city, or the best looked-up place. */
const stripPlace = computed(() => {
  const text = readLine(query.value);
  if (text.length < minPlaceChars(text) || text.startsWith('>')) return null;
  const preset = presetCityIn(text);
  if (preset) {
    const [first] = preset.pois;
    return { kind: 'preset', name: preset.name, city: preset, latitude: first.lat, longitude: first.lon };
  }
  const [best] = placesFor.value === query.value.trim() ? places.value : [];
  if (!best) return null;
  return {
    kind: REGION_TYPES.has(best.type) ? 'region' : 'place',
    type: best.type,
    name: best.name,
    latitude: best.latitude,
    longitude: best.longitude,
    extent: best.extent,
    countryCode: best.countryCode,
  };
});

// The cities of a state or country, looked up once it is the strip's place.
const regionCities = ref([]);
const regionCitiesFor = ref('');
watch(stripPlace, async (place) => {
  if (place?.kind !== 'region') return;
  const key = `${place.name}|${place.latitude}|${place.longitude}`;
  if (regionCitiesFor.value === key) return;
  regionCitiesFor.value = key;
  regionCities.value = [];
  const span = Array.isArray(place.extent)
    ? kmBetween(
        { latitude: place.extent[1], longitude: place.extent[0] },
        { latitude: place.extent[3], longitude: place.extent[2] },
      ) / 2
    : 300;
  try {
    // The most populous cities from the bundled pack that lie inside the
    // region's extent and in its country (by ISO code): Texas lists no
    // Mexican city, however close.
    const around = await citiesAround({
      latitude: place.latitude,
      longitude: place.longitude,
      radiusKm: Math.round(Math.min(2500, Math.max(50, span))),
      limit: 400,
    });
    if (regionCitiesFor.value !== key) return;
    regionCities.value = citiesInRegion(around, place).slice(0, 12).map(asPlace);
  } catch {
    // No cities, no chips for them.
  }
});

const strip = computed(() => {
  const asked = query.value.trim();
  if (asked && mayBePrivate(asked)) return null;
  if (asked && countQuery.value) {
    const counted = countQuery.value;
    return {
      title: tn(counted.count, '{what} in {place}: {count} item', '{what} in {place}: {count} items', { what: counted.what, place: counted.placeName }),
      chips: counted.items.map((item) => ({ key: `count:${item.key}`, kind: 'entity', icon: item.icon, identity: item.identity, name: item.title })),
    };
  }
  if (!asked && !selected.value) {
    const groups = entityCard.inView({ perLayer: 2 });
    const chips = groups
      .flatMap((group) => group.items.map((item) => ({ ...item, icon: group.icon })))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 6)
      .map((item) => ({ key: `inview:${item.key}`, kind: 'entity', icon: item.icon, identity: item.identity, name: item.title }));
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    return chips.length ? { title: tn(total, '{count} item in view', '{count} items in view'), chips } : null;
  }
  if (!asked && selected.value) {
    // The selection itself leads, highlighted; what is near it follows.
    const current = selected.value;
    const { same = [], other = [] } = selectedNearby.value || {};
    const chips = [
      { key: `sel:${current.key}`, kind: 'entity', icon: current.icon, identity: current.identity, name: current.title, pressed: true },
      ...[...same.slice(0, 5), ...other].map((item) => ({
        key: `sel-near:${item.key}`,
        kind: 'entity',
        icon: item.icon,
        identity: item.identity,
        name: item.title,
      })),
      ...selectedPlaces.value.map((place) => ({ key: `sel-place:${placeKey(place)}`, kind: 'place', icon: 'location_city', ...place })),
    ];
    return { title: t('Selected · near {name}', { name: current.title }), chips };
  }
  if (villagesAsked.value && villages.value?.asked === villagesAsked.value && villages.value.places.length) {
    return {
      title: t('Near {name}', { name: villages.value.name }),
      chips: villages.value.places.map((place) => ({ key: `village:${placeKey(place)}`, kind: 'place', icon: 'location_city', ...place })),
    };
  }
  if (drawAsked(asked)) {
    const on = drawView.value?.active;
    const shape = drawView.value?.shape;
    return {
      title: t('Draw'),
      chips: [
        { key: 'draw:area', kind: 'draw', shape: 'area', icon: 'pentagon', name: t('Area'), pressed: on && shape === 'area' },
        { key: 'draw:line', kind: 'draw', shape: 'line', icon: 'timeline', name: t('Line'), pressed: on && shape === 'line' },
        { key: 'draw:pin', kind: 'draw', shape: 'pin', icon: 'location_on', name: t('Pin'), pressed: on && shape === 'pin' },
        ...(on ? [{ key: 'draw:stop', kind: 'draw-stop', icon: 'close', name: t('Stop drawing') }] : []),
      ],
    };
  }
  const place = stripPlace.value;
  if (!place) return null;
  const near = (item) =>
    place.extent ? inside(place.extent, item) : kmBetween(place, item) < 40;
  const recent = readRecent()
    .filter(near)
    .slice(0, 4)
    // A place kept before sources were recorded: a Wikidata id means the
    // bundled packs, anything else may be OpenStreetMap data from Photon.
    .map((item) => ({ key: `recent:${placeKey(item)}`, kind: 'place', icon: 'history', ...item, source: item.source || (item.id ? 'wikidata' : 'photon') }));
  let chips = [];
  let title = '';
  if (place.kind === 'preset') {
    title = t('{place} · landmarks', { place: place.name });
    chips = place.city.pois.map((poi, index) => ({
      key: `landmark:${place.city.id}:${index}`,
      kind: 'landmark',
      icon: 'location_on',
      cityId: place.city.id,
      index,
      name: poi.name,
      latitude: poi.lat,
      longitude: poi.lon,
    }));
  } else if (place.kind === 'region') {
    title = t('In {place}', { place: place.name });
    const presets = PRESET_CITIES.filter((city) => inside(place.extent, { latitude: city.pois[0].lat, longitude: city.pois[0].lon }))
      .map((city) => ({ key: `city:${city.id}`, kind: 'city', icon: 'star', cityId: city.id, name: city.name, latitude: city.pois[0].lat, longitude: city.pois[0].lon }));
    chips = [
      ...presets,
      ...regionCities.value
        .filter((city) => !presets.some((preset) => preset.name === city.name))
        .slice(0, 10)
        .map((city) => ({ key: `around:${placeKey(city)}`, kind: 'place', icon: 'location_city', ...city })),
    ];
  } else {
    title = t('Near {place}', { place: place.name });
  }
  // One chip per place: a recent pick and the same city from the pack are
  // one place, two namesakes are two.
  const seen = new Set();
  const all = [...recent, ...chips].filter((chip) => {
    const same = chip.kind === 'place' || chip.kind === 'city' ? `${chip.name}@${Math.round(chip.latitude * 20)},${Math.round(chip.longitude * 20)}` : chip.key;
    if (seen.has(same)) return false;
    seen.add(same);
    return true;
  });
  return all.length ? { title, chips: all } : null;
});

/**
 * Fly to a place by its coordinates, as a looked-up place row does. Only the
 * coordinates go: with its name, "Paris, Texas" would fly to the city
 * preset Paris.
 */
async function goTo({ latitude, longitude }) {
  if (runner.value) return settled(await runner.value('fly_to_location', { latitude, longitude }));
  const location = locationStore.controls;
  if (!location || location.destroyed) throw new Error();
  searchedFor.value = query.value;
  await location.search(`${latitude}, ${longitude}`);
  return true;
}

function chooseChip(chip, { viaKey = false } = {}) {
  if (screenIsOwned()) return;
  generation++;
  busy.value = false;
  // A chip is a new request: the last one's error goes.
  error.value = '';
  locationStore.controls?.editSearch();
  if (chip.kind === 'entity') {
    entityCard.select(chip.identity, { fly: true });
    reset({ blur: !keepsFocus(viaKey) });
    return;
  }
  if (chip.kind === 'draw') {
    // Turn drawing on with that shape; the hint in Utilities explains the rest.
    if (!drawView.value?.active) display.act('toggleDraw');
    display.act('setDrawShape', chip.shape);
    reset();
    return;
  }
  if (chip.kind === 'draw-stop') {
    if (drawView.value?.active) display.act('toggleDraw');
    reset();
    return;
  }
  // The city whose landmarks are open would only fold them: it is flown to.
  if (chip.kind === 'city' && locationView.value?.poiCity === chip.cityId && runner.value)
    void runner.value('fly_to_location', { locationId: chip.cityId });
  else if (chip.kind === 'city') locationStore.controls?.chooseCity(chip.cityId);
  else if (chip.kind === 'landmark') {
    if (locationView.value?.poiCity === chip.cityId) locationStore.controls?.choosePoi(chip.index);
    else {
      locationStore.controls?.chooseCity(chip.cityId);
      if (chip.index > 0) setTimeout(() => locationStore.controls?.choosePoi(chip.index), 0);
    }
  }
  // Preset cities and landmarks are the app's own data, not Photon's.
  rememberPlace(chip.kind === 'city' || chip.kind === 'landmark' ? { ...chip, source: 'preset' } : chip);
  reset({ blur: !keepsFocus(viaKey) });
  if (chip.kind === 'city' || chip.kind === 'landmark') return;
  // A refused flight shows its error under the field, as a row's does.
  const current = generation;
  goTo(chip).catch((failure) => {
    if (current === generation)
      error.value = failure?.reason
        ? t('Unable to complete this action: {reason}', { reason: failure.reason })
        : t('Unable to complete this action. Please try again.');
  });
}

/** A vertical wheel scrolls the strip sideways. */
function onStripWheel(event) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.currentTarget.scrollLeft += event.deltaY;
  event.preventDefault();
}

// ── Tools by name ────────────────────────────────────────────────────
// "draw" (or the start of it) offers the draw shapes in the strip and a row
// that opens Draw's options in Utilities.
const display = useDisplayStore();
const { draw: drawView } = storeToRefs(display);

// What is selected in Context, which an empty field offers actions for.
const { card: selected } = storeToRefs(entityCard);
const selectedNearby = computed(() => !query.value.trim() && focused.value ? entityCard.nearbySelected() : null);

// ── Count and filter ─────────────────────────────────────────────────
// "flights over Texas", "quakes above M5 in Japan": with that layer on, how
// many of its items are in the place (and pass the filter), the nearest of
// them in the strip, and a row that goes there.
// A magnitude floor ("above M5") is read for earthquakes only.
const countQuery = computed(() => {
  const text = query.value.trim();
  const asked = reader.value.countRequest(text);
  if (!asked) return null;
  const { layer, minMagnitude: minMag } = asked;
  // A count is about an area: a country, state or city beats a building
  // that merely has the name in it.
  const found_ = placesFor.value === text ? places.value : [];
  const AREA_TYPES = ['country', 'state', 'province', 'region', 'county', 'city', 'town'];
  const best = found_.find((place) => AREA_TYPES.includes(place.type)) || found_[0];
  if (!best) return null;
  const rect = Array.isArray(best.extent)
    ? { west: best.extent[0], north: best.extent[1], east: best.extent[2], south: best.extent[3] }
    : null;
  const found = entityCard.matchesIn(layer.id, {
    center: { lat: best.latitude, lon: best.longitude },
    rect,
    radiusKm: 60,
    test: minMag === null ? undefined : (record) => Number(record.magnitude ?? record.mag) >= minMag,
    limit: 8,
  });
  if (!found) return null;
  const what = minMag === null ? layer.shown : t('{layer} M{mag}+', { layer: layer.shown, mag: minMag });
  return { ...found, what, placeName: best.name, place: { ...best, source: 'photon' }, layer };
});

// ── Empty field ──────────────────────────────────────────────────────
// With nothing typed or selected: what the view shows. "What's here?" asks
// GEV about it, the strip lists the nearest things in view, and the most
// used layers that are off can be turned on here.
const viewPlace = ref(null);
let viewPlaceFor = '';
watch(
  () => (focused.value && !query.value.trim() ? entityCard.view : null),
  async (view) => {
    if (!view) return;
    const key = `${view.center.lat.toFixed(2)},${view.center.lon.toFixed(2)}`;
    if (key === viewPlaceFor) return;
    viewPlaceFor = key;
    try {
      const city = await nearestCity(view.center.lat, view.center.lon);
      if (viewPlaceFor === key) viewPlace.value = city ? asPlace(city) : null;
    } catch {
      if (viewPlaceFor === key) viewPlace.value = null;
    }
  },
);

// The rows for what is typed, and the one Enter runs before any is chosen
// with the keyboard (-1 for none): one call into the reader.
const built = computed(() => {
  const text = query.value.trim();
  const card = selected.value;
  return reader.value.rows(text, {
    places: placesFor.value === text ? places.value : [],
    entities: (needle, options) => entityCard.search(needle, options),
    selection: card
      ? { title: card.title, layerName: card.layerName, canFollow: entityCard.canFollow(), canCockpit: entityCard.canCockpit() }
      : null,
    viewPlace: viewPlace.value,
    counted: text ? countQuery.value : null,
  });
});
const items = computed(() => built.value.rows);

// Named places under the selected item, for its strip. The spot is rounded
// (about 10 km) so a moving aircraft asks again only once it has moved on.
const selectedPlaces = ref([]);
let selectedPlacesFor = '';
watch(
  () => (focused.value && !query.value.trim() ? selected.value : null),
  async (current) => {
    if (!current || !Number.isFinite(current.lat) || !Number.isFinite(current.lon)) {
      if (!current) return;
      selectedPlacesFor = '';
      selectedPlaces.value = [];
      return;
    }
    const key = `${current.key}|${current.lat.toFixed(1)},${current.lon.toFixed(1)}`;
    if (selectedPlacesFor === key) return;
    if (!selectedPlacesFor.startsWith(`${current.key}|`)) selectedPlaces.value = [];
    selectedPlacesFor = key;
    try {
      const found = await placesNear({ latitude: current.lat, longitude: current.lon, radiusKm: 12, limit: 4 });
      if (selectedPlacesFor === key) selectedPlaces.value = found.map(asPlace);
    } catch {
      // No places nearby, no chips for them.
    }
  },
);

// "villages near Manor", "towns around here": the named places around a
// city from the bundled pack (or a smaller place near the view), the selected
// item or the view.
const villagesAsked = computed(() => VILLAGES.exec(readLine(query.value))?.[1]?.trim() || '');
const villages = ref(null);
async function villagesOrigin(where) {
  if (HERE.test(where) || /^(me|it|this|that)$/i.test(where)) {
    const current = selected.value;
    if (Number.isFinite(current?.lat) && Number.isFinite(current?.lon)) return { name: current.title, latitude: current.lat, longitude: current.lon };
    const center = entityCard.view?.center;
    return center ? { name: viewPlace.value?.name || t('This view'), latitude: center.lat, longitude: center.lon } : null;
  }
  const center = entityCard.view?.center;
  return findPlace(where, { includeSmallPlaces: true, near: center ? { latitude: center.lat, longitude: center.lon } : null });
}
// Looked up once typing pauses, not on every keystroke.
let villagesTimer = null;
onBeforeUnmount(() => clearTimeout(villagesTimer));
watch(
  () => (focused.value ? villagesAsked.value : ''),
  (asked) => {
    clearTimeout(villagesTimer);
    // "around here" and "near it" move with the view and the selection, so
    // they are looked up again; a named place is the same place.
    const relative = HERE.test(asked) || /^(me|it|this|that)$/i.test(asked);
    if (!asked || (villages.value?.asked === asked && !relative)) return;
    villagesTimer = setTimeout(() => void findVillages(asked), 250);
  },
);
async function findVillages(asked) {
    if (villagesAsked.value !== asked) return;
    try {
      const origin = await villagesOrigin(asked);
      if (!origin || villagesAsked.value !== asked) return;
      const found = await placesNear({ latitude: origin.latitude, longitude: origin.longitude, radiusKm: 20, limit: 11 });
      if (villagesAsked.value !== asked) return;
      villages.value = {
        asked,
        name: origin.name,
        places: found.filter((place) => (origin.wikidata ? place.wikidata !== origin.wikidata : place.name !== origin.name)).slice(0, 10).map(asPlace),
      };
    } catch {
      // No places found, no strip for them.
    }
}

/** Open Utilities and bring Draw's options into view. */
function openDrawOptions() {
  if (!togglePanel({ action: 'open', side: 'left', item: 'utilities-panel' })) throw new ActionFailed();
  setTimeout(() => {
    globalThis.document
      ?.getElementById('draw-group')
      ?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, 250);
}

/** The row Enter picks before any is chosen with the keyboard, or -1. */
const defaultRow = computed(() => built.value.defaultIndex);

// While voice is on the list gives way to the waveform: it is not open, and
// Enter runs nothing.
const open = computed(() => focused.value && !dismissed.value && !voiceOn.value && (items.value.length > 0 || Boolean(strip.value)));

// Photon's suggestions (place rows, the strip built on them and recent
// chips that came from them) are OpenStreetMap data: its credit shows while
// they do. Recent chips from the bundled packs credit Wikidata.
const photonShown = computed(
  () =>
    open.value &&
    ((placesFor.value === query.value.trim() && places.value.length > 0) ||
      Boolean(strip.value?.chips.some((chip) => chip.source === 'photon'))),
);
watch(
  () => open.value && Boolean(strip.value?.chips.some((chip) => chip.source === 'wikidata')),
  (shown) => {
    if (shown) controls.value?.creditPlaces?.();
  },
);
watch(photonShown, (shown) => controls.value?.creditSuggestions?.(shown));
onBeforeUnmount(() => {
  if (photonShown.value) controls.value?.creditSuggestions?.(false);
});
const noCommand = computed(() => focused.value && !dismissed.value && query.value.trim().startsWith('>') && !items.value.length);
// Text withheld as private says so, rather than showing nothing.
const privateNote = computed(() => focused.value && !dismissed.value && mayBePrivate(query.value.trim()));
// An error stays in view while voice is on, even with the voice panel open.
const showFeedback = computed(() => feedback.value && (focused.value || !assistantOpen.value || voiceOn.value));
const showResults = computed(() => open.value || showFeedback.value || noCommand.value || privateNote.value);

function onInput(event) {
  // Text an input method is still composing is read when it is committed
  // (compositionend), not sent to the place service half-written.
  if (event.isComposing) return;
  query.value = event.target.value;
  generation++;
  busy.value = false;
  dismissed.value = false;
  locationStore.controls?.editSearch();
  error.value = '';
  navigated.value = false;
  chosenKey.value = null;
  inStrip.value = false;
  chipIndex.value = 0;
}

/**
 * Empty and close the field. Whatever was still running for it (a plan
 * waiting on a flight) is superseded, so none of its later steps run.
 */
function reset({ blur = true } = {}) {
  generation++;
  busy.value = false;
  dismissed.value = true;
  query.value = '';
  navigated.value = false;
  chosenKey.value = null;
  inStrip.value = false;
  if (blur) input.value?.blur();
}

function askGev(text) {
  if (!voice.controls) throw new Error();
  voice.controls.emit('chat-restore');
  voice.controls?.emit('chat-prompt', text);
  voice.controls?.emit('chat-submit');
}

/**
 * Open or close side panels through their rail buttons, as a click would.
 * Returns false when a panel to open has no button (the layout has no such
 * rail item), so the action fails rather than passing for done; closing a
 * panel that is not open is already done.
 */
function togglePanel({ action, side, item }) {
  const doc = globalThis.document;
  const sides = side === 'all' ? ['left', 'right'] : [side];
  for (const where of sides) {
    const rail = `.ui-rail--${where} .ui-rail__item`;
    if (action === 'open') {
      const button = doc.querySelector(`${rail}[data-rail-item="${item}"]`);
      if (!button) return false;
      if (button.getAttribute('aria-pressed') !== 'true') button.click();
    } else {
      const open = doc.querySelector(`${rail}[aria-pressed="true"]`);
      if (open && (!item || open.dataset.railItem === item)) open.click();
    }
  }
  return true;
}

/**
 * An action's result: a refusal or failure throws, so the plan stops and the
 * field shows the error as a single action does; a cancellation (another
 * flight took over) stops the plan quietly. Returns whether to go on.
 */
function settled(result) {
  if (result === false || (result?.ok === false && !result.cancelled)) throw new ActionFailed(result?.say);
  return !result?.cancelled;
}

/**
 * A refused action, with the runner's own sentence for people when it gave a
 * short single-line one (its `say`); internal `error` text is never shown.
 * The runner speaks English, so its sentence is shown only in English; other
 * languages get the translated message alone.
 */
class ActionFailed extends Error {
  constructor(say) {
    const english = /^en\b/i.test(getLocale() || 'en');
    const reason = english && typeof say === 'string' && say.length <= 160 && !/[\r\n<>]/.test(say) ? say.trim() : '';
    super(reason);
    this.reason = reason;
  }
}

/** Run a plan's steps in order; the camera travels before layers load. */
async function runPlan(steps, current) {
  const run = runner.value;
  const needsRunner = steps.some((step) =>
    ['style', 'stack', 'hud', 'radio', 'cockpit', 'nearest', 'follow'].includes(step.kind) ||
    (step.kind === 'camera' && step.name),
  );
  if (needsRunner && !run) throw new Error();
  const place = steps.find((step) => step.kind === 'place')?.place;
  // Radio on and the nearest aircraft go to the place themselves; turning
  // the radio off goes there first like any other step.
  const placeOwned = steps.some(
    (step) => (step.kind === 'radio' && step.action !== 'disable') || step.kind === 'nearest',
  );
  for (const step of steps) {
    if (current !== generation) return;
    let result;
    switch (step.kind) {
      case 'place': {
        if (placeOwned) break;
        // Wait for arrival, so a camera move later in the plan does not cut
        // the flight short.
        if (run) result = await run('fly_to_location', { query: step.place, waitForArrival: true });
        else {
          // The location search shows its own error under the field.
          // Only a search that found the place and is still current lets
          // the plan go on; a cancelled, missing or failed one stops it.
          const location = locationStore.controls;
          if (!location || location.destroyed) throw new Error();
          searchedFor.value = query.value;
          const flight = await location.search(step.place);
          if (flight !== true) return;
        }
        break;
      }
      case 'layer': {
        // The layer as it is now, not as it was when the line was read.
        if (!controls.value) throw new Error();
        const live = controls.value.layers().find((layer) => layer.id === step.layer.id);
        if (!live) throw new Error();
        if (Boolean(live.enabled) !== step.enabled)
          result = await controls.value.setLayer(step.layer.id, step.enabled);
        break;
      }
      case 'style':
        result = await run('set_visual_style', { style: step.style });
        break;
      case 'stack':
        result = await run('set_map_stack', { stack: step.stack });
        break;
      case 'camera':
        // An action nobody answers fails rather than passing for done.
        if (step.act && !globeActions.answers(step.act)) throw new Error();
        result = step.act ? await globeActions.act(step.act) : await run(step.name, step.args);
        break;
      case 'hud':
        result = await run('set_hud', { visible: step.visible });
        break;
      case 'panel':
        if (!togglePanel(step)) throw new ActionFailed();
        break;
      case 'radio':
        result = await run(
          'control_radio',
          step.action === 'disable'
            ? { action: 'disable' }
            : { action: 'enable', ...(place && { locationQuery: place }) },
        );
        break;
      case 'cockpit':
        result = await run('control_cockpit', { action: 'enter' });
        break;
      case 'nearest':
        result = await run('select_nearest_aircraft', {
          layerId: 'flights',
          ...(place && { locationQuery: place }),
        });
        break;
      case 'follow':
        result = await run('track_entity', { query: step.query });
        break;
    }
    // A superseded plan neither reports nor goes on.
    if (current !== generation) return;
    if (!settled(result)) return;
  }
}

/**
 * Whether the field keeps focus after a row or chip runs: only when it was
 * run with Enter (a tap or click lets go, so the phone's keyboard does not
 * stay up over the map), and never while drawing, whose Enter, Backspace and
 * Esc the field would otherwise take.
 */
const keepsFocus = (viaKey) =>
  viaKey &&
  !drawView.value?.active &&
  // A phone's Go key is an Enter too: there the field always lets go.
  !globalThis.document?.body.classList.contains('mobile-shell');

async function choose(item, { viaKey = false } = {}) {
  if (!item || item.kind === 'none' || screenIsOwned()) return;
  const current = ++generation;
  busy.value = true;
  error.value = '';
  try {
    if (item.kind === 'view-ask') entityCard.askAboutView(entityCard.inView());
    else if (item.kind === 'sel-fly') entityCard.flyTo();
    else if (item.kind === 'sel-follow') entityCard.follow();
    else if (item.kind === 'sel-cockpit') entityCard.cockpit();
    else if (item.kind === 'sel-ask') entityCard.ask();
    else if (item.kind === 'sel-close') entityCard.clear();
    else if (item.kind === 'count-show' || item.kind === 'place') {
      const { coords, place } = item;
      if (coords && runner.value) {
        // The coordinates alone: a name would win over them (see goTo).
        if (!settled(await runner.value('fly_to_location', { ...coords }))) return;
      } else {
        const location = locationStore.controls;
        if (!location || location.destroyed) throw new Error();
        searchedFor.value = query.value;
        const result = await location.search(coords ? `${coords.latitude}, ${coords.longitude}` : place);
        // Only a search that found the place counts: a refused or cancelled
        // one (undefined) keeps the line, as the plan path does.
        if (result !== true || locationView.value?.searchOrigin !== 'omnibar' || searchError.value) return;
      }
      // A typed spot is the user's own; a looked-up place keeps its source.
      if (coords && item.kind === 'place') rememberPlace({ name: place, ...coords, source: item.source || 'typed' });
    } else if (item.kind === 'layer') {
      if (!controls.value) throw new Error();
      // A layer already as asked ("show flights" with Flights on) is left alone.
      const live = controls.value.layers().find((layer) => layer.id === item.id);
      // A layer that is no longer there cannot be switched.
      if (!live) throw new Error();
      if (Boolean(live.enabled) !== item.enabled && (await controls.value.setLayer(item.id, item.enabled)) === false) throw new Error();
    } else if (item.kind === 'entity') entityCard.select(item.identity, { fly: true });
    else if (item.kind === 'plan') await runPlan(item.steps, current);
    else if (item.kind === 'mic') {
      // No voice connected: the row fails rather than passing for done.
      if (!voice.controls) throw new Error();
      onMic();
    }
    else if (item.kind === 'open-draw') openDrawOptions();
    else if (item.kind === 'guide') {
      const steps = item.guide.settings
        ? layerSettingsGuide(item.guide.settings)
        : item.guide.layer
          ? layerGuide(item.guide.layer, (id) =>
              Boolean(controls.value?.layers().find((layer) => layer.id === id)?.enabled),
              { readAltitude: () => entityCard.view?.heightM },
            )
          : FEATURE_GUIDES[item.guide.feature]();
      // Closing the field supersedes this choice too; the walk starts unless
      // something newer happens before the next tick.
      reset();
      const mine = generation;
      await nextTick();
      if (mine === generation) {
        stopGuide?.();
        stopGuide = startGuide(steps, { title: t('Guide') });
      }
      return;
    } else if (item.kind === 'ask') askGev(item.query);
    // Run with Enter, the field keeps focus, ready for the next line. Rows
    // that hand the keyboard to something else let it go: chat, voice, the
    // cockpit, following and drawing.
    const handsOff =
      ['ask', 'sel-ask', 'view-ask', 'mic', 'open-draw', 'sel-cockpit', 'sel-follow'].includes(item.kind) ||
      (item.kind === 'plan' && item.steps.some((step) => step.kind === 'cockpit' || step.kind === 'follow'));
    if (current === generation) reset({ blur: handsOff || !keepsFocus(viaKey) });
  } catch (failure) {
    if (current === generation)
      error.value = failure?.reason
        ? t('Unable to complete this action: {reason}', { reason: failure.reason })
        : t('Unable to complete this action. Please try again.');
  } finally {
    if (current === generation) busy.value = false;
    layerRevision.value++;
  }
}

function enterStrip() {
  inStrip.value = true;
  chipIndex.value = Math.min(chipIndex.value, strip.value.chips.length - 1);
  showChip();
}
function showChip() {
  nextTick(() =>
    stripChips.value?.children[chipIndex.value]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }),
  );
}

function onKeydown(event) {
  if (event.isComposing || event.keyCode === 229 || screenIsOwned()) return;
  const chips = strip.value?.chips || [];
  if (inStrip.value && !chips.length) inStrip.value = false;
  if (inStrip.value && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    const rtl = getComputedStyle(input.value).direction === 'rtl';
    const step = (event.key === 'ArrowRight') !== rtl ? 1 : -1;
    chipIndex.value = (chipIndex.value + step + chips.length) % chips.length;
    showChip();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!items.value.length && !chips.length) return;
    event.preventDefault();
    dismissed.value = false;
    const down = event.key === 'ArrowDown';
    if (inStrip.value) {
      inStrip.value = false;
      active.value = down ? 0 : items.value.length - 1;
    } else if (chips.length && (!items.value.length || (!down && active.value === 0) || (down && active.value === items.value.length - 1))) {
      enterStrip();
    } else if (active.value < 0) {
      // Nothing picked yet (an empty field): start at either end.
      active.value = down ? 0 : items.value.length - 1;
    } else {
      active.value = (active.value + (down ? 1 : -1) + items.value.length) % items.value.length;
    }
    if (!inStrip.value) nextTick(() => document.getElementById(`gev-omnibar-item-${active.value}`)?.scrollIntoView?.({ block: 'nearest' }));
  } else if (event.key === 'Enter') {
    if (!open.value) return;
    event.preventDefault();
    // A held or repeated Enter does not start the same line again over its
    // flight; an edited line (which clears busy) runs.
    if (event.repeat || busy.value) return;
    if (inStrip.value && chips[chipIndex.value]) chooseChip(chips[chipIndex.value], { viaKey: true });
    else choose(items.value[active.value], { viaKey: true });
  } else if (event.key === 'Escape' && !showResults.value && !query.value.trim()) {
    // An empty, closed field lets go, so the app's own keys work again.
    input.value?.blur();
  } else if (event.key === 'Escape' && showResults.value) {
    // Closes the field and supersedes anything still running from it: a
    // plan waiting on its flight changes no layer afterwards.
    event.preventDefault();
    event.stopPropagation();
    locationStore.controls?.editSearch();
    error.value = '';
    reset({ blur: false });
  }
}

// `/` from anywhere outside a text input, or ⌘K on a Mac (Ctrl+K elsewhere),
// focuses the field. Ctrl+K on a Mac is left to the text field it is in.
const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');
function onGlobalKeydown(event) {
  // With voice on the field is hidden: the shortcut does not focus it.
  if (event.defaultPrevented || event.isComposing || voiceOn.value || screenIsOwned() || !input.value?.getClientRects().length) return;
  // An open modal dialog, or focus inside any dialog (the guide), keeps its
  // keys: the shortcut does not pull focus out of it.
  const doc = globalThis.document;
  if (doc.querySelector('[aria-modal="true"]:not([hidden]), dialog[open]') || doc.activeElement?.closest?.('[role="dialog"], dialog')) return;
  const typing = event.target?.closest?.('input, textarea, select, [contenteditable]');
  const commandK =
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === 'k';
  if (commandK || (event.key === '/' && !typing && !event.altKey && !event.ctrlKey && !event.metaKey)) {
    event.preventDefault();
    input.value?.focus();
  }
}

onMounted(() => document.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => {
  generation++;
  stopGuide?.();
  document.removeEventListener('keydown', onGlobalKeydown);
});

/** The mic button; pressing it supersedes a plan still running. */
function onMic(supersede = false) {
  if (screenIsOwned()) return;
  if (supersede) {
    generation++;
    busy.value = false;
  }
  voice.controls?.emit('button');
}

const shortcut = computed(() => (isMac ? '⌘K' : 'Ctrl K'));

// The dock's stylesheet selects on the field being on the page, on its
// results and on focus inside it through classes on the page root
// (src/ui/rail/rootClass.js). Removing a focused row sends no focusout, so
// every render checks the focus again.
const root = ref(null);
const focusWithin = ref(false);
function followFocus(event) {
  const el = root.value;
  if (!el) return;
  if (event?.type === 'focusin') focusWithin.value = true;
  else if (event?.type === 'focusout') focusWithin.value = el.contains(event.relatedTarget);
  else focusWithin.value = el.matches(':focus-within');
}
onUpdated(() => followFocus());


// Chips come and go as the text changes; the arrow keys stay on one that is
// there, and leave the strip when it empties.
watch(
  () => strip.value?.chips.length || 0,
  (count) => {
    if (!count) {
      inStrip.value = false;
      chipIndex.value = 0;
    } else if (chipIndex.value >= count) chipIndex.value = count - 1;
  },
);
</script>

<template>
  <section id="gev-omnibar" ref="root" :class="{ 'has-results': showResults }" v-root-class="{ 'has-omnibar': true, 'omnibar-has-results': showResults, 'omnibar-focus-within': focusWithin }" :aria-label="t('Search')" @focusin="followFocus" @focusout="followFocus">
    <div class="omnibar-field">
      <span class="omnibar-edge" aria-hidden="true"></span>
      <UiIcon class="omnibar-search-icon" name="search" :size="null" />
      <input
        ref="input"
        id="gev-omnibar-input"
        type="text"
        maxlength="300"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        aria-autocomplete="list"
        :aria-controls="open ? 'gev-omnibar-list' : undefined"
        :aria-keyshortcuts="isMac ? '/ Meta+K' : '/ Control+K'"
        :aria-expanded="String(open)"
        :aria-activedescendant="open ? (inStrip ? `gev-omnibar-chip-${chipIndex}` : items[active] ? `gev-omnibar-item-${active}` : undefined) : undefined"
        :aria-busy="String(busy)"
        :aria-invalid="showFeedback ? 'true' : undefined"
        :aria-describedby="showFeedback ? 'omnibar-error' : undefined"
        :aria-label="t('Search places, layers and things on the map, or ask GEV')"
        :placeholder="t('Search places, layers, flights… or ask GEV  ·  > for commands')"
        :value="query"
        @input="onInput"
        @compositionend="onInput"
        @keydown="onKeydown"
        @focus="focused = true; dismissed = false; navigated = false; inStrip = false; layerRevision++"
        @blur="focused = false"
      />
      <kbd class="omnibar-kbd" aria-hidden="true">{{ shortcut }}</kbd>
      <UiButton class="omnibar-mic" :pressed="voiceOn" pressed-class="active" :disabled="!voice.controls" :label="t('Talk to GEV')" @click="onMic(true)">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></svg>
      </UiButton>
    </div>
    <div v-show="showResults" ref="results" class="omnibar-results" :class="{ 'has-feedback': showFeedback }">
      <p id="omnibar-error" v-show="showFeedback" role="alert">{{ feedback }}</p>
    <ul v-if="open" id="gev-omnibar-list" class="omnibar-list" role="listbox" :aria-label="t('Suggestions')">
      <li v-if="strip" class="omnibar-strip" role="group" :aria-label="strip.title">
        <span class="omnibar-strip__title" aria-hidden="true">{{ strip.title }}</span>
        <div ref="stripChips" class="omnibar-strip__chips" role="presentation" @wheel="onStripWheel">
          <UiButton
            v-for="(chip, index) in strip.chips"
            :id="`gev-omnibar-chip-${index}`"
            :key="chip.key"
            tabindex="-1"
            class="omnibar-strip__chip"
            :class="{ active: chip.pressed, focused: inStrip && index === chipIndex }"
            role="option"
            :aria-selected="String(inStrip && index === chipIndex)"
            :aria-current="chip.pressed ? 'true' : undefined"
            @mousedown.prevent
            @click="chooseChip(chip)"
          >
            <UiIcon :name="chip.icon" :size="null" />{{ chip.name }}
          </UiButton>
        </div>
      </li>
      <li
        v-for="(item, index) in items"
        :id="`gev-omnibar-item-${index}`"
        :key="item.key"
        role="option"
        class="omnibar-item"
        :class="[`omnibar-item--${item.kind}`, { active: !inStrip && index === active }]"
        :aria-selected="String(!inStrip && index === active)"
        @mousedown.prevent
        @click="choose(item)"
        @mousemove="inStrip = false"
      >
        <UiIcon v-if="item.icon" class="omnibar-item-icon" :name="item.icon" :size="null" />
        <svg v-else class="omnibar-item-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>
        <span class="omnibar-item-label">{{ item.label }}</span>
        <small>{{ item.hint }}</small>
      </li>
    </ul>
      <p v-show="noCommand" role="status">{{ t('No matching command') }}</p>
      <p v-show="privateNote" role="status">{{ t('Looks private, so nothing is searched or sent') }}</p>
    </div>
  </section>
</template>

<style scoped>
#gev-omnibar {
  --omnibar-top: 78px;
  --omnibar-credit-bottom: calc(2vh + 5rem + var(--world-timeline-lift, 0px));
  position: fixed;
  top: var(--omnibar-top);
  left: 50%;
  transform: translateX(-50%);
  z-index: 150;
  width: clamp(20rem, calc(100vw - 56rem), 34rem);
  color: var(--text-primary, #e6f5ff);
  font-family: var(--font-mono);
  font-size: 13px;
}
.omnibar-field {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  box-sizing: border-box;
  height: var(--omnibar-field-height, 2.5rem);
  padding-inline: 0.75rem 0.3rem;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(24px) saturate(1.4);
}
.omnibar-field:focus-within {
  border-color: rgba(54, 220, 255, 0.6);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4), 0 0 0 3px rgba(54, 220, 255, 0.16);
}
.has-results .omnibar-field { border-end-start-radius: 0; border-end-end-radius: 0; }
.omnibar-search-icon {
  flex: none;
  width: 1.1rem;
  overflow: hidden;
  color: rgba(199, 225, 231, 0.65);
  font-size: 1.1rem;
  pointer-events: none;
}
#gev-omnibar-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  color: inherit;
  font: 0.82rem var(--font-sans, sans-serif);
  background: none;
  border: 0;
}
#gev-omnibar-input::placeholder { color: rgba(199, 225, 231, 0.65); }
#gev-omnibar-input:focus-visible { outline: none !important; }
.omnibar-kbd {
  flex: none;
  padding: 0.12rem 0.38rem;
  color: rgba(199, 225, 231, 0.72);
  font: 0.58rem var(--font-mono);
  border: 1px solid rgba(199, 225, 231, 0.2);
  border-radius: 4px;
}
.omnibar-field:focus-within .omnibar-kbd { display: none; }
button { color: inherit; background: transparent; border: 0; cursor: pointer; padding: 6px; }
button:disabled { opacity: .4; cursor: default; }
button:focus-visible { outline: 2px solid #7bd3ef; outline-offset: -2px; }
.omnibar-mic {
  display: grid;
  flex: none;
  place-items: center;
  width: var(--omnibar-mic-size, 2rem);
  height: var(--omnibar-mic-size, 2rem);
  padding: 0;
  color: #30c2e0;
  background: rgba(29, 69, 81, 0.25);
  border: 1px solid rgba(48, 194, 224, 0.4);
  border-radius: 8px;
}
.omnibar-mic.active,
.omnibar-mic:not(:disabled):is(:hover, :focus-visible) {
  color: #36dcff;
  background: rgba(25, 151, 178, 0.2);
  border-color: #36dcff;
}
.omnibar-edge {
  display: none;
  position: absolute;
  inset: -1px;
  padding: 1.5px;
  border-radius: inherit;
  pointer-events: none;
  background: conic-gradient(from var(--gev-edge-angle), transparent, #36dcffb3 25%, #b6f5ff 29%, transparent 41%, transparent 61%, #36dcff70 75%, transparent 86%);
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
}
@media (prefers-reduced-motion: no-preference) and (pointer: fine) {
  .omnibar-field:focus-within .omnibar-edge { display: block; animation: gev-border-orbit 4s linear infinite; }
}
.omnibar-results {
  /* Suggestions and feedback share the space below the field and above credits. */
  max-height: min(
    360px,
    45dvh,
    max(0px, calc(
      100dvh - var(--omnibar-top) - var(--omnibar-field-room, 50px) - var(--omnibar-credit-bottom) - var(--omnibar-credit-room, 48px)
    ))
  );
  overflow: auto;
  background: rgba(50, 54, 62, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-top: 0;
  border-radius: 0 0 10px 10px;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(26px) saturate(1.2);
}
ul, p { margin: 0; }
ul { padding: var(--omnibar-result-padding, 0.3rem); list-style: none; }
p { padding: var(--omnibar-message-padding, 0.55rem) 0.7rem; }
.omnibar-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: var(--omnibar-item-padding, 0.45rem) 0.55rem;
  color: rgba(214, 220, 226, 0.92);
  font-size: 0.74rem;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.45);
  border-radius: 6px;
  cursor: pointer;
}
.omnibar-item[aria-selected=true] { color: #f0f4f8; background: rgba(255, 255, 255, 0.08); }
/* Hover is a lighter mark than the row Enter runs. */
@media (hover: hover) {
  .omnibar-item:hover:not([aria-selected=true]) { color: #e6ebf0; background: rgba(255, 255, 255, 0.04); }
}
.omnibar-item-icon {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  overflow: hidden;
  font-size: 19px;
  font-style: normal;
  line-height: 1;
  pointer-events: none;
}
.omnibar-item-label { flex: 1; min-width: 0; font-family: var(--font-sans, sans-serif); overflow-wrap: anywhere; }
small {
  flex: 0 1 auto;
  max-width: 45%;
  overflow: hidden;
  color: rgba(214, 220, 226, 0.8);
  font-size: 0.58rem;
  letter-spacing: 0.06em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.omnibar-strip {
  display: grid;
  gap: 6px;
  padding: 0.45rem 0.55rem 0.55rem;
  margin-bottom: 0.25rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.omnibar-strip__title {
  /* At least 4.5:1 on the results panel. */
  color: rgba(214, 220, 226, 0.88);
  font-size: 0.58rem;
  letter-spacing: 0.06rem;
  text-transform: uppercase;
}

.omnibar-strip__chips {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
}

.omnibar-strip__chips::-webkit-scrollbar {
  display: none;
}

.omnibar-strip__chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  padding: 5px 10px 5px 7px;
  color: rgba(225, 232, 238, 0.88);
  font: 500 0.72rem/1.2 var(--font-sans, inherit);
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  cursor: pointer;
}

.omnibar-strip__chip .material-symbols-outlined {
  color: rgba(214, 220, 226, 0.7);
  font-size: 0.95rem;
}

.omnibar-strip__chip:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.18);
}

.omnibar-strip__chip.active {
  color: #fff;
  background: rgba(54, 220, 255, 0.16);
  border-color: rgba(54, 220, 255, 0.45);
}

/* The chip the arrow keys are on. */
.omnibar-strip__chip.focused {
  color: #fff;
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(54, 220, 255, 0.7);
  box-shadow: 0 0 0 1px rgba(54, 220, 255, 0.35);
}


@media (max-width: 900px) {
  #gev-omnibar { width: min(26rem, calc(100vw - 16rem)); }
}
@media (pointer: coarse) {
  .omnibar-kbd { display: none; }
}
:global(body.mobile-shell #gev-omnibar) {
  --omnibar-top: calc(var(--mobile-top-inset, 0px) + 88px);
  --omnibar-credit-bottom: max(
    calc(var(--mobile-tab-space) + 106px + var(--world-timeline-lift, 0px)),
    calc(var(--mobile-sheet-cover, 0px) + 6px)
  );
  left: auto;
  inset-inline: 16px;
  width: auto;
  transform: none;
}
/* The language picker sits at the right edge beside the field; the field leaves it room.
   `.has-locale-picker`, `.has-world-timeline` and `.has-omnibar` are page-root classes (src/ui/rail/rootClass.js). */
:global(body.mobile-shell:is(.has-locale-picker *, #locale-picker) #gev-omnibar) {
  inset-inline: 16px 60px;
}
/* A lifted timeline leaves less map above the credits on short phones. */
@media (max-height: 480px) {
  :global(body.mobile-shell:is(.has-world-timeline *, #world-timeline) #gev-omnibar) {
    --omnibar-top: calc(var(--mobile-top-inset, 0px) + 48px);
    --omnibar-field-room: 34px;
    --omnibar-field-height: 34px;
    --omnibar-credit-room: 36px;
    --omnibar-mic-size: 26px;
    --omnibar-result-padding: 1px;
    --omnibar-message-padding: 1px;
    --omnibar-item-padding: 2px;
  }
  /* The field takes the HUD readout's row (48-82px): the readout sits under it. */
  :global(body.mobile-shell:is(.has-world-timeline *, #world-timeline):is(.has-omnibar *, #gev-omnibar) #intel-hud .hud-bottom-left) {
    top: calc(var(--mobile-top-inset, 0px) + 88px);
  }
}
:global(body.ui-clean-view #gev-omnibar),
:global(body.recording-mode #gev-omnibar),
:global(body.scene-playback-mode #gev-omnibar),
:global(body.cockpit-mode #gev-omnibar) { display: none; }
</style>
