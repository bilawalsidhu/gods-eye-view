// Native mission graphics stay here; shared mission logic uses plain geometry.
import * as Cesium from 'cesium';
import { isPointerFree } from '../../../data/inputOwnership.js';
import {
  MISSION_ORBIT_PATTERN_GROUPS,
  MISSION_ORBIT_DASHES_PER_GROUP,
  LAUNCH_PAD_ZONE_RADIUS_M,
  LAUNCH_PAD_ZONE_STYLE,
} from '../policy.js';
const HOVER_PICK_INTERVAL_MS = 120;
/** A GLSL float literal (always with a decimal point). */
const glslFloat = (value) => value.toFixed(4);

/**
 * Bound hover picking independently of precise click selection. A move inside
 * the throttle window is not dropped: its position is kept and one trailing
 * check runs when the window ends, so a pointer that stops is still resolved.
 */
export function createLaunchHover({
  viewer,
  enabled,
  entityLaunchId,
  now = () => performance.now(),
  documentRef = globalThis.document,
  pointerFree = isPointerFree,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  let moving = false;
  let lastPick = -Infinity;
  let ownsCursor = false;
  let pendingPosition = null;
  let trailingTimer = null;
  const clearCursor = () => {
    if (ownsCursor && viewer.scene.canvas.style.cursor === 'pointer')
      viewer.scene.canvas.style.cursor = '';
    ownsCursor = false;
  };
  const cancelTrailing = () => {
    if (trailingTimer !== null) clearTimer(trailingTimer);
    trailingTimer = null;
    pendingPosition = null;
  };
  const reset = () => {
    cancelTrailing();
    clearCursor();
    lastPick = -Infinity;
  };
  const start = () => {
    moving = true;
    reset();
  };
  const end = () => {
    moving = false;
    reset();
  };
  const visibility = () => {
    if (documentRef?.hidden || documentRef?.visibilityState === 'hidden')
      reset();
  };
  const eligible = () =>
    enabled() &&
    !moving &&
    !documentRef?.hidden &&
    documentRef?.visibilityState !== 'hidden' &&
    pointerFree();
  const pick = (position, at) => {
    lastPick = at;
    const found = viewer.scene
      .drillPick(position, 12)
      .some((picked) => entityLaunchId(picked?.id));
    if (found) {
      viewer.scene.canvas.style.cursor = 'pointer';
      ownsCursor = true;
    } else clearCursor();
  };
  const trailing = () => {
    trailingTimer = null;
    const position = pendingPosition;
    pendingPosition = null;
    if (!position) return;
    // Eligibility may have changed while the check waited.
    if (!eligible()) {
      reset();
      return;
    }
    pick(position, now());
  };
  const removeStart = viewer.camera?.moveStart?.addEventListener(start);
  const removeEnd = viewer.camera?.moveEnd?.addEventListener(end);
  documentRef?.addEventListener?.('visibilitychange', visibility);
  return {
    move(movement) {
      if (!eligible()) {
        reset();
        return;
      }
      const at = now();
      const wait = HOVER_PICK_INTERVAL_MS - (at - lastPick);
      if (wait > 0) {
        // Cesium reuses the movement object, so keep a copy of the position.
        pendingPosition = Cesium.Cartesian2.clone(
          movement.endPosition,
          pendingPosition ?? undefined,
        );
        if (trailingTimer === null) trailingTimer = setTimer(trailing, wait);
        return;
      }
      cancelTrailing();
      pick(movement.endPosition, at);
    },
    reset,
    destroy() {
      reset();
      removeStart?.();
      removeEnd?.();
      documentRef?.removeEventListener?.('visibilitychange', visibility);
    },
  };
}

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
          color: Cesium.Color.fromCssColorString(LAUNCH_PAD_ZONE_STYLE.color),
          fillAlpha: LAUNCH_PAD_ZONE_STYLE.fillAlpha,
          rimAlpha: LAUNCH_PAD_ZONE_STYLE.rimAlpha,
        },
        source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          vec2 centered = (materialInput.st - vec2(0.5)) * 2.0;
          float radius = length(centered);
          float inside = 1.0 - smoothstep(${glslFloat(LAUNCH_PAD_ZONE_STYLE.rimEnd)}, 1.0, radius);
          float rim = smoothstep(${glslFloat(LAUNCH_PAD_ZONE_STYLE.rimStart)}, ${glslFloat(LAUNCH_PAD_ZONE_STYLE.rimEnd)}, radius) * inside;
          material.diffuse = color.rgb;
          material.emission = color.rgb * rim * ${glslFloat(LAUNCH_PAD_ZONE_STYLE.emission)};
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
      const hover = createLaunchHover({
        viewer,
        enabled,
        entityLaunchId: (entity) => entity?.id?.startsWith('rocket-'),
      });
      handler.setInputAction(
        hover.move,
        Cesium.ScreenSpaceEventType.MOUSE_MOVE,
      );
      return {
        reset: hover.reset,
        destroy() {
          hover.destroy();
          handler.destroy();
        },
      };
    },
    destroy() {},
  };
}
