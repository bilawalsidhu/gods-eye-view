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
      getRenderer()?.visible() &&
      !layerState.launchHidden(
        layerState._missionOverlayRecords.get(launchId)?.launch,
      ) &&
      (!layerState._selectedLaunchId ||
        layerState._selectedLaunchId === launchId),
    );
  }

  function syncMissionOrbitPrimitiveVisibility() {
    for (const [launchId, path] of layerState._missionOrbitPrimitives) {
      if (path.line) path.line.show = missionOrbitPrimitiveVisible(launchId);
    }
  }

  function removeMissionOrbitPrimitives() {
    for (const path of layerState._missionOrbitPrimitives.values())
      path.line?.remove();
    layerState._missionOrbitPrimitives.clear();
  }

  function updateMissionOrbitPrimitiveFrames(nowDate) {
    for (const [launchId, path] of layerState._missionOrbitPrimitives) {
      if (!path.line || !missionOrbitPrimitiveVisible(launchId)) continue;
      orbitFrameModelMatrix(path.gmstAtBake, nowDate, path.modelMatrix);
      path.line.setModelMatrix(path.modelMatrix);
      if (path.labelBakePosition && path.labelPosition) {
        geo.matrix4.multiplyByPoint(
          path.modelMatrix,
          path.labelBakePosition,
          path.labelPosition,
        );
      }
    }
  }

  function addMissionOrbitPrimitive(launch, orbitPath, satelliteTrack) {
    if (
      !getRenderer() ||
      !satelliteTrack ||
      !Number.isFinite(satelliteTrack.gmstAtBake)
    )
      return false;
    const modelMatrix = orbitFrameModelMatrix(
      satelliteTrack.gmstAtBake,
      new Date(layerState.orbitNow()),
      geo.matrix4.clone(geo.matrix4.IDENTITY),
    );
    // The live ring is not picked (as Cesium's polyline collection).
    const line = getRenderer().addLine({
      id: `rocket-orbit-ring:${launch.id}`,
      positions: orbitPath,
      widthPx: 3,
      color: rgbaFromCss('#22e6e6').withAlpha(0.95),
      dash: 'tactical',
      modelMatrix,
    });
    line.show = missionOrbitPrimitiveVisible(launch.id);
    layerState._missionOrbitPrimitives.set(launch.id, {
      line,
      modelMatrix,
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
