<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { formatNumber, getLocale, t, tn } from '../../../i18n/index.js';
import { inViewTest, recordMatches } from '../../../data/entityContext.js';
import { greatCircleKm } from '../../../geoDistance.js';
import { distanceText } from '../../distanceText.js';
import { inspectorScopeLabel } from '../../inspectorSpatialIndex.js';
import { useEntityCardStore } from '../../stores/entityCard.js';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import { useCctvStore } from '../../stores/cctv.js';
import { inspectorFeedLabel } from '../../layerRowState.js';
import { contextRadiusKm } from '../../contextRadius.js';
import { contextNeedle, contextSearchText } from '../../contextSearch.js';
import EntityCard from './EntityCard.vue';
import ContextListCard from '../../kit/ContextListCard.vue';
import CityFilterChips from './CityFilterChips.vue';

const props = defineProps({ shown: { type: Boolean, default: false }, selected: { type: String, default: null } });

const emit = defineEmits(['has-matches']);
const store = useEntityCardStore();
const chrome = usePanelChromeStore();
const cctvView = useCctvStore();
const layer = computed(() => {
  void store.layerRevision;
  return store.liveLayers().find((row) => row.id === 'cctv');
});
const layerName = computed(() => layer.value?.name ?? '');
const catalogLoading = computed(() => {
  void store.layerRevision;
  return Boolean(layer.value?.stats?.loading);
});
const catalogKey = computed(() => {
  void store.layerRevision;
  if (!layer.value) return null;
  const stats = layer.value.stats;
  return `${store.managerVersion}:${stats?.count ?? ''}:${stats?.lastUpdate ?? ''}:${stats?.recordsRevision ?? ''}:${catalogLoading.value}`;
});
const cctv = () => store.layerModule('cctv');
const center = computed(() => {
  const at = store.view?.center;
  return Number.isFinite(at?.lat) && Number.isFinite(at?.lon) ? { lat: at.lat, lon: at.lon } : null;
});
const contextOpen = computed(() => chrome.panels['global-context-panel']?.collapsed === false);
// The visible catalog's walk uses its IDs. Only a hidden walk needs a
// moving center for the geographic fallback.
const shownCenter = computed((previous) =>
  props.shown && contextOpen.value ? previous ?? center.value : null,
);
const walkCenter = computed(() => (props.shown ? shownCenter.value : center.value));

// Read the catalog in source order once per camera update. ContextListCard
// renders just the current page, and the globe pose never invalidates it.
const catalog = computed((previous) => {
  if (catalogKey.value === null) return { items: [], failed: false };
  const module = cctv();
  if (!props.shown)
    return previous?.module === module ? previous : { module, items: [], failed: false };
  if (catalogLoading.value && previous?.module === module && previous?.items.length)
    return previous;
  try {
    const source = module?.getInspectorContextPoints?.();
    const items = source ? [...source.points] : module?.getAnalystRecords?.() ?? [];
    return { module, items, failed: false };
  } catch {
    return { module, items: [], failed: true };
  }
});
const catalogState = computed(() => {
  void store.layerRevision;
  if (catalog.value.items.length) return 'ready';
  const stats = layer.value?.stats;
  if (
    catalog.value.failed || stats?.sourceUnavailable || stats?.status === 'unavailable' ||
    stats?.error || stats?.managerRefreshError
  ) return 'failed';
  return stats?.loading ? 'loading' : 'ready';
});
const catalogTone = computed(() => ({ ready: 'nominal', failed: 'unavailable', loading: 'loading' })[catalogState.value]);
// Below globe height the list is the cameras in view (the Inspector's own
// test, inViewTest), nearest the centre of the view first, each with its
// distance; with none in view, the closest three. A search reads the whole
// loaded catalog, nearest first. At globe height, the catalog in source
// order. Only a settled view ranks it again, as the tiles wait for one.
const CLOSEST_SHOWN = 3;
const settledView = computed((previous) =>
  store.viewMoving && previous ? previous : store.view,
);
const localView = computed(() => {
  const where = settledView.value;
  return where?.center && store.scopeTier && !store.scopeTier.globe ? where : null;
});
const wholeWorld = (rect) =>
  rect?.west === -180 && rect.east === 180 && rect.south === -90 && rect.north === 90;
