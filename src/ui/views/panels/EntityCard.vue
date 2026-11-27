<script setup>
import { approximatePosition } from '../../distanceText.js';
import { formatCockpitCoordinatePair } from '../../cockpitPresentation.js';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { factFigure, factLabel, factValue, sayWords, useEntityCardStore } from '../../stores/entityCard.js';
import { contextAgeText } from '../../contextTime.js';
import { distanceText } from '../../distanceText.js';
import AircraftModelHero from './AircraftModelHero.vue';
import SatelliteGroundView from './SatelliteGroundView.vue';
import FlightCockpitView from './FlightCockpitView.vue';
import AltitudeGraph from './AltitudeGraph.vue';
import { contextNeedle, contextSearchText, matchesContextSearch } from '../../contextSearch.js';
import RouteGlobe from './RouteGlobe.vue';
import CctvPreview from './CctvPreview.vue';
import UiButton from '../../kit/UiButton.vue';
import UiCloseButton from '../../kit/UiCloseButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import { useCctvStore } from '../../stores/cctv.js';
import SpotConditions from './SpotConditions.vue';
import { shownLayerName } from '../../layerNames.js';
import { countryName, nearestCity } from '../../../data/wikidataCities.js';
import { reportingProviderCredit } from '../../../layers/wildlifeSightings/photoText.js';

// The Context panel's card for one thing on the map: what it is, its facts,
// links, actions, and what else is near it. It reads from the entity card
// store, which the globe click, the omnibar and the nearby list all fill.
const props = defineProps({
  /** Contacts follows this same aircraft, and its list sits inside the card. */
  withContacts: Boolean,
});
const store = useEntityCardStore();
const { card, lost, locationWithheld, tick, away, finding, located } = storeToRefs(store);
// A matching frame can supply a label for the camera card.
const { frame: cctvFrame } = storeToRefs(useCctvStore());
const shownTitle = computed(() => {
  const current = card.value;
  if (current?.titleWords) return sayWords(current.titleWords, current.title);
  if (current?.layerId !== 'cctv') return current?.title;
  const f = cctvFrame.value;
  if (!f || f.cameraId !== current.identity?.id) return current.title;
  try {
    return new URL(f.src || f.currentSrc, location.origin).searchParams.get('label') || current.title;
  } catch {
    return current.title;
  }
});

const status = computed(() => {
  void tick.value;
  const current = card.value;
  if (!current) return null;
  if (finding.value === 'finding') return { tone: 'aged', text: t('Finding it…') };
  if (finding.value === 'none') return { tone: 'lost', text: t('No reading at this time') };
  if (lost.value && located.value)
    return {
      tone: 'aged',
      text: t('Last reading · {age}', {
        age: contextAgeText(located.value.atMs - located.value.observedAtMs),
      }),
    };
  if (lost.value) return { tone: 'lost', text: t('Out of feed · last reading') };
  if (current.observedAgeMs !== null)
    return {
      tone: current.moving && current.observedAgeMs < 120_000 ? 'live' : 'aged',
      text: current.moving
        ? t('Live · {age}', { age: contextAgeText(current.observedAgeMs) })
        : contextAgeText(current.observedAgeMs),
    };
  if (current.moving) return { tone: 'live', text: t('Live') };
  return null;
});

const position = computed(() => {
  const current = card.value;
  if (!Number.isFinite(current?.lat) || !Number.isFinite(current?.lon)) return '';
  if (current.obscured) return t('Location obscured to a 0.2° cell');
  const text = formatCockpitCoordinatePair(current.lat, current.lon);
  return approximatePosition(current) ? `${text} (${t('approximate')})` : text;
});

const source = computed(() => {
  void tick.value;
  return store.sourceOf(card.value);
});
const acartiaCredit = computed(() => reportingProviderCredit(card.value?.acartiaProvider));
const ageText = computed(() => {
  void tick.value;
  const age = card.value?.observedAgeMs;
  return Number.isFinite(age) ? t('updated {age}', { age: contextAgeText(age) }) : '';
});

