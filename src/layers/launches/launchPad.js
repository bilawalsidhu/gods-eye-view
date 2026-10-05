import * as Cesium from 'cesium';
import { LAUNCH_PAD_ZONE_RADIUS_M } from './policy.js';

export function createLaunchPad({
  state: layerState,
  services,
  parts,
  source,
}) {
  function hideLaunchPadZone() {
    if (layerState._launchPadZonePrimitive)
      layerState._launchPadZonePrimitive.show = false;
  }

  function removeLaunchPadZonePrimitive() {
    if (
      layerState._launchPadZonePrimitive &&
      layerState._viewer?.scene?.primitives
    ) {
      layerState._viewer.scene.primitives.remove(
        layerState._launchPadZonePrimitive,
      );
    }
    layerState._launchPadZonePrimitive = null;
    layerState._launchPadZoneLaunchId = null;
  }

  function createLaunchPadZonePrimitive(launch) {
    removeLaunchPadZonePrimitive();
    const material = new Cesium.Material({
      fabric: {
        type: 'GevLaunchPadZone',
        uniforms: {
          color: Cesium.Color.fromCssColorString('#22e6e6'),
          fillAlpha: 0.105,
          rimAlpha: 0.72,
        },
        source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          vec2 centered = (materialInput.st - vec2(0.5)) * 2.0;
          float radius = length(centered);
          float inside = 1.0 - smoothstep(0.985, 1.0, radius);
          float rim = smoothstep(0.952, 0.985, radius) * inside;
          material.diffuse = color.rgb;
          material.emission = color.rgb * rim * 0.35;
          material.alpha = color.a * inside * mix(fillAlpha, rimAlpha, rim);
          return material;
        }`,
      },
    });
    const geometry = new Cesium.EllipseGeometry({
      center: Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat),
      semiMajorAxis: LAUNCH_PAD_ZONE_RADIUS_M,
      semiMinorAxis: LAUNCH_PAD_ZONE_RADIUS_M,
      granularity: Cesium.Math.toRadians(0.08),
      vertexFormat:
        Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
    });
    layerState._launchPadZonePrimitive =
      layerState._viewer.scene.primitives.add(
        new Cesium.GroundPrimitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry,
            id: `rocket-pad-zone:${launch.id}`,
          }),
          appearance: new Cesium.MaterialAppearance({
            material,
            translucent: true,
            closed: false,
            faceForward: true,
            flat: true,
            // Keep the zone classified onto the photoreal surface, but bias only its
            // rasterized depth toward the camera. This avoids coplanar fragments
            // being intermittently buried by the launch-pad mesh at oblique angles
            // without adding a world-space height that would make the ring float.
            renderState: {
              depthTest: {
                enabled: true,
              },
              depthMask: false,
              polygonOffset: {
                enabled: true,
                factor: -1,
                units: -4,
              },
              blending: Cesium.BlendingState.ALPHA_BLEND,
            },
          }),
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
          show: true,
        }),
      );
    layerState._launchPadZoneLaunchId = launch.id;
  }

  function initLaunchPadZonePrimitive() {
    if (!layerState._viewer || layerState._launchPadZoneRemover) return;
    layerState._launchPadZoneRemover =
      layerState._viewer.scene.preRender.addEventListener(() => {
        if (!layerState._enabled || !layerState._dataSource?.show) {
          hideLaunchPadZone();
          return;
        }
        const nowMs = Date.now();
        if (nowMs - layerState._lastMissionRingRotationMs >= 1000) {
          layerState._missionRingDate.setTime(nowMs);
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
        const launchPosition = Cesium.Cartesian3.fromDegrees(
          launch.lon,
          launch.lat,
        );
        const visible = parts.policyHelpers.launchPadZoneVisible({
          layerActive: Boolean(layerState._dataSource?.show),
          selectedLaunchId: layerState._selectedLaunchId,
          launchId: launch.id,
          cameraHeightM: camera.positionCartographic?.height,
          cameraDistanceM: Cesium.Cartesian3.distance(
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
