<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import * as Cesium from 'cesium';
import { DURBAN, PLACES, findPlaces, readSaved, writeSaved } from './places.js';

import Account from './Account.vue';
import Admin from './Admin.vue';
import { cloud, unwrap, placeFromCloud } from './cloud.js';

const props = defineProps({
  viewer: { type: Object, required: true },
  navigation: { type: Object, required: true },
});
const open = ref(false);
const tab = ref('places');
const session = ref(null);
const mode = ref(cloud ? 'cloud' : 'reference');
const cloudRows = ref([]),
  sources = ref([]),
  cloudSaved = ref([]),
  summary = ref([]);
const loading = ref(false),
  cloudError = ref('');
let requestVersion = 0,
  queryTimer;
const filters = computed(() => ({
  query: query.value,
  category: category.value,
  radius: radius.value,
}));
const query = ref('');
const category = ref('All');
const radius = ref(50);
const centre = ref({ ...DURBAN });
const centreLabel = ref('Durban centre');
const savedOnly = ref(false);
const markers = ref(false);
const selected = ref(null);
const status = ref('');
const trigger = ref(null);
const search = ref(null);
const picking = ref(false);
let storage;
try {
  storage = globalThis.localStorage;
} catch {
  /* Private mode remains usable. */
}
const saved = ref(readSaved(storage));
const results = computed(() =>
  mode.value === 'cloud'
    ? cloudRows.value.filter(
        (p) => !savedOnly.value || cloudSaved.value.includes(p.id),
      )
    : findPlaces({
        query: query.value,
        category: category.value,
        radius: Number(radius.value),
        centre: centre.value,
        savedOnly: savedOnly.value,
        saved: saved.value,
      }),
);
const selectedPlace = computed(() =>
  (mode.value === 'cloud' ? cloudRows.value : PLACES).find(
    (p) => p.id === selected.value,
  ),
);
const entities = new Map();
let picker;

