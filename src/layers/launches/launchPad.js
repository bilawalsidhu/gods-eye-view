import { fromDegrees } from '../../geo/ellipsoid.js';
import { distance } from '../../geo/vector.js';
import { findCamera, findFrame } from '../../render/rendererOf.js';
import { hexColor } from '../../render/color.js';
import { LAUNCH_PAD_ZONE_RADIUS_M } from './policy.js';

/** The zone's colour: a faint fill under a brighter rim. */
const ZONE_COLOR = '#22e6e6';
const ZONE_FILL_ALPHA = 0.105;
const ZONE_RIM_ALPHA = 0.72;
/** The rim's width, a fraction of the zone's radius. */
const ZONE_RIM_WIDTH = 0.033;
/**
 * Pulled toward the eye, metres, so the zone is not buried by the pad's
 * mesh at oblique angles, without a height that would float it.
 */
const ZONE_DEPTH_BIAS_M = 1;

export function createLaunchPad({
  state: layerState,
  services,
  parts,
  source,
}) {
  function zoneSet() {
    return layerState._missionSets?.pad ?? null;
  }

  function hideLaunchPadZone() {
    const item = layerState._launchPadZoneItem;
    if (!item || item.show === false) return;
    layerState._launchPadZoneItem = { ...item, show: false };
    zoneSet()?.upsert([layerState._launchPadZoneItem]);
  }

  function removeLaunchPadZonePrimitive() {
    if (layerState._launchPadZoneItem) zoneSet()?.clear();
    layerState._launchPadZoneItem = null;
    layerState._launchPadZoneLaunchId = null;
  }

  /** The zone drawn around a launch's pad, draped on the ground. */
  function createLaunchPadZonePrimitive(launch) {
    removeLaunchPadZonePrimitive();
    const item = {
      id: `rocket-pad-zone:${launch.id}`,
      geometry: {
        kind: 'ellipse',
        center: { lon: launch.lon, lat: launch.lat },
        semiMajor: LAUNCH_PAD_ZONE_RADIUS_M,
        semiMinor: LAUNCH_PAD_ZONE_RADIUS_M,
      },
      fill: {
        preset: 'radialRim',
        color: hexColor(ZONE_COLOR, ZONE_FILL_ALPHA),
        rimColor: hexColor(ZONE_COLOR, ZONE_RIM_ALPHA),
        rimWidth: ZONE_RIM_WIDTH,
      },
      height: 'clampGround',
      clampTo: 'both',
      depthBias: ZONE_DEPTH_BIAS_M,
      show: true,
    };
    layerState._launchPadZoneItem = item;
    zoneSet()?.set([item]);
    layerState._launchPadZoneLaunchId = launch.id;
  }

  /** Before each frame: the rings' labels, and the selected pad's zone. */
  function updateLaunchPadZone() {
    if (!layerState._enabled || !parts.rendering.missionsShown()) {
      hideLaunchPadZone();
      return;
    }
    const nowMs = Date.now();
    if (nowMs - layerState._lastMissionRingRotationMs >= 1000) {
      parts.orbitRendering.updateMissionOrbitPrimitiveFrames(nowMs);
      layerState._lastMissionRingRotationMs = nowMs;
    }
    const launch = layerState._launches.find(
      (item) => item.id === layerState._selectedLaunchId,
    );
    const pose = findCamera(layerState._viewer)?.pose();
    if (!launch || !pose) {
      hideLaunchPadZone();
      return;
    }
    const launchPosition = fromDegrees(launch.lon, launch.lat);
    const visible = parts.policyHelpers.launchPadZoneVisible({
      layerActive: parts.rendering.missionsShown(),
      selectedLaunchId: layerState._selectedLaunchId,
      launchId: launch.id,
      cameraHeightM: pose.height,
      cameraDistanceM: distance(pose.position, launchPosition),
    });
    if (!visible) {
      hideLaunchPadZone();
      return;
    }
    if (layerState._launchPadZoneLaunchId !== launch.id)
      createLaunchPadZonePrimitive(launch);
    else if (layerState._launchPadZoneItem.show === false) {
      layerState._launchPadZoneItem = {
        ...layerState._launchPadZoneItem,
        show: true,
      };
      zoneSet()?.upsert([layerState._launchPadZoneItem]);
    }
  }

  function initLaunchPadZonePrimitive() {
    if (!layerState._viewer || layerState._launchPadZoneRemover) return;
    layerState._launchPadZoneRemover =
      findFrame(layerState._viewer)?.on('preRender', updateLaunchPadZone) ??
      null;
  }

  function destroyLaunchPadZonePrimitive() {
    if (layerState._launchPadZoneRemover) layerState._launchPadZoneRemover();
    layerState._launchPadZoneRemover = null;
    removeLaunchPadZonePrimitive();
  }
  return {
    hideLaunchPadZone,
    removeLaunchPadZonePrimitive,
    createLaunchPadZonePrimitive,
    initLaunchPadZonePrimitive,
    destroyLaunchPadZonePrimitive,
    updateLaunchPadZone,
  };
}
