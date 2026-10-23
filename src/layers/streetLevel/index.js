import * as Cesium from 'cesium';
import { createState } from './state.js';
import { createMarker } from './marker.js';
import { createCameraFraming } from './cameraFraming.js';
import { createCredits } from './credits.js';
import { createPickRouter } from './pickRouter.js';
import { createSelection } from './selection.js';
import { createViewerHost } from './viewerHost.js';
import { filtersOf, requiresKeyIdFor, validateProviders } from './registry.js';
import { normalizeFilter, resolveFilter, sameFilter } from './filter.js';
import { decodeParams, encodeParams } from './params.js';
import {
  composeUIState,
  keyAlternatives,
  summarizeCoverage,
} from './uiState.js';
import { groundUnderCamera, viewCentre } from './view.js';
import { createGroundClick, groundClickHeightOk } from './groundClick.js';
import { msg, t, translateKnown } from '../../i18n/index.js';
import {
  AIM_AT_GROUND_MESSAGE,
  keyStatusLabel,
  NEAREST_RADIUS_M,
  POSITION_PICK_ID,
  STREET_LEVEL_LAYER_ID,
} from './policy.js';

export { STREET_LEVEL_LAYER_ID } from './policy.js';

/** Longest wait for a provider's key status; past it, the provider decides. */
const KEY_STATUS_TIMEOUT_MS = 10_000;
/** Re-measures of a ground not loaded yet (Google 3D), a second apart. */
const GROUND_RETRY_LIMIT = 5;
const GROUND_RETRY_MS = 1000;

