import * as Cesium from 'cesium';

/** Per-instance scene state. Nothing here is shared between two catalogs. */
export function createState({ services }) {
  const { setOverlayEntries, setOverlaySourceVisible, clearOverlaySource } =
    services.overlays;
  const layerState = {};

  layerState.DEFAULT_OVERLAY_HOST = Object.freeze({
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
  });
  layerState._overlayHost = layerState.DEFAULT_OVERLAY_HOST;

  /** @type {Cesium.Viewer|null} */
  layerState._viewer = null;
  /** @type {Cesium.PointPrimitiveCollection|null} One point per vehicle. */
  layerState._points = null;
  layerState._enabled = false;
  layerState._cameraChangedAttached = false;
  layerState._cameraDebounceTimer = null;
  layerState._altitudeGateOpen = false;
  /** Bumped on enable/disable so a late poll from a previous session is ignored. */
  layerState._generation = 0;
  layerState._preRenderRemove = null;
  layerState._renderHeld = false;
  layerState._clickHandler = null;
  /** @type {Map<string, object>} feedId → registry entry currently polled */
  layerState._activeFeeds = new Map();
  /** @type {Map<string, {count:number, lastUpdate:number|null, error:string|null, stale:boolean, pollSeq:number, loading:boolean}>} */
  layerState._feedStatus = new Map();
  /** @type {Map<string, {controller: AbortController, promise: Promise<void>}>} */
  layerState._inFlight = new Map();
  /** @type {Map<string, object>} vehicle key → runtime entry */
  layerState._vehicles = new Map();
  layerState._floorTimer = null;
  layerState._floorAttempts = 0;
  layerState._selectedKey = null;
  layerState._selectedCardAt = 0;
  /** @type {{ refreshLayerStats?: () => void }|null} */
  layerState._dataManager = null;
  layerState._lastUpdate = null;
  layerState._error = null;
  layerState._limitWarned = false;
  /** Injectable clock so tests can drive the glide. */
  layerState._now = () => Date.now();
  layerState._scratch = new Cesium.Cartesian3();
  return layerState;
}