// The headline figures, as big tiles: the fields the item's kind leads with
// (how high, how fast and which way for an aircraft; a quake's magnitude and
// depth; a fire's power), in that order. The rest stay in the grid. An
// aircraft's altitude is left out: its graph already leads with the figure.
const altitudeGraphed = computed(() => card.value?.kind === 'aircraft' && Number.isFinite(card.value?.altitudeM));
// A satellite graphs its altitude and its speed, and leaves both out of the
// tiles and the grid.
const orbitGraphed = computed(() => card.value?.kind === 'satellite' && Number.isFinite(card.value?.altitudeM));
const graphedFields = computed(() => (orbitGraphed.value ? ['altitudeM', 'speedMps'] : altitudeGraphed.value ? ['altitudeM'] : []));
const tiles = computed(() => {
  const facts = card.value?.facts || [];
  return (card.value?.headline || [])
    .filter((field) => !graphedFields.value.includes(field))
    .map((field) => facts.find((fact) => fact.field === field))
    .filter(Boolean)
    .slice(0, 3);
});
const restFacts = computed(() => {
  const shown = new Set(tiles.value.map((fact) => fact.field));
  for (const field of graphedFields.value) shown.add(field);
  return (card.value?.facts || []).filter((fact) => !shown.has(fact.field));
});

// What the turning model's callout says: what can be worked out about the
// flight (its phase, flight level, Mach, what its squawk means, how fresh its
// signal is), which the facts below don't already show.
const callouts = computed(() =>
  (card.value?.insights || []).map((item) => ({ label: t(item.label), value: sayWords(item.words, item.value) })),
);


// The line under the name: who runs it and what it is. The layer is already
// named on the line above the title.
const subtitle = computed(() => {
  const current = card.value;
  if (!current) return '';
  const cls = current.aircraftClass;
  const clsName = current.aircraftClassName ? t(current.aircraftClassName) : cls && cls[0].toUpperCase() + cls.slice(1);
  return [current.operator, clsName].filter(Boolean).join(' · ');
});
// The details grid leaves out what the header already says.
// The Context search narrows them to the ones whose name or value holds its
// text, and looks through every fact, the headline ones included.
const gridFacts = computed(() =>
  contextNeedle.value
    ? (card.value?.facts || []).filter((fact) => matchesContextSearch(factLabel(fact), factValue(fact), fact.value))
    : restFacts.value.filter((fact) => !(card.value?.operator && fact.field === 'operator') && !(card.value?.aircraftClass && fact.field === 'aircraftClass')),
);

// How far along its route the flight is, when both airports are known: the
// share flown (distance from the origin over that plus the distance still to
// go), what is left, and the time to go at its current speed.
const routeProgress = computed(() => {
  const current = card.value;
  const route = current?.route;
  if (!route?.verified || !route.fromAt || !route.toAt) return null;
  if (!Number.isFinite(current.lat) || !Number.isFinite(current.lon)) return null;
  const km = (a, b) => {
    const rad = Math.PI / 180;
    const h =
      Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  };
  const here = { lat: current.lat, lon: current.lon };
  const flown = km(route.fromAt, here);
  const left = km(here, route.toAt);
  const share = flown + left > 0 ? flown / (flown + left) : 0;
  const speedKmh = Number.isFinite(current.speedMps) ? current.speedMps * 3.6 : null;
  const hours = speedKmh && speedKmh > 80 ? left / speedKmh : null;
  const eta =
    hours === null
      ? null
      : hours >= 1
        ? t('{h} h {m} min', { h: Math.floor(hours), m: Math.round((hours % 1) * 60) })
        : t('{n} min', { n: Math.max(1, Math.round(hours * 60)) });
  return {
    share: Math.min(1, Math.max(0, share)),
    flown: distanceText(flown),
    left: distanceText(left),
    eta,
  };
});

