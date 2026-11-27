import { DEFAULT_FIRE_FILTER } from '../../data/firmsIntensity.js';

export function createFirmsState({ services, config }) {
  return {
    /** Pre-baked radial-glow sprites keyed by color stop name. */
    glowSpriteCache: new Map(),
    _viewer: null,
    /** Set by `init`; `destroy` clears it. */
    _initialized: false,
    /** Hidden with the layer: the context store reads its `show`. */
    _visibility: { show: false },
    /** The detection glows' icon draw set (made with the first render). */
    _icons: null,
    _enabled: false,
    _destroyed: false,
    _loading: false,
    /** True when the proxy answered 503 {error:'no_key'} — FIRMS_MAP_KEY unset. */
    _keyRequired: false,
    /** True when the proxy served a cached payload past TTL (upstream failing). */
    _stale: false,
    /** Surfaced error string when the live fetch failed outright. */
    _error: null,
    /** Every adapted detection in the current payload, before the filter. */
    _allFires: [],
    /** `_allFires` sorted by FRP descending, once per payload. */
    _allFiresByFrp: [],
    /**
     * The detections that pass the intensity filter — the ONLY set rendering,
     * selection, cells, the top-fires query and the analyst records ever walk.
     */
    _fires: [],
    _firesByFrp: [],
    /** Shown (filtered) detection count. */
    _count: 0,
    /** Loaded detection count before the filter ("N of M shown"). */
    _totalCount: 0,
    /** Minimum FRP (MW) and confidence mode; see firmsIntensity.js. */
    _filter: { ...DEFAULT_FIRE_FILTER },
    /** @type {{ invalidate: () => void } | null} the panels' handle, from init */
    _panel: null,
    _cellCount: 0,
    _lastUpdate: null,
    _at: null,
    _currentLodId: null,
    _currentLodIndex: -1,
    _lastViewRect: null,
    _preRenderRemover: null,
    _moveEndSettleRemover: null,
    _lastLodCheck: 0,
    _contextIds: new Set(),
    _clickSubscription: null,
    _moveEndRemover: null,
    _selectedFire: null,
    /**
     * What an application draws in place of the markers (`setMarkerStandIn`):
     * while set, the glows, heatmap and ambient cards are hidden and clicks
     * resolve through its `hitTest`.
     */
    _standIn: null,
    /** Priority-ordered label candidates from the last rebuild (detections or cells). */
    _labelCandidates: [],
    _labelLodDistance: 0,
    /** pick id string -> fire record, for the currently rendered sprites. */
    _pickIndexById: new Map(),
    /** Actionable card id -> current detection record painted for that id. */
    _fireByCardId: new Map(),
    /**
     * gridDegrees -> heat-sorted full cell list. The full-grid aggregation is
     * viewport-independent but walks every detection (~200k live), so it is
     * computed once per grid size per data refresh; renders only clip + cap
     * (field-test round 1: intermediate-zoom chug during LOD rebuilds).
     * @type {Map<number, Array<Object>>}
     */
    _cellCacheByGrid: new Map(),
    /**
     * Heat raster for the far bands (firmsHeatRaster.js); null = stale, rebuilt
     * on the next far render. Cleared with the cell cache on every new shown set.
     */
    _heatRaster: null,
    /** Pending debounced heat rebuild (see HEAT_REBUILD_MS). */
    _heatRebuildTimer: null,
    /** Last applied hand-off fade (0 markers … 1 heatmap); -1 forces a reapply. */
    _handoffHeat: -1,
    /** Imagery adapter (heatImagery.js), created on the first far render. */
    _heatImagery: null,
    /** Shell-provided imagery host resolver; without one, the globe. */
    _imageryHost: null,
    /** Camera idle snapshot so the throttled LOD check is ~free when parked. */
    _camSnapValid: false,
    _camPos: { x: 0, y: 0, z: 0 },
    _camDir: { x: 0, y: 0, z: 0 },
    request: null,
  };
}
