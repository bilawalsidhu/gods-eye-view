import { createState } from './state.js';
import { createMarker } from './marker.js';
import { createCameraFollow } from './cameraFollow.js';
import { createCredits } from './credits.js';
import { createPickRouter } from './pickRouter.js';
import { createSelection } from './selection.js';
import { createViewerHost } from './viewerHost.js';
import { requiresKeyIdFor, validateProviders } from './registry.js';
import { normalizeFilter, resolveFilter, sameFilter } from './filter.js';
import { decodeParams, encodeParams } from './params.js';
import { composeUIState, summarizeCoverage } from './uiState.js';
import { viewCentre } from './view.js';
import {
  FOLLOW_MAP_STACK_ID,
  NEAREST_RADIUS_M,
  POSITION_PICK_ID,
  STREET_LEVEL_LAYER_ID,
} from './policy.js';

export { STREET_LEVEL_LAYER_ID } from './policy.js';

/**
 * Construct the Street Level layer from a list of imagery providers (see
 * registry.js for the contract). The core owns what every provider shares:
 * the enable state and per-provider switches, the imagery filter, one click
 * handler, one viewer host, the position marker, camera follow, credits and
 * share-link parameters. Providers own their coverage, sequences and viewer.
 * @param {{providers: Array<import('./registry.js').StreetLevelProvider>, services?: object}} options
 */
