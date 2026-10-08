import { FILTER_DEFAULT } from './policy.js';

/**
 * The per-image fields of `state.street` with no image open; closing resets
 * exactly these (host and render mode outlive an image).
 */
export function freshStreet() {
  return {
    open: false,
    imageId: null,
    position: null,
    bearing: null,
    altitude: null,
    isPano: false,
    capturedAt: null,
    sequenceId: null,
    creator: null,
    externalUrl: null,
    loading: false,
    error: null,
  };
}

/** Coverage bookkeeping, before the first refresh. */
export function freshCoverage() {
  return {
    zoom: null,
    /** Current zoom's tiles by `z/x/y` key. */
    tiles: new Map(),
    /** The selected sequence drawn over the coverage, or null. */
    highlight: null,
    /** Tile key → its request's controller; any entry means LOADING. */
    pending: new Map(),
    lastError: null,
    /**
     * Why tile requests are paused, or null: 'status' until the key status
     * answers, 'no-key', 'rejected' (until the layer goes off) or
     * 'rate-limited' (until `blockTimer` fires).
     */
    blocked: 'status',
    blockTimer: null,
    debounceTimer: null,
    removeCameraListener: null,
    terrainReady: null,
    hint: '',
  };
}

/** Mutable layer state, created once per layer instance. */
export function createState({ services }) {
  return {
    services,
    viewer: null,
    enabled: false,
    listeners: new Set(),
    notify: null,
    /** The share link's `mapillary` switch: off draws nothing. */
    providerOn: true,
    /** Imagery filter, in the stored (relative-days) form. */
    filter: { ...FILTER_DEFAULT },

    street: {
      host: null,
      /** 'letterbox' shows the whole image; 'fill' crops it to the frame. */
      renderMode: 'letterbox',
      ...freshStreet(),
    },

    coverage: freshCoverage(),
    sequence: {
      selectedId: null,
      images: [],
      collection: null,
      loading: false,
      /** Why the selected sequence's images could not load, until it goes. */
      error: null,
      abort: null,
    },

    marker: { collection: null, billboard: null },
    clickHandler: null,
  };
}

/** Coverage, cones and lookups run only while the layer and its switch are on. */
export function isActive(state) {
  return state.enabled && state.providerOn;
}