function stopPicking() {
  picker?.destroy();
  picker = null;
  picking.value = false;
  props.viewer.canvas.style.cursor = '';
}
function showPanel() {
  open.value = !open.value;
  if (open.value) {
    markers.value = true;
    nextTick(() => search.value?.focus());
  } else {
    stopPicking();
    trigger.value?.focus();
  }
}
function closePanel() {
  open.value = false;
  stopPicking();
  trigger.value?.focus();
}
function fly(place, height = 3000) {
  stopPicking();
  const accepted = props.navigation.runImmediateNavigation('location', () => {
    props.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        place.longitude,
        place.latitude,
        height,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      duration: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
        .matches
        ? 0
        : 1.4,
    });
  });
  if (accepted !== false) selected.value = place.id ?? null;
}
function home() {
  centre.value = { ...DURBAN };
  centreLabel.value = 'Durban centre';
  fly(DURBAN, 18000);
}
async function toggleSaved(id) {
  if (mode.value === 'cloud') {
    if (!session.value) {
      status.value = 'Sign in to save cloud bookmarks.';
      tab.value = 'account';
      return;
    }
    try {
      if (cloudSaved.value.includes(id))
        await unwrap(cloud.from('bookmarks').delete().eq('place_id', id));
      else await unwrap(cloud.from('bookmarks').insert({ place_id: id }));
      await loadBookmarks();
      status.value = 'Cloud bookmark updated.';
    } catch (e) {
      status.value = e.message;
    }
    return;
  }
  const next = saved.value.includes(id)
    ? saved.value.filter((v) => v !== id)
    : [...saved.value, id];
  saved.value = next;
  status.value = writeSaved(storage, next)
    ? 'Favourites saved in this browser.'
    : 'Browser storage is unavailable. Favourites last for this session only.';
}
function pickCentre() {
  if (picking.value) {
    stopPicking();
    return;
  }
  picking.value = true;
  props.viewer.canvas.style.cursor = 'crosshair';
  status.value = 'Select a point on the map to search nearby. Escape cancels.';
  picker = new Cesium.ScreenSpaceEventHandler(props.viewer.canvas);
  picker.setInputAction(({ position }) => {
    const ray = props.viewer.camera.getPickRay(position);
    const scene = props.viewer.scene;
    // Photorealistic tiles hide the base globe; prefer their rendered depth.
    let point;
    if (scene.pickPositionSupported) {
      try {
        point = scene.pickPosition(position);
      } catch {
        /* Use terrain below. */
      }
    }
    point ??= ray && scene.globe.pick(ray, scene);
    if (!point) {
      status.value = 'Select a point on the Earth, or zoom in first.';
      return;
    }
    const geo = Cesium.Cartographic.fromCartesian(point);
    centre.value = {
      latitude: Cesium.Math.toDegrees(geo.latitude),
      longitude: Cesium.Math.toDegrees(geo.longitude),
    };
    centreLabel.value = `${centre.value.latitude.toFixed(3)}, ${centre.value.longitude.toFixed(3)}`;
    status.value =
      'Nearby results updated. Distances are straight-line estimates.';
    stopPicking();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}
function keydown(event) {
  if (event.key !== 'Escape' || !open.value) return;
  if (picking.value) {
    stopPicking();
    status.value = 'Map selection cancelled.';
  } else closePanel();
}
async function loadBookmarks() {
  cloudSaved.value = session.value
    ? (await unwrap(cloud.from('bookmarks').select('place_id'))).map(
        (r) => r.place_id,
      )
    : [];
}
async function refreshCloud() {
  const version = ++requestVersion;
  if (!cloud || mode.value !== 'cloud') {
    loading.value = false;
    return;
  }
  loading.value = true;
  cloudError.value = '';
  try {
    const [rows, sourceRows, totals] = await Promise.all([
      unwrap(
        cloud.rpc('nearby_places', {
          p_lat: centre.value.latitude,
          p_lon: centre.value.longitude,
          p_radius: Number(radius.value) * 1000,
          p_category: category.value === 'All' ? null : category.value,
          p_query: query.value,
          p_limit: 100,
        }),
      ),
      unwrap(cloud.from('data_sources').select('*')),
      unwrap(
        cloud.rpc('region_summary', {
          p_lat: centre.value.latitude,
          p_lon: centre.value.longitude,
          p_radius: Number(radius.value) * 1000,
        }),
      ),
    ]);
    if (version !== requestVersion) return;
    sources.value = sourceRows;
    cloudRows.value = rows.map((row) => placeFromCloud(row, sourceRows));
    summary.value = totals;
  } catch (e) {
    if (version === requestVersion) {
      cloudError.value = e.message || 'Cloud places unavailable.';
      cloudRows.value = [];
      summary.value = [];
    }
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}
async function updateSession(value) {
  session.value = value;
  try {
    await loadBookmarks();
  } catch (e) {
    status.value = e.message;
    cloudSaved.value = [];
  }
}
async function migrateFavourites() {
  try {
    const ids = PLACES.filter((p) => saved.value.includes(p.id)).map(
      (p) => p.id,
    );
    const rows = await unwrap(
      cloud
        .from('places')
        .select('id,external_id')
        .eq('source_id', 'starter-reference')
        .in('external_id', ids),
    );
    if (rows.length)
      await unwrap(
        cloud.from('bookmarks').upsert(
          rows.map((p) => ({ user_id: session.value.user.id, place_id: p.id })),
          { onConflict: 'user_id,place_id', ignoreDuplicates: true },
        ),
      );
    await loadBookmarks();
    status.value = `Copied ${rows.length} local favourites to your account. Browser favourites retained.`;
  } catch (e) {
    status.value = e.message;
  }
}
function restoreFilters(value) {
  const f = value.filters;
  if (typeof f?.query === 'string') query.value = f.query.slice(0, 120);
  if (
    [
      'All',
      'Venues',
      'Transport',
      'Health',
      'Education',
      'Public services',
      'Infrastructure',
    ].includes(f?.category)
  )
    category.value = f.category;
  if ([2, 10, 25, 50].includes(f?.radius)) radius.value = f.radius;
}
watch(
  [query, category, radius, centre, mode],
  () => {
    clearTimeout(queryTimer);
    ++requestVersion;
    queryTimer = setTimeout(refreshCloud, 250);
  },
  { immediate: true },
);
document.addEventListener('keydown', keydown);
watch([markers, results], () => {
  for (const entity of entities.values()) props.viewer.entities.remove(entity);
  entities.clear();
  if (markers.value)
    for (const place of results.value) {
      entities.set(
        place.id,
        props.viewer.entities.add({
          id: `mzansi:${place.id}`,
          name: place.name,
          position: Cesium.Cartesian3.fromDegrees(
            place.longitude,
            place.latitude,
          ),
          point: {
            pixelSize: 11,
            color: Cesium.Color.fromCssColorString('#66dfb7'),
            outlineColor: Cesium.Color.fromCssColorString('#102c29'),
            outlineWidth: 3,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: place.name,
            font: '13px sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#102c29'),
            pixelOffset: new Cesium.Cartesian2(0, -24),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              45000,
            ),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
  props.viewer.scene.requestRender();
});
onBeforeUnmount(() => {
  clearTimeout(queryTimer);
  ++requestVersion;
  stopPicking();
  document.removeEventListener('keydown', keydown);
  for (const entity of entities.values()) props.viewer.entities.remove(entity);
});
</script>

<template>
  <nav
    lang="en"
    translate="no"
    class="mz-ribbon"
    aria-label="MzansiView navigation"
  >
    <button
      ref="trigger"
      type="button"
      :aria-expanded="open"
      aria-controls="mz-places"
      @click="showPanel"
      >Explore Durban
      <span aria-hidden="true">{{ open ? '−' : '+' }}</span></button
    >
    <button type="button" @click="home">Home view</button>
    <button
      type="button"
      @click="
        open = true;
        tab = 'account';
      "
      >Account</button
    >
  </nav>
  <aside
    v-show="open"
    id="mz-places"
    lang="en"
    translate="no"
    class="mz-panel"
    aria-labelledby="mz-heading"
  >
    <header class="mz-panel-header">
      <div
        ><p class="mz-eyebrow">SOUTH AFRICA / 01</p
        ><h2 id="mz-heading">Discover Durban<span>.</span></h2></div
      >
      <button
        class="mz-close"
        type="button"
        aria-label="Close places"
        @click="closePanel"
        >×</button
      >
    </header>
    <div class="mz-tabs" role="group" aria-label="Explorer panels"
      ><button :aria-pressed="tab === 'places'" @click="tab = 'places'"
        >Places</button
      ><button :aria-pressed="tab === 'account'" @click="tab = 'account'"
        >Account & views</button
      ></div
    >
    <div v-show="tab === 'account'">
      <Account
        :viewer="viewer"
        :navigation="navigation"
        :session="session"
        :filters="filters"
        @session="updateSession"
        @status="restoreFilters"
      />
      <button v-if="session && saved.length" @click="migrateFavourites"
        >Copy {{ saved.length }} browser favourites to cloud</button
      >
      <Admin v-if="session" :key="session.user.id" />
    </div>
    <div v-show="tab === 'places'">
      <p class="mz-intro"
        >A local perspective on the world. Explore places, find what’s nearby,
        and keep your favourites.</p
      >
      <label class="mz-search"
        >Data collection<select v-model="mode"
          ><option value="reference"
            >Starter reference · 3 places · browser favourites</option
          ><option v-if="cloud" value="cloud"
            >Published cloud places · account bookmarks</option
          ></select
        ></label
      >
      <p v-if="loading" role="status">Loading published places…</p>
      <p v-if="cloudError" role="alert"
        >{{ cloudError }} <button @click="refreshCloud">Retry</button> or select
        the starter reference collection.</p
      >
      <label class="mz-search"
        >Search places<input
          maxlength="120"
          ref="search"
          v-model="query"
          type="search"
          placeholder="Try airport or convention centre"
      /></label>
      <div class="mz-filters">
        <label
          >Category<select v-model="category"
            ><option>All</option
            ><option>Venues</option
            ><option>Transport</option
            ><option>Health</option
            ><option>Education</option
            ><option>Public services</option
            ><option>Infrastructure</option></select
          ></label
        >
        <label
          >Within<select v-model.number="radius"
            ><option :value="2">2 km</option
            ><option :value="10">10 km</option
            ><option :value="25">25 km</option
            ><option :value="50">50 km</option></select
          ></label
        >
      </div>
      <div class="mz-centre"
        ><span>From {{ centreLabel }}</span
        ><button type="button" :aria-pressed="picking" @click="pickCentre">{{
          picking ? 'Cancel selection' : 'Choose on map'
        }}</button></div
      >
      <div class="mz-options">
        <label><input v-model="savedOnly" type="checkbox" /> Favourites</label>
        <label><input v-model="markers" type="checkbox" /> Map markers</label>
      </div>
      <p class="mz-count" aria-live="polite"
        >{{ results.length }}
        {{
          mode === 'cloud'
            ? 'published places (up to 100)'
            : 'of 3 reference places'
        }}
        · straight-line distance</p
      >
      <div class="mz-results">
        <p v-if="!loading && !cloudError && !results.length" class="mz-empty"
          >No matching places in this
          {{ mode === 'cloud' ? 'published' : 'starter' }} collection. Try a
          wider radius, another category, or turn off Favourites.</p
        >
        <article
          v-for="place in results"
          :key="place.id"
          class="mz-place"
          :class="{ 'is-selected': selected === place.id }"
        >
          <div class="mz-place-meta"
            ><span>{{ place.category }}</span
            ><span>{{ place.distance.toFixed(1) }} km</span></div
          >
          <button class="mz-place-name" type="button" @click="fly(place)"
            >{{ place.name }} <span aria-hidden="true">↗</span></button
          >
          <div class="mz-place-actions"
            ><button
              type="button"
              @click="selected = selected === place.id ? null : place.id"
              >{{ selected === place.id ? 'Hide details' : 'Details' }}</button
            ><button
              type="button"
              :aria-pressed="
                (mode === 'cloud' ? cloudSaved : saved).includes(place.id)
              "
              :aria-label="`${(mode === 'cloud' ? cloudSaved : saved).includes(place.id) ? 'Unsave' : 'Save'} ${place.name}`"
              @click="toggleSaved(place.id)"
              >{{
                (mode === 'cloud' ? cloudSaved : saved).includes(place.id)
                  ? '★ Saved'
                  : '☆ Save'
              }}</button
            ></div
          >
          <div v-if="selectedPlace?.id === place.id" class="mz-detail"
            ><p>{{ place.description }}</p
            ><p>Approximate map location · reviewed {{ place.reviewed }}</p
            ><a
              :href="place.sourceUrl"
              target="_blank"
              rel="noopener noreferrer"
              >{{ place.source }} ↗</a
            ></div
          >
        </article>
      </div>
      <section
        v-if="mode === 'cloud' && summary.length"
        class="mz-summary"
        aria-label="Nearby summary"
        ><h3>Nearby snapshot</h3
        ><p
          >Nearest 200 visible places · straight-line radius · not a complete
          facility census.</p
        ><div v-for="row in summary" :key="row.category"
          >{{ row.category }}
          <meter
            min="0"
            max="200"
            :value="Number(row.total)"
            :aria-label="row.category"
          />
          {{ row.total }}</div
        ><details
          ><summary>Source health</summary
          ><p v-for="source in sources" :key="source.id"
            >{{ source.name }} · {{ source.kind }} · metadata reviewed
            {{ source.reviewed_at.slice(0, 10) }}</p
          ></details
        ></section
      >
    </div>
    <p v-if="status" class="mz-status" role="status">{{ status }}</p>
    <footer class="mz-footer"
      ><p>{{
        mode === 'cloud'
          ? 'Published source records · not real-time service availability. Cloud bookmarks require sign-in.'
          : 'Curated reference locations · not a live directory. Favourites stay in this browser.'
      }}</p
      ><p
        >Created by Phindile Sandi · Built on
        <a
          href="https://github.com/bilawalsidhu/gods-eye-view"
          target="_blank"
          rel="noopener noreferrer"
          >God’s Eye View</a
        ></p
      ></footer
    >
  </aside>
</template>
