import { createState } from './state.js';
import { createMarker } from './marker.js';
import { createCameraFraming } from './cameraFraming.js';
import { createCredit } from './credits.js';
import { createSelection } from './selection.js';
import { createViewerHost } from './viewerHost.js';
import { normalizeFilter, sameFilter } from './filter.js';
import { keyStatusLabel, STREET_LEVEL_LAYER_ID } from './policy.js';
import { createCoverage } from './providers/mapillary/coverage.js';
import { createSequences } from './providers/mapillary/sequences.js';
import { createMapillaryViewer } from './providers/mapillary/viewer.js';
import {
  MAPILLARY_CREDIT_HTML,
  MAPILLARY_KEY_ID,
} from './providers/mapillary/policy.js';

export { STREET_LEVEL_LAYER_ID } from './policy.js';

/** Longest wait for the server's key status; past it, the bundle's token decides. */
const KEY_STATUS_TIMEOUT_MS = 10_000;

/** Coverage as the panel sees it while the `mapillary` switch is off. */
const COVERAGE_OFF = Object.freeze({
  count: 0,
  loading: false,
  hint: '',
  error: null,
  keyRequired: false,
  keyRejected: false,
});

/**
 * The Street Level layer: Mapillary coverage lines at street zoom, a selected
 * sequence's image cones, and the photo viewer in the panel.
 * @param {{source: object, services?: object, photoViewer?: object}} options
 *   `source` is providers/mapillary/source.js or a stand-in; `photoViewer`
 *   stands in for the MapillaryJS adapter (providers/mapillary/viewer.js).
 */
