// engine.ground on Cesium: each set is a PrimitiveCollection placed by
// `order` inside one engine-owned collection in scene.groundPrimitives
// (added with the first set), so a rebuild keeps its place. A commit
// rebuilds the set as at most two batches: one GroundPrimitive of every
// fill (polygons, discs as EllipseGeometry, cells as RectangleGeometry,
// metre corridors as CorridorGeometry) and one GroundPolylinePrimitive of
// every outline and pixel corridor, over the fills, both with per-instance
// colours and the set's classificationType. A pixel corridor with a glow,
// a pulse or a dash draws in a GroundPolylinePrimitive of its own look and
// colour (a material has one colour), over the set's other batches; its
// material reads a time uniform the engine writes before every frame, and
// while a shown set has a pulse or a dash the engine asks for a frame after
// every frame, the continuous render Cesium drew them with. Cesium builds
// them in workers; the engine keeps requesting frames until they are
// drawn. A set made
// without pickable stays out of the pick pass (a GroundPrimitive with
// allowPicking false still writes its stencil there and hides what lies
// under it); identify() names a picked item.

import * as Cesium from 'cesium';
import { createCesiumPulseField } from './groundPulse.js';
import {
  areaRings,
  createGroundRegistry,
  DASH_EDGE,
  groundSeconds,
} from '../ground.js';

// Read when a set is made: no module reads Cesium while it loads.
const classificationOf = (drape) =>
  ({
    both: Cesium.ClassificationType.BOTH,
    terrain: Cesium.ClassificationType.TERRAIN,
    tiles: Cesium.ClassificationType.CESIUM_3D_TILE,
  })[drape];

// Outline rings of a disc, in Cesium's own ellipse granularity (1°, at
// least 64 points round).
const DISC_OUTLINE_SEGMENTS = 128;

// Cesium's GroundPrimitive and GroundPolylinePrimitive, out of the pick pass
// unless asked to pick.
function pickPassAware(Base) {
  return class extends Base {
    constructor(options) {
      super(options);
      this.gevPickable = options.allowPicking === true;
    }
    update(frameState) {
      if (frameState.passes.pick && !this.gevPickable) return;
      super.update(frameState);
    }
  };
}
// Made on first use: no module reads Cesium while it loads.
let groundClasses = null;
const classes = () =>
  (groundClasses ??= {
    fills: pickPassAware(Cesium.GroundPrimitive),
    lines: pickPassAware(Cesium.GroundPolylinePrimitive),
  });

const DEFAULT_FACTORIES = {
  fills: (options) => new (classes().fills)(options),
  lines: (options) => new (classes().lines)(options),
};

const colorOf = (rgba) => new Cesium.Color(rgba[0], rgba[1], rgba[2], rgba[3]);

// One material for every animated corridor: PolylineGlow's falloff across
// the width (st.t) and taper along it (st.s), an alpha pulse, and the
// annotation route's flowing dashes (src/globe/cesium/annotations/worldAnnotationRenderer.js,
// GevRouteFlow): its diffuse plus emission and alpha. Each part is off at
// its zero uniform. Fragments are LDR and premultiplied, as Cesium writes
// ground polylines.
const CORRIDOR_MATERIAL = 'GevGroundCorridor';
const CORRIDOR_SOURCE = /* glsl */ `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  if (st.s > reveal) discard;
  vec3 rgb = color.rgb;
  float alpha = color.a;
  if (pulsePeriod > 0.0)
    alpha *= mix(pulseMin, pulseMax, 0.5 + 0.5 * sin(6.283185307179586 * time / pulsePeriod));
  if (glowPower > 0.0) {
    float glow = glowPower / abs(st.t - 0.5) - (glowPower / 0.5);
    if (taperPower <= 0.99999)
      glow *= min(1.0, taperPower / (0.5 - st.s * 0.5) - (taperPower / 0.5));
    rgb = max(vec3(glow - 1.0 + rgb), rgb);
    alpha *= clamp(glow, 0.0, 1.0);
  }
  if (dashCells > 0.0) {
    float flow = fract(st.s * dashCells - time * dashSpeed);
    float on = 1.0 - smoothstep(dashDuty - ${DASH_EDGE}, dashDuty + ${DASH_EDGE}, flow);
    rgb *= 1.0 + dashEmission * on;
    alpha *= max(on, dashGap);
  }
  if (abs(st.t - 0.5) > coreFraction * 0.5) {
    rgb = backingColor.rgb;
    alpha = backingColor.a;
  }
  material.emission = coreFraction < 1.0 ? czm_gammaCorrect(rgb) : rgb;
  material.alpha = alpha;
  return material;
}`;

