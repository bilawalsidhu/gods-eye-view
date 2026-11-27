export function createState() {
  return {
    /** @type {object|null} The viewer the layer draws on. */
    _viewer: null,
    /** @type {{ invalidate: () => void } | null} the panels' handle, from init */
    _panel: null,
    /** Draw set of the station dots (`drawOf(viewer).points`), or null. */
    _stationSet: null,
    /** Covered cities' markers, shown above the activation height, or null. */
    _coverageSet: null,
    /** The shell's camera action for a marker's flight (`attachShellServices`), or null. */
    _runNavigation: null,
    /** Draw set of the selected station's highlight dot, or null. */
    _selectedSet: null,
    _enabled: false,
    _cameraDebounceTimer: null,
    /** @type {(() => void)|null} Stops the camera `changed` listener, while attached. */
    _cameraChangedOff: null,
    /** Hysteresis flag for altitude-based activation. */
    _altitudeGateEnabled: false,
    /** Incremented on each proximity check so stale async work can bail out. */
    _proximityGeneration: 0,
    /** @type {Set<string>} City ids currently considered in-range. */
    _activeCityIds: new Set(),
    /** @type {Map<string, { stationKeys: Set<string> }>} Rendered station keys per city. */
    _cityRuntime: new Map(),
    /** @type {Map<string, Map<string, Object>>} cityId -> stationId -> StationInfo. */
    _stationInfoCache: new Map(),
    /** @type {Map<string, { timestamp: number, statusMap: Map<string, Object> }>} */
    _statusCache: new Map(),
    /** @type {Map<string, { promise: Promise, controller: AbortController }>} */
    _inFlightInfo: new Map(),
    /** @type {Map<string, { promise: Promise, controller: AbortController }>} */
    _inFlightStatus: new Map(),
    /** @type {Map<string, Object>} Render records keyed by "cityId:stationId". */
    _stationRenderMap: new Map(),
    /** @type {(() => void)|null} Unsubscribes the station-selection click. */
    _clickSubscription: null,
    /** @type {string|null} Key of the currently selected station, or null. */
    _selectedKey: null,
    _count: 0,
    /** Timestamp (ms) of the last successful status update. */
    _lastUpdate: null,
    _loading: false,
    /** Reference count of concurrent loading operations. */
    _loadingOps: 0,
    /**
     * @type {Set<string>} City ids whose most recent fetch failed.
     *
     * Per city rather than one layer-wide flag: feeds are fetched independently,
     * so a retired operator must not mark a layer that other cities are still
     * populating as failed. Entries are dropped when their city leaves range.
     * The layer reports failure only when these cost it everything it had to
     * draw, and degraded otherwise — see `getStats()` in controls.js.
     */
    _failedCityIds: new Set(),
    /** Whether the MAX_TOTAL_POINTS cap warning has already been logged. */
    _limitWarned: false,
  };
}
