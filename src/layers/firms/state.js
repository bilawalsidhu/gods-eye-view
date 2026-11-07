export function createFirmsState({ services, config }) {
  const layerState = {};

  /** Pre-baked radial-glow sprites keyed by color stop name. */

  layerState.glowSpriteCache = new Map();

  layerState._viewer = null;

  /** The heat cells' draw set (made at `init`). */

  layerState._cells = null;

  /** Detection glow rows and the primitive that draws them. */

  layerState._icons = null;

  layerState._iconPrimitive = null;

  layerState._enabled = false;

  layerState._destroyed = false;

  layerState._loading = false;

  /** True when the proxy answered 503 {error:'no_key'} — FIRMS_MAP_KEY unset. */

  layerState._keyRequired = false;

  /** True when the proxy served a cached payload past TTL (upstream failing). */

  layerState._stale = false;

  /** Surfaced error string when the live fetch failed outright. */

  layerState._error = null;

  layerState._fires = [];

  layerState._firesByFrp = [];

  layerState._count = 0;

  layerState._cellCount = 0;

  layerState._lastUpdate = null;

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

  /** Camera idle snapshot so the throttled LOD check is ~free when parked. */

  layerState._camSnapValid = false;

  layerState._camPos = { x: 0, y: 0, z: 0 };

  layerState._camDir = { x: 0, y: 0, z: 0 };
  layerState.request = null;
  return layerState;
}
