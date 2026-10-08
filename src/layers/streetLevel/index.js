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
import { cameraHeightAboveGround, viewCentre, whenIdle } from './view.js';
import { createGroundCaster, nextSurfaceMode } from './groundCast.js';
import { createMeshSampler } from './meshSampler.js';

/** Above this camera height the ground under the camera is not worth fetching. */
const SURFACE_WARM_BELOW_M = 6000;
import {
  FOLLOW_MAP_STACK_ID,
  NEAREST_RADIUS_M,
  POSITION_PICK_ID,
  STREET_LEVEL_LAYER_ID,
} from './policy.js';

export { STREET_LEVEL_LAYER_ID } from './policy.js';

/**
 * The Street Level layer over imagery providers (contract in registry.js).
 * The core owns what they share; providers own coverage, sequences, viewer.
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
  parts.groundCaster = services.terrain?.resolveEllipsoidalGround
    ? createGroundCaster({ terrain: services.terrain })
    : null;
  // Mesh samples follow the application's rules: a real bare-earth prior,
  // its mesh window, and a tileset that has finished streaming.
  parts.meshSampler = parts.groundCaster
    ? createMeshSampler({
        getViewer: () => state.viewer,
        groundAt: parts.groundCaster.groundAt,
        withinPrior: services.ground?.meshFloorSampleWithinPrior ?? null,
        tilesReady: services.meshFloor?.visibleTilesetLoaded ?? null,
      })
    : null;
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
      getFilter: () => resolveFilter(state.filter),
      isActive: () => state.enabled && entry.on,
      groundCaster: parts.groundCaster,
      meshSampler: parts.meshSampler,
      getSurface: () => state.surface,
      notify,
      actions: {
        openImage: (imageId) => openImage(entry.def.id, imageId),
        /**
         * Show a provider error, or withdraw it (null). A withdrawal clears
         * only this provider's own error, never a newer one from elsewhere.
         */
        reportError: (message) => {
          if (message) {
            state.street.error = entry.reportedError = message;
          } else {
            if (!entry.reportedError) return;
            if (state.street.error === entry.reportedError)
              state.street.error = null;
            entry.reportedError = null;
          }
          notify();
        },
      },
    });
  }

  for (const def of definitionsFrozen) {
    const entry = {
      def,
      instance: null,
      on: true,
      status: null,
      /** The error this provider last reported, until it withdraws it. */
      reportedError: null,
    };
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

  /**
   * Camera height above bare earth, for the surface mode. A cold grid cell is
   * fetched once and the mode rechecked when it lands.
   */
  function cameraHeightForSurface() {
    const carto = state.viewer?.camera?.positionCartographic;
    if (!carto) return null;
    const caster = parts.groundCaster;
    const height = cameraHeightAboveGround(state.viewer, {
      groundAt: caster.groundAt,
    });
    const lon = (carto.longitude * 180) / Math.PI;
    const lat = (carto.latitude * 180) / Math.PI;
    if (caster.groundAt(lon, lat) === null && height < SURFACE_WARM_BELOW_M)
      caster.prepare([[lon, lat]]).then((ready) => {
        if (ready) scheduleSurfaceSync();
      });
    return height;
  }

  /** Cast overlays to bare earth on Google 3D at street zoom; drape them elsewhere. */
  function syncSurface() {
    const available = Boolean(parts.groundCaster) && state.enabled;
    const photoreal = mapStack?.getActiveId?.() === FOLLOW_MAP_STACK_ID;
    const mode = nextSurfaceMode(state.surface, {
      available,
      photoreal,
      heightM: available && photoreal ? cameraHeightForSurface() : null,
    });
    if (mode === state.surface) return;
    state.surface = mode;
    parts.meshSampler?.setEnabled(mode === 'terrain');
    parts.marker.setSurface(mode);
    for (const entry of state.providers.values())
      entry.instance.setSurface?.(mode);
    notify();
  }

  let surfaceTimer = null;
  function scheduleSurfaceSync() {
    clearTimeout(surfaceTimer);
    surfaceTimer = setTimeout(syncSurface, 150);
  }

  let removeSurfaceListeners = null;
  function watchSurface(viewer) {
    removeSurfaceListeners?.();
    const camera = viewer?.camera;
    if (!camera?.changed || !camera?.moveEnd) {
      removeSurfaceListeners = null;
      return;
    }
    const removeChanged = camera.changed.addEventListener(scheduleSurfaceSync);
    const removeEnd = camera.moveEnd.addEventListener(scheduleSurfaceSync);
    removeSurfaceListeners = () => {
      removeChanged();
      removeEnd();
    };
  }

  function unwatchSurface() {
    removeSurfaceListeners?.();
    removeSurfaceListeners = null;
    clearTimeout(surfaceTimer);
    surfaceTimer = null;
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
    whenIdle(() => parts.viewerHost.prewarm([entry]), 1500);
  }

  function deactivate(entry) {
    parts.viewerHost.unmount(entry.def.id);
    entry.instance.deactivate();
    parts.credits.hide(state.viewer, entry.def);
  }

  /** The nearest-image lookup in flight; any newer user action aborts it. */
  let nearestLookup = null;

  function abortNearest() {
    nearestLookup?.abort();
    nearestLookup = null;
  }

  function openImage(providerId, imageId) {
    abortNearest();
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
      surface: state.surface,
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
      watchSurface(viewer);
      syncSurface();
      notify();
    },

    disable() {
      state.enabled = false;
      abortNearest();
      unwatchSurface();
      parts.viewerHost.unmount();
      for (const entry of state.providers.values()) entry.instance.deactivate();
      syncSurface();
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
      parts.meshSampler?.destroy();
      parts.follow.destroy();
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
      const keyLabel = coverage.keyRejected ? 'KEY REJECTED' : 'KEY REQUIRED';
      if (coverage.keyRequired) loadingLabel = keyLabel;
      else if (coverage.loading) loadingLabel = 'loading coverage...';
      else if (coverage.hint && state.enabled) loadingLabel = coverage.hint;
      return {
        count: coverage.count,
        loading: coverage.loading,
        keyRequired: coverage.keyRequired,
        error: coverage.keyRequired
          ? coverage.keyRejected
            ? coverage.error || keyLabel
            : keyLabel
          : coverage.error,
        loadingLabel,
      };
    },

    /**
     * The application's camera authority: `run(noun, move)`, the deferred
     * `begin(noun)` / `reassert(generation)` pair and
     * `subscribeHandoff(listener)`. FOLLOW claims the camera with `run`; a
     * photo claims it when opening starts and frames only if it still owns
     * it once loaded. FOLLOW stops when another feature takes the camera.
     */
    attachNavigation(navigation) {
      parts.follow.attachNavigation(navigation);
    },

    /** The application map stack; FOLLOW is available only on Google 3D. */
    attachMapStackController(controller) {
      unsubscribeMapStack?.();
      mapStack = controller || null;
      unsubscribeMapStack =
        mapStack?.subscribe?.(() => {
          syncFollowAvailability();
          syncSurface();
        }) || null;
      syncFollowAvailability();
      syncSurface();
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
        whenIdle(() => parts.viewerHost.prewarm(activeEntries()), 1500);
    },
    setProviderEnabled,
    /** Imagery filter for coverage, cones and nearest-image lookups. */
    setCoverageFilter,
    openImage,
    /** Open the nearest image any active provider has around a point. */
    async openNearest(point) {
      const view = point || viewCentre(state.viewer);
      if (!Number.isFinite(view?.lat) || !Number.isFinite(view?.lon))
        return false;
      abortNearest();
      const lookup = new AbortController();
      nearestLookup = lookup;
      const { signal } = lookup;
      state.street.loading = true;
      state.street.error = null;
      notify();
      let lastError = null;
      for (const entry of activeEntries()) {
        let imageId = null;
        try {
          imageId = await entry.instance.nearestImage(
            { lat: view.lat, lon: view.lon },
            { signal },
          );
        } catch (error) {
          // Overtaken: whatever replaced it owns the panel, errors included.
          if (signal.aborted) return false;
          // One provider failing (no key, offline) must not hide the others.
          lastError = error;
          continue;
        }
        if (signal.aborted) return false;
        if (!state.enabled) break;
        // This provider was switched off while it looked: try the next.
        if (!imageId || !entry.on) continue;
        nearestLookup = null;
        return openImage(entry.def.id, imageId);
      }
      if (nearestLookup === lookup) nearestLookup = null;
      // Switched off while it looked: nothing to open, nothing to report.
      if (state.enabled && activeEntries().length)
        state.street.error =
          lastError?.message ||
          `No street-level imagery within ${NEAREST_RADIUS_M} m of the view centre`;
      state.street.loading = false;
      notify();
      return false;
    },
    /** Close the image and deselect it everywhere on the map. */
    closeViewer() {
      abortNearest();
      parts.viewerHost.close();
      parts.clearSequences();
    },
    setViewerRenderMode: (mode) => parts.viewerHost.setRenderMode(mode),
    setFollow: (enabled) => parts.follow.setFollow(enabled),
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
