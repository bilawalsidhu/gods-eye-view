/**
 * Renderer ports over a Cesium-shaped viewer double, for tests of layers
 * that reach the camera, projection, frame loop and drawing through the
 * renderer: everything reads the double live, as the Cesium ports read
 * their scene.
 *
 * - camera: `pose()` from the double's camera (`viewer.camera`, else
 *   `viewer.scene.camera`): `positionWC`, `directionWC`,
 *   `positionCartographic` and `frustum.fovy` (none for an orthographic
 *   frustum, π/3 without a frustum); `matrices()` from its `viewMatrix` and
 *   `frustum.projectionMatrix`; `viewRectangle()` from its
 *   `computeViewRectangle()`, in degrees; events from its own `moveEnd`,
 *   `moveStart` and `changed`.
 * - query: `pick` and `drillPick` through the scene's own, naming a pick of
 *   a draw-set item (its pick id `{set, id}`) as the renderer does and
 *   anything else as the map (`drillPick`: draw-set items only);
 *   `sampleHeightNow` through the scene's height service;
 *   `pickPosition` through the scene's, where `pickPositionSupported`;
 *   `pickRay` and `pickEllipsoid` through the double camera's, when it has
 *   them; `pickGlobe` through the scene's globe; `project`
 *   (and `projectMany`) through `Cesium.SceneTransforms.worldToWindowCoordinates`
 *   (which a test may stub), `isOccluded` against the ellipsoid's horizon
 *   from the camera's `positionWC` (never occluded without one).
 * - frame: phases from the scene's own `preUpdate`, `preRender` and
 *   `postRender` events.
 * - draw: a fake draw port (`fakeDrawPort.mjs`) unless one is given.
 * - canvas: the double's `canvas`, else its scene's.
 */
import * as Cesium from 'cesium';
import { bindRenderer } from '../render/rendererOf.js';
import { heightsFor } from '../render/cesium/heights.js';
import { drawHitOf } from '../render/cesium/drawHit.js';
import { rememberPick } from '../render/cesium/pickMemo.js';
import { fakeDrawPort } from './fakeDrawPort.mjs';

const toCartesian = (p) => new Cesium.Cartesian3(p.x, p.y, p.z);
const plain = (c) => ({ x: c.x, y: c.y, z: c.z });

/** Subscribe to a Cesium-style event, if the double has it. */
function listen(source, cb) {
  const off = source?.addEventListener?.(cb);
  if (typeof off === 'function') return off;
  return () => source?.removeEventListener?.(cb);
}

/** The double's camera: `viewer.camera`, else `viewer.scene.camera`. */
const cameraOfDouble = (viewer) =>
  viewer.camera?.positionWC || !viewer.scene?.camera
    ? viewer.camera
    : viewer.scene.camera;

/**
 * A query port's `pick` and `drillPick` over a viewer double's own
 * `scene.pick` and `drillPick`: a pick of a draw-set item (its pick id
 * `{set, id}`) is that item's `Hit`, anything else the map; a drill names
 * draw-set items only. A pick is noted as the Cesium query port notes its
 * own, so a click's own Cesium picks reuse it.
 * @param {object} viewer
 */
export function fakeScenePicks(viewer) {
  const at = (x, y) => new Cesium.Cartesian2(x, y);
  return {
    pick(x, y, window = {}) {
      const width = window.width ?? 3;
      const height = window.height ?? 3;
      const scene = viewer.scene;
      if (typeof scene?.pick !== 'function') return null;
      const picked = scene.pick(at(x, y), width, height);
      rememberPick(scene, x, y, width, height, picked);
      return drawHitOf(picked) ?? { set: '', id: '', surface: true };
    },
    drillPick(x, y, { width, height, limit } = {}) {
      const scene = viewer.scene;
      if (typeof scene?.drillPick !== 'function' || limit === 0) return [];
      const hits = [];
      for (const picked of scene.drillPick(
        at(x, y),
        limit === undefined ? undefined : Math.max(limit, 16),
        width,
        height,
      ) ?? []) {
        const hit = drawHitOf(picked);
        if (!hit) continue;
        hits.push(hit);
        if (limit !== undefined && hits.length >= limit) break;
      }
      return hits;
    },
  };
}

/**
 * The query port `bindFakeCesiumScene` binds, on its own, for a test that
 * binds its other ports another way (`bindFakeCesiumCamera`'s `ports`).
 * @param {object} viewer
 */