export function createStreetLevelLayer({
  source,
  services = {},
  photoViewer = null,
}) {
  const state = createState({ services });
  const parts = {};
  const context = { state, parts };
  const credit = createCredit(MAPILLARY_CREDIT_HTML);
  parts.marker = createMarker(context);
  parts.framing = createCameraFraming(context);
  parts.coverage = createCoverage({ state, source });
  parts.sequences = createSequences({ state, source, parts });
  parts.viewerHost = createViewerHost({
    state,
    parts,
    adapter:
      photoViewer || createMapillaryViewer({ source, render: services.render }),
  });
  parts.openImage = openImage;
  parts.selection = createSelection(context);

  let notifyQueued = false;
  function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      const snapshot = getUIState();
      for (const listener of [...state.listeners]) {
        try {
          listener(snapshot);
        } catch (error) {
          console.warn('[Data:StreetLevel] listener error:', error);
        }
      }
    });
  }
  state.notify = notify;

  /** The key-status request in flight; overlapping checks share it. */
  let keyCheck = null;

  /** Coverage waits for the key status: no tile requests without a key. */
  function checkKey() {
    keyCheck ||= (async () => {
      let configured;
      try {
        // A hung server must not hold LOADING, or the next check, forever.
        const signal = AbortSignal.timeout(KEY_STATUS_TIMEOUT_MS);
        configured = (await source.getStatus({ signal }))?.configured === true;
      } catch {
        configured = source.hasToken?.() === true;
      }
      parts.coverage.setKeyStatus(configured);
    })().finally(() => {
      keyCheck = null;
    });
    return keyCheck;
  }

  function startDrawing() {
    const viewer = state.viewer;
    if (!viewer) return;
    parts.sequences.setVisible(true);
    parts.coverage.attach(viewer);
    credit.show(viewer);
    // Without a known key, a switch-on asks again: the server may be back,
    // or have a key now.
    if (['status', 'no-key'].includes(state.coverage.blocked)) checkKey();
  }

  /** Close the photo, clear lines and cones, forget refusals. */
  function stopDrawing() {
    parts.viewerHost.unmount();
    parts.coverage.detach();
    parts.coverage.clear();
    parts.coverage.unblock();
    parts.sequences.clearSelection();
    parts.sequences.setVisible(false);
    credit.hide(state.viewer);
  }

  /** The share link's `mapillary` switch: off, the layer draws nothing. */
  function setProviderOn(on) {
    if (state.providerOn === on) return;
    state.providerOn = on;
    if (state.enabled) {
      if (on) startDrawing();
      else stopDrawing();
    }
    notify();
  }

  function openImage(imageId) {
    return parts.viewerHost.open(imageId);
  }

  function setCoverageFilter(next) {
    const filter = normalizeFilter(next, state.filter);
    if (sameFilter(filter, state.filter)) return;
    state.filter = filter;
    parts.coverage.rebuild();
    parts.sequences.rerender();
    notify();
  }

  function coverageStats() {
    return state.providerOn ? parts.coverage.stats() : COVERAGE_OFF;
  }

  function getUIState() {
    const { host, ...street } = state.street;
    const { keyRequired, keyRejected, ...coverage } = coverageStats();
    return {
      enabled: state.enabled,
      providerOn: state.providerOn,
      // A rejected key gates the layer exactly like a missing one.
      keyRequired,
      keyRejected,
      filter: { ...state.filter },
      coverage,
      sequence: {
        selectedId: state.sequence.selectedId,
        images: state.sequence.images.length,
        loading: state.sequence.loading,
        error: state.sequence.error,
      },
      street,
    };
  }

  const layer = {
    id: STREET_LEVEL_LAYER_ID,
    name: 'Street Level',
    icon: '📷',
    source: 'Mapillary',
    updateInterval: 0,
    statsRefreshInterval: 1000,
    requiresKeyId: MAPILLARY_KEY_ID,

    init(viewer) {
      state.viewer = viewer;
      parts.marker.ensure(viewer);
      parts.marker.setVisible(false);
      parts.sequences.ensureCollections(viewer);
      parts.sequences.setVisible(false);
      checkKey();
      console.log('[Data:StreetLevel] Initialized');
    },

    enable(viewer) {
      state.enabled = true;
      state.viewer = viewer;
      parts.marker.setVisible(true);
      parts.selection.install(viewer);
      if (state.providerOn) startDrawing();
      notify();
    },

    disable() {
      state.enabled = false;
      stopDrawing();
      parts.selection.uninstall();
      parts.marker.setVisible(false);
      notify();
    },

    async update() {
      return state.enabled;
    },

    destroy(viewer = state.viewer) {
      layer.disable();
      parts.sequences.destroy(viewer);
      parts.marker.destroy(viewer);
      parts.framing.attachNavigation(null);
      state.listeners.clear();
      state.viewer = null;
    },

    getStats() {
      const coverage = coverageStats();
      const keyLabel = keyStatusLabel(coverage);
      let loadingLabel = '';
      if (keyLabel) loadingLabel = keyLabel;
      else if (coverage.loading) loadingLabel = 'loading coverage...';
      else if (coverage.hint && state.enabled) loadingLabel = coverage.hint;
      return {
        count: coverage.count,
        loading: coverage.loading,
        keyRequired: coverage.keyRequired,
        // A rejected key's message names the fix; a missing one says so.
        error: keyLabel && !coverage.keyRejected ? keyLabel : coverage.error,
        loadingLabel,
      };
    },

    /** A photo frames itself only if it still owns the camera once loaded. */
    attachNavigation(navigation) {
      parts.framing.attachNavigation(navigation);
    },

    /**
     * Share-link and stored state, in the codec's keys (src/data/layerState.js):
     * the `mapillary` switch plus the filter.
     */
    getParams() {
      return {
        mapillary: state.providerOn,
        pano: state.filter.pano,
        sinceDays: state.filter.sinceDays,
      };
    },

    /** Unknown keys and malformed values are ignored, so any link applies. */
    setParams(params = {}) {
      const input = params && typeof params === 'object' ? params : {};
      if (typeof input.mapillary === 'boolean') setProviderOn(input.mapillary);
      const next = {};
      if ('pano' in input) next.pano = input.pano;
      if ('sinceDays' in input) next.sinceDays = input.sinceDays;
      setCoverageFilter(next);
      return true;
    },

    // ── Public surface used by the panel ────────────────────────────────
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    getUIState,
    /** The DOM element the photo viewer renders into. */
    attachViewerHost(element) {
      parts.viewerHost.attach(element);
    },
    openImage,
    /** Close the image and deselect its sequence on the map. */
    closeViewer() {
      parts.viewerHost.close();
      parts.sequences.clearSelection();
    },
    setViewerRenderMode: (mode) => parts.viewerHost.setRenderMode(mode),
    resizeViewer: () => parts.viewerHost.resize(),
  };
  return layer;
}
