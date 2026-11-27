import {
  createCableReferenceSweepGate,
  createCableOverlayPublisher,
} from './overlay.js';

export function createState({ sweepClock, overlayHost }) {
  return {
    _viewer: null,
    _enabled: false,
    _loading: false,
    _loaded: false,
    _count: 0,
    _error: null,
    _lastUpdate: null,
    _loadingLabel: '',
    _abort: null,
    /** Monotonic load-ownership token; every load() start claims a new one. */
    _loadGeneration: 0,
    /**
     * The layer's draw sets, made at init: cable and landing lines (draped),
     * pins (landing points), fills (polygons), stems and reference points.
     */
    _sets: null,
    /** Set ids this layer made, for matching picks. */
    _setIds: new Set(),
    /** What each drawn item is, by set id then item id (picks fly to it). */
    _picks: new Map(),
    /** Drawn surface items, culled by their feature's reference each sweep. */
    _surfaceItems: [],
    /**
     * Fetched cable/landing JSON kept across disable/enable. A disable CLEARS
     * the draw sets (see releaseDrawing) instead of hiding them, so a
     * re-enable has to rebuild the items; the network/parse half of that
     * rebuild is the expensive part users would notice, so it is cached.
     */
    _cachedCableJson: null,
    _cachedLandingJson: null,
    _referenceRecords: [],
    /** The cable or landing point a click named, `{ kind, featureId }`, or null:
     * its name card shows until a click lands elsewhere. */
    _selected: null,
    _clickSubscription: null,
    /** Off for the name card's side of the one map selection. */
    _selectionYield: null,
    _preRenderRemover: null,
    _moveEndRemover: null,
    _mapStackRemover: null,
    /** What ground lines drape on; refined from live scene state at init. */
    _clampTo: 'both',
    _referenceLabelCount: 0,
    _referenceSweepGate: createCableReferenceSweepGate({ now: sweepClock }),
    _overlayPublisher: createCableOverlayPublisher({ host: overlayHost }),
    /** Reused winner→entry scratch so a 2 Hz sweep allocates no arrays. */
    _publishScratch: [],
    /**
     * Last published cohort signature (ids + quantized priorities). A parked
     * camera reproduces the same winners every sweep; skipping the identical
     * republish keeps the host from requesting a render per publish, so the
     * layer stays render-governor idle exactly like its native predecessor.
     * Tip positions need no republish either: the host reprojects the same
     * mutable Cartesians on every painted frame.
     */
    _lastPublishedIds: [],
    _lastPublishedPriorities: [],
    _lastPublishedCount: -1,
  };
}
