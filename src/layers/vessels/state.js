import { createVesselFeed } from './ingestion.js';
import { VesselRecords } from './records.js';
import * as Cesium from 'cesium';
import { DEFAULT_AIS_RUNTIME } from './policy.js';

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

  vesselState._aisSessionSequence = 0;

  /**
   * True once the EGM96 geoid grid has loaded (fire-and-forget warm at
   * enable(), aircraft idiom — see militaryFlights.js). Gates all synchronous
   * geoidHeight() reads so a poll can never throw pre-load.
   * @type {boolean}
   */

  vesselState._geoidReady = false;
  vesselState._presentationSuppressed = false;

  /** @type {Map<string, string>} `${cssColor}:${variant}` -> chevron SVG data URL */

  vesselState.shipIconCache = new Map();

  vesselState.state = {
    feed: createVesselFeed(),
    records: new VesselRecords({ now: () => vesselState._aisRuntime.now() }),
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
    lastVisibilityUpdate: 0,
    lastFocusUpdate: 0,
    /** Sprites whose animated emphasis remains outside the 1.0 deadband. */
    activeFocusCount: 0,
    activeLabelCount: 0,
    selectedRecord: null,
    /** @type {{setPositions: Function, clear: Function, destroy: Function}|null} Selected-vessel fading trail */
    trail: null,
    /** @type {Cesium.Cartesian3[]} Chronological trail vertices (oldest first) */
    trailPositions: [],
    /** @type {string|null} MMSI that owns the active selected-vessel trail. */
    trailMmsi: null,
    /** @type {number} Monotonic token — invalidates in-flight backfill responses */
    trailBackfillToken: 0,
    trailAbort: null,
  };
  return vesselState;
}
