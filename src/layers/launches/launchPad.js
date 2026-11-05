import * as geo from '../../geo/index.js';
import { appClock } from '../../time/clock.js';

export function createLaunchPad({
  state: layerState,
  services,
  parts,
  source,
  getRenderer,
}) {
  function hideLaunchPadZone() {
    if (layerState._launchPadZonePrimitive)
      layerState._launchPadZonePrimitive.show = false;
  }

  function removeLaunchPadZonePrimitive() {
    if (layerState._launchPadZonePrimitive)
      getRenderer().removePrimitive(layerState._launchPadZonePrimitive);
    layerState._launchPadZonePrimitive = null;
    layerState._launchPadZoneLaunchId = null;
  }

  function createLaunchPadZonePrimitive(launch) {
    removeLaunchPadZonePrimitive();
    layerState._launchPadZonePrimitive = getRenderer().createPad(launch);
    layerState._launchPadZoneLaunchId = launch.id;
  }

  function initLaunchPadZonePrimitive() {
    if (!layerState._viewer || layerState._launchPadZoneRemover) return;
    layerState._launchPadZoneRemover = getRenderer().on('preRender', () => {
      if (!layerState._enabled || !layerState._dataSource?.show) {
        hideLaunchPadZone();
        return;
      }
      const nowMs = Date.now();
      if (nowMs - layerState._lastMissionRingRotationMs >= 1000) {
        layerState._missionRingDate.setTime(appClock.now());
        parts.orbitRendering.updateMissionOrbitPrimitiveFrames(
          layerState._missionRingDate,
        );
        layerState._lastMissionRingRotationMs = nowMs;
      }
      const launch = layerState._launches.find(
        (item) => item.id === layerState._selectedLaunchId,
      );
      const camera = layerState._viewer?.camera;
      if (!launch || !camera) {
        hideLaunchPadZone();
        return;
      }
      const launchPosition = geo.cartesian3.fromDegrees(launch.lon, launch.lat);
      const visible = parts.policyHelpers.launchPadZoneVisible({
        layerActive: Boolean(layerState._dataSource?.show),
        selectedLaunchId: layerState._selectedLaunchId,
        launchId: launch.id,
        cameraHeightM: camera.positionCartographic?.height,
        cameraDistanceM: geo.cartesian3.distance(
          camera.positionWC,
          launchPosition,
        ),
      });
      if (!visible) {
        hideLaunchPadZone();
        return;
      }
      if (layerState._launchPadZoneLaunchId !== launch.id)
        createLaunchPadZonePrimitive(launch);
      layerState._launchPadZonePrimitive.show = true;
    });
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
  };
}
