import { destroyTrack } from '../../data/contactPlayback.js';
import { TRANSIT_SELECTED_OVERLAY_SOURCE_ID } from './policy.js';
import { TRANSIT_ENABLED_FEEDS } from '../../data/transitFeeds.js';

/**
 * Init / enable / disable / update / destroy for one Transit layer instance.
 * Everything acquired here is released here — the renderer, listeners, the
 * pick owner, the render hold, and the camera sensitivity this layer
 * borrowed.
 * @param {object} context
 * @returns {object}
 */
export function createLifecycle({
  state,
  services,
  parts,
  source,
  rendererFactory,
}) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { releaseContinuousRender } = services.render;

  /**
   * Borrow the camera's change sensitivity through the shared claim ledger.
   *
   * `camera.changed` fires on a percentage of the view moving, and this layer
   * needs a finer trigger than the default to notice it has entered a feed's
   * coverage. It is a single shared number, so the claim is registered by name
   * rather than written directly: comparing the VALUE on the way out could not
   * tell this layer's 0.05 from anybody else's, and handing back the coarse
   * default while Bikeshare was still relying on a fine one was exactly the
   * bug that produced.
   */
  function borrowCameraSensitivity() {
    parts.renderer.claimCamera();
  }

  /** Give the claim up. The camera keeps whatever anyone else still asks for. */
  function returnCameraSensitivity() {
    parts.renderer?.releaseCamera();
  }

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

  const picks = {
    owner: 'transit',
    predicate: (pickedId) => state._vehicles.has(pickedId),
  };
  const methods = {
    id: 'transit',
    name: 'Transit',
    icon: '🚌',
    source: 'GTFS-RT',

    /**
     * Create the marker sets. Called once at bootstrap.
     */
    init(viewer, options) {
      this.attachRenderer(options);
    },
    show(enabled) {
      if (state._markers) state._markers.show = enabled;
      if (state._animatedMarkers) state._animatedMarkers.show = enabled;
      state._overlayHost.setVisible(
        TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
        enabled,
      );
    },
    picks,
    attachRenderer(options = {}) {
      state._sceneContext = options;
      if (parts.renderer)
        throw new Error('Transit layer is already initialized');
      if (typeof rendererFactory !== 'function')
        throw new TypeError('A transit renderer factory is required');
      const renderer = rendererFactory({
        state,
        services,
        parts,
        source,
        engine: options.engine,
      });
      if (!renderer)
        throw new TypeError('Transit has no renderer on this engine');
      parts.renderer = renderer;
      try {
        renderer.attach();
        [state._markers, state._animatedMarkers] = renderer.createMarkers();
      } catch (error) {
        renderer.destroy();
        parts.renderer = null;
        throw error;
      }
      state._overlayHost.setVisible(
        TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
        state._enabled,
      );
      if (state._enabled) {
        for (const [key, entry] of state._vehicles) {
          parts.rendering.addMarker(key, entry);
          entry.detectContact = null;
          entry.pathRevision = -1;
        }
        this.bindScene();
        if (state._sceneContext?.viewReady !== false) this.repaint();
      }
      bindStyleEvents();
      console.log(
        `[Data:Transit] Initialized with ${TRANSIT_ENABLED_FEEDS.length} GTFS-RT feeds`,
      );
    },

    /**
     * Show vehicles, watch the camera, and poll every feed in range.
     */
    enable() {
      state._enabled = true;
      state._generation += 1;
      state._error = null;
      this.bindScene();
    },

    bindScene() {
      bindVisibility();
      state._markers.show = true;
      state._animatedMarkers.show = true;
      state._maintenanceTimer = setInterval(
        parts.rendering.maintainPresentation,
        250,
      );
      state._overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, true);
      parts.selection.installClickHandler();
      registerPickOwner(picks.owner, picks.predicate, parts.renderer?.engine);
      if (!state._cameraChangedAttached) {
        state._cameraChangedRemove = parts.renderer.onCameraChanged(
          parts.viewport.onCameraChanged,
        );
        borrowCameraSensitivity();
        state._cameraChangedAttached = true;
      }
      if (!state._preRenderRemove) {
        state._preRenderRemove = parts.renderer.onPreRender(
          parts.rendering.onPreRender,
        );
      }
      parts.viewport.runProximityCheck();
    },

    repaint() {
      state._visibilityAt = 0;
      state._rotationDirty = true;
      parts.viewport.runProximityCheck();
      parts.rendering.refreshVisibility();
      parts.trails.rebind();
      parts.selection.refreshSelectedCard(true);
      for (const feed of state._activeFeeds.values())
        parts.renderer.addCredit(
          feed,
          state._feedStatus.get(feed.id)?.creditSnapshot,
        );
    },
    resumeViewport() {
      if (state._enabled && parts.renderer) this.repaint();
    },
    detachRenderer() {
      if (!parts.renderer) return;
      state._sceneContext = null;
      unbindVisibility();
      clearInterval(state._maintenanceTimer);
      clearTimeout(state._cameraDebounceTimer);
      clearTimeout(state._visibilityTimer);
      state._maintenanceTimer =
        state._cameraDebounceTimer =
        state._visibilityTimer =
          null;
      parts.selection.removeClickHandler();
      unregisterPickOwner('transit', parts.renderer?.engine);
      state._cameraChangedRemove?.();
      state._cameraChangedRemove = null;
      if (state._cameraChangedAttached) returnCameraSensitivity();
      state._cameraChangedAttached = false;
      state._preRenderRemove?.();
      state._preRenderRemove = null;
      parts.trails.detachRenderer();
      for (const entry of state._vehicles.values()) {
        parts.rendering.cancelWake(entry);
        entry.marker = entry.markerCollection = entry.detectContact = null;
      }
      state._detectCache = null;
      state._detectBuiltAt = -Infinity;
      state._visible.clear();
      state._moving.clear();
      if (state._renderHeld)
        releaseContinuousRender('transit', parts.renderer?.engine);
      state._renderHeld = false;
      parts.renderer.destroy();
      parts.renderer = state._markers = state._animatedMarkers = null;
    },

    /**
     * Hide everything, stop polling, drop all vehicles.
     */
    disable() {
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
      parts.selection.clearSelection();
      state._overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, false);
      parts.selection.removeClickHandler();
      unregisterPickOwner('transit', parts.renderer?.engine);
      if (state._cameraChangedAttached) {
        state._cameraChangedRemove?.();
        state._cameraChangedRemove = null;
        returnCameraSensitivity();
        state._cameraChangedAttached = false;
      }
      if (state._preRenderRemove) {
        state._preRenderRemove();
        state._preRenderRemove = null;
      }
      parts.ingestion.abortAllInFlight();
      state._activeFeeds.clear();
      state._feedStatus.clear();
      for (const entry of state._vehicles.values()) {
        entry.detectContact = null;
        parts.rendering.cancelWake(entry);
        destroyTrack(entry.track);
      }
      state._vehicles.clear();
      parts.height.clear();
      state._markers?.removeAll();
      state._animatedMarkers?.removeAll();
      if (state._animatedMarkers) state._animatedMarkers.show = false;
      if (state._markers) state._markers.show = false;
      state._altitudeGateOpen = false;
      state._moving.clear();
      state._heightDirty.clear();
      state._rotationPose = null;
      state._rotationDirty = false;
      if (state._renderHeld) {
        releaseContinuousRender('transit', parts.renderer?.engine);
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
     */
    destroy() {
      this.disable();
      state._overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
      parts.renderer?.destroy();
      parts.renderer = null;
      state._markers = state._animatedMarkers = null;
      parts.height.clear();
      unbindStyleEvents();
      state._dataManager = null;
    },
  };

  return { methods };
}
