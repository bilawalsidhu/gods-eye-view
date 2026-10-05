import * as Cesium from 'cesium';
import {
  SATELLITE_STANDALONE_DEFAULTS,
  LAUNCH_PAD_ZONE_MAX_CAMERA_HEIGHT_M,
  LAUNCH_PAD_ZONE_MAX_CAMERA_DISTANCE_M,
} from './policy.js';

export function createPolicyHelpers({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Derive the temporary Satellite display mode required by Space Missions.
   * @param {object|null} currentParams Complete pre-mission Satellite parameters.
   * @returns {object} Temporary mission-specific Satellite parameters.
   */

  function satelliteParamsForSpaceMissions(currentParams) {
    return {
      ...SATELLITE_STANDALONE_DEFAULTS,
      ...(currentParams || {}),
      catalog: 'dense',
      showPoints: false,
      showOrbits: false,
    };
  }

  /**
   * Resolve the complete Satellite parameter set restored after mission mode.
   * @param {object|null} snapshot Complete pre-mission Satellite parameters.
   * @returns {object} Standalone Satellite parameters.
   */

  function satelliteParamsAfterSpaceMissions(snapshot) {
    return {
      ...SATELLITE_STANDALONE_DEFAULTS,
      ...(snapshot || {}),
    };
  }

  /**
   * Failed launch records may retain a planned orbit in Launch Library, but
   * must not be represented as a live or estimated payload in orbit.
   * @param {string|null} status Normalized Launch Library status name.
   * @returns {boolean} Whether orbital visualization is allowed.
   */

  function launchStatusAllowsOrbit(status) {
    return !/\b(?:fail(?:ed|ure)?|partial failure)\b/i.test(
      String(status || ''),
    );
  }

  /**
   * Describe only the mission paths that the selected record can actually show.
   * Launch Library may retain a target orbit after a failure, but that target is
   * not evidence of orbital insertion and cannot support a reconstructed replay.
   * @param {object|null} launch Normalized launch record.
   * @param {boolean} replayAvailable Whether a rendered ascent/orbit track exists.
   * @returns {{orbit: string|null, ascent: string, replayAvailable: boolean}}
   */

  function missionPathPresentation(launch, replayAvailable = false) {
    const orbitName =
      launch?.orbit?.name ||
      (typeof launch?.orbit === 'string' ? launch.orbit : null);
    const orbitAllowed = launchStatusAllowsOrbit(launch?.status);
    const suppliedTrajectoryPoints = Array.isArray(launch?.trajectory)
      ? launch.trajectory.filter(
          (point) =>
            Number.isFinite(Number(point?.latitude)) &&
            Number.isFinite(Number(point?.longitude)),
        ).length
      : 0;
    return {
      orbit: orbitName
        ? `${orbitAllowed ? '' : 'PLANNED · '}${orbitName}`
        : null,
      ascent:
        suppliedTrajectoryPoints > 1
          ? 'SUPPLIED TRAJECTORY POINTS'
          : replayAvailable
            ? 'RECONSTRUCTED ESTIMATE'
            : 'UNAVAILABLE',
      replayAvailable: Boolean(replayAvailable),
    };
  }

  /**
   * Release aircraft follow state through each owning flight layer before a
   * mission replay takes over the camera.
   * @param {object|null} dataManager DataLayerManager instance.
   * @returns {number} Number of owner APIs invoked.
   */

  function releaseAircraftTracking(dataManager) {
    let released = 0;
    for (const layerId of ['flights', 'military']) {
      const module = dataManager?.layers?.get(layerId)?.module;
      if (typeof module?.stopTracking !== 'function') continue;
      module.stopTracking();
      released++;
    }
    return released;
  }

  /**
   * Decide whether the selected launch-pad zone belongs in the current view.
   * Both altitude and direct camera range are bounded so an oblique close-up can
   * show the effect without leaking it into regional or globe views.
   * @param {object} input Visibility inputs.
   * @param {boolean} input.layerActive Whether Space Missions is active.
   * @param {string|null} input.selectedLaunchId Selected mission identifier.
   * @param {string} input.launchId Candidate mission identifier.
   * @param {number} input.cameraHeightM Camera height above the ellipsoid.
   * @param {number} input.cameraDistanceM Direct camera range to the launch pad.
   * @returns {boolean}
   */

  function launchPadZoneVisible({
    layerActive,
    selectedLaunchId,
    launchId,
    cameraHeightM,
    cameraDistanceM,
  }) {
    return Boolean(
      layerActive &&
      selectedLaunchId &&
      selectedLaunchId === launchId &&
      Number.isFinite(cameraHeightM) &&
      cameraHeightM <= LAUNCH_PAD_ZONE_MAX_CAMERA_HEIGHT_M &&
      Number.isFinite(cameraDistanceM) &&
      cameraDistanceM <= LAUNCH_PAD_ZONE_MAX_CAMERA_DISTANCE_M,
    );
  }

  /**
   * Score the amount of useful mission context available for roster triage.
   * @param {object} launch Normalized launch record.
   * @returns {number} Completeness score.
   */

  function missionDataCompleteness(launch = {}) {
    let score = 0;
    const present = (value) =>
      value !== null && value !== undefined && value !== '';
    score += present(launch.provider) ? 1 : 0;
    score += present(launch.mission) ? 2 : 0;
    score += present(launch.missionName) ? 1 : 0;
    score += present(launch.orbit?.name || launch.orbit) ? 2 : 0;
    score += Array.isArray(launch.payloads)
      ? Math.min(launch.payloads.length, 5) * 2
      : 0;
    score += Array.isArray(launch.recoveryStages)
      ? Math.min(launch.recoveryStages.length, 4) * 2
      : 0;
    score += Array.isArray(launch.trajectory)
      ? Math.min(launch.trajectory.length, 12)
      : 0;
    score += Array.isArray(launch.timeline)
      ? Math.min(launch.timeline.length, 6)
      : 0;
    return score;
  }

  /**
   * Build a data-rich roster while preserving the source-array index
   * used by mission selection and Previous/Next navigation.
   * @param {Array<object>} launches Normalized launch records.
   * @returns {Array<{launch: object, index: number}>}
   */

  function missionRosterEntries(launches) {
    return (launches || [])
      .map((launch, index) => ({ launch, index }))
      .sort((a, b) => {
        const completeness =
          missionDataCompleteness(b.launch) - missionDataCompleteness(a.launch);
        if (completeness !== 0) return completeness;
        const aTime = Date.parse(a.launch?.launchTime);
        const bTime = Date.parse(b.launch?.launchTime);
        if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime)
          return bTime - aTime;
        return b.index - a.index;
      });
  }

  /**
   * Format a mission epoch for compact on-globe replay labels.
   * @param {string|Date|null} launchTime ISO-8601 mission time or Date.
   * @returns {string} UTC timestamp or a clear unavailable state.
   */

  function formatMissionEventTime(launchTime) {
    const date = new Date(launchTime);
    if (!launchTime || !Number.isFinite(date.getTime())) return 'UNAVAILABLE';
    return `${date.toISOString().slice(0, 10)}\n${date.toISOString().slice(11, 19)} UTC`;
  }

  /**
   * Parse the ISO-8601 durations supplied by Launch Library timeline events.
   * @param {string|null} value ISO duration such as PT8M40S or -PT35M.
   * @returns {number|null} Signed duration in seconds.
   */

  function parseMissionDurationSeconds(value) {
    const match = String(value || '')
      .trim()
      .match(
        /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
      );
    if (!match) return null;
    const seconds =
      Number(match[2] || 0) * 86400 +
      Number(match[3] || 0) * 3600 +
      Number(match[4] || 0) * 60 +
      Number(match[5] || 0);
    return match[1] ? -seconds : seconds;
  }

  function previewMissionFromRoster(launch) {
    if (!layerState._viewer || !launch || layerState._selectedLaunchId) return;
    const range = parts.panel.missionHoverPreviewRange(
      layerState._viewer.camera.positionCartographic?.height,
    );
    const position = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat);
    layerState._viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(position, 0),
      {
        offset: new Cesium.HeadingPitchRange(
          0,
          -Cesium.Math.PI_OVER_TWO,
          range,
        ),
        duration: 0.8,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      },
    );
  }
  return {
    satelliteParamsForSpaceMissions,
    satelliteParamsAfterSpaceMissions,
    launchStatusAllowsOrbit,
    missionPathPresentation,
    releaseAircraftTracking,
    launchPadZoneVisible,
    missionDataCompleteness,
    missionRosterEntries,
    formatMissionEventTime,
    parseMissionDurationSeconds,
    previewMissionFromRoster,
  };
}
