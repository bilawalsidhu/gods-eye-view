<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import * as Cesium from 'cesium';
import { DURBAN, PLACES, findPlaces, readSaved, writeSaved } from './places.js';

const props = defineProps({
  viewer: { type: Object, required: true },
  navigation: { type: Object, required: true },
});
const open = ref(false);
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
  findPlaces({
    query: query.value,
    category: category.value,
    radius: Number(radius.value),
    centre: centre.value,
    savedOnly: savedOnly.value,
    saved: saved.value,
  }),
);
const selectedPlace = computed(() =>
  PLACES.find((p) => p.id === selected.value),
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
function toggleSaved(id) {
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
  </nav>
  <aside
    v-if="open"
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
    <p class="mz-intro"
      >A local perspective on the world. Explore places, find what’s nearby, and
      keep your favourites.</p
    >
    <label class="mz-search"
      >Search reference places<input
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
          ><option>Transport</option></select
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
      >{{ results.length }} of {{ PLACES.length }} reference places ·
      straight-line distance</p
    >
    <div class="mz-results">
      <p v-if="!results.length" class="mz-empty"
        >No matching places in this starter collection. Try a wider radius,
        another category, or turn off Favourites.</p
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
            :aria-pressed="saved.includes(place.id)"
            :aria-label="`${saved.includes(place.id) ? 'Unsave' : 'Save'} ${place.name}`"
            @click="toggleSaved(place.id)"
            >{{ saved.includes(place.id) ? '★ Saved' : '☆ Save' }}</button
          ></div
        >
        <div v-if="selectedPlace?.id === place.id" class="mz-detail"
          ><p>{{ place.description }}</p
          ><p>Approximate map location · reviewed {{ place.reviewed }}</p
          ><a :href="place.sourceUrl" target="_blank" rel="noopener noreferrer"
            >{{ place.source }} ↗</a
          ></div
        >
      </article>
    </div>
    <p v-if="status" class="mz-status" role="status">{{ status }}</p>
    <footer class="mz-footer"
      ><p
        >Curated reference locations · not a live directory.<br />Favourites
        stay in this browser.</p
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
