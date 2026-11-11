// engine.lines on Cesium: each line is one Primitive of a PolylineGeometry
// (built synchronously, rebuilt when its positions change) with a
// PolylineMaterialAppearance. Every line has its own slot, a
// PrimitiveCollection placed by `order` inside one engine-owned
// PrimitiveCollection that joins the scene with the first line, so a rebuild
// keeps its place. depthFailAlpha adds Cesium's depthFailAppearance (the
// same material, its alpha scaled) for the part the scene hides; dashes in
// pixels are PolylineDash; the tactical dash is the launches'
// selected-orbit pattern along the whole line. Only a line with a pickId
// takes part in picks; identify() names it.

import * as Cesium from 'cesium';
import { createLineRegistry } from '../lines.js';

const TACTICAL_TYPE = 'GevLineTactical';
let tacticalRegistered = false;

// The launches' selected-orbit pattern (layers/launches/policy.js
// MISSION_ORBIT_PATTERN_GROUPS and MISSION_ORBIT_DASHES_PER_GROUP): one
// round dot and the dashes of each group, under the engine's own type.
function registerTactical() {
  if (tacticalRegistered) return;
  new Cesium.Material({
    fabric: {
      type: TACTICAL_TYPE,
      uniforms: { color: Cesium.Color.CYAN, groupCount: 4, dashCount: 100 },
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
  tacticalRegistered = true;
}

/** PolylineDash's 16-bit pattern: the dash first, then the gap. */
export function dashPattern(lengthPx, gapPx) {
  const on = Math.max(
    1,
    Math.min(16, Math.round((16 * lengthPx) / (lengthPx + gapPx))),
  );
  return (0xffff << (16 - on)) & 0xffff;
}

const toColor = ([r, g, b, a], alphaScale = 1) =>
  new Cesium.Color(r, g, b, a * alphaScale);

/** The Cesium material type and uniforms of a line (pure, for tests). */
export function materialSpec(options, color, alphaScale = 1) {
  if (options.arrow)
    return {
      type: 'PolylineArrow',
      uniforms: { color: toColor(color, alphaScale) },
    };
  const { dash } = options;
  if (dash?.kind === 'pixels')
    return {
      type: 'PolylineDash',
      uniforms: {
        color: toColor(color, alphaScale),
        gapColor: Cesium.Color.TRANSPARENT,
        // PolylineDash measures in CSS pixels (dashLength × czm_pixelRatio).
        dashLength: dash.lengthPx + dash.gapPx,
        dashPattern: dashPattern(dash.lengthPx, dash.gapPx),
      },
    };
  if (dash?.kind === 'tactical')
    return {
      type: TACTICAL_TYPE,
      uniforms: {
        color: toColor(color, alphaScale),
        groupCount: dash.groups,
        dashCount: dash.dashes,
      },
    };
  return { type: 'Color', uniforms: { color: toColor(color, alphaScale) } };
}

function cesiumMaterial({ type, uniforms }) {
  if (type === TACTICAL_TYPE) registerTactical();
  return Cesium.Material.fromType(type, uniforms);
}

const DEFAULT_FACTORIES = {
  primitive: (options) => new Cesium.Primitive(options),
  appearance: (spec) =>
    new Cesium.PolylineMaterialAppearance({ material: cesiumMaterial(spec) }),
};

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void, factories?: object }} [options]
 *   `factories` (the primitive and its appearance) is a test seam.
 * @returns {{ lines: import('../contract.js').GlobeLines,
 *   identify: (picked: object) => ({ owner: string, id: any } | null),
 *   destroy: () => void }}
 */
export function createCesiumLines(
  viewer,
  { requestRender = () => viewer.scene.requestRender(), factories = {} } = {},
) {
  const make = { ...DEFAULT_FACTORIES, ...factories };
  const { scene } = viewer;
  let root = null;
  const ordered = [];
  const rootCollection = () => {
    if (!root) {
      root = new Cesium.PrimitiveCollection({ destroyPrimitives: true });
      scene.primitives.add(root);
    }
    return root;
  };
  const registry = createLineRegistry((options) => {
    // Later (higher) order draws later: after every line of lower or equal order.
    const slot = new Cesium.PrimitiveCollection({ destroyPrimitives: true });
    const at = ordered.filter((entry) => entry.order <= options.order).length;
    ordered.splice(at, 0, { order: options.order, slot });
    rootCollection().add(slot, at);
    let color = options.color;
    let modelMatrix = options.modelMatrix
      ? Cesium.Matrix4.fromArray(options.modelMatrix)
      : Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
    let shown = true;
    let primitive = null;
    let appearance = null;
    let depthFail = null;
    const drop = () => {
      if (primitive) slot.remove(primitive);
      primitive = null;
      appearance = null;
      depthFail = null;
    };
    return {
      setPositions(flat) {
        drop();
        if (flat.length < 6) {
          requestRender('lines');
          return;
        }
        const positions = [];
        for (let index = 0; index < flat.length; index += 3)
          positions.push(
            new Cesium.Cartesian3(
              flat[index],
              flat[index + 1],
              flat[index + 2],
            ),
          );
        appearance = make.appearance(materialSpec(options, color));
        depthFail =
          options.depthFailAlpha > 0
            ? make.appearance(
                materialSpec(options, color, options.depthFailAlpha),
              )
            : undefined;
        primitive = make.primitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: new Cesium.PolylineGeometry({
              positions,
              width: options.widthPx,
              vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
              arcType:
                options.arc === 'geodesic'
                  ? Cesium.ArcType.GEODESIC
                  : Cesium.ArcType.NONE,
            }),
            id: options.pickId,
          }),
          appearance,
          depthFailAppearance: depthFail,
          modelMatrix: Cesium.Matrix4.clone(modelMatrix),
          show: shown,
          asynchronous: false,
          // A line without a pickId is not in the pick pass (Navara's CPU
          // picks leave it out too).
          allowPicking: options.pickId !== undefined,
        });
        primitive.gevLine = options.id;
        slot.add(primitive);
        requestRender('lines');
      },
      setSegments(items) {
        drop();
        if (items.length) {
          primitive = make.primitive({
            geometryInstances: items.map(
              (item) =>
                new Cesium.GeometryInstance({
                  geometry: new Cesium.PolylineGeometry({
                    positions: Cesium.Cartesian3.unpackArray(item.positions),
                    width: item.widthPx,
                    vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
                    arcType: Cesium.ArcType.NONE,
                  }),
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                      toColor(item.color),
                    ),
                  },
                  id: item.pickId,
                }),
            ),
            appearance: new Cesium.PolylineColorAppearance({
              translucent: true,
            }),
            show: shown,
            asynchronous: false,
            allowPicking: items.some((item) => item.pickId !== undefined),
          });
          primitive.gevLine = options.id;
          slot.add(primitive);
        }
        requestRender('lines');
      },
      setColor(rgba) {
        color = rgba;
        if (appearance) appearance.material.uniforms.color = toColor(rgba);
        if (depthFail)
          depthFail.material.uniforms.color = toColor(
            rgba,
            options.depthFailAlpha,
          );
        requestRender('lines');
      },
      setModelMatrix(matrix) {
        modelMatrix = Cesium.Matrix4.fromArray(matrix);
        if (primitive)
          primitive.modelMatrix = Cesium.Matrix4.clone(modelMatrix);
        requestRender('lines');
      },
      show(visible) {
        shown = visible;
        if (primitive) primitive.show = visible;
        requestRender('lines');
      },
      destroy() {
        drop();
        ordered.splice(
          ordered.findIndex((entry) => entry.slot === slot),
          1,
        );
        root.remove(slot);
        requestRender('lines');
      },
    };
  });
  return {
    lines: registry.lines,
    primitiveOf(handle) {
      const state = [...registry.live.values()].find(
        (entry) => entry.line === handle,
      );
      if (!state) return null;
      const entry = ordered.find(
        ({ slot }) => slot.get(0)?.gevLine === state.options.id,
      );
      return entry?.slot ?? null;
    },
    /** The live line a Cesium pick result belongs to, with its pickId, or null. */
    identify(picked) {
      const owner = picked?.primitive?.gevLine;
      const state = owner === undefined ? null : registry.live.get(owner);
      if (state?.options.segments)
        return state.shown &&
          state.items.some(
            (item) => item.pickId !== undefined && item.pickId === picked.id,
          )
          ? { owner, id: picked.id }
          : { owner, id: picked.id, pickable: false };
      return state && state.options.pickId !== undefined
        ? { owner, id: state.options.pickId }
        : null;
    },
    destroy() {
      registry.destroyAll();
      if (root) {
        scene.primitives.remove(root);
        root = null;
      }
    },
  };
}
