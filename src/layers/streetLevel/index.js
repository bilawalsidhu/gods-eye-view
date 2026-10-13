import { createState } from './state.js';
import { createMarker } from './marker.js';
import { createCameraFraming } from './cameraFraming.js';
import { createCredits } from './credits.js';
import { createPickRouter } from './pickRouter.js';
import { createSelection } from './selection.js';
import { createViewerHost } from './viewerHost.js';
import { requiresKeyIdFor, validateProviders } from './registry.js';
import { normalizeFilter, resolveFilter, sameFilter } from './filter.js';
import { decodeParams, encodeParams } from './params.js';
import { composeUIState, summarizeCoverage } from './uiState.js';
import {
  keyStatusLabel,
  POSITION_PICK_ID,
  STREET_LEVEL_LAYER_ID,
} from './policy.js';

export { STREET_LEVEL_LAYER_ID } from './policy.js';

/** Longest wait for a provider's key status; past it, the provider decides. */
const KEY_STATUS_TIMEOUT_MS = 10_000;

/**
 * The Street Level layer over imagery providers (contract in registry.js).
 * The core owns what they share: the filter and switches, the photo viewer
 * host, the position marker and the click handler. Providers own coverage,
 * sequences and their viewer.
 * @param {{providers: Array<import('./registry.js').StreetLevelProvider>, services?: object}} options
 */
