<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { formatNumber, t } from '../../../i18n/index.js';
import { factFigure, factLabel, factValue, sayWords, useEntityCardStore } from '../../stores/entityCard.js';
import AltitudeGraph from './AltitudeGraph.vue';
import { contextNeedle, contextSearchText, matchesContextSearch } from '../../contextSearch.js';
import CctvPreview from './CctvPreview.vue';
import { useCctvStore } from '../../stores/cctv.js';
import SpotConditions from './SpotConditions.vue';
import { shownLayerName } from '../../layerNames.js';
import { countryName, nearestCity } from '../../../data/wikidataCities.js';

// The Context panel's card for one thing on the map: what it is, its facts,
// links, actions, and what else is near it. It reads from the entity card
// store, which the globe click, the omnibar and the nearby list all fill.
const props = defineProps({
  /** Contacts follows this same aircraft, and its list sits inside the card. */
  withContacts: Boolean,
});
const store = useEntityCardStore();
const { card, lost, tick } = storeToRefs(store);
// Cameras carry only an id; the CCTV panel's store knows the picked one's name.
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

function ago(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t('{n} s ago', { n: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('{n} min ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('{n} h ago', { n: hours });
  return t('{n} d ago', { n: Math.round(hours / 24) });
}

const status = computed(() => {
  void tick.value;
  const current = card.value;
  if (!current) return null;
  if (lost.value) return { tone: 'lost', text: t('Out of feed · last reading') };
  if (current.observedAgeMs !== null)
    return {
      tone: current.moving && current.observedAgeMs < 120_000 ? 'live' : 'aged',
      text: current.moving
        ? t('Live · {age}', { age: ago(current.observedAgeMs) })
        : ago(current.observedAgeMs),
    };
  if (current.moving) return { tone: 'live', text: t('Live') };
  return null;
});

const position = computed(() => {
  const current = card.value;
  if (!Number.isFinite(current?.lat) || !Number.isFinite(current?.lon)) return '';
  const lat = `${Math.abs(current.lat).toFixed(3)}°${current.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(current.lon).toFixed(3)}°${current.lon >= 0 ? 'E' : 'W'}`;
  return `${lat}  ${lon}`;
});

const distance = (km) =>
  km < 1
    ? t('{n} m', { n: formatNumber(Math.round(km * 1000)) })
    : t('{n} km', { n: formatNumber(km < 10 ? Number(km.toFixed(1)) : Math.round(km)) });

const source = computed(() => {
  void tick.value;
  return store.sourceOf(card.value);
});
const ageText = computed(() => {
  void tick.value;
  const age = card.value?.observedAgeMs;
  return Number.isFinite(age) ? t('updated {age}', { age: ago(age) }) : '';
});

// The headline figures, as big tiles: the fields the item's kind leads with
// (how high, how fast and which way for an aircraft; a quake's magnitude and
// depth; a fire's power), in that order. The rest stay in the grid. An
// aircraft's altitude is left out: its graph already leads with the figure.
const altitudeGraphed = computed(() => card.value?.kind === 'aircraft' && Number.isFinite(card.value?.altitudeM));
const tiles = computed(() => {
  const facts = card.value?.facts || [];
  return (card.value?.headline || [])
    .filter((field) => !(altitudeGraphed.value && field === 'altitudeM'))
    .map((field) => facts.find((fact) => fact.field === field))
    .filter(Boolean)
    .slice(0, 3);
});
const restFacts = computed(() => {
  const shown = new Set(tiles.value.map((fact) => fact.field));
  if (altitudeGraphed.value) shown.add('altitudeM');
  return (card.value?.facts || []).filter((fact) => !shown.has(fact.field));
});


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
    flown: distance(flown),
    left: distance(left),
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
    if (card.value?.route?.fromAt?.code === route.fromAt.code) routePlaces.value = { from, to };
  },
  { immediate: true },
);

// The hero tile at the top of every card. A camera shows its latest frame.
// Anything else gets a quiet placeholder with its icon and its headline
// figures until it has imagery of its own.
const heroKind = computed(() => (card.value?.layerId === 'cctv' ? 'camera' : 'none'));

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
        <CctvPreview v-if="heroKind === 'camera'" :camera-id="card.identity?.id || ''" />
        <!-- No imagery for it yet: its icon, with its headline figures beside it. -->
        <div v-else class="entity-hero__placeholder" :class="{ 'entity-hero__placeholder--bare': props.withContacts || !tiles.length }">
          <span class="material-symbols-outlined entity-hero__glyph" aria-hidden="true">{{ card.icon }}</span>
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
        <span class="material-symbols-outlined entity-card__icon" aria-hidden="true">{{ card.icon }}</span>
        <div class="entity-card__name">
          <span class="entity-card__kind">{{ kindLine }}</span>
          <h3 class="entity-card__title">{{ shownTitle }}</h3>
          <span v-if="subtitle" class="entity-card__subtitle">{{ subtitle }}</span>
        </div>
        <button type="button" class="entity-card__close" :aria-label="t('Close card')" :title="t('Close card')" @click="store.clear()">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </header>

      <div class="entity-card__meta">
        <span v-if="status" class="entity-card__status" :class="`entity-card__status--${status.tone}`">{{ status.text }}</span>
        <span v-if="position" class="entity-card__where">{{ position }}</span>
      </div>

      <div v-if="card.warnings?.length" class="entity-card__warning" role="alert">
        <span class="material-symbols-outlined" aria-hidden="true">warning</span>
        <span>{{ card.warnings.map((warning, index) => sayWords(card.warningWords?.[index], warning)).join(' · ') }}</span>
      </div>

      <div v-if="card.route" class="entity-card__route" :class="{ 'entity-card__route--unverified': !card.route.verified, 'entity-card__route--progress': routeProgress }">
        <strong>{{ card.route.from }}</strong>
        <span class="entity-card__route-line" :style="routeProgress ? { '--route-share': `${(routeProgress.share * 100).toFixed(1)}%` } : null" aria-hidden="true">
          <span class="material-symbols-outlined">flight</span>
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
      <p
        v-if="card.route && !card.route.verified"
        class="entity-card__route-note"
        :title="t('The scheduled route for this flight number does not match where the plane is; it may be another leg of the same flight.')"
      >
        <span class="material-symbols-outlined" aria-hidden="true">warning</span>{{ t('Scheduled · unverified: does not match where the plane is') }}
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

      <div v-if="card.links.length" class="entity-card__links">
        <a v-for="link in card.links" :key="link.kind" :href="link.href" target="_blank" rel="noopener noreferrer">{{ t(link.label) }} ↗</a>
      </div>

      <div class="entity-card__actions">
        <!-- On an aircraft or a satellite, Cockpit leads: it is the action people come for. -->
        <button v-if="store.canCockpit()" type="button" class="entity-card__action entity-card__action--primary" data-entity-cockpit-entry @click="store.cockpit()">
          <span class="material-symbols-outlined" aria-hidden="true">{{ card.layerId === 'satellites' ? 'satellite_alt' : 'flight' }}</span>{{ card.layerId === 'satellites' ? t('Enter orbital view') : t('Enter Cockpit') }}
        </button>
        <div class="entity-card__action-row">
          <button type="button" class="entity-card__action" @click="store.flyTo()">
            <span class="material-symbols-outlined" aria-hidden="true">my_location</span>{{ t('Fly to') }}
          </button>
          <button v-if="store.canFollow()" type="button" class="entity-card__action" :class="{ 'entity-card__action--on': store.isFollowing() }" :aria-pressed="String(store.isFollowing())" @click="store.follow()">
            <span class="material-symbols-outlined" aria-hidden="true">navigation</span>{{ store.isFollowing() ? t('Following') : t('Follow') }}
          </button>
        </div>
        <button type="button" class="entity-card__action entity-card__action--ask" @click="store.ask()">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>{{ t('Ask GEV about {name}', { name: shownTitle }) }}
        </button>
      </div>

      <slot />
      <SpotConditions v-if="Number.isFinite(card.lat) && Number.isFinite(card.lon)" :key="card.key" entity :lat="card.lat" :lon="card.lon" :exclude-key="card.key" :settle-km="settleKm" :with-contacts="props.withContacts" />

      <p v-if="source" class="entity-card__source">
        <span>{{ t('Source') }}</span> {{ source }}<template v-if="ageText"> · {{ ageText }}</template>
      </p>
    </section>
  </Transition>
</template>
