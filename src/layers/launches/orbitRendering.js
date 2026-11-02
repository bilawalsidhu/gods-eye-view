import * as Cesium from 'cesium';
import {
  MISSION_ORBIT_PATTERN_GROUPS,
  MISSION_ORBIT_DASHES_PER_GROUP,
} from './policy.js';

export function createOrbitRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { orbitFrameModelMatrix } = services.satellites;

  /**
   * Register the selected-orbit tactical material once. Each group begins with
   * one compact round dot followed by one hundred short dashes.
   */

  function ensureMissionOrbitPatternRegistered() {
    if (layerState._missionOrbitPatternRegistered) return;
    new Cesium.Material({
      fabric: {
        type: 'GevMissionOrbitTactical',
        uniforms: {
          color: Cesium.Color.CYAN,
          groupCount: MISSION_ORBIT_PATTERN_GROUPS,
          dashCount: MISSION_ORBIT_DASHES_PER_GROUP,
        },
        source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          float groupPosition = fract(materialInput.st.s * groupCount);
          float markPosition = groupPosition * (dashCount + 1.0);
          float markIndex = floor(markPosition);
          float localPosition = fract(markPosition);
          float centerDistance = abs(localPosition - 0.5);
          float edge = max(fwidth(localPosition) * 1.35, 0.012);
          float dashAlong = 1.0 - smoothstep(0.27 - edge, 0.27 + edge, centerDistance);
          float dashAcross = 1.0 - smoothstep(0.12, 0.24, abs(materialInput.st.t - 0.5));
          float dash = dashAlong * dashAcross;
          float dotAlong = (localPosition - 0.5) / 0.32;
          float dotAcross = (materialInput.st.t - 0.5) / 0.5;
          float dot = 1.0 - smoothstep(0.78, 1.0, length(vec2(dotAlong, dotAcross)));
          float isDot = 1.0 - step(0.5, markIndex);
          float visible = mix(dash, dot, isDot);
          material.diffuse = color.rgb;
          material.emission = color.rgb * mix(0.07, 0.65, isDot);
          material.alpha = color.a * visible * mix(0.58, 1.0, isDot);
          return material;
        }`,
      },
    });
    layerState._missionOrbitPatternRegistered = true;
  }

  function createMissionOrbitPatternMaterial(color) {
    ensureMissionOrbitPatternRegistered();
    return Cesium.Material.fromType('GevMissionOrbitTactical', {
      color,
      groupCount: MISSION_ORBIT_PATTERN_GROUPS,
      dashCount: MISSION_ORBIT_DASHES_PER_GROUP,
    });
  }

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
      if (path.primitive && layerState._viewer?.scene?.primitives) {
        layerState._viewer.scene.primitives.remove(path.primitive);
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
      if (path.labelBakePosition && path.labelPosition) {
        Cesium.Matrix4.multiplyByPoint(
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
    const collection = new Cesium.PolylineCollection();
    collection.add({
      positions: orbitPath,
      width: 3,
      material: createMissionOrbitPatternMaterial(
        Cesium.Color.fromCssColorString('#22e6e6').withAlpha(0.95),
      ),
    });
    collection.show = missionOrbitPrimitiveVisible(launch.id);
    orbitFrameModelMatrix(
      satelliteTrack.gmstAtBake,
      new Date(),
      collection.modelMatrix,
    );
    layerState._viewer.scene.primitives.add(collection);
    layerState._missionOrbitPrimitives.set(launch.id, {
      primitive: collection,
      gmstAtBake: satelliteTrack.gmstAtBake,
    });
    return true;
  }

  function MissionOrbitPatternMaterialProperty(color) {
    ensureMissionOrbitPatternRegistered();
    this._color = color;
    this._definitionChanged = new Cesium.Event();
  }
  Object.defineProperties(MissionOrbitPatternMaterialProperty.prototype, {
    isConstant: {
      get() {
        return true;
      },
    },
    definitionChanged: {
      get() {
        return this._definitionChanged;
      },
    },
  });
  MissionOrbitPatternMaterialProperty.prototype.getType = function getType() {
    return 'GevMissionOrbitTactical';
  };
  MissionOrbitPatternMaterialProperty.prototype.getValue = function getValue(
    time,
    result,
  ) {
    if (!Cesium.defined(result)) result = {};
    result.color = this._color;
    result.groupCount = MISSION_ORBIT_PATTERN_GROUPS;
    result.dashCount = MISSION_ORBIT_DASHES_PER_GROUP;
    return result;
  };
  MissionOrbitPatternMaterialProperty.prototype.equals = function equals(
    other,
  ) {
    return this === other;
  };
  return {
    ensureMissionOrbitPatternRegistered,
    createMissionOrbitPatternMaterial,
    missionOrbitPrimitiveVisible,
    syncMissionOrbitPrimitiveVisibility,
    removeMissionOrbitPrimitives,
    updateMissionOrbitPrimitiveFrames,
    addMissionOrbitPrimitive,
    MissionOrbitPatternMaterialProperty,
  };
}