// Each airport's city and state (or country), from its position, for the line
// under the progress bar.
const routePlaces = ref({ from: '', to: '' });
async function airportPlace(airport) {
  if (!airport) return '';
  try {
    const found = await nearestCity(airport.lat, airport.lon);
    const city = airport.name || found?.name || '';
    const region = countryName(found?.country);
    return [city, region].filter(Boolean).join(', ');
  } catch {
    return airport.name || '';
  }
}
watch(
  () => `${card.value?.route?.fromAt?.code}|${card.value?.route?.toAt?.code}`,
  async () => {
    const route = card.value?.route;
    routePlaces.value = { from: route?.fromAt?.name || '', to: route?.toAt?.name || '' };
    if (!route?.fromAt || !route?.toAt) return;
    const [from, to] = await Promise.all([airportPlace(route.fromAt), airportPlace(route.toAt)]);
    // Only for the same route still: another flight from the same airport
    // may have taken the card meanwhile.
    const now = card.value?.route;
    if (now?.fromAt?.code === route.fromAt.code && now?.toAt?.code === route.toAt.code) routePlaces.value = { from, to };
  },
  { immediate: true },
);

// The hero tile at the top of every card. A flight shows its photo, its route
// on a small globe, its 3D model and the view from its cockpit; a vessel, its
// photo; a satellite, the ground beneath it; a camera, its latest frame.
// The globe, model and cockpit view are the renderer's (`store.previews()`).
// Anything else gets a quiet placeholder with its icon and its headline
// figures until it has imagery of its own. Previews stay mounted so switching
// shows the next one at once.
const routeFailed = ref(false);
const routeKnown = computed(() => Boolean(card.value?.route?.fromAt && card.value?.route?.toAt) && !routeFailed.value);
const modelFailed = ref(false);
const cockpitFailed = ref(false);
const hasPosition = computed(() => Number.isFinite(card.value?.lat) && Number.isFinite(card.value?.lon));
const cockpitKnown = computed(() => card.value?.kind === 'aircraft' && hasPosition.value && !cockpitFailed.value);
const modelKnown = computed(() => Boolean(card.value?.aircraftModel) && !modelFailed.value);
const preview = ref(null);
// The photo the item's layer looked up (Planespotters for a tracked
// airliner, Open Vessel Photos for a selected vessel), with its credit.
const failedPhoto = ref('');
const photo = computed(() => {
  const found = card.value?.photo;
  if (!found?.src || found.src === failedPhoto.value) return null;
  const { photographer, licence } = found;
  const credit = licence
    ? photographer
      ? t('Photo: {photographer} · {licence}', { photographer, licence })
      : t('Photo · {licence}', { licence })
    : photographer
      ? t('Photo © {photographer}', { photographer })
      : '';
  return { ...found, credit };
});
const photoAvailable = computed(() => Boolean(photo.value));
const onPhotoError = (event) => (failedPhoto.value = event.currentTarget.getAttribute('src'));
watch(() => props.withContacts, () => (preview.value = null));
// The model and the cockpit view take turns: after each of the model's
// cycles, the view ahead from the cockpit shows for as long as that cycle
// took. It is made only once it is first needed. A manual selection holds the
// preview until another view or another item is selected.
const modelTurn = ref('model');
const cockpitMade = ref(false);
const activeFlightPreview = computed(() => {
  const chosen = preview.value;
  if (photoAvailable.value && (chosen === null || chosen === 'photo')) return 'photo';
  if (cockpitKnown.value && (chosen === 'cockpit' || modelTurn.value === 'other')) return 'cockpit';
  if (routeKnown.value && (chosen !== 'model' || !modelKnown.value)) return 'route';
  if (modelKnown.value) return 'model';
  return photoAvailable.value ? 'photo' : null;
});
let turnTimer = 0;
function onCockpitFailed() {
  cockpitFailed.value = true;
  if (preview.value === 'cockpit') preview.value = null;
  clearTimeout(turnTimer);
  modelTurn.value = 'model';
}
function showOtherView(ms) {
  if (preview.value !== null || !hasPosition.value) return;
  if (!cockpitKnown.value || activeFlightPreview.value === 'photo') return;
  clearTimeout(turnTimer);
  modelTurn.value = 'other';
  cockpitMade.value = true;
  turnTimer = setTimeout(() => (modelTurn.value = 'model'), Math.min(Math.max(ms, 4000), 30000));
}

