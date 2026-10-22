import { appClock } from '../../time/clock.js';
import * as geo from '../../geo/index.js';
import { rgbaFromCss } from '../shared/color.js';
export function createOrbitRendering({
  state: layerState,
  services,
  getRenderer,
}) {
  const { orbitFrameModelMatrix } = services.satellites;
  function missionOrbitPrimitiveVisible(launchId) {
    return Boolean(
      layerState._enabled &&
      layerState._dataSource?.show &&
      (!layerState._selectedLaunchId ||
        layerState._selectedLaunchId === launchId),
    );
  }

  function syncMissionOrbitPrimitiveVisibility() {
    for (const [launchId, path] of layerState._missionOrbitPrimitives) {
      if (path.primitive)
        path.primitive.show = missionOrbitPrimitiveVisible(launchId);
    }
  }

  function removeMissionOrbitPrimitives() {
    for (const path of layerState._missionOrbitPrimitives.values()) {
      if (path.primitive && layerState._viewer) {
        getRenderer().removePrimitive(path.primitive);
      }
    }
    layerState._missionOrbitPrimitives.clear();
  }

  function updateMissionOrbitPrimitiveFrames(nowDate) {
    for (const [launchId, path] of layerState._missionOrbitPrimitives) {
      if (!path.primitive || !missionOrbitPrimitiveVisible(launchId)) continue;
      orbitFrameModelMatrix(
        path.gmstAtBake,
        nowDate,
        path.primitive.modelMatrix,
      );
      getRenderer().commitOrbit(path.primitive);
      if (path.labelBakePosition && path.labelPosition) {
        geo.matrix4.multiplyByPoint(
          path.primitive.modelMatrix,
          path.labelBakePosition,
          path.labelPosition,
        );
      }
    }
  }

  function addMissionOrbitPrimitive(launch, orbitPath, satelliteTrack) {
    if (
      !layerState._viewer ||
      !satelliteTrack ||
      !Number.isFinite(satelliteTrack.gmstAtBake)
    )
      return false;
    const collection = getRenderer().createOrbit({
      positions: orbitPath,
      width: 3,
      color: rgbaFromCss('#22e6e6').withAlpha(0.95),
    });
    collection.show = missionOrbitPrimitiveVisible(launch.id);
    orbitFrameModelMatrix(
      satelliteTrack.gmstAtBake,
      new Date(appClock.now()),
      collection.modelMatrix,
    );
    getRenderer().commitOrbit(collection);
    layerState._missionOrbitPrimitives.set(launch.id, {
      primitive: collection,
      basePositions: orbitPath,
      gmstAtBake: satelliteTrack.gmstAtBake,
    });
    return true;
  }

  return {
    missionOrbitPrimitiveVisible,
    syncMissionOrbitPrimitiveVisibility,
    removeMissionOrbitPrimitives,
    updateMissionOrbitPrimitiveFrames,
    addMissionOrbitPrimitive,
  };
}
