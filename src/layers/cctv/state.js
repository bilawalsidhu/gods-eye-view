import * as Cesium from 'cesium';

export function createState({ services }) {
  const {
    clearOverlaySource,
    hitTestWorldOverlay,
    setOverlayEntries,
    setOverlaySourceVisible,
  } = services.overlays;
  const layerState = {};

  // ---------------------------------------------------------------------------
  // Module-scoped mutable state
  // ---------------------------------------------------------------------------

  layerState._viewer = null;

  layerState._billboards = null;

  layerState._records = [];

  layerState._recordById = new Map();

  layerState._coverageEntities = [];

  layerState._projectionEntities = [];

  layerState._enabled = false;

  layerState._activeCameraId = null;

  layerState._coverageMode = 'on';
  // 'off' | 'on' (wireframes) | 'viewshed' (color-coded volumes)

  layerState._showProjection = true;

  layerState._autoHop = false;

  // An explicit empty-space deselect keeps AUTO HOP configured but prevents its
  // timer from silently choosing a replacement. A later explicit activation or
  // AUTO HOP toggle-on releases the hold.

  layerState._autoHopSuspended = false;

  layerState._autoHopSec = 18;

  layerState._lastHopAt = 0;

  layerState._lastViewContext = '';

  layerState._clickHandler = null;

  layerState._count = 0;
  layerState._catalogFromSeeds = false;

  layerState._lastUpdate = null;

  layerState._lastHealthSyncAt = 0;

  layerState._lastError = null;

  layerState._healthById = new Map();

  layerState._calibrationById = new Map();

  layerState._listeners = new Set();

  layerState._projectionRaf = 0;

  layerState._removeFocusAppearListener = null;

  layerState._lastFocusStyleAt = 0;

  /** Icons whose animated emphasis remains outside the 1.0 deadband. */

  layerState._activeFocusStyleCount = 0;

  layerState._scratchFocusScreen = new Cesium.Cartesian2();

  // Staggered geometry-load queue state (see startGeometryLoadQueue).

  layerState._geoQueue = [];

  layerState._geoQueueTimer = 0;

  layerState._geoLoading = false;

  layerState._geoLoadTotal = 0;

  layerState._geoLoadDone = 0;

  layerState._geoProgressNotifier = null;

  // One-shot completion latch for shared floor resolution: the enable-time queue
  // can drain while DEM cells or 3D tiles are still loading. The first update()
  // tick that sees projectionTilesReady() re-enqueues unresolved records ONCE;
  // shared mesh cells remain one-shot and idle ticks stay sample-free. Reset by
  // startGeometryLoadQueue so each enable-time drain gets its own completion pass.

  layerState._tilesReadyReenqueued = false;

  // Calibration ADJUST mode (viewshed/gizmo design §3c): while true, the active
  // camera renders the direct-manipulation gizmo. Reset on layer disable.

  layerState._calibrationMode = false;

  layerState._gizmo = null;

  layerState._lastTransientNotifyAt = 0;

  // Cached handle on the active Google Photorealistic 3D Tileset, discovered
  // lazily from scene.primitives. Shared mesh-floor sampling is gated on its
  // tilesLoaded flag so a coarse-LOD miss is never baked in. Cleared when the
  // tileset is destroyed / the layer tears down.

  layerState._activeTileset = null;

  // Task 5: last surface regime the record geometry was recomputed for. The
  // map-stack change listener compares the CURRENT regime (derived live from
  // scene.globe.show) against this so bing→osm switches (same 'terrain-globe'
  // regime) don't trigger a pointless full-catalog rewrite.

  layerState._lastAppliedRegime = null;

  // Task 5: window listener handle for the 'gev:map-stack-changed' CustomEvent
  // main.js dispatches from MapStackController's onChange (removed in destroy).

  layerState._mapStackListener = null;

  // Field-test fix (2026-07-06): camera.moveEnd handle for the horizon-culling
  // pass (removed in destroy). Event-driven only — never a per-frame loop, so
  // the zero-steady-state-work invariant holds.

  layerState._horizonCullListener = null;

  // Ambient card tier state (2026-07-29 design). The card set is rebuilt only
  // on moveEnd/enable/activation (refreshAmbientCards); frame slots are STABLE
  // objects shared with the overlay host so landed frames appear without an
  // entry rebuild.

  layerState._cardIds = new Set();

  /** @type {Map<string,{misses:number,since:number}>} */

  layerState._cardGraceState = new Map();

  /** @type {Map<string,{frame:*, stamp:number, failCount:number, lastAttemptAt:number}>} */

  layerState._cardFrameSlots = new Map();

  layerState._cardFetchTimer = 0;

  /** In-flight card-frame fetch count (burst allows up to 4, steady is 1). */

  layerState._cardFetchInFlightCount = 0;

  /** @type {Set<HTMLImageElement>} in-flight fetches, detached on teardown. */

  layerState._cardFetchImages = new Set();

  /** @type {Set<string>} camera ids with an in-flight fetch (no double-fetch). */

  layerState._cardFetchPendingIds = new Set();

  layerState._cardFetchCount = 0;

  layerState._cardLastFetchAt = 0;

  layerState._cardMinFetchSpacingMs = null;

  /** Pacer mode telemetry: 'burst' during cold fill, 'steady' after. */

  layerState._cardFetchMode = 'steady';

  layerState.DEFAULT_CCTV_OVERLAY_HOST = Object.freeze({
    clearSource: clearOverlaySource,
    hitTest: hitTestWorldOverlay,
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
  });

  layerState._cctvOverlayHost = layerState.DEFAULT_CCTV_OVERLAY_HOST;

  layerState._projectionOverlayOwnerId = null;

  /**
   * Product presentation option. Shipped behavior keeps the active camera's
   * thumbnail absent because its monitor plane is the active representation.
   */

  layerState._activeCameraCardEnabled = false;

  /** Camera id currently holding the hover-summoned pinned card (or null). */

  layerState._hoverCardId = null;

  layerState._hoverReleaseTimer = 0;

  layerState._hoverLastPickAt = 0;

  // True between camera.moveStart and moveEnd — hover picking pauses while the
  // camera is in motion (picks during a flight would fight the reselection).

  layerState._cameraMoving = false;

  layerState._moveStartListener = null;
  layerState._sourceAbort = null;
  return layerState;
}
