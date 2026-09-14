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

  state._dataSource = null;

  state._count = 0;

  state._lastUpdate = null;

  state._lastError = null;

  state._orbitMatches = 0;

  state._clickHandler = null;

  state._moveHandler = null;

  state._viewer = null;

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

  state._missionPanel = null;

  state._missionRoster = null;

  state._missionRosterHoverTimer = null;

  state._hoveredRosterLaunchId = null;

  state._missionRosterPreviewOwnership = null;

  state._missionHoverReticleImage = null;

  state._replayVehicleOverlay = null;

  state._replayVehicleOverlayText = '';

  state._animationStarts = new Map();

  state._satelliteTelemetry = new Map();

  state._lastPanelTelemetryMs = 0;

  state._lastMissionRingRotationMs = 0;

  state._activeTleText = null;

  state._activeTlePromise = null;

  state._activeTlePromiseToken = 0;

  state._renderedTleText = null;

  state._focusAfterActiveLookup = false;

  state._satelliteStateBeforeMission = null;

  state._satelliteActivationPromise = null;

  state._replayCameraRemover = null;

  state._replayCameraLaunchId = null;

  state._replayCameraToken = 0;

  state._replayPaused = false;

  state._replayPausedAtMs = null;

  state._replaySpeed = 1;

  state._replayTracks = new Map();

  state._missionOverlayRecords = new Map();

  state._missionOverlayHost = state.DEFAULT_OVERLAY_HOST;

  state._selectedMissionOverlayTimeText = null;

  state._missionZoomAnchorRemover = null;

  state._missionZoomAnchorId = null;

  state._launchPadZonePrimitive = null;

  state._launchPadZoneRemover = null;

  state._launchPadZoneLaunchId = null;

  state._missionOrbitPrimitives = new Map();

  state._declutterTime = new Cesium.JulianDate();

  state._declutterOccluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    new Cesium.Cartesian3(),
  );

  state._missionRingDate = new Date(0);

  state._missionOrbitPatternRegistered = false;

  state._pathDistanceCache = new WeakMap();
  state._sourceController = new AbortController();
  return state;
}
