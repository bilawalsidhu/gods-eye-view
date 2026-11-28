import { DEFAULT_FIRE_FILTER } from '../../data/firmsIntensity.js';

export function createFirmsState({ services, config }) {
  const layerState = {};

  /** Pre-baked radial-glow sprites keyed by color stop name. */

  layerState.glowSpriteCache = new Map();

  layerState._viewer = null;

  /**
   * The layer's own shape set (made at `init`): empty since the heat became
   * draped imagery, it marks the layer initialized and carries the `show`
   * the context store reads.
   */

  layerState._cells = null;

  /** The detection glows' icon draw set (made with the first render). */

  layerState._icons = null;

  layerState._enabled = false;

  layerState._destroyed = false;

  layerState._loading = false;

  /** True when the proxy answered 503 {error:'no_key'} — FIRMS_MAP_KEY unset. */

  layerState._keyRequired = false;

  /** True when the proxy served a cached payload past TTL (upstream failing). */

  layerState._stale = false;

  /** Surfaced error string when the live fetch failed outright. */

  layerState._error = null;

  /** Every adapted detection in the current payload, before the filter. */

  layerState._allFires = [];

  /** `_allFires` sorted by FRP descending, once per payload. */

  layerState._allFiresByFrp = [];

  /**
   * The detections that pass the intensity filter — the ONLY set rendering,
   * selection, cells, the top-fires query and the analyst records ever walk.
   */

  layerState._fires = [];

  layerState._firesByFrp = [];

  /** Shown (filtered) detection count. */

  layerState._count = 0;

  /** Loaded detection count before the filter ("N of M shown"). */

  layerState._totalCount = 0;

  /** Minimum FRP (MW) and confidence mode; see firmsIntensity.js. */

  layerState._filter = { ...DEFAULT_FIRE_FILTER };

  /** Panel callback: repaint the row controls (counter) after a load. */

  /** @type {{ invalidate: () => void } | null} the panels' handle, from init */
  layerState._panel = null;

  layerState._cellCount = 0;

  layerState._lastUpdate = null;

  layerState._at = null;

  layerState._currentLodId = null;

  layerState._currentLodIndex = -1;

  layerState._lastViewRect = null;

  layerState._preRenderRemover = null;

  layerState._moveEndSettleRemover = null;

  layerState._lastLodCheck = 0;

  layerState._contextIds = new Set();

  layerState._clickSubscription = null;

  layerState._moveEndRemover = null;

  layerState._selectedFire = null;

  /**
   * What an application draws in place of the markers (`setMarkerStandIn`):
   * while set, the glows, heatmap and ambient cards are hidden and clicks
   * resolve through its `hitTest`.
   */

  layerState._standIn = null;

  /** Priority-ordered label candidates from the last rebuild (detections or cells). */

  layerState._labelCandidates = [];

  layerState._labelLodDistance = 0;

  /** pick id string -> fire record, for the currently rendered sprites. */

  layerState._pickIndexById = new Map();

  /** Actionable card id -> current detection record painted for that id. */

  layerState._fireByCardId = new Map();

  /**
   * gridDegrees -> heat-sorted full cell list. The full-grid aggregation is
   * viewport-independent but walks every detection (~200k live), so it is
   * computed once per grid size per data refresh; renders only clip + cap
   * (field-test round 1: intermediate-zoom chug during LOD rebuilds).
   * @type {Map<number, Array<Object>>}
   */

  layerState._cellCacheByGrid = new Map();

  /**
   * Heat raster for the far bands (firmsHeatRaster.js); null = stale, rebuilt
   * on the next far render. Cleared with the cell cache on every new shown set.
   */

  layerState._heatRaster = null;

  /** Pending debounced heat rebuild (see HEAT_REBUILD_MS). */

  layerState._heatRebuildTimer = null;

  /** Last applied hand-off fade (0 markers … 1 heatmap); -1 forces a reapply. */

  layerState._handoffHeat = -1;

  /** Imagery adapter (heatImagery.js), created on the first far render. */

  layerState._heatImagery = null;

  /** Shell-provided imagery host resolver; without one, the globe. */

  layerState._imageryHost = null;

  /** Camera idle snapshot so the throttled LOD check is ~free when parked. */

  layerState._camSnapValid = false;

  layerState._camPos = { x: 0, y: 0, z: 0 };

  layerState._camDir = { x: 0, y: 0, z: 0 };
  layerState.request = null;
  return layerState;
}
