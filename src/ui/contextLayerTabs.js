import { computed, ref } from 'vue';

// Context's layer tabs: when a layer that has its own settings is on, those
// settings move out of the panel they normally live in (Visual) into a tab
// in the Context panel, so they sit beside what they affect.
// Each tab's content is teleported into `#context-tab-<id>`; when the layer
// goes off the content returns to its usual panel.
const AIRCRAFT = ['flights', 'military', 'local-adsb'];

// Layers that draw labels and cards through the world overlay, which the
// Dense settings (density, allocation, fade, outside) govern.
export const LABEL_LAYERS = new Set([
  'satellites',
  'ais-live-vessels',
  'rocket-launches',
  'cctv',
  'transit',
  'bikeshare',
  'radio',
  'local-adsb',
  'earthquakes',
  'local-firms',
  'fire-perimeters',
  'weather-cyclones',
  'air-quality',
  'alpr-cameras',
  'drone-airspace',
  'military-installations',
  'telegeography-submarine-cables',
  'osm-places',
  's2-ghostmaps',
  'directions',
]);

// Which of the layers that are on each tab acts on.
export const TAB_AFFECTS = {
  labels: (on) => [...on].filter((id) => LABEL_LAYERS.has(id)),
  aircraft: (on) => [...on].filter((id) => AIRCRAFT.includes(id)),
};

export const LAYER_TABS = [
  // Labels and cards the world overlay draws for the label layers.
  {
    id: 'labels',
    label: 'Labels',
    icon: 'label',
    when: (on) => TAB_AFFECTS.labels(on).length > 0,
  },
  {
    id: 'aircraft',
    label: '3D aircraft',
    icon: 'flight',
    when: (on) => TAB_AFFECTS.aircraft(on).length > 0,
  },
];

/** Ids of the layers that are on; Context refreshes it. */
export const enabledLayerIds = ref(new Set());

export function setEnabledLayers(ids) {
  const next = new Set(ids);
  const prev = enabledLayerIds.value;
  if (next.size === prev.size && [...next].every((id) => prev.has(id))) return;
  enabledLayerIds.value = next;
}

/** Whether Context is mounted and can host tab content. */
export const contextReady = ref(false);

/** The tabs available now. */
export const availableTabs = computed(() =>
  contextReady.value
    ? LAYER_TABS.filter((tab) => tab.when(enabledLayerIds.value))
    : [],
);

export const hasTab = (id) => availableTabs.value.some((tab) => tab.id === id);

/** The tab Context shows: 'view' (the card) or a layer tab's id. */
export const activeTab = ref('view');

// Each tab's content lands in an element made here, before any panel mounts,
// so a panel that mounts ahead of Context still has a real target; Context
// places these elements in its tab panes when it mounts.
const targets = new Map();
export function tabTarget(id) {
  if (!targets.has(id) && globalThis.document) {
    const el = document.createElement('div');
    el.className = 'context-tab-body';
    el.dataset.tab = id;
    targets.set(id, el);
  }
  return targets.get(id) ?? 'body';
}