export function createStreetLevelLayer({
  providers: definitions,
  services = {},
}) {
  const definitionsFrozen = validateProviders(definitions);
  const state = createState({ services });
  const parts = {};
  const context = { state, parts };
  parts.credits = createCredits();
  parts.marker = createMarker(context);
  parts.follow = createCameraFollow(context);
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

  /** Run low-priority work when the browser is idle (or soon, headless). */
  function scheduleIdle(task) {
    if (typeof globalThis.requestIdleCallback === 'function')
      globalThis.requestIdleCallback(() => task(), { timeout: 1500 });
    else setTimeout(task, 200);
  }

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
      getViewer: () => state.viewer,
      getFilter: () => resolveFilter(state.filter),
      isActive: () => state.enabled && entry.on,
      notify,
      actions: {
        openImage: (imageId) => openImage(entry.def.id, imageId),
        reportError: (message) => {
          state.street.error = message || null;
          notify();
        },
      },
    });
  }

  for (const def of definitionsFrozen) {
    const entry = { def, instance: null, on: true, status: null };
    entry.instance = def.create(providerContext(entry));
    state.providers.set(def.id, entry);
  }

  let mapStack = null;
  let unsubscribeMapStack = null;

  /** Follow is offered only on the Google 3D stack; leaving it stops following. */
  function syncFollowAvailability() {
    const available = mapStack?.getActiveId?.() === FOLLOW_MAP_STACK_ID;
    if (available === state.street.followAvailable) return;
    state.street.followAvailable = available;
    if (!available && state.street.follow) parts.follow.setFollow(false);
    notify();
  }

  const activeEntries = () =>
    [...state.providers.values()].filter((entry) => entry.on);

  async function refreshStatus(entry) {
    try {
      entry.status = await entry.instance.status();
    } catch {
      entry.status = null;
    }
    notify();
  }

  function activate(entry) {
    if (!state.viewer) return;
    entry.instance.activate(state.viewer);
    parts.credits.show(state.viewer, entry.def);
    if (!entry.status) refreshStatus(entry);
    scheduleIdle(() => parts.viewerHost.prewarm([entry]));
  }

  function deactivate(entry) {
    if (state.street.providerId === entry.def.id) parts.viewerHost.unmount();
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
        keyRequired: stats.keyRequired === true,
        requiresKeyId: entry.def.requiresKeyId || null,
        loading: stats.loading === true,
        count: stats.count || 0,
        hint: stats.hint || '',
        error: stats.error || null,
        legend: entry.def.legend,
      };
    });
  }

  function sequenceSnapshot() {
    // The provider showing the open image answers first.
    const owner = state.providers.get(state.street.providerId);
    const candidates = owner
      ? [owner, ...[...state.providers.values()].filter((e) => e !== owner)]
      : [...state.providers.values()];
    for (const entry of candidates) {
      const stats = entry.instance.sequenceStats?.();
      if (stats?.selectedId || stats?.loading)
        return {
          providerId: entry.def.id,
          selectedId: stats.selectedId || null,
          images: stats.images || 0,
          loading: stats.loading === true,
        };
    }
    return { providerId: null, selectedId: null, images: 0, loading: false };
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
    source: definitionsFrozen.map((def) => def.name).join(' · '),
    updateInterval: 0,
    statsRefreshInterval: 1000,
    requiresKeyId: requiresKeyIdFor(definitionsFrozen),
    /** Registered providers, in chip order. */
    providerIds: definitionsFrozen.map((def) => def.id),

    init(viewer) {
      if (state.initialized)
        throw new Error('Street Level layer is already initialized');
      state.viewer = viewer;
      state.initialized = true;
      parts.marker.ensure(viewer);
      parts.marker.setVisible(false);
      for (const entry of state.providers.values()) {
        entry.instance.init(viewer);
        refreshStatus(entry);
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
      unsubscribeMapStack?.();
      unsubscribeMapStack = null;
      mapStack = null;
      state.listeners.clear();
      state.viewer = null;
      state.initialized = false;
      state.destroyed = true;
    },

    getStats() {
      // The lifecycle polls this every second: summarise, don't snapshot.
      const coverage = summarizeCoverage(providerSnapshots());
      let loadingLabel = '';
      if (coverage.keyRequired) loadingLabel = 'KEY REQUIRED';
      else if (coverage.loading) loadingLabel = 'loading coverage...';
      else if (coverage.hint && state.enabled) loadingLabel = coverage.hint;
      return {
        count: coverage.count,
        sequences: coverage.count,
        loading: coverage.loading,
        keyRequired: coverage.keyRequired,
        error: coverage.keyRequired ? 'KEY REQUIRED' : coverage.error,
        loadingLabel,
      };
    },

    /** The application map stack; FOLLOW is available only on Google 3D. */
    attachMapStackController(controller) {
      unsubscribeMapStack?.();
      mapStack = controller || null;
      unsubscribeMapStack =
        mapStack?.subscribe?.(() => syncFollowAvailability()) || null;
      syncFollowAvailability();
    },

    /** Share-link and stored state: provider switches plus the filter. */
    getParams() {
      return encodeParams({
        providers: [...state.providers].map(([id, entry]) => [id, entry.on]),
        filter: state.filter,
      });
    },

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
      if (element && state.enabled)
        scheduleIdle(() => parts.viewerHost.prewarm(activeEntries()));
    },
    setProviderEnabled,
    isProviderEnabled: (id) => state.providers.get(id)?.on === true,
    /** Imagery filter for coverage, cones and nearest-image lookups. */
    setCoverageFilter,
    getCoverageFilter: () => ({ ...state.filter }),
    openImage,
    /** Open the nearest image any active provider has around a point. */
    async openNearest(point) {
      const view = point || viewCentre(state.viewer);
      if (!Number.isFinite(view?.lat) || !Number.isFinite(view?.lon))
        return false;
      state.street.loading = true;
      state.street.error = null;
      notify();
      let lastError = null;
      for (const entry of activeEntries()) {
        let imageId = null;
        try {
          imageId = await entry.instance.nearestImage({
            lat: view.lat,
            lon: view.lon,
          });
        } catch (error) {
          // One provider failing (no key, offline) must not hide the others.
          lastError = error;
          continue;
        }
        if (!imageId) continue;
        await openImage(entry.def.id, imageId);
        return true;
      }
      state.street.error =
        lastError?.message ||
        `No street-level imagery within ${NEAREST_RADIUS_M} m of the view centre`;
      state.street.loading = false;
      notify();
      return false;
    },
    /** Close the image and deselect it everywhere on the map. */
    closeViewer() {
      parts.viewerHost.close();
      parts.clearSequences();
    },
    setViewerRenderMode: (mode) => parts.viewerHost.setRenderMode(mode),
    setFollow: (enabled) => parts.follow.setFollow(enabled),
    lookAtImage: () => parts.follow.lookAtPosition(),
    resizeViewer: () => parts.viewerHost.resize(),
    selectSequence(
      sequenceId,
      providerId = state.providers.keys().next().value,
    ) {
      return state.providers
        .get(providerId)
        ?.instance.selectSequence?.(sequenceId);
    },
    clearSequence: () => parts.clearSequences(),
    refreshCoverage() {
      for (const entry of activeEntries()) entry.instance.refreshCoverage();
    },
  };
  return layer;
}
