/**
 * @module render/cesium/query
 * @description The Cesium renderer's query port
 * (`src/render/contract/query.d.ts`) over a scene and the draw sets drawn
 * in it: picks of draw-set items (by their pick ids), projection, rays and
 * height samples that see through the sets not drawn as ground.
 *
 * Built over a scene by `createCesiumPorts`, and on its own over a Cesium
 * viewer with no renderer bound, when code first asks
 * `findQuery` for one (`rendererOf.js`): then it answers over that viewer's
 * draw sets (`findDraw`), so a layer's height samples can see through its
 * own sets.
 */
import * as Cesium from 'cesium';
import { heightsFor } from './heights.js';
import { findDraw, provideUnboundQuery } from '../rendererOf.js';
import { toCartesian } from './common.js';
import { unboundDrawPart } from './draw.js';
import { drawHitOf } from './drawHit.js';

/**
 * The query capabilities a Cesium scene has: depth picks, height samples
 * and ray casts all need depth textures, which `pickPositionSupported` and
 * `sampleHeightSupported` report.
 * @param {object} scene
 * @returns {string[]}
 */
export function queryCapabilities(scene) {
  const found = [];
  if (scene.pickPositionSupported) found.push('pickPosition');
  if (scene.sampleHeightSupported)
    found.push('sampleHeight', 'finestHeights', 'rayCast');
  return found;
}

/**
 * @param {{scene: object, camera?: object, draw: {sets: Map<string, object>,
 *   version: () => number}, capabilities: ReadonlySet<string>}} options
 *   `draw`: the draw port's part (`createCesiumDraw`) whose sets it picks
 *   and sees through, read on each query; `capabilities` gate the members that need them.
 * @returns {import('../contract/query').QueryPort}
 */
