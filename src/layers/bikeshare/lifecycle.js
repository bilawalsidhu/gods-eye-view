import * as Cesium from 'cesium';
import { GBFS_CITY_REGISTRY } from './registry.js';
import { BIKESHARE_SELECTED_OVERLAY_SOURCE_ID } from './policy.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { registerSpriteCollection, restoreSpriteOrder } = services.sprites;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  const methods = {
    /**
     * Initialize the bikeshare layer. Creates the point primitive collection,
     * resets all internal state, and installs the click handler.
     * Called once during app bootstrap.
     * @param {Cesium.Viewer} viewer - Cesium viewer instance.
     */
    init(viewer) {
      layerState._viewer = viewer;
      layerState._pointCollection = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(layerState._pointCollection);
      registerSpriteCollection('bikeshare', layerState._pointCollection);
      layerState._pointCollection.show = false;

      layerState._enabled = false;
      layerState._cameraDebounceTimer = null;
      layerState._cameraChangedAttached = false;
      layerState._altitudeGateEnabled = false;
      layerState._proximityGeneration = 0;

      layerState._activeCityIds = new Set();
      layerState._cityRuntime = new Map();
      layerState._stationInfoCache = new Map();
      layerState._statusCache = new Map();
      layerState._inFlightInfo = new Map();
      layerState._inFlightStatus = new Map();
      layerState._stationRenderMap = new Map();
      layerState._clickHandler = null;
      layerState._selectedKey = null;
      layerState._selectedEntity = null;
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._loading = false;
      layerState._loadingOps = 0;
      layerState._failedCityIds.clear();
      layerState._limitWarned = false;

      layerState._overlayHost.setVisible(
        BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
        false,
      );

      parts.selection._installClickHandler(viewer);

      restoreSpriteOrder(viewer);

      console.log(
        `[Data:Bikeshare] Initialized with ${GBFS_CITY_REGISTRY.length} cities`,
      );
    },

    /**
     * Enable the bikeshare layer. Shows points, attaches the camera listener,
     * and triggers an initial proximity check.
     * @param {Cesium.Viewer} viewer - Cesium viewer instance.
     */
    enable(viewer) {
      layerState._enabled = true;
      layerState._failedCityIds.clear();
      layerState._pointCollection.show = true;
      layerState._overlayHost.setVisible(
        BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
        true,
      );
      parts.selection._installClickHandler(viewer);
      // Pick-ownership (H2): station point ids are string render-map keys.
      registerPickOwner('bikeshare', (pickedId) =>
        layerState._stationRenderMap.has(pickedId),
      );

      if (!layerState._cameraChangedAttached) {
        viewer.camera.changed.addEventListener(parts.viewport.onCameraChanged);
        // Through the shared ledger: this is a single number every layer's
        // camera.changed listener shares, and a layer leaving must not hand
        // back a coarse default while this one is still driving off it.
        claimCameraSensitivity(viewer.camera, 'bikeshare', 0.05);
        layerState._cameraChangedAttached = true;
      }

      void parts.viewport.runProximityCheck();
      restoreSpriteOrder(viewer);
    },

    /**
     * Disable the bikeshare layer. Hides points, removes event listeners,
     * aborts all pending fetches, and tears down all city data.
     * @param {Cesium.Viewer} viewer - Cesium viewer instance.
     */
    disable(viewer) {
      layerState._enabled = false;
      layerState._proximityGeneration++;
      layerState._altitudeGateEnabled = false;
      clearTimeout(layerState._cameraDebounceTimer);
      layerState._cameraDebounceTimer = null;
      parts.selection._clearSelection();
      layerState._overlayHost.setVisible(
        BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
        false,
      );

      if (layerState._clickHandler) {
        layerState._clickHandler.destroy();
        layerState._clickHandler = null;
      }
      document.removeEventListener('keydown', parts.selection._onKeyDown);
      unregisterPickOwner('bikeshare');

      if (layerState._cameraChangedAttached) {
        viewer.camera.changed.removeEventListener(
          parts.viewport.onCameraChanged,
        );
        releaseCameraSensitivity(viewer.camera, 'bikeshare');
        layerState._cameraChangedAttached = false;
      }

      parts.ingestion.abortAllInFlight();
      parts.viewport.deactivateAllCities();
      layerState._cityRuntime.clear();
      layerState._pointCollection.show = false;
      layerState._count = 0;
      layerState._loading = false;
      layerState._loadingOps = 0;
    },

    /** Permanently release primitives, handlers, and the selected host source. */
    destroy(viewer) {
      if (layerState._enabled) this.disable(viewer);
      else {
        parts.selection._clearSelection();
        layerState._overlayHost.setVisible(
          BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
          false,
        );
        if (layerState._clickHandler) {
          layerState._clickHandler.destroy();
          layerState._clickHandler = null;
        }
        document.removeEventListener('keydown', parts.selection._onKeyDown);
        unregisterPickOwner('bikeshare');
      }
      if (layerState._cameraChangedAttached) {
        viewer.camera.changed.removeEventListener(
          parts.viewport.onCameraChanged,
        );
        releaseCameraSensitivity(viewer.camera, 'bikeshare');
        layerState._cameraChangedAttached = false;
      }
      parts.ingestion.abortAllInFlight();
      if (layerState._pointCollection) {
        viewer.scene.primitives.remove(layerState._pointCollection);
        layerState._pointCollection = null;
      }
      layerState._viewer = null;
    },
  };

  return { methods };
}
