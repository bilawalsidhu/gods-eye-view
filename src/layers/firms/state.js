import * as Cesium from 'cesium';
import { DEFAULT_FIRE_FILTER } from '../../data/firmsIntensity.js';

export function createFirmsState({ services, config }) {
  const layerState = {};

  /** Pre-baked radial-glow sprites keyed by `<colorStop>:<sizeBucket>`. */

  layerState.glowSpriteCache = new Map();

  layerState.scratchViewRect = new Cesium.Rectangle();

  layerState.scratchCenterA = new Cesium.Cartographic();

  layerState.scratchCenterB = new Cesium.Cartographic();

  layerState.scratchWindowCoord = new Cesium.Cartesian2();

  layerState._viewer = null;

  layerState._dataSource = null;

  layerState._billboards = null;

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

  layerState._rowControlsListener = null;

  layerState._cellCount = 0;

  layerState._lastUpdate = null;

  layerState._currentLodId = null;

  layerState._currentLodIndex = -1;

  layerState._lastViewRect = null;

  layerState._preRenderRemover = null;

  layerState._moveEndSettleRemover = null;

  layerState._lastLodCheck = 0;

  layerState._contextIds = new Set();

  layerState._clickHandler = null;

  layerState._moveEndRemover = null;

  layerState._selectedFire = null;

  /** Priority-ordered label candidates from the last rebuild (detections or cells). */

  layerState._labelCandidates = [];

  layerState._labelLodDistance = 0;

  /** pick id string -> fire record, for the currently rendered sprites. */

  layerState._pickIndexById = new Map();

  /** Actionable card id -> current detection record painted for that id. */

  layerState._fireByCardId = new Map();

  /**
   * Occlusion-test anchors index-aligned with the billboard collection (the
   * collection is cleared and refilled in one ordered pass per rebuild, and
   * nothing else adds to it). Lifted where the render anchor sits at/below
   * the ellipsoid — see {@link fireCullPosition}.
   * @type {Array<Cesium.Cartesian3>}
   */

  layerState._cullPositions = [];

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

  /** Imagery adapter (heatImagery.js), created on the first far render. */

  layerState._heatImagery = null;

  /** Shell-provided imagery host resolver; falls back to viewer.imageryLayers. */

  layerState._imageryHost = null;

  /** Camera idle snapshot so the throttled LOD check is ~free when parked. */

  layerState._camSnapValid = false;

  layerState._camPos = new Cesium.Cartesian3();

  layerState._camDir = new Cesium.Cartesian3();
  layerState.request = null;
  return layerState;
}
