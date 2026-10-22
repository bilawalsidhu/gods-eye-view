// Native mission graphics stay here; shared mission logic uses plain geometry.
import * as Cesium from 'cesium';
import { isPointerFree } from '../../../data/inputOwnership.js';
import {
  MISSION_ORBIT_PATTERN_GROUPS,
  MISSION_ORBIT_DASHES_PER_GROUP,
  LAUNCH_PAD_ZONE_RADIUS_M,
} from '../policy.js';
export function createLaunchesCesiumRenderer(engine, { viewer } = {}) {
  let patternRegistered = false;
  const scratchTime = new Cesium.JulianDate();
  const color = (value) =>
    value?.red !== undefined
      ? new Cesium.Color(value.red, value.green, value.blue, value.alpha)
      : value;
  function ensureMissionOrbitPatternRegistered() {
    if (patternRegistered) return;
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
    patternRegistered = true;
  }

  function createMissionOrbitPatternMaterial(color) {
    ensureMissionOrbitPatternRegistered();
    return Cesium.Material.fromType('GevMissionOrbitTactical', {
      color,
      groupCount: MISSION_ORBIT_PATTERN_GROUPS,
      dashCount: MISSION_ORBIT_DASHES_PER_GROUP,
    });
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
  function createPad(launch) {
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
    const primitive = viewer.scene.primitives.add(
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
    return primitive;
  }

  return {
    kind: 'cesium',
    engine,
    view: viewer,
    time(epochMs) {
      return Cesium.JulianDate.fromDate(new Date(epochMs), scratchTime);
    },
    occluder: () =>
      new Cesium.EllipsoidalOccluder(
        Cesium.Ellipsoid.WGS84,
        Cesium.Cartesian3.ZERO,
      ),
    callback: (fn) => new Cesium.CallbackProperty(fn, false),
    range: (heading, pitch, range) =>
      new Cesium.HeadingPitchRange(heading, pitch, range),
    easing: Cesium.EasingFunction.CUBIC_IN_OUT,
    createDataSource() {
      const source = new Cesium.CustomDataSource('rocket-launches');
      source.show = false;
      viewer.dataSources.add(source);
      return source;
    },
    removeDataSource: (source) => viewer?.dataSources.remove(source, true),
    addEntity(source, spec) {
      const options = { ...spec };
      for (const key of ['point', 'billboard'])
        if (spec[key])
          options[key] = {
            ...spec[key],
            ...(spec[key].color ? { color: color(spec[key].color) } : {}),
            ...(spec[key].outlineColor
              ? { outlineColor: color(spec[key].outlineColor) }
              : {}),
          };
      if (spec.polyline) {
        const { arc, ...line } = spec.polyline;
        options.polyline = {
          ...line,
          material: color(line.material),
          ...(arc
            ? {
                arcType:
                  arc === 'none'
                    ? Cesium.ArcType.NONE
                    : Cesium.ArcType.GEODESIC,
              }
            : {}),
        };
      }
      return source.entities.add(options);
    },
    dash: (options) =>
      new Cesium.PolylineDashMaterialProperty({
        ...options,
        color: color(options.color),
      }),
    patternMaterial: (value) =>
      new MissionOrbitPatternMaterialProperty(color(value)),
    createOrbit({ positions, width, color: rgba }) {
      const collection = new Cesium.PolylineCollection();
      collection.add({
        positions,
        width,
        material: createMissionOrbitPatternMaterial(color(rgba)),
      });
      viewer.scene.primitives.add(collection);
      return collection;
    },
    commitOrbit() {},
    removePrimitive: (primitive) => viewer?.scene.primitives.remove(primitive),
    createPad,
    project: (position, result) =>
      Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        position,
        result,
      ),
    on: (event, listener) => viewer.scene[event].addEventListener(listener),
    listenClick(source, listener, { enabled = () => true } = {}) {
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((movement) => {
        if (!isPointerFree()) return;
        if (!enabled()) return;
        const entity = viewer.scene
          .drillPick(movement.position, 12)
          .map((p) => p?.id)
          .find((e) => e?.id?.startsWith('rocket-'));
        listener(entity);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      return { destroy: () => handler.destroy() };
    },
    listenMove(source, listener, { enabled = () => true } = {}) {
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((movement) => {
        if (!enabled()) return;
        const entity = viewer.scene
          .drillPick(movement.endPosition, 12)
          .map((p) => p?.id)
          .find((e) => e?.id?.startsWith('rocket-'));
        listener(entity);
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      return { destroy: () => handler.destroy() };
    },
    destroy() {},
  };
}
