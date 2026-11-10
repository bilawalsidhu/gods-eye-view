import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
export function createState({ services }) {
  const { setEntries, setVisible, clearSource } = bindOverlayHost(
    services.overlays,
    () => layerState._engine,
  );
  const layerState = {};

  layerState.DEFAULT_OVERLAY_HOST = Object.freeze({
    setEntries: setEntries,
    setVisible: setVisible,
    clearSource: clearSource,
  });

  layerState._overlayHost = layerState.DEFAULT_OVERLAY_HOST;

  // ---------------------------------------------------------------------------
  // Module-level mutable state
  // ---------------------------------------------------------------------------

  /** The globe engine the stations draw on, or null. */

  layerState._engine = null;

  /** @type {{ refreshLayerStats?: (layerId?: string) => void }|null} Manager that repaints the layer's row. */

  layerState._dataManager = null;

  /** Whether the bikeshare layer is currently enabled. */

  layerState._enabled = false;

  /** Timer handle for camera-move debounce. */

  layerState._cameraDebounceTimer = null;

  /** Whether the camera.changed listener is currently attached. */

  layerState._cameraChangedAttached = false;

  /** Hysteresis flag for altitude-based activation. */

  layerState._altitudeGateEnabled = false;

  /** Monotonic generation counter; incremented on each proximity check to cancel stale work. */

  layerState._proximityGeneration = 0;

  /** @type {Set<string>} City ids currently considered in-range. */

  layerState._activeCityIds = new Set();

  /** @type {Map<string, { stationKeys: Set<string> }>} Per-city runtime tracking of rendered station keys. */

  layerState._cityRuntime = new Map();

  /** @type {Map<string, Map<string, Object>>} Cached station information per city (cityId -> stationId -> StationInfo). */

  layerState._stationInfoCache = new Map();

  /** @type {Map<string, { timestamp: number, statusMap: Map<string, Object> }>} Cached station status per city. */

  layerState._statusCache = new Map();

  /** @type {Map<string, { promise: Promise, controller: AbortController, generation: number }>} In-flight station info requests. */

  layerState._inFlightInfo = new Map();

  /** @type {Map<string, { promise: Promise, controller: AbortController, generation: number }>} In-flight station status requests. */

  layerState._inFlightStatus = new Map();

  /** @type {Map<string, Object>} Render records keyed by "cityId:stationId". */

  layerState._stationRenderMap = new Map();

  /** @type {string|null} Key of the currently selected station, or null. */

  layerState._selectedKey = null;

  /** Total number of currently rendered station points. */

  layerState._count = 0;

  /** Timestamp (ms) of the last successful status update. */

  layerState._lastUpdate = null;

  /** Whether any GBFS fetch is currently in progress. */

  layerState._loading = false;

  /** Reference count of concurrent loading operations. */

  layerState._loadingOps = 0;

  /**
   * @type {Set<string>} City ids whose most recent fetch failed.
   *
   * Per city rather than one layer-wide flag: feeds are fetched independently,
   * so a retired operator must not mark a layer that other cities are still
   * populating as failed. Entries are dropped when their city leaves range.
   * The layer reports failure only when these cost it everything it had to
   * draw, and degraded otherwise — see `getStats()` in controls.js.
   */

  layerState._failedCityIds = new Set();

  /** Whether the MAX_TOTAL_POINTS cap warning has already been logged. */

  layerState._limitWarned = false;
  return layerState;
}
