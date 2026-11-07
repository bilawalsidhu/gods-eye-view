// engine.ground on Cesium: each set is a PrimitiveCollection placed by
// `order` inside one engine-owned collection in scene.groundPrimitives
// (added with the first set), so a rebuild keeps its place. A commit
// rebuilds the set as at most two batches: one GroundPrimitive of every
// fill (polygons, discs as EllipseGeometry, cells as RectangleGeometry,
// metre corridors as CorridorGeometry) and one GroundPolylinePrimitive of
// every outline and pixel corridor, over the fills, both with per-instance
// colours and the set's classificationType. Cesium builds them in workers;
// the engine keeps requesting frames until they are drawn. A set made
// without pickable stays out of the pick pass (a GroundPrimitive with
// allowPicking false still writes its stencil there and hides what lies
// under it); identify() names a picked item.

import * as Cesium from 'cesium';
import { areaRings, createGroundRegistry } from '../ground.js';

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

function positionsOf(flat) {
  const positions = [];
  for (let index = 0; index < flat.length; index += 2)
    positions.push(Cesium.Cartesian3.fromDegrees(flat[index], flat[index + 1]));
  return positions;
}

const longitude = (degrees) => degrees - 360 * Math.round(degrees / 360);

/** The fill geometry of one item of a set of `kind` (pure, for tests). */
export function fillGeometry(kind, item) {
  const vertexFormat = Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT;
  if (kind === 'disc')
    return new Cesium.EllipseGeometry({
      center: Cesium.Cartesian3.fromDegrees(item.center[0], item.center[1]),
      semiMajorAxis: item.radiusM,
      semiMinorAxis: item.radiusM,
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
 * `lines` for the GroundPolylinePrimitive. Instance ids name the set and
 * item ({ gevGroundSet, instance }).
 */
export function groundInstances(options, items) {
  const fills = [];
  const lines = [];
  items.forEach((item, instance) => {
    const id = { gevGroundSet: options.id, instance };
    const attributes = (rgba) => ({
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorOf(rgba)),
    });
    if (options.kind === 'corridor') {
      if (item.widthM)
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
    if (item.fill)
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
  return { fills, lines };
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
  let root = null;
  const ordered = [];
  const building = new Set();
  let removeWatch = null;
  // Frames until every committed primitive has been built and drawn.
  const watch = () => {
    if (removeWatch || !scene.postRender) return;
    removeWatch = scene.postRender.addEventListener(() => {
      for (const primitive of building)
        if (primitive.ready || primitive.isDestroyed?.())
          building.delete(primitive);
      if (building.size) requestRender('ground-build');
      else {
        removeWatch();
        removeWatch = null;
        requestRender('ground-ready');
      }
    });
  };
  const rootCollection = () => {
    if (!root) {
      root = new Cesium.PrimitiveCollection({ destroyPrimitives: true });
      scene.groundPrimitives.add(root);
    }
    return root;
  };
  const registry = createGroundRegistry((options) => {
    const slot = new Cesium.PrimitiveCollection({ destroyPrimitives: true });
    const at = ordered.filter((entry) => entry.order <= options.order).length;
    ordered.splice(at, 0, { order: options.order, slot });
    rootCollection().add(slot, at);
    let drawn = [];
    const classificationType = classificationOf(options.drape);
    const allowPicking = options.pickable;
    return {
      commit(items) {
        for (const primitive of drawn) building.delete(primitive);
        slot.removeAll();
        drawn = [];
        const { fills, lines } = groundInstances(options, items);
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
            }),
          );
        if (lines.length)
          drawn.push(
            make.lines({
              geometryInstances: lines,
              appearance: new Cesium.PolylineColorAppearance(),
              classificationType,
              allowPicking,
            }),
          );
        for (const primitive of drawn) {
          primitive.gevGroundSet = options.id;
          slot.add(primitive);
          building.add(primitive);
        }
        watch();
        requestRender('ground');
      },
      show(visible) {
        slot.show = visible;
        requestRender('ground');
      },
      ready: () => drawn.every((primitive) => primitive.ready === true),
      destroy() {
        for (const primitive of drawn) building.delete(primitive);
        drawn = [];
        ordered.splice(
          ordered.findIndex((entry) => entry.slot === slot),
          1,
        );
        root.remove(slot);
        requestRender('ground');
      },
    };
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
      building.clear();
      if (root) {
        scene.groundPrimitives.remove(root);
        root = null;
      }
    },
  };
}