export function fakeSceneQuery(viewer) {
  return {
    ...fakeScenePicks(viewer),
    project(position) {
      // The position itself, so a stub can tell positions apart by identity.
      const s = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        position,
      );
      return s ? { x: s.x, y: s.y } : null;
    },
    /** The scene's depth pick, where the double says it has one. */
    pickPosition(x, y) {
      const scene = viewer.scene;
      if (
        !scene?.pickPositionSupported ||
        typeof scene.pickPosition !== 'function'
      )
        return null;
      const hit = scene.pickPosition(new Cesium.Cartesian2(x, y));
      return hit ? plain(hit) : null;
    },
    /** The double camera's own pick ray. */
    pickRay(x, y) {
      const ray = cameraOfDouble(viewer).getPickRay(
        new Cesium.Cartesian2(x, y),
      );
      return { origin: plain(ray.origin), direction: plain(ray.direction) };
    },
    /** The double globe's own pick, when it has one. */
    pickGlobe(ray) {
      const hit = viewer.scene?.globe?.pick?.(
        new Cesium.Ray(toCartesian(ray.origin), toCartesian(ray.direction)),
        viewer.scene,
      );
      return hit ? plain(hit) : null;
    },
    /** The double camera's own, when it has one. */
    get pickEllipsoid() {
      const camera = cameraOfDouble(viewer);
      if (typeof camera?.pickEllipsoid !== 'function') return undefined;
      return (x, y) => {
        const hit = camera.pickEllipsoid(new Cesium.Cartesian2(x, y));
        return hit ? plain(hit) : null;
      };
    },
    projectMany(source, out) {
      for (let i = 0, j = 0; i + 2 < source.length; i += 3, j += 2) {
        const s = this.project({
          x: source[i],
          y: source[i + 1],
          z: source[i + 2],
        });
        out[j] = s ? s.x : Number.NaN;
        out[j + 1] = s ? s.y : Number.NaN;
      }
    },
    // The scene's own height service, the surface only where the scene has
    // depth support. Unlike the Cesium port it samples terrain without depth
    // support too, and sees through nothing (`exclude` is ignored).
    sampleHeightNow(point, { against = 'surface' } = {}) {
      if (against === 'terrain')
        return heightsFor(viewer.scene).now(point, { against: 'terrain' });
      return viewer.scene?.sampleHeightSupported
        ? heightsFor(viewer.scene).now(point)
        : null;
    },
    isOccluded(position) {
      const eye = cameraOfDouble(viewer)?.positionWC;
      if (!eye) return false;
      return !new Cesium.EllipsoidalOccluder(
        Cesium.Ellipsoid.WGS84,
        eye,
      ).isPointVisible(toCartesian(position));
    },
  };
}

/**
 * The frame port `bindFakeCesiumScene` binds, on its own, as
 * `fakeSceneQuery` is.
 * @param {object} viewer
 */
export function fakeSceneFrame(viewer) {
  return {
    on: (phase, cb) => listen(viewer.scene?.[phase], cb),
    requestRender: () => viewer.scene?.requestRender?.(),
    /** Scene time: the fake clock's, else now. */
    time() {
      const time = viewer.clock?.currentTime;
      return time instanceof Cesium.JulianDate
        ? Cesium.JulianDate.toDate(time).getTime()
        : Date.now();
    },
  };
}

/**
 * A fake draw port and the query and frame ports above, for
 * `bindFakeCesiumCamera(viewer, fakeScenePorts(viewer))`.
 * @param {object} viewer
 * @returns {{draw: object, query: object, frame: object}}
 */
export function fakeScenePorts(viewer) {
  return {
    draw: fakeDrawPort(),
    query: fakeSceneQuery(viewer),
    frame: fakeSceneFrame(viewer),
  };
}

/**
 * Bind the ports to `viewer`.
 * @param {object} viewer
 * @param {{draw?: object, capabilities?: ReadonlySet<string>}} [options]
 *   `capabilities`: what the renderer reports it can draw (none by default).
 * @returns {{draw: object, camera: object, query: object, frame: object, unbind: () => void}}
 */
export function bindFakeCesiumScene(
  viewer,
  { draw = fakeDrawPort(), capabilities } = {},
) {
  const cam = () => cameraOfDouble(viewer);
  const camera = {
    pose() {
      const c = cam();
      const carto = c?.positionCartographic;
      const deg = (r) =>
        Number.isFinite(r) ? Cesium.Math.toDegrees(r) : Number.NaN;
      return {
        lon: deg(carto?.longitude),
        lat: deg(carto?.latitude),
        height: carto?.height ?? Number.NaN,
        heading: c?.heading ?? 0,
        pitch: c?.pitch ?? -Math.PI / 2,
        roll: c?.roll ?? 0,
        position: c?.positionWC ? plain(c.positionWC) : { x: 0, y: 0, z: 0 },
        direction: c?.directionWC
          ? plain(c.directionWC)
          : { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
        right: { x: 1, y: 0, z: 0 },
        // An orthographic frustum has none, as the Cesium port reports it.
        fovy:
          c?.frustum instanceof Cesium.OrthographicOffCenterFrustum
            ? undefined
            : (c?.frustum?.fovy ?? Math.PI / 3),
        aspectRatio: 1,
        near: 1,
        far: 5e8,
        frameIsIdentity: true,
      };
    },
    /** The double camera's `viewMatrix` and `frustum.projectionMatrix`. */
    matrices() {
      const c = cam();
      return {
        view: Float64Array.from(Cesium.Matrix4.toArray(c.viewMatrix)),
        projection: Float64Array.from(
          Cesium.Matrix4.toArray(c.frustum.projectionMatrix),
        ),
      };
    },
    viewRectangle() {
      const rect = cam()?.computeViewRectangle?.();
      if (!rect) return null;
      const deg = Cesium.Math.toDegrees;
      return {
        west: deg(rect.west),
        south: deg(rect.south),
        east: deg(rect.east),
        north: deg(rect.north),
      };
    },
    on: (event, cb) => listen(cam()?.[event], cb),
  };
  const query = fakeSceneQuery(viewer);
  const frame = fakeSceneFrame(viewer);
  const unbind = bindRenderer(viewer, {
    // The double's canvas, as `bindFakeCesiumCamera`'s renderer reports it.
    get canvas() {
      return viewer.canvas ?? viewer.scene?.canvas;
    },
    draw,
    camera,
    query,
    frame,
    // What the renderer can draw, when a test gives it (none otherwise).
    ...(capabilities ? { capabilities } : null),
  });
  return { draw, camera, query, frame, unbind };
}
