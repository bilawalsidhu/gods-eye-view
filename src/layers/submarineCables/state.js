import * as Cesium from 'cesium';
import {
  createCableReferenceSweepGate,
  createCableOverlayPublisher,
} from './overlay.js';
import { BASE_CABLE_COLOR, BASE_LANDING_COLOR } from './policy.js';

export function createState({ sweepClock, overlayHost }) {
  const state = {};

  state._viewer = null;

  state._enabled = false;

  state._loading = false;

  state._loaded = false;

  state._count = 0;

  state._error = null;

  state._lastUpdate = null;

  state._loadingLabel = '';

  state._abort = null;

  /** Monotonic load-ownership token; every load() start claims a new one. */

  state._loadGeneration = 0;

  /**
   * What the layer draws, built once per load and kept across disable/enable
   * (a disable only hides them, which costs nothing per frame):
   * one ground polyline primitive for every line, one billboard collection
   * for every point marker, a point collection for the reference tips and
   * one polyline primitive for the reference stems.
   */

  state._cablePrimitive = null;

  state._markerBillboards = null;

  state._referencePoints = null;

  /** The stems now drawn, and their replacement while it builds. */

  state._stemPrimitive = null;

  state._stemPrimitivePending = null;

  state._stemsDirty = false;

  state._referenceRecords = [];

  /** One record per drawn line: its pick record, horizon base and show state. */

  state._lineRecords = [];

  /** Line show states still to be written once the primitive is ready. */

  state._lineShowDirty = false;

  /** One record per point marker: its billboard and horizon base. */

  state._markerRecords = [];

  /** Markers the last sweep found visible but not on the ground yet; drained
   * a few per frame (CABLE_LANDING_REVEALS_PER_FRAME). */

  state._pendingLandingReveals = [];

  /** The pick records handed to Cesium as ids, so a pick is known to be ours. */

  state._pickRecords = new WeakSet();

  state._clickHandler = null;

  state._preRenderRemover = null;

  state._moveEndRemover = null;

  state._mapStackListener = null;

  /** Active ground-line classification; refined from live scene state at init. */

  state._classificationType = Cesium.ClassificationType.BOTH;

  state._referenceLabelCount = 0;

  state._referenceSweepGate = createCableReferenceSweepGate({
    now: sweepClock,
  });

  state._overlayPublisher = createCableOverlayPublisher({ host: overlayHost });

  /** Reused winner→entry scratch so a 2 Hz sweep allocates no arrays. */

  state._publishScratch = [];

  /**
   * Last published cohort signature (ids + quantized priorities). A parked
   * camera reproduces the same winners every sweep; skipping the identical
   * republish keeps the host from requesting a render per publish, so the
   * layer stays render-governor idle exactly like its native predecessor.
   * Tip positions need no republish either: the host reprojects the same
   * mutable Cartesians on every painted frame.
   */

  state._lastPublishedIds = [];

  state._lastPublishedPriorities = [];

  state._lastPublishedCount = -1;

  state.cableColor = Cesium.Color.fromCssColorString(BASE_CABLE_COLOR);

  state.cableOutline = Cesium.Color.BLACK.withAlpha(0.45);

  state.landingColor = Cesium.Color.fromCssColorString(BASE_LANDING_COLOR);
  return state;
}
