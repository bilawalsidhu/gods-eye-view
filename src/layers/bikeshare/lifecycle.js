import { GBFS_CITY_REGISTRY } from './registry.js';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  CAMERA_CHANGED_THRESHOLD,
} from './policy.js';
import { cameraOf } from '../../render/rendererOf.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { restoreSpriteOrder } = services.sprites;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  /** Stop listening to the camera, if the layer is. */
  function detachCamera() {
    layerState._cameraChangedOff?.();
    layerState._cameraChangedOff = null;
  }

  const methods = {
    /**
     * Initialize the bikeshare layer. Makes the station draw sets on the
     * viewer's renderer (`drawOf`), resets all internal state, and installs
     * the click handler. Called once during app bootstrap. Given a Cesium
     * viewer with no renderer bound, the caller loads
     * the package's `./render/cesium/unbound` export first.
     * @param {object} viewer - The viewer the layer draws on.
     */
    init(viewer) {
      parts.rendering.attachSets(viewer);
      layerState._viewer = viewer;

      layerState._enabled = false;
      layerState._cameraDebounceTimer = null;
      detachCamera();
      layerState._altitudeGateEnabled = false;
      layerState._proximityGeneration = 0;

      layerState._activeCityIds = new Set();
      layerState._cityRuntime = new Map();
      layerState._stationInfoCache = new Map();
      layerState._statusCache = new Map();
      layerState._inFlightInfo = new Map();
      layerState._inFlightStatus = new Map();
      layerState._stationRenderMap = new Map();
      layerState._clickSubscription = null;
      layerState._selectedKey = null;
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
     * @param {object} viewer - The viewer the layer draws on.
     */
    enable(viewer) {
      layerState._enabled = true;
      layerState._failedCityIds.clear();
      layerState._stationSet.show = true;
      layerState._overlayHost.setVisible(
        BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
        true,
      );
      parts.selection._installClickHandler(viewer);
      // Pick-ownership (H2): station point ids are string render-map keys.
      registerPickOwner('bikeshare', (pickedId) =>
        layerState._stationRenderMap.has(pickedId),
      );

      if (!layerState._cameraChangedOff) {
        // Its own threshold: the camera measures it for this listener alone.
        layerState._cameraChangedOff = cameraOf(viewer).on(
          'changed',
          parts.viewport.onCameraChanged,
          { threshold: CAMERA_CHANGED_THRESHOLD },
        );
      }

      void parts.viewport.runProximityCheck();
      restoreSpriteOrder(viewer);
    },

    /**
     * Disable the bikeshare layer. Hides points, removes event listeners,
     * aborts all pending fetches, and tears down all city data.
     */
    disable() {
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

      layerState._clickSubscription?.();
      layerState._clickSubscription = null;
      document.removeEventListener('keydown', parts.selection._onKeyDown);
      unregisterPickOwner('bikeshare');

      detachCamera();

      parts.ingestion.abortAllInFlight();
      parts.viewport.deactivateAllCities();
      layerState._cityRuntime.clear();
      if (layerState._stationSet) layerState._stationSet.show = false;
      layerState._count = 0;
      layerState._loading = false;
      layerState._loadingOps = 0;
    },

    /** Permanently release draw sets, handlers, and the selected host source. */
    destroy() {
      if (layerState._enabled) this.disable();
      else {
        parts.selection._clearSelection();
        layerState._overlayHost.setVisible(
          BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
          false,
        );
        layerState._clickSubscription?.();
        layerState._clickSubscription = null;
        document.removeEventListener('keydown', parts.selection._onKeyDown);
        unregisterPickOwner('bikeshare');
      }
      detachCamera();
      parts.ingestion.abortAllInFlight();
      parts.rendering.detachSets();
      layerState._viewer = null;
    },
  };

  return { methods };
}