const heroKind = computed(() => {
  if (card.value?.kind === 'aircraft' && (photoAvailable.value || routeKnown.value || modelKnown.value)) return 'flight';
  if (card.value?.kind === 'vessel' && photoAvailable.value) return 'photo';
  if (card.value?.layerId === 'satellites' && hasPosition.value) return 'satellite';
  if (card.value?.layerId === 'cctv') return 'camera';
  return 'none';
});
// The route globe has no cycle of its own: it shows for ROUTE_TURN_MS,
// then the cockpit view shows for as long, and round again.
const ROUTE_TURN_MS = 20_000;
let routeTimer = 0;
watch(
  [heroKind, activeFlightPreview, preview, cockpitKnown, () => card.value?.key],
  () => {
    clearTimeout(routeTimer);
    // Under reduced motion the views do not swap by themselves (the model
    // shows no scan there either, so it never hands over).
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    if (preview.value === null && cockpitKnown.value && heroKind.value === 'flight' && activeFlightPreview.value === 'route')
      routeTimer = setTimeout(() => showOtherView(ROUTE_TURN_MS), ROUTE_TURN_MS);
  },
  { immediate: true },
);
// Picking a preview shows it at once, ending the cockpit view's turn.
function choosePreview(which) {
  clearTimeout(turnTimer);
  modelTurn.value = 'model';
  preview.value = which;
  if (which === 'cockpit') cockpitMade.value = true;
}
onBeforeUnmount(() => {
  clearTimeout(turnTimer);
  clearTimeout(routeTimer);
});
watch(
  () => card.value?.key,
  () => {
    preview.value = null;
    routeFailed.value = false;
    modelFailed.value = false;
    cockpitFailed.value = false;
    clearTimeout(turnTimer);
    modelTurn.value = 'model';
    cockpitMade.value = false;
  },
);

// Things that move are read again only after they have gone a fair way, so
// following a jet does not ask for the weather every few seconds.
const settleKm = computed(() => (card.value?.moving ? 25 : 1));

const kindLabel = computed(() => (card.value ? t(card.value.kind) : ''));
// What it is, then the layer it came from, unless the layer's name already
// says what it is ("fire perimeter · Fire Perimeters").
const kindLine = computed(() => {
  const current = card.value;
  if (!current) return '';
  const layer = current.layerName || '';
  const plain = (words) => words.toLowerCase().replace(/s\b/g, '');
  const shown = shownLayerName(layer, current.layerId);
  return plain(layer).includes(plain(current.kind)) ? shown : `${kindLabel.value} · ${shown}`;
});

// A new item starts at the top of the panel, not wherever the last one was
// scrolled to.
watch(
  () => card.value?.key,
  async (key, previous) => {
    if (!key || key === previous) return;
    await nextTick();
    document
      .getElementById('entity-card')
      ?.closest('[data-rail-scroller]')
      ?.scrollTo({ top: 0, behavior: 'smooth' });
  },
);
</script>

