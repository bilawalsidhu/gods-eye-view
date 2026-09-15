import * as Cesium from 'cesium';
import { TRANSIT_FEED_REGISTRY } from '../../data/transitFeeds.js';
import {
  TRANSIT_LAYER_KEY,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
} from './policy.js';

export function createLifecycle({ state: layerState, services, parts }) {
  const {
    registerSpriteCollection,
    unregisterSpriteCollection,
    restoreSpriteOrder,
  } = services.sprites;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  function detachViewer(viewer) {
    if (layerState._cameraChangedAttached) {
      viewer.camera.changed.removeEventListener(parts.viewport.onCameraChanged);
      layerState._cameraChangedAttached = false;
    }
    if (layerState._preRenderRemove) {
      layerState._preRenderRemove();
      layerState._preRenderRemove = null;
    }
  }

  const methods = {
    /**
     * Create the point collection. Called once at bootstrap.
     * @param {Cesium.Viewer} viewer
     */
    init(viewer) {
      layerState._viewer = viewer;
      layerState._points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(layerState._points);
      registerSpriteCollection(TRANSIT_LAYER_KEY, layerState._points);
      layerState._points.show = false;
      layerState._enabled = false;
      layerState._activeFeeds = new Map();
      layerState._feedStatus = new Map();
      layerState._inFlight = new Map();
      layerState._vehicles = new Map();
      layerState._selectedKey = null;
      layerState._lastUpdate = null;
      layerState._error = null;
      layerState._limitWarned = false;
      layerState._altitudeGateOpen = false;
      layerState._overlayHost.setVisible(
        TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
        false,
      );
      restoreSpriteOrder(viewer);
      console.log(
        `[Data:Transit] Initialized with ${TRANSIT_FEED_REGISTRY.length} GTFS-RT feeds`,
      );
    },

    /**
     * Show vehicles, watch the camera, and poll every feed in range.
     * @param {Cesium.Viewer} viewer
     */
    enable(viewer) {
      layerState._enabled = true;
      layerState._generation += 1;
      layerState._error = null;
      layerState._points.show = true;
      layerState._overlayHost.setVisible(
        TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
        true,
      );
      parts.selection.installClickHandler(viewer);
      registerPickOwner(TRANSIT_LAYER_KEY, (pickedId) =>
        layerState._vehicles.has(pickedId),
      );
      if (!layerState._cameraChangedAttached) {
        viewer.camera.changed.addEventListener(parts.viewport.onCameraChanged);
        viewer.camera.percentageChanged = Math.min(
          viewer.camera.percentageChanged || 1,
          0.05,
        );
        layerState._cameraChangedAttached = true;
      }
      if (!layerState._preRenderRemove)
        layerState._preRenderRemove = viewer.scene.preRender.addEventListener(
          parts.rendering.onPreRender,
        );
      parts.viewport.runProximityCheck();
      restoreSpriteOrder(viewer);
    },

    /**
     * Hide everything, stop polling, drop all vehicles.
     * @param {Cesium.Viewer} viewer
     */
    disable(viewer) {
      layerState._enabled = false;
      layerState._generation += 1;
      clearTimeout(layerState._cameraDebounceTimer);
      layerState._cameraDebounceTimer = null;
      parts.rendering.clearFloorTimer();
      parts.selection.clearSelection();
      layerState._overlayHost.setVisible(
        TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
        false,
      );
      parts.selection.removeClickHandler();
      unregisterPickOwner(TRANSIT_LAYER_KEY);
      detachViewer(viewer);
      parts.ingestion.abortAllInFlight();
      layerState._activeFeeds.clear();
      layerState._feedStatus.clear();
      layerState._vehicles.clear();
      layerState._points?.removeAll();
      if (layerState._points) layerState._points.show = false;
      layerState._altitudeGateOpen = false;
      parts.rendering.syncRenderHold();
    },

    /**
     * Manager tick (every TRANSIT_POLL_MS): re-poll every active feed.
     * @returns {Promise<void>}
     */
    async update() {
      if (!layerState._enabled || layerState._activeFeeds.size === 0) return;
      const generation = layerState._generation;
      await Promise.all(
        [...layerState._activeFeeds.values()].map((feed) =>
          parts.ingestion.pollFeed(feed, generation),
        ),
      );
    },

    /**
     * Tear down the collection entirely.
     * @param {Cesium.Viewer} viewer
     */
    destroy(viewer) {
      if (layerState._enabled) this.disable(viewer);
      else {
        parts.rendering.clearFloorTimer();
        parts.selection.clearSelection();
        parts.selection.removeClickHandler();
        unregisterPickOwner(TRANSIT_LAYER_KEY);
        detachViewer(viewer);
        parts.ingestion.abortAllInFlight();
      }
      if (layerState._points) {
        unregisterSpriteCollection(TRANSIT_LAYER_KEY, layerState._points);
        viewer.scene.primitives.remove(layerState._points);
        layerState._points = null;
      }
      layerState._overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
      layerState._viewer = null;
    },
  };
  return { methods };
}
