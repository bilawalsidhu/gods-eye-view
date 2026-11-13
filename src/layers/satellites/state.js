import * as Cesium from 'cesium';
import { DEFAULT_SATELLITE_CLASSES } from './classes.js';
import { worldClock, worldTimeFor } from '../../time/worldClock.js';

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

  // Satellite catalog: { noradId → { name, satrec, group, line1, line2,
  // satelliteClass, ucs, satcat } } — class, UCS and SATCAT records from
  // src/layers/satellites/classes.js and the sources the update read.

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

  // Cache provenance belongs to admitted core and dense records separately.
  state._coreStale = false;
  // How current the SATCAT records behind the classes are: null before any
  // read, then 'current' | 'stale' | 'unavailable' (see ingestion.js).
  state._satcatState = null;
  // When _satcatState was last set (Date.now()); a current read is kept
  // SATCAT_KEEP_MS (src/layers/satellites/ingestion.js).
  state._satcatReadAtMs = Number.NEGATIVE_INFINITY;
  state._denseStale = false;

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

  state._params = {
    catalog: 'core',
    showPoints: true,
    showOrbits: true,
    // Which satellite classes show (src/layers/satellites/classes.js). Starlink
    // follows `catalog`: its points exist only in dense mode.
    classes: { ...DEFAULT_SATELLITE_CLASSES },
  };
  // 'core' | 'dense'

  /** SATCAT records (object type, status, owner) by NORAD id, last update. */
  state._satcat = new Map();

  /** The UCS pack by NORAD id, once loaded; null until then or if it failed. */
  state._ucs = null;

  /** The imaging-sensor index, once loaded; null until then or if it failed. */
  state._sensors = null;

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

  // Cockpit orbital-view hold (cockpitSubject.js): the NORAD id the Cockpit
  // camera rides, and what the hold hid so release restores exactly that.

  state._cockpitSubjectNorad = null;

  state._cockpitHiddenPoints = new Set();

  state._cockpitHiddenPath = null;

  state._cockpitHiddenDot = false;

  /** The time satellites are propagated to, in epoch ms. */

  state.now = worldTimeFor('satellites');

  /** The catalog changed, so the time satellites can be shown at may have. */

  state.coverageChanged = () => worldClock.coverageChanged();

  // Scratch variables

  state._scratchCartesian = new Cesium.Cartesian3();

  state._scratchRingRotation = new Cesium.Matrix3();

  /** Update the explicit model only when the rounded altitude line changes. */
  /** Epoch of the last shared-context refresh for the tracked satellite. */

  state._contextRefreshedAtMs = 0;

  state._lookupTleText = null;

  state._lookupTleEntries = [];
  return state;
}
