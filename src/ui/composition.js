/** Compose UI controls with the application's existing engines and layer instances. */
import { StyleManager as ApplicationShell } from './applicationShell.js';
import { LocationSearch } from './location.js';
import { CITY_POIS } from '../cityPois.js';
import {
  GLOBE_VIEW,
  flyToGlobeView,
  flyToPresetLocation,
  flyToPOI,
  searchAndFlyTo,
} from '../locations.js';
import {
  interruptCameraMotion,
  interruptGlobeRotation,
} from '../cameraVerbs.js';
import { IntelHUD } from '../hud.js';
import { ShareLinkManager } from '../sharelink.js';
import { OrbitController } from '../orbit.js';
import {
  CelestialRing,
  getKeyholeFadeTuning,
  isCelestialRingStyleSupported,
  setKeyholeFadeTuning,
} from '../celestialRing.js';
import {
  destroyTrackedReadout,
  initTrackedReadout,
} from '../data/trackedReadout.js';
import {
  activateWorldOverlayAction,
  destroyWorldOverlay,
  hitTestWorldOverlay,
  initWorldOverlay,
  subscribeWorldOverlayActions,
} from '../overlays/worldOverlay.js';
import {
  destroyDetection,
  initDetection,
  cycleMode as cycleDetectionMode,
  getDetectionDiagnostics as readDetectionDiagnostics,
  getDetectionTuning,
  getMode as getDetectionMode,
  setMode as setDetectionModeByLabel,
  suspendDetection,
  resumeDetection,
  setDetectionStyle,
  setDetectionTuning,
} from '../data/detection.js';
import { isTr3b, toggleTr3b } from '../data/tr3bRegistry.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../renderGovernor.js';
import {
  setScopeMaskEnabled,
  isScopeMaskEnabled,
  setScopeMaskFeather,
  getScopeMaskFeather,
  setScopeMaskOpacity,
  getScopeMaskOpacity,
  setScopeTerminusOverride,
  getScopeTerminusOverride,
  clampScopeTerminusPct,
} from '../scopeMask.js';
import {
  fetchRegionalBrief,
  fetchSpotWeather,
  regionalDistanceM,
  weatherCodeLabel,
} from '../data/regionalBrief.js';

export class StyleManager extends ApplicationShell {
  constructor(viewer, options = {}) {
    const weather = options.requestServices?.weather;
    // When a host replaces the brief, its view centre should only reach a
    // weather service that the host explicitly supplied.
    const hasRegionalOverride =
      typeof options.services?.fetchRegionalBrief === 'function';
    super(viewer, {
      ...options,
      services: {
        hitTestWorldOverlay,
        CITY_POIS,
        GLOBE_VIEW,
        flyToGlobeView,
        flyToPresetLocation,
        flyToPOI,
        searchAndFlyTo,
        interruptCameraMotion,
        interruptGlobeRotation,
        IntelHUD,
        ShareLinkManager,
        OrbitController,
        CelestialRing,
        getKeyholeFadeTuning,
        isCelestialRingStyleSupported,
        setKeyholeFadeTuning,
        destroyTrackedReadout,
        initTrackedReadout,
        destroyWorldOverlay,
        initWorldOverlay,
        subscribeWorldOverlayActions,
        activateWorldOverlayAction,
        destroyDetection,
        initDetection,
        cycleDetectionMode,
        readDetectionDiagnostics,
        getDetectionTuning,
        getDetectionMode,
        setDetectionModeByLabel,
        suspendDetection,
        resumeDetection,
        setDetectionStyle,
        setDetectionTuning,
        isTr3b,
        toggleTr3b,
        holdContinuousRender,
        releaseContinuousRender,
        governorRequestRender,
        setScopeMaskEnabled,
        isScopeMaskEnabled,
        setScopeMaskFeather,
        getScopeMaskFeather,
        setScopeMaskOpacity,
        getScopeMaskOpacity,
        setScopeTerminusOverride,
        getScopeTerminusOverride,
        clampScopeTerminusPct,
        fetchRegionalBrief,
        regionalDistanceM,
        weatherCodeLabel,
        LocationSearch,
        fetchSpotWeather:
          weather?.getConditions?.bind(weather) ??
          (hasRegionalOverride ? undefined : fetchSpotWeather),
        ...options.services,
      },
    });
  }
}