const scoped = computed(() => {
  const items = catalog.value.items;
  const where = localView.value;
  if (!where) return { scope: 'loaded', items };
  const sky = where.groundFootprint === false;
  const from = sky ? (where.eye ?? where.center) : where.center;
  const ranked = (cameras) =>
    cameras
      .map((camera) => ({ ...camera, distanceKm: greatCircleKm(from, camera) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
  if (contextNeedle.value) return { scope: 'search', items: ranked(items) };
  const member = sky
    ? () => false
    : inViewTest(where.rect, where.center, {
        hemisphere: wholeWorld(where.rect),
        clipViewport: true,
        heightM: where.heightM,
        eye: where.eye,
        corners: where.corners,
      });
  const inView = items.filter((camera) => member(camera));
  return inView.length
    ? { scope: 'view', items: ranked(inView) }
    : { scope: 'closest', items: ranked(items).slice(0, CLOSEST_SHOWN) };
});
// The head counts what the list holds; this line says what that is of, and
// how many are loaded.
const scopeText = computed(() => {
  const { scope } = scoped.value;
  if (scope === 'loaded' || catalogState.value !== 'ready') return '';
  const loaded = t('{n} loaded', {
    context: 'Cameras list',
    n: formatNumber(catalog.value.items.length),
  });
  return scope === 'search' ? loaded : [inspectorScopeLabel(scope), loaded].join(' · ');
});
const selectedCity = ref('');
const cameraCity = (camera) => camera.city?.trim() ?? '';
const cityChoices = (cameras) => new Set(
  cameras.map(cameraCity).filter((city) => city && city.toLowerCase() !== 'global'),
);
const catalogCities = computed(() => cityChoices(catalog.value.items));
watch(catalogCities, (choices) => {
  if (selectedCity.value && catalogState.value === 'ready' && !choices.has(selectedCity.value))
    selectedCity.value = '';
});
const searchedCameras = computed(() => {
  const needle = contextNeedle.value;
  const items = scoped.value.items;
  if (!needle) return items;
  const title = t('Cameras');
  const name = layerName.value.toLowerCase();
  return name.includes(needle) ? items : items.filter((camera) => recordMatches(camera, needle, title, 'cctv'));
});
const cities = computed(() => {
  const choices = new Set(cityChoices(searchedCameras.value));
  if (selectedCity.value) choices.add(selectedCity.value);
  return [...choices].sort(new Intl.Collator(getLocale()).compare);
});
const listQuery = computed(() => JSON.stringify([contextNeedle.value, selectedCity.value]));
const matchesCity = computed(() => {
  const city = selectedCity.value;
  return city ? (camera) => cameraCity(camera) === city : null;
});
const noMatches = () => t('Nothing matches “{text}”.', { text: contextSearchText.value.trim() });
const providerOf = (camera) => camera.provider || t('Other');
const order = shallowRef([]);
watch(
  () => Boolean(layer.value && props.shown && contextNeedle.value && order.value.length),
  (matches) => emit('has-matches', matches),
  { immediate: true },
);

// Prev/Next walk this list while Context is open; with Context closed its
// centre is not kept up to date, so they walk the cameras nearest the view.
// The list's own order counts only while it shows. A new search, the list
// showing or hiding, or Context opening or closing starts a new walk; a
// recentre does not.
const HIDDEN = Symbol('hidden list');
let walkedFor;
watch(
  [catalogKey, walkCenter, contextRadiusKm, contextOpen, order, () => props.shown, listQuery],
  ([key, at, radiusKm, open, ids, shown, query]) => {
    const listed = key !== null && open && at;
    const listedFor = listed ? (shown ? query : HIDDEN) : null;
    const restart = walkedFor !== undefined && listedFor !== walkedFor;
    walkedFor = listedFor;
    try {
      cctv()?.setNearbyArea?.(listed ? { ...at, radiusKm, order: shown ? ids : null, restart } : restart ? { restart } : null);
    } catch {
      // The walk then goes by the view.
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  try {
    cctv()?.setNearbyArea?.(walkedFor != null ? { restart: true } : null);
  } catch {
    // Nothing to let go of.
  }
});

const detail = (camera) => [camera.city, camera.provider].filter(Boolean).join(' · ');
// The open camera's dot: live while its video plays, else paused.
const openId = computed(() => cctvView.view?.activeCameraId ?? null);
const playing = computed(() => cctvView.liveState === 'playing');
const liveText = computed(() => (playing.value ? t('Live') : t('Paused')));

function openCamera(camera) {
  store.open({ layerId: 'cctv', id: String(camera.id), label: camera.name, lat: camera.lat, lon: camera.lon });
}
</script>

<template>
  <ContextListCard
    v-if="layer"
    id="cctv"
    :class="{ 'camera-list--detail': selected !== null }"
    header-close
    allow-unlisted
    :selected="selected"
    :back-title="t('Close card')"
    @back="store.clear({ dismiss: true })"
    :title="t('Cameras')"
    icon="videocam"
    :items="searchedCameras"
    :item-key="(camera) => String(camera.id)"
    :query="listQuery"
    :page-size="5"
    :filter="matchesCity"
    :group-by="providerOf"
    :return-revision="store.view?.manualInputCount ?? 0"
    :scope-text="scopeText"
    :state="catalogState"
    :tone="catalogTone"
    :tone-text="catalogTone === 'nominal' ? '' : inspectorFeedLabel(catalogTone)"
    @order="order = $event"
    @select="openCamera"
  >
    <template #filter><CityFilterChips v-model="selectedCity" :cities="cities" /></template>
    <!-- The enlarged frame lives over the map, including while another phone sheet is open. -->
    <template #detail><EntityCard v-if="shown || (contextOpen && cctvView.previewPopups.includes(selected))" embedded /></template>
    <template #row="{ item: camera }">
      <i v-if="String(camera.id) === openId" class="view-context__dot" :class="playing ? 'view-context__dot--nominal' : 'view-context__dot--stale'" role="img" :aria-label="liveText" :title="liveText"></i>
      <span class="camera-list__text">
        <span class="nearby-lists__name" :title="camera.name">{{ camera.name || camera.id }}</span>
        <span v-if="detail(camera)" class="camera-list__detail" :title="detail(camera)">{{ detail(camera) }}</span>
      </span>
      <span v-if="Number.isFinite(camera.distanceKm)" class="nearby-lists__meta">{{ distanceText(camera.distanceKm) }}</span>
    </template>
    <template #empty>{{ contextNeedle && catalog.items.length ? noMatches() : tn(0, '{n} results', '{n} results', { n: formatNumber(0) }) }}</template>
    <template #no-matches>{{ noMatches() }}</template>
  </ContextListCard>
</template>

<style scoped>
.camera-list--detail.nearby-lists {
  margin-top: 0;
  border: 0;
  padding: 0;
  background: transparent;
}

.camera-list--detail :deep(.context-list-card__head) {
  margin-bottom: 0.25rem;
  justify-content: flex-end;
}

.camera-list--detail :deep(.context-list-card__head > :is(.view-context__dot, .entity-mark)) {
  display: none;
}

/* Keep the section named for assistive technology. The selected card has
   its own visible heading. */
.camera-list--detail :deep(.view-context__block-name) {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  clip-path: inset(50%);
}
</style>
