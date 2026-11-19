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
import { pickEllipsoidAt, pickRayAt, toCartesian } from './common.js';
import { unboundDrawPart } from './draw.js';
import { drawHitOf } from './drawHit.js';
import { rememberPick } from './pickMemo.js';
import { createSceneOcclusionTest } from './sceneOcclusionProbe.js';

/** The fewest things a bounded drill looks through (`QueryPort.drillPick`). */
const DRILL_DEPTH = 16;

/**
 * The query capabilities a Cesium scene has: depth picks, height samples
 * and ray casts all need depth textures, which `pickPositionSupported` and
 * `sampleHeightSupported` report.
 * @param {object} scene
 * @returns {string[]}
 */
export function queryCapabilities(scene) {
  const found = [];
  // The occlusion test reads the same depth a depth pick does.
  if (scene.pickPositionSupported) found.push('pickPosition', 'occlusionTest');
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

  /**
   * The hits a picked object stands for: its item's, or for a cluster's
   * icon, one a member in the cluster's order (seed first), each at the
   * cluster's position (`ClusterSpec`); unpickable members left out.
   */
  function hitsOf(owner) {
    const cluster = owner.id.cluster;
    if (!cluster) return pickable(owner) ? [hitOf(owner)] : [];
    const { record } = owner;
    const hits = [];
    for (const id of cluster.ids) {
      const item = record.items.get(id);
      if (!item || !pickable({ record, item })) continue;
      hits.push({
        set: record.spec.id,
        id,
        ...(item.meta === undefined ? {} : { meta: item.meta }),
        surface: false,
        position: { ...cluster.position },
      });
    }
    return hits;
  }

  /** A query that throws answers nothing. */
  const quietly = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  /**
   * The globe (or ellipsoid) under a pixel, as a surface hit. Where the
   * ellipsoid is under it, its position is the depth pick's (another pass
   * over the scene), made when first read. Where it is not, the depth pick
   * decides, unless nothing was picked there and no globe tile is on the
   * pixel's ray: the sky, with no pass. A depth pick that throws finds no
   * surface, so what was picked there is still read.
   */
  function surfaceHit(x, y, picked) {
    const ellipsoid = quietly(() => query.pickEllipsoid(x, y));
    if (!ellipsoid) {
      if (
        picked == null &&
        !quietly(() => query.pickGlobe(query.pickRay(x, y)))
      )
        return null;
      const position = quietly(() => query.pickPosition(x, y));
      return position ? { set: '', id: '', surface: true, position } : null;
    }
    let position;
    const hit = { set: '', id: '', surface: true };
    Object.defineProperty(hit, 'position', {
      enumerable: true,
      configurable: true,
      get() {
        position ??= quietly(() => query.pickPosition(x, y)) ?? ellipsoid;
        return position;
      },
    });
    return hit;
  }

  /**
   * The pickable draw-set items under a pixel, nearest first, once each (a
   * shape's fill and outline share one id). `untilForeign` stops at the first
   * thing that is not a draw-set item (a tile, the app's own primitives):
   * what is behind it is hidden. With a `limit`, Cesium looks through at
   * most `max(limit, 16)` things of any kind (each a pick pass), as the
   * contract bounds the work; without one, or with `unbounded` (a `pick`
   * looking under something unpickable), it picks until nothing is left.
   */
  function drill(
    x,
    y,
    { width = 3, height = 3, limit, untilForeign, unbounded = false } = {},
  ) {
    const hits = [];
    if (limit === 0) return hits;
    const seen = new Set();
    for (const picked of scene.drillPick(
      screen(x, y),
      limit === undefined || unbounded
        ? undefined
        : Math.max(limit, DRILL_DEPTH),
      width,
      height,
    )) {
      const owner = ownerOf(picked);
      if (!owner) {
        if (untilForeign) break;
        continue;
      }
      let full = false;
      for (const hit of hitsOf(owner)) {
        const key = `${hit.set}\u0000${hit.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(hit);
        if (limit !== undefined && hits.length >= limit) {
          full = true;
          break;
        }
      }
      if (full) break;
    }
    return hits;
  }

  // What height queries see through, by their items' pick ids: the sets not
  // drawn as ground, and the sets a caller excludes. Built once per change
  // to the sets, not per query. Each list's sets are kept beside it, with
  // the change they were read at, for `withoutSets` to hide.
  const seeThroughCache = new Map();
  const seeThroughSets = new WeakMap();
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
      const records = [];
      for (const record of drawPart.sets.values())
        if (
          allSets ||
          !record.spec.includeInHeightQueries ||
          exclude?.includes(record.spec.id)
        ) {
          records.push(record);
          for (const id of record.pickIds) out.push(id);
        }
      seeThroughCache.set(key, out);
      seeThroughSets.set(out, { records, version: seeThroughVersion });
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

  /**
   * The hosts `withoutSets` hid, each followed by its set, shown again once its
   * sample is done.
   */
  let hiddenHosts = [];
  const hide = (host, record) => {
    if (!host || host.show === false || host.isDestroyed?.()) return;
    host.show = false;
    hiddenHosts.push(host, record);
  };
  /** Show again what `hidden` hid, as each set now asks. */
  const showAgain = (hidden) => {
    for (let i = 0; i < hidden.length; i += 2)
      hidden[i].show = hidden[i + 1].spec.show !== false;
  };

  /**
   * `fn` with the sets seen through by `excluded` hidden whole, so a sample
   * renders past them in one pass. Seen through item by item instead, each
   * item hit costs another pass, and a line hit rebuilds every line of its
   * collection, as the scene hides a hit line alone. Synchronous: they are
   * shown again, as their sets now ask, before anything draws. A list read
   * before the sets last changed is seen through item by item, as its items
   * may no longer be all its sets draw; a sample inside another sees what
   * the outer one hid, unless it sees through it too.
   */
  function withoutSets(excluded, fn) {
    const seen = excluded && seeThroughSets.get(excluded);
    const current =
      seen?.records.length > 0 && seen.version === drawPart.version();
    const outer = hiddenHosts;
    if (!current && !outer.length) return fn();
    showAgain(outer);
    hiddenHosts = [];
    try {
      if (current)
        for (const record of seen.records) {
          hide(record.host, record);
          hide(record.retiring, record);
        }
      return fn();
    } finally {
      showAgain(hiddenHosts);
      hiddenHosts = outer;
      for (let i = 0; i < outer.length; i += 2) outer[i].show = false;
    }
  }

  /** A height now from what is loaded, against the surface asked for. */
  function heightNow(point, against, excluded) {
    if (against === 'terrain')
      return heights().now(point, { against: 'terrain' });
    const sample = () =>
      withoutSets(excluded, () => heights().now(point, { exclude: excluded }));
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

  /** `isOccluded`'s horizon, rebuilt when the eye or ellipsoid moves. */
  let occluder = null;
  let occluderEllipsoid = null;
  const occluderEye = new Cesium.Cartesian3(NaN, NaN, NaN);
  const occludedPoint = new Cesium.Cartesian3();
  /** `project`'s scratch point and window position. */
  const projectedPoint = new Cesium.Cartesian3();
  const projectedWindow = new Cesium.Cartesian2();

  const query = {
    pick(x, y, window = {}) {
      const width = window.width ?? 3;
      const height = window.height ?? 3;
      const picked = scene.pick(screen(x, y), width, height);
      rememberPick(scene, x, y, width, height, picked);
      const owner = ownerOf(picked);
      const [hit] = owner ? hitsOf(owner) : [];
      if (hit) return hit;
      // Something unpickable is on top: the first pickable item under it,
      // unless something else hides it.
      if (owner) {
        const [under] = drill(x, y, {
          ...window,
          limit: 1,
          untilForeign: true,
          unbounded: true,
        });
        if (under) return under;
      }
      return surfaceHit(x, y, picked);
    },
    drillPick: (x, y, options = {}) =>
      drill(x, y, { ...options, untilForeign: false }),
    pickPosition(x, y) {
      if (!can('pickPosition') || !scene.pickPositionSupported) return null;
      return ecef(scene.pickPosition(screen(x, y)));
    },
    pickEllipsoid(x, y) {
      return ecef(pickEllipsoidAt(scene, camera, x, y));
    },
    pickGlobe(ray) {
      return ecef(scene.globe?.pick(cesiumRay(ray), scene));
    },
    pickRay(x, y) {
      const ray = pickRayAt(scene, camera, x, y);
      if (!ray) return null;
      return { origin: ecef(ray.origin), direction: ecef(ray.direction) };
    },
    project(position) {
      projectedPoint.x = position.x;
      projectedPoint.y = position.y;
      projectedPoint.z = position.z;
      const s = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        projectedPoint,
        projectedWindow,
      );
      return s ? { x: s.x, y: s.y } : null;
    },
    projectMany(source, out) {
      const p = projectedPoint;
      const s = projectedWindow;
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
      // One occluder per eye and ellipsoid, and one scratch point, so a
      // per-frame pass over many labels allocates nothing.
      const ellipsoid = scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84;
      const eye = camera.positionWC;
      if (
        !occluder ||
        occluderEllipsoid !== ellipsoid ||
        !Cesium.Cartesian3.equals(occluderEye, eye)
      ) {
        occluder = new Cesium.EllipsoidalOccluder(ellipsoid, eye);
        occluderEllipsoid = ellipsoid;
        Cesium.Cartesian3.clone(eye, occluderEye);
      }
      occludedPoint.x = position.x;
      occludedPoint.y = position.y;
      occludedPoint.z = position.z;
      return !occluder.isPointVisible(occludedPoint);
    },
    sampleHeightNow(point, { against = 'surface', exclude } = {}) {
      // Terrain answers from the globe's own tiles, without depth textures.
      if (against === 'terrain') return heightNow(point, against);
      if (!can('sampleHeight')) return null;
      return heightNow(point, against, seeThrough(exclude));
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
  // Only where the scene keeps the depth it tests against.
  if (can('occlusionTest'))
    query.occlusionTest = () => createSceneOcclusionTest(scene);
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