/**
 * The Street Level layer over imagery providers (contract in registry.js).
 * The core owns what they share: the filter and switches, the photo viewer
 * host, the position marker, the click handler and nearest-image lookups.
 * Providers own coverage, sequences and their viewer. One source is lit at
 * a time.
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
  parts.openAtGround = createGroundClick({
    state,
    openNearest: (point, options) => layer.openNearest(point, options),
    isAvailable: (entry) => providerAvailable(entry),
  });

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
        /** `{frame: false}` opens it without moving the camera. */
        openImage: (imageId, options) =>
          openImage(entry.def.id, imageId, options),
        /** This provider's image nearest a point the user picked on the map. */
        openNearest: (point) =>
          layer.openNearest(point, {
            providerIds: [entry.def.id],
            frame: false,
          }),
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

  // One source at a time: the first provider that defaults on.
  const startsOn = defs.find((def) => def.defaultOn !== false);
  for (const def of defs) {
    const entry = {
      def,
      instance: null,
      on: def === startsOn,
      status: null,
      /** The status request in flight; overlapping checks share it. */
      statusCheck: null,
      /** The error this provider last reported, until it withdraws it. */
      reportedError: null,
    };
    entry.instance = def.create(providerContext(entry));
    state.providers.set(def.id, entry);
  }

  let mapStack = null;
  let unsubscribeMapStack = null;

  /** Usable only on its map stack (Google's terms: Street View on Google 3D only). */
  function providerAvailable(entry) {
    const required = entry.def.requiresMapStack;
    return !required || mapStack?.getActiveId?.() === required;
  }

  /** Leaving a provider's map stack closes its image, viewer and credit. */
  function syncProviderAvailability() {
    const owner = state.providers.get(state.street.providerId);
    if (state.street.open && owner && !providerAvailable(owner))
      layer.closeViewer();
    for (const entry of state.providers.values()) {
      if (!entry.def.requiresMapStack) continue;
      if (state.enabled && entry.on && providerAvailable(entry))
        parts.credits.show(state.viewer, entry.def);
      else {
        parts.credits.hide(state.viewer, entry.def);
        parts.viewerHost.unmount(entry.def.id);
      }
    }
    remeasureGround();
    notify();
  }

  let groundRetry = null;
  let groundRetries = 0;
  function cancelGroundRetry() {
    clearTimeout(groundRetry);
    groundRetry = null;
  }

  /**
   * Whether a ground click can open an image: the camera is at street zoom.
   * Under Google 3D the ground is unknown until its tiles load, so an unknown
   * ground is measured again a few times instead of waiting for the next move.
   */
  function syncGroundClickReady() {
    cancelGroundRetry();
    const ready = state.enabled && groundClickHeightOk(state.viewer);
    if (
      state.enabled &&
      !ready &&
      groundRetries < GROUND_RETRY_LIMIT &&
      groundUnderCamera(state.viewer) === null
    ) {
      groundRetries++;
      groundRetry = setTimeout(syncGroundClickReady, GROUND_RETRY_MS);
    }
    if (ready === state.groundClickReady) return;
    state.groundClickReady = ready;
    notify();
  }

  /** A camera move or a map change measures afresh. */
  function remeasureGround() {
    groundRetries = 0;
    syncGroundClickReady();
  }

  let removeCameraListener = null;
  function watchCamera(viewer) {
    removeCameraListener?.();
    removeCameraListener =
      viewer?.camera?.moveEnd?.addEventListener(remeasureGround) || null;
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
    // Without a known key, a switch-on asks again: the server may be back,
    // or have a key now.
    if (entry.status?.configured !== true) checkStatus(entry);
    if (providerAvailable(entry)) parts.credits.show(state.viewer, entry.def);
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

  /** Ground under the screen centre; null for sky, undefined when it cannot aim. */
  function screenCentreGround() {
    const canvas = state.viewer?.scene?.canvas;
    const pick = state.services.scenePick?.pickGroundPosition;
    if (!pick || !canvas?.clientWidth || !canvas?.clientHeight)
      return undefined;
    const position = pick(state.viewer, {
      x: canvas.clientWidth / 2,
      y: canvas.clientHeight / 2,
    });
    const carto = position && Cesium.Cartographic.fromCartesian(position);
    return carto
      ? {
          lon: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
        }
      : null;
  }

  /** `frame: false` keeps the camera where it is (the user picked the spot). */
  function openImage(providerId, imageId, { frame = true } = {}) {
    abortNearest();
    const entry = state.providers.get(providerId);
    if (entry && !providerAvailable(entry)) {
      state.street.loading = false;
      state.street.error = unavailableReason(entry);
      notify();
      return Promise.resolve(false);
    }
    return parts.viewerHost.open(providerId, imageId, { frame });
  }

  function unavailableReason(entry) {
    return t('{name} needs the Google 3D map: choose it under MAP SOURCE', {
      name: translateKnown(entry.def.name),
    });
  }

  /** One imagery source at a time: lighting a provider darkens the others. */
  function setProviderEnabled(providerId, on) {
    const entry = state.providers.get(providerId);
    if (!entry) return false;
    const before = litIds();
    const next = on !== false;
    if (next)
      for (const other of state.providers.values())
        if (other !== entry && other.on) switchProvider(other, false);
    switchProvider(entry, next);
    sourceChanged(before);
    notify();
    return true;
  }

  const litIds = () =>
    [...state.providers]
      .filter(([, entry]) => entry.on)
      .map(([id]) => id)
      .join();

  /**
   * After a chip, voice or a link changed the lit source: a lookup still
   * running and its spinner or error were about the source switched away
   * (an open photo keeps its own state).
   */
  function sourceChanged(before) {
    if (litIds() === before) return;
    abortNearest();
    if (state.street.open) return;
    state.street.error = null;
    state.street.loading = false;
  }

  function switchProvider(entry, on) {
    if (entry.on === on) return;
    entry.on = on;
    if (!state.enabled) return;
    if (on) activate(entry);
    else deactivate(entry);
  }

  /**
   * The one provider params leave lit: of those they switch on, the one
   * already on (reapplying never flips), else the first; with none, the lit
   * one unless they switch it off.
   */
  function litByParams(switches) {
    const asked = [...state.providers.keys()].filter(
      (id) => switches.get(id) === true,
    );
    const current = [...state.providers]
      .filter(([, entry]) => entry.on)
      .map(([id]) => id);
    if (asked.length)
      return asked.find((id) => current.includes(id)) ?? asked[0];
    return current.find((id) => switches.get(id) !== false) ?? null;
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

  /** The hint a ground-click provider shows, or the provider's own. */
  function hintFor(entry, stats) {
    if (entry.def.groundClick && stats.hint && !state.groundClickReady)
      return t('zoom in to a street to open {name}', {
        name: translateKnown(entry.def.name),
      });
    return stats.hint || '';
  }

  /** Providers usable on this map stack; the others are not shown at all. */
  const listedEntries = () =>
    [...state.providers.values()].filter((entry) => providerAvailable(entry));

  function providerSnapshots() {
    return listedEntries().map((entry) => {
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
        hint: hintFor(entry, stats),
        error: stats.error || null,
        color: entry.def.colors.coverage,
        coverageLabel: entry.def.coverageLabel || null,
        sinceBasis: entry.def.sinceBasis === 'upload' ? 'upload' : 'capture',
        groundClick: entry.def.groundClick === true,
        filters: [...filtersOf(entry.def)],
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
    const ui = composeUIState({
      enabled: state.enabled,
      groundClickReady: state.groundClickReady,
      filter: state.filter,
      providers: providerSnapshots(),
      street,
      sequence: sequenceSnapshot(),
    });
    // The lit source cannot run on this map: say so, not a blank panel.
    const stranded = [...state.providers.values()].find(
      (entry) => entry.on && !providerAvailable(entry),
    );
    if (stranded && !ui.providers.some((p) => p.on))
      ui.coverage.hint = unavailableReason(stranded);
    return ui;
  }

  const layer = {
    id: STREET_LEVEL_LAYER_ID,
    name: 'Street Level',
    icon: '📷',
    /** The sources usable on this map (Street View only on Google 3D). */
    get source() {
      return listedEntries()
        .map((entry) => entry.def.name)
        .join(' · ');
    },
    updateInterval: 0,
    statsRefreshInterval: 1000,
    /** The key the switched-on providers share (or null), for the layer row. */
    get requiresKeyId() {
      const on = activeEntries();
      return requiresKeyIdFor(on.length ? on.map((entry) => entry.def) : defs);
    },
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
      watchCamera(viewer);
      remeasureGround();
      notify();
    },

    disable() {
      state.enabled = false;
      abortNearest();
      removeCameraListener?.();
      removeCameraListener = null;
      cancelGroundRetry();
      parts.viewerHost.unmount();
      for (const entry of state.providers.values()) entry.instance.deactivate();
      syncGroundClickReady();
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
      unsubscribeMapStack?.();
      unsubscribeMapStack = null;
      mapStack = null;
      state.listeners.clear();
      state.viewer = null;
    },

    getStats() {
      // The lifecycle polls this every second: summarise, don't snapshot.
      // English data: the layer panel translates these through translateKnown.
      const snapshots = providerSnapshots();
      const coverage = summarizeCoverage(snapshots);
      const keyLabel = keyStatusLabel(coverage);
      let loadingLabel = '';
      if (keyLabel) loadingLabel = keyLabel;
      else if (coverage.loading) loadingLabel = msg('loading coverage...');
      else if (coverage.hint && state.enabled) loadingLabel = coverage.hint;
      return {
        source: layer.source,
        count: coverage.count,
        loading: coverage.loading,
        keyRequired: coverage.keyRequired,
        keyAlternatives: keyAlternatives(snapshots),
        // A rejected key's message names the fix; a missing one says so.
        error: keyLabel
          ? coverage.keyRejected
            ? coverage.error || keyLabel
            : keyLabel
          : coverage.error,
        loadingLabel,
      };
    },

    /** A photo frames itself only if it still owns the camera once loaded. */
    attachNavigation(navigation) {
      parts.framing.attachNavigation(navigation);
    },

    /** The application map stack; Street View is usable only on Google 3D. */
    attachMapStackController(controller) {
      unsubscribeMapStack?.();
      mapStack = controller || null;
      unsubscribeMapStack =
        mapStack?.subscribe?.(syncProviderAvailability) || null;
      syncProviderAvailability();
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
      const lit = litByParams(decoded.providers);
      const before = litIds();
      for (const [id, entry] of state.providers)
        if (id !== lit) switchProvider(entry, false);
      if (lit) switchProvider(state.providers.get(lit), true);
      sourceChanged(before);
      notify();
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
    /**
     * Open the nearest image of the active providers (or `providerIds`) near
     * a point, else the view centre, or with `aim: 'screen-centre'` the ground
     * under the screen centre (sky: nothing). Providers without
     * `nearestImage` are skipped.
     */
    async openNearest(
      point,
      { providerIds = null, frame = true, aim = 'view' } = {},
    ) {
      let view = point;
      if (!view && aim === 'screen-centre') {
        view = screenCentreGround();
        if (view === null) {
          abortNearest();
          state.street.loading = false;
          state.street.error = AIM_AT_GROUND_MESSAGE;
          notify();
          return false;
        }
      }
      view ||= viewCentre(state.viewer);
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
      const asked = (entry) =>
        (!providerIds || providerIds.includes(entry.def.id)) &&
        typeof entry.instance.nearestImage === 'function' &&
        providerAvailable(entry);
      const entries = activeEntries().filter(asked);
      for (const entry of entries) {
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
        // Switched off, or its map left, while it looked: try the next.
        if (!imageId || !entry.on || !providerAvailable(entry)) continue;
        nearestLookup = null;
        return openImage(entry.def.id, imageId, { frame });
      }
      if (nearestLookup === lookup) nearestLookup = null;
      // Switched off while it looked: nothing to open, nothing to report.
      const stillOn = entries.some(
        (entry) => entry.on && providerAvailable(entry),
      );
      // A provider's own refusal is English data that the panel translates;
      // the core's refusal is built here, for the panel only, in the language.
      if (state.enabled && stillOn)
        state.street.error =
          lastError?.message ||
          (point
            ? t('No street-level imagery within {radius} m of that point', {
                radius: NEAREST_RADIUS_M,
              })
            : t(
                'No street-level imagery within {radius} m of the view centre',
                { radius: NEAREST_RADIUS_M },
              ));
      state.street.loading = false;
      notify();
      return false;
    },
    /** Close the image and deselect its sequence on the map. */
    closeViewer() {
      abortNearest();
      parts.viewerHost.close();
      parts.clearSequences();
    },
    setViewerRenderMode: (mode) => parts.viewerHost.setRenderMode(mode),
    resizeViewer: () => parts.viewerHost.resize(),
  };
  return layer;
}
