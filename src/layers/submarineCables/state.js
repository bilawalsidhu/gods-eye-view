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
   * The layer's draw sets, made at init: cable and landing lines (draped),
   * pins (landing points), fills (polygons), stems and reference points.
   */

  state._sets = null;

  /** Set ids this layer made, for matching picks. */

  state._setIds = new Set();

  /** What each drawn item is, by set id then item id (picks fly to it). */

  state._picks = new Map();

  /** Drawn surface items, culled by their feature's reference each sweep. */

  state._surfaceItems = [];

  /**
   * Fetched cable/landing JSON kept across disable/enable. A disable CLEARS
   * the draw sets (see releaseDrawing) instead of hiding them, so a
   * re-enable has to rebuild the items; the network/parse half of that
   * rebuild is the expensive part users would notice, so it is cached.
   */

  state._cachedCableJson = null;

  state._cachedLandingJson = null;

  state._referenceRecords = [];

  /** The cable or landing point a click named, `{ kind, featureId }`, or null:
   * its name card shows until a click lands elsewhere. */
  state._selected = null;

  state._clickSubscription = null;

  /** Off for the name card's side of the one map selection. */
  state._selectionYield = null;

  state._preRenderRemover = null;

  state._moveEndRemover = null;

  state._mapStackListener = null;

  /** What ground lines drape on; refined from live scene state at init. */

  state._clampTo = 'both';

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

  state.cableColor = BASE_CABLE_COLOR;

  state.landingColor = BASE_LANDING_COLOR;
  return state;
}
