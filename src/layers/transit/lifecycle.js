import { destroyTrack } from '../../data/contactPlayback.js';
import { TRANSIT_SELECTED_OVERLAY_SOURCE_ID } from './policy.js';
import { TRANSIT_ENABLED_FEEDS } from '../../data/transitFeeds.js';

/**
 * Init / enable / disable / update / destroy for one Transit layer instance.
 * Everything acquired here is released here — primitives, listeners, the
 * pick owner, the render hold, and the camera listener.
 * @param {object} context
 * @returns {object}
 */
export function createLifecycle({ state, services, parts }) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { releaseContinuousRender } = services.render;

  /**
   * Follow the active post-FX style so the sprites can be restyled for it.
   * The map style arrives on `gev:style-change`; a cockpit vision override
   * (NVG/thermal inside the cockpit view, which sets no map style) arrives on
   * `gev:vision-change` with the effective style and wins while it lasts.
   * Bound once per instance and removed on destroy. Read the document's
   * current style first: a persisted style restores before layers register.
   */
  function bindStyleEvents() {
    if (typeof window === 'undefined') return;
    if (state._styleListeners.length > 0) return;
    parts.rendering.setStylePreset(
      document?.documentElement?.dataset?.gevStyle || 'normal',
    );
    const onStyle = (event) => {
      if (state._cockpitVision) return;
      parts.rendering.setStylePreset(event?.detail?.style);
    };
    const onVision = (event) => {
      state._cockpitVision = event?.detail?.cockpit === true;
      parts.rendering.setStylePreset(event?.detail?.style);
    };
    window.addEventListener('gev:style-change', onStyle);
    window.addEventListener('gev:vision-change', onVision);
    state._styleListeners.push(
      ['gev:style-change', onStyle],
      ['gev:vision-change', onVision],
    );
  }

  function unbindStyleEvents() {
    if (typeof window === 'undefined') return;
    for (const [name, listener] of state._styleListeners) {
      window.removeEventListener(name, listener);
    }
    state._styleListeners.length = 0;
    state._cockpitVision = false;
  }

  let visibilityDocument = null,
    hidden = false;
  function onVisibilityChange() {
    if (visibilityDocument.visibilityState === 'hidden') hidden = true;
    else if (hidden) {
      hidden = false;
      parts.rendering.resumePlayback();
      parts.viewport.runProximityCheck();
    }
  }
  function bindVisibility() {
    if (visibilityDocument || typeof document === 'undefined') return;
    visibilityDocument = document;
    hidden = document.visibilityState === 'hidden';
    visibilityDocument.addEventListener('visibilitychange', onVisibilityChange);
  }
  function unbindVisibility() {
    visibilityDocument?.removeEventListener(
      'visibilitychange',
      onVisibilityChange,
    );
    visibilityDocument = null;
    hidden = false;
  }

  const methods = {
    id: 'transit',
    name: 'Transit',
    icon: '🚌',
    source: 'GTFS-RT',

    /**
     * Create the point collection. Called once at bootstrap.
     * @param {object} viewer
     */
    init(viewer) {
      state._viewer = viewer;
      parts.rendering.createMarkers(viewer);
      state._enabled = false;
      state._activeFeeds.clear();
      state._feedStatus.clear();
      state._inFlight.clear();
      for (const entry of state._vehicles.values()) {
        entry.detectContact = null;
        parts.rendering.cancelWake(entry);
        destroyTrack(entry.track);
        entry.placement?.forget(entry.key);
      }
      state._vehicles.clear();
      parts.height.clear();
      state._selectedKey = null;
      state._cockpitSubjectKey = null;
      state._lastUpdate = null;
      state._error = null;
      state._limitWarned = false;
      state._altitudeGateOpen = false;
      state._moving.clear();
      state._heightDirty.clear();
      state._rotationPose = null;
      state._rotationDirty = false;
      state._overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, false);
      bindStyleEvents();
      console.log(
        `[Data:Transit] Initialized with ${TRANSIT_ENABLED_FEEDS.length} GTFS-RT feeds`,
      );
    },

    /**
     * Show vehicles, watch the camera, and poll every feed in range.
     * @param {object} viewer
     */
    enable(viewer) {
      state._enabled = true;
      bindVisibility();
      state._generation += 1;
      state._error = null;
      parts.rendering.showMarkers();
      state._maintenanceTimer = setInterval(
        parts.rendering.maintainPresentation,
        250,
      );
      state._overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, true);
      parts.selection.installClickHandler(viewer);
      registerPickOwner('transit', (pickedId) => state._vehicles.has(pickedId));
      if (!state._cameraChangedAttached) {
        parts.rendering.watchCamera(viewer, parts.viewport.onCameraChanged);
        // Attached only with a camera to listen to, so a later enable retries.
        state._cameraChangedAttached = state._cameraChangedOff !== null;
      }
      parts.rendering.startFrames(viewer);
      parts.rendering.startModels();
      parts.viewport.runProximityCheck();
    },

    /**
     * Hide everything, stop polling, drop all vehicles.
     * @param {object} viewer
     */
    disable(viewer) {
      state._enabled = false;
      unbindVisibility();
      parts.testing._stopTransitProbeForTest();
      state._qaFixtureFloors?.clear();
      state._generation += 1;
      clearInterval(state._maintenanceTimer);
      state._maintenanceTimer = null;
      clearTimeout(state._visibilityTimer);
      state._visibilityTimer = null;
      state._detectCache = null;
      state._detectBuiltAt = -Infinity;
      state._visible.clear();
      clearTimeout(state._cameraDebounceTimer);
      state._cameraDebounceTimer = null;
      // A hold ends with the layer (cockpitSubject.js).
      state._cockpitSubjectKey = null;
      parts.selection.clearSelection();
      state._overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, false);
      parts.selection.removeClickHandler();
      unregisterPickOwner('transit');
      // Unconditional: whatever watching started, none of it outlives this.
      parts.rendering.unwatchCamera();
      state._cameraChangedAttached = false;
      parts.rendering.stopFrames();
      parts.ingestion.abortAllInFlight();
      state._activeFeeds.clear();
      state._feedStatus.clear();
      for (const entry of state._vehicles.values()) {
        entry.detectContact = null;
        parts.rendering.cancelWake(entry);
        destroyTrack(entry.track);
        entry.placement?.forget(entry.key);
      }
      state._vehicles.clear();
      parts.rendering.stopModels();
      parts.height.clear();
      parts.rendering.clearMarkers();
      state._altitudeGateOpen = false;
      state._moving.clear();
      state._heightDirty.clear();
      state._rotationPose = null;
      state._rotationDirty = false;
      if (state._renderHeld) {
        releaseContinuousRender('transit');
        state._renderHeld = false;
      }
    },

    /**
     * Manager tick (every TRANSIT_POLL_MS): re-poll every active feed, and
     * sweep aged vehicles even when nothing is active, so a layer left over a
     * quiet region does not keep an old fleet on screen.
     * @returns {Promise<void>}
     */
    async update() {
      if (!state._enabled) return;
      parts.ingestion.sweepAgedVehicles(Date.now());
      if (state._activeFeeds.size === 0) return;
      const generation = state._generation;
      await Promise.all(
        [...state._activeFeeds.values()].map((feed) =>
          parts.ingestion.pollFeed(feed, generation),
        ),
      );
    },

    /**
     * Tear down the collection entirely and release every shared registration.
     * @param {object} viewer
     */
    destroy(viewer) {
      this.disable(viewer);
      parts.rendering.stopModels(true);
      parts.rendering.destroyMarkers(viewer);
      state._overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
      parts.height.clear();
      unbindStyleEvents();
      state._dataManager = null;
      state._viewer = null;
    },
  };

  return { methods };
}
