import { destroyTrack } from '../../data/contactPlayback.js';
import * as Cesium from 'cesium';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';
import {
  CAMERA_PERCENTAGE_CHANGED,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
} from './policy.js';
import { TRANSIT_ENABLED_FEEDS } from '../../data/transitFeeds.js';

/**
 * Init / enable / disable / update / destroy for one Transit layer instance.
 * Everything acquired here is released here — primitives, listeners, the sprite
 * registration, the pick owner, the render hold, and the camera sensitivity
 * this layer borrowed.
 * @param {object} context
 * @returns {object}
 */
export function createLifecycle({ state, services, parts }) {
  const {
    registerSpriteCollection,
    unregisterSpriteCollection,
    restoreSpriteOrder,
  } = services.sprites;
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
  function borrowCameraSensitivity(viewer) {
    claimCameraSensitivity(
      viewer?.camera,
      'transit',
      CAMERA_PERCENTAGE_CHANGED,
    );
  }

  /** Give the claim up. The camera keeps whatever anyone else still asks for. */
  function returnCameraSensitivity(viewer) {
    releaseCameraSensitivity(viewer?.camera, 'transit');
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
     * @param {Cesium.Viewer} viewer
     */
    init(viewer) {
      state._viewer = viewer;
      state._markers = new Cesium.BillboardCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(state._markers);
      registerSpriteCollection('transit', state._markers);
      state._animatedMarkers = new Cesium.BillboardCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(state._animatedMarkers);
      registerSpriteCollection('transit-motion', state._animatedMarkers);
      state._animatedMarkers.show = false;
      state._markers.show = false;
      state._enabled = false;
      state._activeFeeds.clear();
      state._feedStatus.clear();
      state._inFlight.clear();
      for (const entry of state._vehicles.values()) {
        entry.detectContact = null;
        parts.rendering.cancelWake(entry);
        destroyTrack(entry.track);
      }
      state._vehicles.clear();
      parts.height.clear();
      state._selectedKey = null;
      state._lastUpdate = null;
      state._error = null;
      state._limitWarned = false;
      state._altitudeGateOpen = false;
      state._moving.clear();
      state._heightDirty.clear();
      state._rotationPose = null;
      state._rotationDirty = false;
      state._overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, false);
      restoreSpriteOrder(viewer);
      bindStyleEvents();
      console.log(
        `[Data:Transit] Initialized with ${TRANSIT_ENABLED_FEEDS.length} GTFS-RT feeds`,
      );
    },

    /**
     * Show vehicles, watch the camera, and poll every feed in range.
     * @param {Cesium.Viewer} viewer
     */
    enable(viewer) {
      state._enabled = true;
      bindVisibility();
      state._generation += 1;
      state._error = null;
      state._markers.show = true;
      state._animatedMarkers.show = true;
      state._maintenanceTimer = setInterval(
        parts.rendering.maintainPresentation,
        250,
      );
      state._overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, true);
      parts.selection.installClickHandler(viewer);
      registerPickOwner(
        'transit',
        (pickedId) =>
          state._vehicles.has(pickedId) || parts.network.isRoutePick(pickedId),
      );
      if (!state._cameraChangedAttached) {
        viewer.camera.changed.addEventListener(parts.viewport.onCameraChanged);
        borrowCameraSensitivity(viewer);
        state._cameraChangedAttached = true;
      }
      if (!state._preRenderRemove) {
        state._preRenderRemove = viewer.scene.preRender.addEventListener(
          parts.rendering.onPreRender,
        );
      }
      parts.viewport.runProximityCheck();
      restoreSpriteOrder(viewer);
    },

    /**
     * Hide everything, stop polling, drop all vehicles.
     * @param {Cesium.Viewer} viewer
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
      parts.selection.clearSelection();
      state._overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, false);
      parts.selection.removeClickHandler();
      unregisterPickOwner('transit');
      if (state._cameraChangedAttached) {
        viewer.camera.changed.removeEventListener(
          parts.viewport.onCameraChanged,
        );
        returnCameraSensitivity(viewer);
        state._cameraChangedAttached = false;
      }
      if (state._preRenderRemove) {
        state._preRenderRemove();
        state._preRenderRemove = null;
      }
      parts.ingestion.abortAllInFlight();
      parts.network.clear();
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
      parts.network.sync(Date.now());
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
     * @param {Cesium.Viewer} viewer
     */
    destroy(viewer) {
      this.disable(viewer);
      if (state._markers) {
        unregisterSpriteCollection('transit', state._markers);
        viewer?.scene?.primitives?.remove(state._markers);
        state._markers = null;
      }
      if (state._animatedMarkers) {
        unregisterSpriteCollection('transit-motion', state._animatedMarkers);
        viewer?.scene?.primitives?.remove(state._animatedMarkers);
        state._animatedMarkers = null;
      }
      state._overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
      parts.height.clear();
      parts.network.destroy();
      unbindStyleEvents();
      state._dataManager = null;
      state._viewer = null;
    },
  };

  return { methods };
}
