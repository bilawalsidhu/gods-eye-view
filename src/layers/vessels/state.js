import { createVesselFeed } from './ingestion.js';
import { VesselRecords } from './records.js';
import { DEFAULT_AIS_RUNTIME, followsClock } from './policy.js';
import { worldTimeFor } from '../../time/worldClock.js';

export function createVesselState({ source, services }) {
  const {
    setOverlayEntries,
    setOverlaySourceVisible,
    clearOverlaySource,
    hitTestWorldOverlay,
  } = services.overlay;
  const vesselState = {};

  vesselState._source = source;

  /** Camera pose signature at the last vessel rotation pass. */

  vesselState._lastCamPoseSig = '';

  vesselState.DEFAULT_VESSEL_OVERLAY_HOST = Object.freeze({
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
    hitTest: hitTestWorldOverlay,
  });

  vesselState._vesselOverlayHost = vesselState.DEFAULT_VESSEL_OVERLAY_HOST;

  vesselState._aisRuntime = DEFAULT_AIS_RUNTIME;

  /** Follows the world clock while the source declares a timeline (set by the
   *  layer); see followsClock in policy.js. */
  vesselState.timeline = null;

  /** The world time the layer draws at while it follows the clock. */
  vesselState.worldNow = worldTimeFor('ais-live-vessels');

  /** The time records are judged at: the world's while following the clock. */
  vesselState.recordsNow = () =>
    followsClock(vesselState)
      ? vesselState.worldNow()
      : vesselState._aisRuntime.now();

  vesselState._aisSessionSequence = 0;

  /**
   * True once the EGM96 geoid grid has loaded (fire-and-forget warm at
   * enable(), aircraft idiom — see militaryFlights.js). Gates all synchronous
   * geoidHeight() reads so a poll can never throw pre-load.
   * @type {boolean}
   */

  vesselState._geoidReady = false;

  /** Row ids for unkeyed (no-id) records, which are rebuilt every poll. */

  vesselState._unkeyedIconSequence = 0;
  // The ship whose icon is hidden under the bridge camera (cockpit subject).
  vesselState._iconHiddenId = null;

  vesselState.state = {
    feed: createVesselFeed(),
    records: new VesselRecords({ now: () => vesselState.recordsNow() }),
    viewer: null,

    /** The vessels' icons as drawn (`iconBook.js`), and their draw set. */
    icons: null,
    /** The click subscription's unsubscribe. */
    clickSubscription: null,
    /** Exact EventTarget currently holding the Escape listener. */
    keyTarget: null,
    /** Exact callback registered on keyTarget. */
    keydownHandler: null,
    /** Follow-change listener disposer. */
    trackedEntityRemover: null,
    /** Test-only key target for enable-time interaction installation. */
    interactionKeyTarget: null,
    preRenderRemover: null,
    /** Pending timer that renders one frame after a cadence-skipped pass. */
    trailingVisibilityTimer: null,
    lastVisibilityUpdate: 0,
    /** Following the clock, the world time the last visibility pass drew. */
    visibilityWorldMs: null,
    lastFocusUpdate: 0,
    /** Sprites whose animated emphasis remains outside the 1.0 deadband. */
    activeFocusCount: 0,
    activeLabelCount: 0,
    selectedRecord: null,
    /** What the camera follows the selected ship with, while asked to (`followSelected`). */
    followTarget: null,
    /** @type {string|null} Id of the vessel whose bridge the Cockpit camera occupies; its sprite and card stay hidden. */
    cockpitSubjectId: null,
    /** @type {{setPositions: Function, clear: Function, destroy: Function}|null} Selected-vessel fading trail */
    trail: null,
    /** @type {{x: number, y: number, z: number}[]} Chronological ECEF trail vertices (oldest first) */
    trailPositions: [],
    /** @type {number[]} Epoch ms of each trail vertex (NaN: undated, drawn
     *  at any time), parallel to trailPositions. */
    trailTimes: [],
    /** How many trail vertices the body draws now, or -1 before it draws. */
    trailBodyCount: -1,
    /** @type {(() => void)|null} Stops drawing the trail's head each frame. */
    trailHeadOff: null,
    /** @type {string|null} Id of the vessel that owns the active selected-vessel trail. */
    trailId: null,
    /** @type {number} Monotonic token — invalidates in-flight backfill responses */
    trailBackfillToken: 0,
    trailAbort: null,
  };
  return vesselState;
}