export function createStreetLevelLayer({
  providers: definitions,
  services = {},
}) {
  const defs = validateProviders(definitions);
  const state = createState({ services });
  const parts = {};
  const context = { state, parts };
  parts.credits = createCredits();
  parts.marker = createMarker(context);
  parts.framing = createCameraFraming(context);
  parts.router = createPickRouter(() => state.providers.values(), {
    positionId: POSITION_PICK_ID,
  });
  parts.viewerHost = createViewerHost(context);
  parts.hasSelectedSequence = () =>
    [...state.providers.values()].some(
      (entry) => entry.instance.sequenceStats?.()?.selectedId,
    );
  parts.clearSequences = () => {
    for (const entry of state.providers.values())
      entry.instance.clearSequence?.();
  };
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

  function providerContext(entry) {
    return Object.freeze({
      services: state.services,
      /** Resolved against now, so "since N days" keeps up with the clock. */
      getFilter: () => resolveFilter(state.filter),
      /** The layer and this provider's switch are both on. */
      isActive: () => state.enabled && entry.on,
      notify,
      actions: {
        openImage: (imageId) => openImage(entry.def.id, imageId),
      },
    });
  }

  for (const def of defs) {
    const entry = {
      def,
      instance: null,
      on: true,
      status: null,
      /** The status request in flight; overlapping checks share it. */
      statusCheck: null,
    };
    entry.instance = def.create(providerContext(entry));
    state.providers.set(def.id, entry);
  }

  const activeEntries = () =>
    [...state.providers.values()].filter((entry) => entry.on);

  /** A provider's key status. A hung server must not hold LOADING, or the next check, forever. */
  function checkStatus(entry) {
    entry.statusCheck ||= (async () => {
      try {
        entry.status = await entry.instance.status({
          signal: AbortSignal.timeout(KEY_STATUS_TIMEOUT_MS),
        });
      } catch {
        entry.status = null;
      }
      notify();
    })().finally(() => {
      entry.statusCheck = null;
    });
    return entry.statusCheck;
  }

  function activate(entry) {
    if (!state.viewer) return;
    entry.instance.activate(state.viewer);
    parts.credits.show(state.viewer, entry.def);
    // Without a known key, a switch-on asks again: the server may be back,
    // or have a key now.
    if (entry.status?.configured !== true) checkStatus(entry);
  }

  function deactivate(entry) {
    parts.viewerHost.unmount(entry.def.id);
    entry.instance.deactivate();
    parts.credits.hide(state.viewer, entry.def);
  }

  function openImage(providerId, imageId) {
    return parts.viewerHost.open(providerId, imageId);
  }

  function setProviderEnabled(providerId, on) {
    const entry = state.providers.get(providerId);
    if (!entry) return false;
    const next = on !== false;
    if (entry.on === next) return true;
    entry.on = next;
    if (state.enabled) {
      if (next) activate(entry);
      else deactivate(entry);
    }
    notify();
    return true;
  }

  function setCoverageFilter(next) {
    const filter = normalizeFilter(next, state.filter);
    if (sameFilter(filter, state.filter)) return;
    state.filter = filter;
    const resolved = resolveFilter(filter);
    for (const entry of state.providers.values())
      entry.instance.setFilter(resolved);
    notify();
  }

  function providerSnapshots() {
    return [...state.providers.values()].map((entry) => {
      const stats = entry.instance.coverageStats();
      return {
        id: entry.def.id,
        name: entry.def.name,
        label: entry.def.label,
        on: entry.on,
        configured: entry.status ? entry.status.configured === true : null,
        // A rejected key gates the provider exactly like a missing one.
        keyRequired: stats.keyRequired === true || stats.keyRejected === true,
        keyRejected: stats.keyRejected === true,
        requiresKeyId: entry.def.requiresKeyId || null,
        loading: stats.loading === true,
        count: stats.count || 0,
        hint: stats.hint || '',
        error: stats.error || null,
        color: entry.def.colors.coverage,
      };
    });
  }

  /** The selected sequence; the provider showing the open image answers first. */
  function sequenceSnapshot() {
    const owner = state.providers.get(state.street.providerId);
    const candidates = owner
      ? [owner, ...[...state.providers.values()].filter((e) => e !== owner)]
      : [...state.providers.values()];
    for (const entry of candidates) {
      const stats = entry.instance.sequenceStats?.();
      if (stats?.selectedId || stats?.loading || stats?.error)
        return {
          providerId: entry.def.id,
          selectedId: stats.selectedId || null,
          images: stats.images || 0,
          loading: stats.loading === true,
          error: stats.error || null,
        };
    }
    return {
      providerId: null,
      selectedId: null,
      images: 0,
      loading: false,
      error: null,
    };
  }

  function getUIState() {
    const { host, ...street } = state.street;
    return composeUIState({
      enabled: state.enabled,
      filter: state.filter,
      providers: providerSnapshots(),
      street,
      sequence: sequenceSnapshot(),
    });
  }

  const layer = {
    id: STREET_LEVEL_LAYER_ID,
    name: 'Street Level',
    icon: '📷',
    source: defs.map((def) => def.name).join(' · '),
    updateInterval: 0,
    statsRefreshInterval: 1000,
    requiresKeyId: requiresKeyIdFor(defs),
    /** Registered providers, in chip order. */
    providerIds: defs.map((def) => def.id),
    getSourceAvailability() {
      const available = defs.length > 0;
      return {
        available,
        source: STREET_LEVEL_LAYER_ID,
        reason: available
          ? null
          : 'No street-level imagery providers configured',
      };
    },

    init(viewer) {
      state.viewer = viewer;
      parts.marker.ensure(viewer);
      parts.marker.setVisible(false);
      for (const entry of state.providers.values()) {
        entry.instance.init(viewer);
        checkStatus(entry);
      }
      console.log('[Data:StreetLevel] Initialized');
    },

    enable(viewer) {
      state.enabled = true;
      state.viewer = viewer;
      parts.marker.setVisible(true);
      parts.selection.install(viewer);
      for (const entry of activeEntries()) activate(entry);
      notify();
    },

    disable() {
      state.enabled = false;
      parts.viewerHost.unmount();
      for (const entry of state.providers.values()) entry.instance.deactivate();
      parts.credits.hideAll(state.viewer);
      parts.selection.uninstall();
      parts.marker.setVisible(false);
      notify();
    },

    async update() {
      return state.enabled;
    },

    destroy(viewer = state.viewer) {
      layer.disable();
      for (const entry of state.providers.values())
        entry.instance.destroy(viewer);
      parts.marker.destroy(viewer);
      parts.framing.attachNavigation(null);
      state.listeners.clear();
      state.viewer = null;
    },

    getStats() {
      // The lifecycle polls this every second: summarise, don't snapshot.
      const coverage = summarizeCoverage(providerSnapshots());
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

    /** Share-link and stored state: provider switches plus the filter. */
    getParams() {
      return encodeParams({
        providers: [...state.providers].map(([id, entry]) => [id, entry.on]),
        filter: state.filter,
      });
    },

    /** Unknown providers and malformed values are ignored, so any link applies. */
    setParams(params = {}) {
      const decoded = decodeParams(params, {
        providerIds: state.providers.keys(),
        filter: state.filter,
      });
      for (const [id, on] of decoded.providers) setProviderEnabled(id, on);
      setCoverageFilter(decoded.filter);
      return true;
    },

    // ── Public surface used by the panel ────────────────────────────────
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    getUIState,
    /** The DOM element provider viewers render into. */
    attachViewerHost(element) {
      parts.viewerHost.attach(element);
    },
    setProviderEnabled,
    openImage,
    /** Close the image and deselect its sequence on the map. */
    closeViewer() {
      parts.viewerHost.close();
      parts.clearSequences();
    },
    setViewerRenderMode: (mode) => parts.viewerHost.setRenderMode(mode),
    resizeViewer: () => parts.viewerHost.resize(),
  };
  return layer;
}