export function createCesiumQuery({
  scene,
  camera = scene.camera,
  draw: drawPart,
  capabilities,
}) {
  const screen = (x, y) => new Cesium.Cartesian2(x, y);
  const ecef = (c) => (c ? { x: c.x, y: c.y, z: c.z } : null);
  const finite = (p) =>
    Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z);
  const cesiumRay = (ray) =>
    new Cesium.Ray(toCartesian(ray.origin), toCartesian(ray.direction));

  /** The live set and item a picked object belongs to, or null. */
  function ownerOf(picked) {
    const id = picked?.id;
    if (!id || typeof id.set !== 'string') return null;
    const record = drawPart.sets.get(id.set);
    const item = record?.items.get(id.id);
    return record && item ? { record, item, id } : null;
  }

  const pickable = ({ record, item }) =>
    record.host?.show !== false &&
    record.spec.pickable !== false &&
    item.show !== false &&
    item.pickable !== false;

  const hitOf = ({ id }) => drawHitOf({ id });

  /** The globe (or ellipsoid) under a pixel, as a surface hit. */
  function surfaceHit(x, y) {
    const position = query.pickPosition(x, y) ?? query.pickEllipsoid(x, y);
    return position ? { set: '', id: '', surface: true, position } : null;
  }

  /**
   * The pickable draw-set items under a pixel, nearest first, once each (a
   * shape's fill and outline share one id). `untilForeign` stops at the first
   * thing that is not a draw-set item (a tile, the app's own primitives):
   * what is behind it is hidden.
   */
  function drill(x, y, { width = 3, height = 3, limit, untilForeign } = {}) {
    const hits = [];
    if (limit === 0) return hits;
    const seen = new Set();
    for (const picked of scene.drillPick(
      screen(x, y),
      undefined,
      width,
      height,
    )) {
      const owner = ownerOf(picked);
      if (!owner) {
        if (untilForeign) break;
        continue;
      }
      const key = `${owner.id.set}\u0000${owner.id.id}`;
      if (!pickable(owner) || seen.has(key)) continue;
      seen.add(key);
      hits.push(hitOf(owner));
      if (limit !== undefined && hits.length >= limit) break;
    }
    return hits;
  }

  // What height queries see through, by their items' pick ids: the sets not
  // drawn as ground, and the sets a caller excludes. Built once per change
  // to the sets, not per query.
  const seeThroughCache = new Map();
  let seeThroughVersion = -1;
  function seeThrough(exclude, { allSets = false } = {}) {
    if (seeThroughVersion !== drawPart.version()) {
      seeThroughCache.clear();
      seeThroughVersion = drawPart.version();
    }
    const key = `${allSets}\u0000${exclude?.join('\u0000') ?? ''}`;
    let out = seeThroughCache.get(key);
    if (!out) {
      out = [];
      for (const record of drawPart.sets.values())
        if (
          allSets ||
          !record.spec.includeInHeightQueries ||
          exclude?.includes(record.spec.id)
        )
          for (const id of record.pickIds) out.push(id);
      seeThroughCache.set(key, out);
    }
    return out;
  }

  /** Whether a set drawn as ground is in the scene, other than `exclude`. */
  const groundSets = (exclude) =>
    [...drawPart.sets.values()].some(
      (record) =>
        record.spec.includeInHeightQueries &&
        record.host?.show !== false &&
        !exclude?.includes(record.spec.id),
    );

  const heights = () => heightsFor(scene);
  const can = (capability) => capabilities.has(capability);
  const globeShown = () => Boolean(scene.globe?.show);

  /**
   * `fn` with the globe hidden, so a pick or sample sees tiles and sets
   * alone. Synchronous: the globe is shown again before anything draws.
   */
  function withoutGlobe(fn) {
    if (!globeShown()) return fn();
    scene.globe.show = false;
    try {
      return fn();
    } finally {
      scene.globe.show = true;
    }
  }

  /** A height now from what is loaded, against the surface asked for. */
  function heightNow(point, against, excluded) {
    if (against === 'terrain')
      return heights().now(point, { against: 'terrain' });
    const sample = () => heights().now(point, { exclude: excluded });
    return against === 'tiles' ? withoutGlobe(sample) : sample();
  }

  const close = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 0.01;
  const ellipsoidTerrain = () =>
    scene.terrainProvider instanceof Cesium.EllipsoidTerrainProvider;

  /**
   * Where a height came from, told apart by sampling again without the
   * ground sets and against the terrain alone.
   */
  function sourceOf(point, height, against, exclude) {
    const terrain = () => (ellipsoidTerrain() ? 'ellipsoid' : 'terrain');
    if (against === 'terrain') return terrain();
    if (groundSets(exclude)) {
      const bare = heightNow(
        point,
        against,
        seeThrough(exclude, { allSets: true }),
      );
      if (!close(bare, height)) return 'set';
    }
    if (against === 'tiles' || !globeShown()) return 'tiles';
    return close(heights().now(point, { against: 'terrain' }), height)
      ? terrain()
      : 'tiles';
  }

  const query = {
    pick(x, y, window = {}) {
      const owner = ownerOf(
        scene.pick(screen(x, y), window.width ?? 3, window.height ?? 3),
      );
      if (owner && pickable(owner)) return hitOf(owner);
      // Something unpickable is on top: the first pickable item under it,
      // unless something else hides it.
      if (owner) {
        const [under] = drill(x, y, {
          ...window,
          limit: 1,
          untilForeign: true,
        });
        if (under) return under;
      }
      return surfaceHit(x, y);
    },
    drillPick: (x, y, options = {}) =>
      drill(x, y, { ...options, untilForeign: false }),
    pickPosition(x, y) {
      if (!can('pickPosition') || !scene.pickPositionSupported) return null;
      return ecef(scene.pickPosition(screen(x, y)));
    },
    pickEllipsoid(x, y) {
      return ecef(camera.pickEllipsoid(screen(x, y)));
    },
    pickGlobe(ray) {
      return ecef(scene.globe?.pick(cesiumRay(ray), scene));
    },
    pickRay(x, y) {
      const ray = camera.getPickRay(screen(x, y));
      return { origin: ecef(ray.origin), direction: ecef(ray.direction) };
    },
    project(position) {
      const s = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        toCartesian(position),
      );
      return s ? { x: s.x, y: s.y } : null;
    },
    projectMany(source, out) {
      const p = new Cesium.Cartesian3();
      const s = new Cesium.Cartesian2();
      for (let i = 0, j = 0; i + 2 < source.length; i += 3, j += 2) {
        p.x = source[i];
        p.y = source[i + 1];
        p.z = source[i + 2];
        const w = Cesium.SceneTransforms.worldToWindowCoordinates(scene, p, s);
        out[j] = w ? w.x : NaN;
        out[j + 1] = w ? w.y : NaN;
      }
    },
    isOccluded(position) {
      const occluder = new Cesium.EllipsoidalOccluder(
        scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
        camera.positionWC,
      );
      return !occluder.isPointVisible(toCartesian(position));
    },
    sampleHeightNow(point, { against = 'surface', exclude } = {}) {
      // Terrain answers from the globe's own tiles, without depth textures.
      if (against === 'terrain') return heightNow(point, against);
      if (!can('sampleHeight')) return null;
      return heightNow(point, against, seeThrough(exclude));
    },
    sampleHeightNowMany(points, out, { against = 'surface', exclude } = {}) {
      // Terrain sees through nothing, so it needs no sets to see through.
      const excluded =
        against === 'terrain' || (can('sampleHeight') && seeThrough(exclude));
      const point = { lon: 0, lat: 0 };
      for (let i = 0; i < out.length; i++) {
        point.lon = points[i * 2];
        point.lat = points[i * 2 + 1];
        out[i] = excluded ? (heightNow(point, against, excluded) ?? NaN) : NaN;
      }
    },
    /**
     * Cesium streams the finest tiles for every sample, `mostDetailed` or
     * not. Against `tiles` it streams them, then samples them with the
     * globe hidden, which only a synchronous sample can do.
     */
    async sampleHeight(points, { against = 'surface', exclude } = {}) {
      if (!can('sampleHeight')) return points.map(() => null);
      const excluded = seeThrough(exclude);
      let found = await heights().batch(
        points,
        against === 'terrain' ? { against: 'terrain' } : { exclude: excluded },
      );
      if (against === 'tiles')
        found = points.map((point) => heightNow(point, 'tiles', excluded));
      const lod = can('finestHeights') ? 'finest' : 'visible';
      return found.map((height, i) =>
        height === null
          ? null
          : {
              height,
              confidence: 1,
              source: sourceOf(points[i], height, against, exclude),
              lod,
            },
      );
    },
    async clampToSurface(positions, options = {}) {
      const points = positions.map((p) => {
        const c =
          finite(p) && Cesium.Cartographic.fromCartesian(toCartesian(p));
        return c
          ? {
              lon: Cesium.Math.toDegrees(c.longitude),
              lat: Cesium.Math.toDegrees(c.latitude),
            }
          : null;
      });
      const samples = await query.sampleHeight(
        points.map((p) => p ?? { lon: NaN, lat: NaN }),
        options,
      );
      return samples.map((sample, i) =>
        sample && points[i]
          ? ecef(
              Cesium.Cartesian3.fromDegrees(
                points[i].lon,
                points[i].lat,
                sample.height,
              ),
            )
          : null,
      );
    },
    async rayCast(
      ray,
      { against = 'surface', exclude, maxDistance = Infinity } = {},
    ) {
      if (!can('rayCast')) return null;
      const r = cesiumRay(ray);
      let position;
      if (against === 'terrain') position = scene.globe?.pick(r, scene);
      else {
        const cast = () => scene.pickFromRay(r, seeThrough(exclude))?.position;
        position = against === 'tiles' ? withoutGlobe(cast) : cast();
      }
      if (!position) return null;
      return Cesium.Cartesian3.distance(r.origin, position) <= maxDistance
        ? ecef(position)
        : null;
    },
  };
  return query;
}

/** No draw sets, while a viewer has no draw port. */
const NO_SETS = new Map();

// A Cesium viewer with no renderer bound to it gets a
// query port over its scene when code first asks `findQuery` for one,
// answering over the draw sets drawn through `findDraw` on the same viewer
// (looked up on each query, which makes the viewer's draw port if it has
// none yet: a layer may draw after it asks for the query port).
provideUnboundQuery((viewer) => {
  const scene = viewer.scene;
  // By shape, not `instanceof`: the viewer may come from another
  // copy of Cesium.
  if (
    typeof scene?.pick !== 'function' ||
    typeof scene.drillPick !== 'function' ||
    typeof scene.camera?.pickEllipsoid !== 'function'
  )
    return null;
  const part = () => unboundDrawPart(findDraw(viewer));
  const port = createCesiumQuery({
    scene,
    draw: {
      get sets() {
        return part()?.sets ?? NO_SETS;
      },
      version: () => part()?.version() ?? 0,
    },
    capabilities: new Set(queryCapabilities(scene)),
  });
  return { port, dispose() {} };
});
