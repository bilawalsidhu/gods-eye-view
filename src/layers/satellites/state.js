import * as Cesium from 'cesium';

export function createState({ services }) {
  const { setOverlayEntries, setOverlaySourceVisible, clearOverlaySource } =
    services.overlays;
  const state = {};

  state.DEFAULT_OVERLAY_HOST = Object.freeze({
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
  });

  state._overlayHost = state.DEFAULT_OVERLAY_HOST;

  // Satellite catalog: { noradId → { name, satrec, group } }

  state._catalog = new Map();

  state._pointCollection = null;

  state._points = new Map();
  // noradId → point primitive
  /** Stable lightweight records reused by the detection overlay between updates. */

  state._detectionObjects = new Map();

  // noradId → { primitive, gmstAtBake }
  // primitive is a one-instance Cesium.Primitive holding the ring baked in ECEF
  // at gmstAtBake; the preRender tick re-aligns it to current GMST by updating
  // its modelMatrix (rigid Z-rotation — no geometry rebuild, WS-D1).

  state._orbitPaths = new Map();

  state._count = 0;

  state._lastUpdate = null;

  /** @type {string|null} Surfaced feed error (e.g. CelesTrak outage) for the layer chip. */

  state._lastError = null;

  state._activeUpdateControllers = new Set();

  state._denseLoadController = null;

  state._viewer = null;

  state._preRenderListener = null;

  state._lastPropagation = 0;

  state._lastRingRotation = 0;

  state._lastFocusUpdate = 0;

  /** Points whose animated emphasis remains outside the 1.0 deadband. */

  state._activeFocusCount = 0;

  state._scratchFocusScreen = new Cesium.Cartesian2();

  state._enabled = false;

  // Click-to-track state

  state._trackedNorad = null;

  state._pendingTrackingRestore = null;

  state._trackingIntentGeneration = 0;

  state._trackingRefreshEpoch = 0;

  state._lastTrackingRefreshOutcome = {
    epoch: 0,
    status: 'unavailable',
    failedGroups: [],
  };

  state._trackedEntity = null;

  state._clickHandler = null;

  /** @type {Cesium.Event.RemoveCallback|null} trackedEntityChanged listener disposer (cross-layer untrack) */

  state._trackedEntityChangedRemove = null;

  // Runtime params (DataLayerManager.setLayerParams path)

  state._params = { catalog: 'core', showPoints: true, showOrbits: true };
  // 'core' | 'dense'

  state._denseIds = [];
  // norad ids of dense extras, round-robin order

  state._denseCursor = 0;
  // next dense id to re-propagate

  state._denseLoadToken = 0;
  // invalidates in-flight dense loads on mode flip/reload

  state._denseLoadPromise = null;

  /**
   * Dense-load lifecycle: 'idle' → 'loading' → 'ready' | 'failed'.
   * The catalog param flips synchronously but the Starlink shell arrives over
   * seconds and can fail outright (CelesTrak 502s this feed regularly), so the
   * row chip reports THIS, not the param. An active chip must mean dense points
   * are actually on screen.
   */

  state._denseStatus = 'idle';

  /** @type {string|null} Why the last dense load failed, for the chip tooltip. */

  state._denseError = null;

  /** Bumped on every bulk catalog mutation; keys the row-legend tally cache. */

  state._catalogRevision = 0;

  state._classTallyCache = { revision: -1, counts: null };

  /** @type {(() => void)|null} Manager callback: "this layer's row controls changed". */

  state._rowControlsListener = null;

  /** @type {Set<number>} NORAD ids co-located with the tracked satellite. */

  state._dockedCompanions = new Set();

  state._lastDockedScanMs = Number.NEGATIVE_INFINITY;

  // Per-frame cache for the tracked satellite (WS-D2): dot, host readout, camera, and
  // getTrackedInfo all read one SGP4 sample per rendered frame, keyed on
  // scene.frameState.frameNumber, so they never diverge in epoch.

  state._trackedFrameNumber = -1;

  state._trackedFrameGeo = null;
  // { longitude, latitude, altitude } or null

  state._trackedFrameCartesian = new Cesium.Cartesian3();

  /** Optional deterministic clock used only by the production-frame test seam. */

  state._trackedFrameNowForTest = null;

  // Scratch variables

  state._scratchCartesian = new Cesium.Cartesian3();

  state._scratchRingRotation = new Cesium.Matrix3();

  /** Update the explicit model only when the rounded altitude line changes. */
  /** Epoch of the last shared-context refresh for the tracked satellite. */

  state._contextRefreshedAtMs = 0;

  state._lookupTleText = null;

  state._lookupTleEntries = [];

  // Satellite search panel (left-stack UI) — DOM ref + current query/filter.

  state._satellitePanel = null;

  state._satelliteSearchQuery = '';

  state._satelliteSearchGroup = '';

  state._satelliteSearchDebounce = null;
  return state;
}
