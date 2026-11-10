import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
import * as geo from '../../geo/index.js';
import { worldClock, worldTimeFor } from '../../time/worldClock.js';

export function createState({ services }) {
  const { setEntries, setVisible, clearSource } = bindOverlayHost(
    services.overlays,
    () => state._engine,
  );
  const state = {};

  state.DEFAULT_OVERLAY_HOST = Object.freeze({
    setEntries: setEntries,
    setVisible: setVisible,
    clearSource: clearSource,
  });

  // The layer's records of what it draws, by pick id (rendering.js).
  state._missionElements = new Map();

  state._count = 0;

  state._lastUpdate = null;

  state._lastError = null;

  state._lastErrorAt = null;

  state._entryCameraView = null;

  state._entryLandedView = null;

  /** Navigation took the camera; set until the layer flies again. */
  state._cameraReleased = false;

  state._stale = false;

  state._orbitMatches = 0;

  state._clickHandler = null;

  state._moveHandler = null;

  state._declutterHandler = null;

  state._dataManager = null;

  state._retryTimer = null;

  state._postTleRetryCount = 0;

  state._updatePromise = null;

  state._updatePromiseToken = 0;

  state._updateDirty = false;

  state._lifecycleToken = 0;

  state._enabled = false;

  state._selectedLaunchId = null;

  state._explicitSelection = false;

  state._launches = [];

  state._missionPanelReady = false;

  state._missionPanelView = null;

  state._missionPanelSignature = null;

  state._missionPanelListeners = new Set();

  state._missionRosterView = null;

  state._missionRosterSignature = null;

  state._missionTelemetry = null;

  state._missionPanelScrollRequest = 0;

  state._missionRosterHoverTimer = null;

  state._hoveredRosterLaunchId = null;

  state._missionRosterPreviewOwnership = null;

  state._missionHoverReticleImage = null;

  // The replay vehicle overlay as its view renders it; null without one.
  state._replayVehicleOverlay = null;

  state._replayVehicleOverlayListeners = new Set();

  state._animationStarts = new Map();

  state._satelliteTelemetry = new Map();

  state._lastPanelTelemetryMs = 0;

  state._lastMissionRingRotationMs = 0;

  state._activeTleText = null;

  state._activeTlePromise = null;

  state._activeTlePromiseToken = 0;

  state._renderedTleText = null;

  state._focusAfterActiveLookup = false;

  // The mission whose orbit view the user asked for last; any later camera
  // command of this layer (a flyover, a launch-site view) clears it, so a late
  // active-satellite answer can reframe only a view nobody has left.
  state._missionFocusIntentId = null;

  state._satelliteStateBeforeMission = null;

  state._satelliteActivationPromise = null;

  state._replayCameraRemover = null;

  state._replayCameraLaunchId = null;

  state._replayCameraToken = 0;

  state._replayPaused = false;

  state._replayTransportLabel = null;

  state._replayPausedAtMs = null;

  state._replaySpeed = 1;

  state._replayTracks = new Map();
  state._replayCameraHeading = null;

  state._missionOverlayRecords = new Map();

  state._missionOverlayHost = state.DEFAULT_OVERLAY_HOST;

  state._selectedMissionOverlayTimeText = null;

  state._missionZoomAnchorRemover = null;

  state._missionZoomAnchorId = null;

  state._launchPadZonePrimitive = null;

  state._launchPadZoneRemover = null;

  state._launchPadZoneLaunchId = null;

  state._missionOrbitPrimitives = new Map();

  // The display (render/display.js) and the engine it draws on.
  state._renderer = null;
  state._engine = null;

  state._missionRingDate = new Date(0);

  /** The time the launch window ends at, in epoch ms. */

  state.now = worldTimeFor('rocket-launches');

  /** A launched mission's satellite flies on the satellites layer's time. */

  state.orbitNow = worldTimeFor('satellites');

  /** The launches loaded changed, and with them the time they cover. */

  state.coverageChanged = () => worldClock.coverageChanged();

  /**
   * Whether a launch has yet to lift off at the world time. While live none
   * has, so the layer shows every launch in its window as it always did.
   */

  state.launchPending = (launch) => {
    if (worldClock.isLive()) return false;
    const launchMs = Date.parse(launch?.launchTime);
    return Number.isFinite(launchMs) && launchMs > state.now();
  };

  /** Whether a launch is hidden for lifting off after the world time. */

  state.launchHidden = (launch) =>
    launch?.id !== state._selectedLaunchId && state.launchPending(launch);

  /** The launches hidden at the last frame, by id, to spot a change. */

  state._pendingLaunchIds = new Set();

  state._pathDistanceCache = new WeakMap();
  state._sourceController = new AbortController();
  return state;
}