<template>
  <Transition name="entity-card">
    <section v-if="card" id="entity-card" class="entity-card" :aria-label="t('Selected on the map')" :data-layer="card.layerId">
      <div class="entity-hero" :data-hero="heroKind">
        <template v-if="heroKind === 'flight'">
          <a
            v-if="photoAvailable"
            :key="photo.src"
            class="entity-hero__layer entity-hero__photo"
            :class="{ 'is-shown': activeFlightPreview === 'photo' }"
            :href="photo.link || undefined"
            target="_blank"
            rel="noopener"
          >
            <img :src="photo.src" :alt="t('Photo of {name}', { name: shownTitle })" v-on="{ error: onPhotoError }" />
            <small v-if="photo.credit">{{ photo.credit }}</small>
          </a>
          <RouteGlobe v-if="routeKnown" :key="`route-${card.key}`" class="entity-hero__layer" :class="{ 'is-shown': activeFlightPreview === 'route' }" :active="activeFlightPreview === 'route'" :from="card.route.fromAt" :to="card.route.toAt" :at="{ lat: card.lat, lon: card.lon }" @failed="routeFailed = true" />
          <AircraftModelHero v-if="modelKnown" :key="card.key" class="entity-hero__layer" :class="{ 'is-shown': activeFlightPreview === 'model' }" :active="activeFlightPreview === 'model'" :aircraft="card.aircraftModel" :heading="card.heading || 0" :callouts="callouts" @failed="modelFailed = true" @cycle="showOtherView" />
          <FlightCockpitView v-if="cockpitMade && cockpitKnown" :key="`cockpit-${card.key}`" class="entity-hero__layer" :class="{ 'is-shown': activeFlightPreview === 'cockpit' }" :active="activeFlightPreview === 'cockpit'" :lat="card.lat" :lon="card.lon" :altitude-m="card.altitudeM" :heading="card.heading" :speed-mps="card.speedMps" @failed="onCockpitFailed" />
          <div v-if="cockpitKnown || (routeKnown && modelKnown) || (photoAvailable && (routeKnown || modelKnown))" class="entity-card__preview-switch" role="group" :aria-label="t('Preview')">
            <UiButton v-if="photoAvailable" :pressed="activeFlightPreview === 'photo'" pressed-class="active" :label="t('Photos')" @click="choosePreview('photo')"><UiIcon name="photo_camera" :size="null" /></UiButton>
            <UiButton v-if="routeKnown" :pressed="activeFlightPreview === 'route'" pressed-class="active" :label="t('Route')" @click="choosePreview('route')"><UiIcon name="timeline" :size="null" /></UiButton>
            <UiButton v-if="modelKnown" :pressed="activeFlightPreview === 'model'" pressed-class="active" :title="t('3D model')" @click="choosePreview('model')">{{ t('3D') }}</UiButton>
            <UiButton v-if="cockpitKnown" :pressed="activeFlightPreview === 'cockpit'" pressed-class="active" :label="t('Cockpit view')" @click="choosePreview('cockpit')"><UiIcon name="visibility" :size="null" /></UiButton>
          </div>
        </template>
        <a v-else-if="heroKind === 'photo'" :key="photo.src" class="entity-hero__layer entity-hero__photo is-shown" :href="photo.link || undefined" target="_blank" rel="noopener">
          <img :src="photo.src" :alt="t('Photo of {name}', { name: shownTitle })" v-on="{ error: onPhotoError }" />
          <small v-if="photo.credit">{{ photo.credit }}</small>
        </a>
        <SatelliteGroundView v-else-if="heroKind === 'satellite'" :key="`ground-${card.key}`" class="entity-hero__layer is-shown" active :lat="card.lat" :lon="card.lon" />
        <CctvPreview v-else-if="heroKind === 'camera'" :camera-id="card.identity?.id || ''" />
        <!-- No imagery for it yet: its icon, with its headline figures beside it. -->
        <div v-else class="entity-hero__placeholder" :class="{ 'entity-hero__placeholder--bare': props.withContacts || !tiles.length }">
          <UiIcon class="entity-hero__glyph" :name="card.icon" :size="null" />
          <div v-if="!props.withContacts && tiles.length" class="entity-hero__figures">
            <div v-for="fact in tiles" :key="fact.field" class="entity-hero__figure">
              <strong>{{ factFigure(fact).number }}<small v-if="factFigure(fact).unit">{{ factFigure(fact).unit }}</small></strong>
              <span>{{ factLabel(fact) }}</span>
            </div>
          </div>
          <span v-else class="entity-hero__kind">{{ kindLabel }}</span>
        </div>
      </div>

      <header class="entity-card__head">
        <UiIcon class="entity-card__icon" :name="card.icon" :size="null" />
        <div class="entity-card__name">
          <span class="entity-card__kind">{{ kindLine }}</span>
          <h3 class="entity-card__title">{{ shownTitle }}</h3>
          <span v-if="subtitle" class="entity-card__subtitle">{{ subtitle }}</span>
        </div>
        <UiButton v-if="away && card.moving" class="entity-card__find" data-entity-find :label="t('Find it')" :title="t('Find it')" :disabled="finding === 'finding'" @click="store.locate()"><UiIcon name="my_location" :size="null" /></UiButton>
        <UiCloseButton class="entity-card__close" glyph="icon" :label="t('Close card')" :title="t('Close card')" @click="store.clear()" />
      </header>

      <div class="entity-card__meta">
        <span v-if="status" class="entity-card__status" :class="`entity-card__status--${status.tone}`">{{ status.text }}</span>
        <span v-if="position" class="entity-card__where">{{ position }}</span>
      </div>

      <p v-if="card.description" class="entity-card__description">{{ card.description }}</p>

      <div v-if="card.warnings?.length" class="entity-card__warning" role="alert">
        <UiIcon name="warning" :size="null" />
        <span>{{ card.warnings.map((warning, index) => sayWords(card.warningWords?.[index], warning)).join(' · ') }}</span>
      </div>

      <div v-if="card.route" class="entity-card__route" :class="{ 'entity-card__route--unverified': !card.route.verified, 'entity-card__route--progress': routeProgress }">
        <strong>{{ card.route.from }}</strong>
        <span class="entity-card__route-line" :style="routeProgress ? { '--route-share': `${(routeProgress.share * 100).toFixed(1)}%` } : null" aria-hidden="true">
          <UiIcon name="flight" :size="null" />
        </span>
        <strong>{{ card.route.to }}</strong>
      </div>
      <p v-if="routeProgress" class="entity-card__route-stats">
        <span>{{ t('{n}% flown', { n: Math.round(routeProgress.share * 100) }) }} · {{ routeProgress.flown }}</span>
        <span>{{ routeProgress.left }} {{ t('to go') }}<template v-if="routeProgress.eta"> · ~{{ routeProgress.eta }}</template></span>
      </p>
      <p v-if="card.route?.verified && (routePlaces.from || routePlaces.to)" class="entity-card__route-places">
        <span>{{ routePlaces.from }}</span>
        <span>{{ routePlaces.to }}</span>
      </p>
      <AltitudeGraph v-if="altitudeGraphed" v-show="!props.withContacts" :key="`altitude:${card.key}`" :altitude-m="lost ? null : card.altitudeM" :tick="tick" />
      <template v-if="orbitGraphed">
        <AltitudeGraph :key="`orbit-altitude:${card.key}`" :altitude-m="lost ? null : card.altitudeM" :tick="tick" unit="km" />
        <AltitudeGraph v-if="Number.isFinite(card.speedMps)" :key="`orbit-speed:${card.key}`" :altitude-m="lost ? null : card.speedMps" :tick="tick" unit="km/s" :label="t('Speed')" />
      </template>
      <p
        v-if="card.route && !card.route.verified"
        class="entity-card__route-note"
        :title="t('The scheduled route for this flight number does not match where the plane is; it may be another leg of the same flight.')"
      >
        <UiIcon name="warning" :size="null" />{{ t('Scheduled · unverified: does not match where the plane is') }}
      </p>

      <div v-if="!props.withContacts && tiles.length && heroKind !== 'none' && !contextNeedle" class="entity-card__tiles" :style="{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }">
        <div v-for="fact in tiles" :key="fact.field" class="entity-card__tile">
          <span>{{ factLabel(fact) }}</span>
          <strong>{{ factFigure(fact).number }}<small v-if="factFigure(fact).unit">{{ factFigure(fact).unit }}</small></strong>
        </div>
      </div>

      <p v-if="contextNeedle && !gridFacts.length" class="entity-card__no-match">{{ t('Nothing in this item’s details matches “{text}”.', { text: contextSearchText.trim() }) }}</p>
      <section v-if="gridFacts.length" class="entity-card__section">
        <h4>{{ contextNeedle ? t('Matching details') : t('Details') }}</h4>
        <dl class="entity-card__facts">
          <div v-for="fact in gridFacts" :key="fact.field" class="entity-card__fact">
            <dt>{{ factLabel(fact) }}</dt>
            <dd>{{ factValue(fact) }}</dd>
          </div>
        </dl>
      </section>

      <p v-if="acartiaCredit" class="entity-card__source">
        {{ acartiaCredit }} · {{ t('CC BY 4.0') }}
      </p>
      <div v-if="acartiaCredit || card.observationHref || card.wildlifeViewingGuidance" class="entity-card__attribution-links">
        <a v-if="acartiaCredit" href="https://acartia.io/" target="_blank" rel="noopener noreferrer">{{ t('Acartia') }} ↗</a>
        <a v-if="card.observationHref" :href="card.observationHref" target="_blank" rel="noopener noreferrer">{{ t('iNaturalist') }} ↗</a>
        <a v-if="card.wildlifeViewingGuidance" href="https://www.bewhalewise.org" target="_blank" rel="noopener noreferrer">{{ t('Be Whale Wise') }} ↗</a>
      </div>
      <div v-if="card.links.length" class="entity-card__links">
        <a v-for="link in card.links" :key="link.kind" :href="link.href" target="_blank" rel="noopener noreferrer">{{ t(link.label) }} ↗</a>
      </div>

      <div class="entity-card__actions">
        <!-- On an aircraft or a satellite, Cockpit leads: it is the action people come for. -->
        <UiButton v-if="store.canCockpit()" class="entity-card__action entity-card__action--primary" data-entity-cockpit-entry @click="store.cockpit()">
          <UiIcon :name="card.layerId === 'satellites' ? 'satellite_alt' : 'flight'" :size="null" />{{ card.layerId === 'satellites' ? t('Enter orbital view') : t('Enter Cockpit') }}
        </UiButton>
        <div class="entity-card__action-row">
          <UiButton class="entity-card__action" @click="store.flyTo()">
            <UiIcon name="my_location" :size="null" />{{ t('Fly to') }}
          </UiButton>
          <UiButton v-if="store.canFollow()" class="entity-card__action" :pressed="Boolean(store.isFollowing())" pressed-class="entity-card__action--on" @click="store.follow()">
            <UiIcon name="navigation" :size="null" />{{ store.isFollowing() ? t('Following') : t('Follow') }}
          </UiButton>
        </div>
        <!-- The chat bubble is no Material symbol the page loads, so it stays drawn. -->
        <UiButton class="entity-card__action entity-card__action--ask" @click="store.ask()">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>{{ t('Ask GEV about {name}', { name: shownTitle }) }}
        </UiButton>
      </div>

      <slot />
      <SpotConditions v-if="Number.isFinite(card.lat) && Number.isFinite(card.lon) && !locationWithheld" :key="card.key" :lat="card.lat" :lon="card.lon" :approximate="approximatePosition(card)" :exclude-key="card.key" :settle-km="settleKm" :with-contacts="props.withContacts" />

      <p v-if="source" class="entity-card__source">
        <span>{{ t('Source') }}</span> {{ source }}<template v-if="ageText"> · {{ ageText }}</template>
      </p>
    </section>
  </Transition>
</template>