/** The uniforms of an animated corridor's material (pure, for tests). */
function corridorUniforms(item) {
  const { glow, pulse, dash } = item.animation;
  return {
    color: colorOf(item.fill),
    time: 0,
    reveal: 1,
    coreFraction:
      item.widthPx / (item.animation.backing?.widthPx ?? item.widthPx),
    backingColor: colorOf(item.animation.backing?.color ?? [0, 0, 0, 0]),
    glowPower: glow?.power ?? 0,
    taperPower: glow?.taper ?? 1,
    pulsePeriod: pulse ? pulse.periodMs / 1000 : 0,
    pulseMin: pulse?.min ?? 1,
    pulseMax: pulse?.max ?? 1,
    dashCells: dash?.cells ?? 0,
    dashDuty: dash?.duty ?? 0.5,
    dashSpeed: dash?.speed ?? 0,
    dashGap: dash?.gapAlpha ?? 0,
    dashEmission: dash?.emission ?? 0,
  };
}

const corridorMaterial = (item) =>
  item.animation.pattern
    ? Cesium.Material.fromType('PolylineDash', {
        color: colorOf(item.fill),
        gapColor: Cesium.Color.TRANSPARENT,
        dashLength: item.animation.pattern.lengthPx,
        dashPattern: item.animation.pattern.pattern,
      })
    : new Cesium.Material({
        fabric: {
          type: CORRIDOR_MATERIAL,
          uniforms: corridorUniforms(item),
          source: CORRIDOR_SOURCE,
        },
        translucent: true,
      });

/** The radial disc material, including its soft outside edge. */
function radialMaterial(item) {
  return new Cesium.Material({
    fabric: {
      type: 'GevGroundRadial',
      uniforms: { color: colorOf(item.fill), ...item.radial },
      source: `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float radius = length((materialInput.st - vec2(0.5)) * 2.0);
  float inside = 1.0 - smoothstep(rimEnd, 1.0, radius);
  float rim = smoothstep(rimStart, rimEnd, radius) * inside;
  material.diffuse = color.rgb;
  material.emission = color.rgb * rim * emission;
  material.alpha = color.a * inside * mix(fillAlpha, rimAlpha, rim);
  return material;
}`,
    },
    translucent: true,
  });
}

// Items of one look and colour share a primitive.
const lookKey = (item) =>
  JSON.stringify([Array.from(item.fill), item.animation]);

function positionsOf(flat) {
  const positions = [];
  for (let index = 0; index < flat.length; index += 2)
    positions.push(Cesium.Cartesian3.fromDegrees(flat[index], flat[index + 1]));
  return positions;
}

const longitude = (degrees) => degrees - 360 * Math.round(degrees / 360);

/** The fill geometry of one item of a set of `kind` (pure, for tests). */
function fillGeometry(kind, item) {
  const vertexFormat = item.radial
    ? Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat
    : Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT;
  if (kind === 'disc')
    return new Cesium.EllipseGeometry({
      center: Cesium.Cartesian3.fromDegrees(item.center[0], item.center[1]),
      semiMajorAxis: item.radiusM,
      semiMinorAxis: item.radiusM,
      ...(item.radial ? { granularity: Cesium.Math.toRadians(0.08) } : {}),
      vertexFormat,
    });
  if (kind === 'cell') {
    const { west, south, east, north } = item.bounds;
    return new Cesium.RectangleGeometry({
      rectangle: Cesium.Rectangle.fromDegrees(
        longitude(west),
        south,
        longitude(east),
        north,
      ),
      vertexFormat,
    });
  }
  if (kind === 'corridor')
    return new Cesium.CorridorGeometry({
      positions: positionsOf(item.path),
      width: item.widthM,
      vertexFormat,
    });
  const [outer, ...holes] = item.rings.map(positionsOf);
  return new Cesium.PolygonGeometry({
    polygonHierarchy: new Cesium.PolygonHierarchy(
      outer,
      holes.map((hole) => new Cesium.PolygonHierarchy(hole)),
    ),
    vertexFormat,
  });
}

/**
 * The geometry instances of a commit: `fills` for the GroundPrimitive,
 * `lines` for the GroundPolylinePrimitive, `animated` the corridors with a
 * glow, pulse or dash ({ item, instances }: one per look and colour, by
 * their first item). Instance ids name the set and item ({ gevGroundSet,
 * instance }).
 */
