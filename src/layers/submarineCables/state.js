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

  state._cableDataSource = null;

  state._landingDataSource = null;

  state._referenceDataSource = null;

  /**
   * Fetched cable/landing JSON kept across disable/enable. A disable RELEASES
   * the three data sources (see releaseDataSources) instead of hiding them,
   * so a re-enable has to rebuild the entities; the network/parse half of
   * that rebuild is the expensive part users would notice, so it is cached.
   */

  state._cachedCableJson = null;

  state._cachedLandingJson = null;

  state._referenceRecords = [];

  state._surfaceRecords = [];

  state._clickHandler = null;

  state._preRenderRemover = null;

  state._moveEndRemover = null;

  state._mapStackListener = null;

  /** Active ground-line classification; refined from live scene state at init. */

  state._classificationType = Cesium.ClassificationType.BOTH;

  /** True once both marker collections blend translucent (or the shape probe failed). */

  state._markerBlendDone = false;

  state._markerBlendInvariantWarned = false;

  state._pickByEntity = new WeakMap();

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
