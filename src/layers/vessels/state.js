import { createVesselFeed } from './ingestion.js';
import { VesselRecords } from './records.js';
import * as Cesium from 'cesium';
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

  vesselState._scratchFocusScreen = new Cesium.Cartesian2();

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

  /** @type {Map<string, string>} `${cssColor}:${variant}` -> chevron SVG data URL */

  vesselState.shipIconCache = new Map();

  vesselState.state = {
    feed: createVesselFeed(),
    records: new VesselRecords({ now: () => vesselState.recordsNow() }),
    viewer: null,

    billboardCollection: null,
    clickHandler: null,
    /** Exact EventTarget currently holding the Escape listener. */
    keyTarget: null,
    /** Exact callback registered on keyTarget. */
    keydownHandler: null,
    /** Cesium trackedEntityChanged listener disposer. */
    trackedEntityRemover: null,
    /** Test-only factory used to exercise enable-time interaction installation. */
    interactionHandlerFactory: null,
    /** Test-only key target paired with interactionHandlerFactory. */
    interactionKeyTarget: null,
    preRenderRemover: null,
    /** Pending timer that renders one frame after a cadence-skipped pass. */
    trailingVisibilityTimer: null,
    lastVisibilityUpdate: 0,
    lastFocusUpdate: 0,
    /** Sprites whose animated emphasis remains outside the 1.0 deadband. */
    activeFocusCount: 0,
    activeLabelCount: 0,
    selectedRecord: null,
    /** @type {string|null} Id of the vessel whose bridge the Cockpit camera occupies; its sprite and card stay hidden. */
    cockpitSubjectId: null,
    /** @type {{setPositions: Function, clear: Function, destroy: Function}|null} Selected-vessel fading trail */
    trail: null,
    /** @type {Cesium.Cartesian3[]} Chronological trail vertices (oldest first) */
    trailPositions: [],
    /** @type {string|null} Id of the vessel that owns the active selected-vessel trail. */
    trailId: null,
    /** @type {number} Monotonic token — invalidates in-flight backfill responses */
    trailBackfillToken: 0,
    trailAbort: null,
  };
  return vesselState;
}