export function groundInstances(options, items) {
  const fills = [];
  const lines = [];
  const looks = new Map();
  const radial = [];
  items.forEach((item, instance) => {
    const id = { gevGroundSet: options.id, instance };
    const attributes = (rgba) => ({
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorOf(rgba)),
    });
    if (options.kind === 'corridor') {
      if (item.animation) {
        const key = lookKey(item);
        if (!looks.has(key)) looks.set(key, { item, instances: [] });
        looks.get(key).instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: positionsOf(item.path),
              width: item.animation.backing?.widthPx ?? item.widthPx,
            }),
            id,
          }),
        );
      } else if (item.widthM)
        fills.push(
          new Cesium.GeometryInstance({
            geometry: fillGeometry('corridor', item),
            id,
            attributes: attributes(item.fill),
          }),
        );
      else
        lines.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: positionsOf(item.path),
              width: item.widthPx,
            }),
            id,
            attributes: attributes(item.fill),
          }),
        );
      return;
    }
    if (item.radial)
      radial.push({
        item,
        instance: new Cesium.GeometryInstance({
          geometry: fillGeometry(options.kind, item),
          id,
        }),
      });
    else if (item.fill)
      fills.push(
        new Cesium.GeometryInstance({
          geometry: fillGeometry(options.kind, item),
          id,
          attributes: attributes(item.fill),
        }),
      );
    if (item.outline)
      for (const ring of areaRings(options.kind, item, {
        discSegments: DISC_OUTLINE_SEGMENTS,
      }))
        lines.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: positionsOf(ring),
              width: item.outline.widthPx,
              loop: true,
            }),
            id,
            attributes: attributes(item.outline.color),
          }),
        );
  });
  return { fills, lines, animated: [...looks.values()], radial };
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void, factories?: object }} [options]
 *   `factories` (the fill and line primitives) is a test seam.
 * @returns {{ ground: import('../contract.js').GlobeGround,
 *   identify: (picked: object) => ({ owner: string, instance: number, id: any, pickable: boolean } | null),
 *   destroy: () => void }}
 */
export function createCesiumGround(
  viewer,
  { requestRender = () => viewer.scene.requestRender(), factories = {} } = {},
) {
  const make = { ...DEFAULT_FACTORIES, ...factories };
  const { scene } = viewer;
  let heightsReady =
    make.lines !== DEFAULT_FACTORIES.lines &&
    make.fills !== DEFAULT_FACTORIES.fills;
  let heightsPromise = null;
  let root = null;
  const ordered = [];
  const building = new Set();
  let removeWatch = null;
  // Classification reads the current globe depth, including after a camera move.
  const surfaceReady = () =>
    scene.globe?.show === false || scene.globe?.tilesLoaded !== false;
  // Frames until every committed primitive has been built and drawn.
  const watch = () => {
    if (removeWatch || !scene.postRender) return;
    removeWatch = scene.postRender.addEventListener(() => {
      for (const primitive of building)
        if ((primitive.ready && surfaceReady()) || primitive.isDestroyed?.())
          building.delete(primitive);
      if (building.size) requestRender('ground-build');
      else {
        removeWatch();
        removeWatch = null;
        requestRender('ground-ready');
      }
    });
  };
  // Animated materials of every live set: their time is written before
  // every frame, and a frame follows every frame while a shown set has a
  // pulse or a dash.
  const materials = new Set();
  let removeTick = null;
  let removeAnimate = null;
  const animate = () => {
    if (materials.size && !removeTick && scene.preRender)
      removeTick = scene.preRender.addEventListener(() => {
        const seconds = groundSeconds();
        for (const material of materials) material.uniforms.time = seconds;
      });
    if (!materials.size && removeTick) {
      removeTick();
      removeTick = null;
    }
    const wanted = registry.animating();
    if (wanted && !removeAnimate && scene.postRender)
      removeAnimate = scene.postRender.addEventListener(() =>
        requestRender('ground-animate'),
      );
    if (!wanted && removeAnimate) {
      removeAnimate();
      removeAnimate = null;
    }
  };
  const rootCollection = () => {
    if (!root) {
      root = new Cesium.PrimitiveCollection({ destroyPrimitives: true });
      scene.groundPrimitives.add(root);
    }
    return root;
  };
  const build = (options) => {
    const slot = new Cesium.PrimitiveCollection({ destroyPrimitives: true });
    const at = ordered.filter((entry) => entry.order <= options.order).length;
    ordered.splice(at, 0, { order: options.order, slot });
    rootCollection().add(slot, at);
    let drawn = [];
    let looks = [];
    let fraction = 1;
    const classificationType = classificationOf(options.drape);
    const allowPicking = options.pickable;
    const synchronous = options.dynamic || options.reveal;
    let pending = null;
    let waiting = false;
    let destroyed = false;
    const forget = () => {
      for (const primitive of drawn) building.delete(primitive);
      for (const material of looks) materials.delete(material);
      drawn = [];
      looks = [];
    };
    const part = {
      commit(items) {
        pending = items;
        if (synchronous && !heightsReady) {
          if (!waiting) {
            waiting = true;
            heightsPromise ??=
              Cesium.GroundPrimitive.initializeTerrainHeights();
            heightsPromise.then(
              () => {
                heightsReady = true;
                waiting = false;
                if (!destroyed) part.commit(pending);
              },
              () => {
                heightsPromise = null;
                waiting = false;
              },
            );
          }
          return;
        }
        forget();
        slot.removeAll();
        const { fills, lines, animated, radial } = groundInstances(
          options,
          items,
        );
        if (fills.length)
          drawn.push(
            make.fills({
              geometryInstances: fills,
              appearance: new Cesium.PerInstanceColorAppearance({
                flat: true,
                translucent: true,
              }),
              classificationType,
              allowPicking,
              asynchronous: !synchronous,
            }),
          );
        for (const { item, instance } of radial)
          drawn.push(
            make.fills({
              geometryInstances: instance,
              appearance: new Cesium.MaterialAppearance({
                material: radialMaterial(item),
                translucent: true,
                closed: false,
                faceForward: true,
                flat: true,
                renderState: {
                  depthTest: { enabled: true },
                  depthMask: false,
                  polygonOffset: { enabled: true, factor: -1, units: -4 },
                  blending: Cesium.BlendingState.ALPHA_BLEND,
                },
              }),
              classificationType,
              allowPicking,
              asynchronous: !synchronous,
            }),
          );
        if (lines.length)
          drawn.push(
            make.lines({
              geometryInstances: lines,
              appearance: new Cesium.PolylineColorAppearance(),
              classificationType,
              allowPicking,
              asynchronous: !synchronous,
            }),
          );
        for (const { item, instances } of animated) {
          const material = corridorMaterial(item);
          material.uniforms.time = groundSeconds();
          material.uniforms.reveal = fraction;
          looks.push(material);
          materials.add(material);
          drawn.push(
            make.lines({
              geometryInstances: instances,
              appearance: new Cesium.PolylineMaterialAppearance({ material }),
              classificationType,
              allowPicking,
              asynchronous: !synchronous,
            }),
          );
        }
        for (const primitive of drawn) {
          primitive.gevGroundSet = options.id;
          slot.add(primitive);
          if (slot.show) building.add(primitive);
        }
        watch();
        animate();
        requestRender('ground');
      },
      reveal(value) {
        fraction = value;
        for (const material of looks) material.uniforms.reveal = value;
        requestRender('ground-reveal');
      },
      show(visible) {
        slot.show = visible;
        for (const primitive of drawn) {
          if (visible && (!primitive.ready || !surfaceReady()))
            building.add(primitive);
          else building.delete(primitive);
        }
        if (building.size) watch();
        animate();
        requestRender('ground');
      },
      ready: () =>
        (!synchronous || heightsReady) &&
        !waiting &&
        (drawn.length === 0 || surfaceReady()) &&
        drawn.every((primitive) => primitive.ready === true),
      destroy() {
        destroyed = true;
        pending = null;
        forget();
        animate();
        ordered.splice(
          ordered.findIndex((entry) => entry.slot === slot),
          1,
        );
        root.remove(slot);
        requestRender('ground');
      },
    };
    return part;
  };
  const registry = createGroundRegistry(build, {
    pulseField: (options) => createCesiumPulseField(viewer, options),
  });
  return {
    ground: registry.ground,
    /** The live ground item a Cesium pick names, with its pickId, or null. */
    identify(picked) {
      const owner = picked?.id?.gevGroundSet;
      const state = owner === undefined ? null : registry.live.get(owner);
      if (!state) return null;
      const { instance } = picked.id;
      const pickId = state.items[instance]?.pickId;
      return {
        owner,
        instance,
        id: pickId,
        pickable: state.options.pickable && pickId !== undefined,
      };
    },
    destroy() {
      registry.destroyAll();
      removeWatch?.();
      removeWatch = null;
      removeTick?.();
      removeAnimate?.();
      removeTick = removeAnimate = null;
      materials.clear();
      building.clear();
      if (root) {
        scene.groundPrimitives.remove(root);
        root = null;
      }
    },
  };
}
