/**
 * @module render/cesium/common
 * @description What the Cesium ports share: the contract's listener rules
 * and its positions as Cesium's.
 */
import * as Cesium from 'cesium';

/**
 * One subscription list under the contract's listener rules: subscription
 * order, one removed during delivery does not run, one added during
 * delivery waits for the next event, and a throw goes to `onThrow` while
 * the rest still run. Each subscription is its own entry, so a callback
 * subscribed twice runs twice.
 * @param {(error: unknown) => void} onThrow
 */
export function listenerList(onThrow) {
  // Copied on change, not on delivery: a delivery runs over the list as it
  // stood, and a change made during it makes a new one.
  let entries = [];
  return {
    get size() {
      return entries.length;
    },
    on(cb) {
      const entry = { cb, live: true };
      entries = [...entries, entry];
      return () => {
        if (!entry.live) return;
        entry.live = false;
        entries = entries.filter((e) => e !== entry);
      };
    },
    fire(...args) {
      for (const entry of entries) {
        if (!entry.live) continue;
        try {
          entry.cb(...args);
        } catch (error) {
          onThrow(error);
        }
      }
    },
    clear() {
      for (const entry of entries) entry.live = false;
      entries = [];
    },
  };
}

/** A contract position as ECEF. */
export function toCartesian(pos) {
  if ('x' in pos) return new Cesium.Cartesian3(pos.x, pos.y, pos.z);
  return Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.height ?? 0);
}

/**
 * Where a listener's throw goes with no `error` listener: the platform's
 * `reportError` (or a rethrow on a microtask), as a browser reports an event
 * listener's exception, loud, while the frame and the other listeners carry
 * on.
 */
export function uncaught(error) {
  if (typeof globalThis.reportError === 'function')
    globalThis.reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}

/**
 * Blob object URLs: one stable URL a blob, revoked only once the blob itself
 * has been collected. Every item that can still draw a blob holds it, so its
 * URL stays valid for as long as anything can load from it (a material that
 * loads on its first draw, a set shown long after it was made); and the
 * same blob always keys the same icon atlas slot.
 * @param {typeof FinalizationRegistry} [Registry] What finds the blobs
 *   collected; `FinalizationRegistry` where there is one.
 */
export function createBlobUrls(Registry = globalThis.FinalizationRegistry) {
  const urls = new WeakMap();
  const collected = Registry
    ? new Registry((url) => URL.revokeObjectURL(url))
    : null;
  return (blob) => {
    let url = urls.get(blob);
    if (!url) {
      url = URL.createObjectURL(blob);
      urls.set(blob, url);
      collected?.register(blob, url);
    }
    return url;
  };
}

/** A blob's object URL: the same one every time it is drawn. */
export const blobUrl = createBlobUrls();

/**
 * How far Cesium's camera may stand from an eye and still be that eye: its
 * world vectors are derived again in floating point (a unit vector's
 * component off by 2e-16 now and then), and a camera that counts any
 * difference as a move would put off `moveEnd` with nothing moving. Metres
 * per metre of distance from the Earth's centre, and the cosine's shortfall
 * from 1 for the unit vectors.
 */
export const ROUNDING = 1e-12;

/** Whether Cesium's `world` vectors are the `written` eye, up to rounding. */
export function sameEye(world, written) {
  const p = world.position;
  const q = written.position;
  const scale = Math.max(1, Math.hypot(q.x, q.y, q.z));
  if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > ROUNDING * scale)
    return false;
  for (const key of ['direction', 'up']) {
    const a = world[key];
    const b = written[key];
    if (a.x * b.x + a.y * b.y + a.z * b.z < 1 - ROUNDING) return false;
  }
  return true;
}

/**
 * The pick ray through a canvas point (CSS pixels), as Cesium's
 * `camera.getPickRay` gives it in 3D, without its loss of precision: Cesium
 * adds the near-plane offset to the eye's position (some 6e6 m from the
 * Earth's centre) and takes the position off again, which leaves the
 * direction off by about 1e-9 at a near plane of 0.1 m. Other frustums go
 * to Cesium's own.
 * @param {object} scene
 * @param {object} camera
 * @param {number} x
 * @param {number} y
 * @returns {Cesium.Ray|undefined} Undefined on a canvas with no size.
 */
export function pickRayAt(scene, camera, x, y) {
  const frustum = camera.frustum;
  if (
    scene.mode !== Cesium.SceneMode.SCENE3D ||
    !(frustum instanceof Cesium.PerspectiveFrustum) ||
    frustum.xOffset ||
    frustum.yOffset
  )
    return camera.getPickRay(new Cesium.Cartesian2(x, y));
  const width = scene.canvas.clientWidth;
  const height = scene.canvas.clientHeight;
  // A canvas with no size (hidden, not laid out yet) has no rays, as in
  // Cesium.
  if (!(width > 0 && height > 0)) return undefined;
  const tanPhi = Math.tan(frustum.fovy * 0.5);
  const tanTheta = frustum.aspectRatio * tanPhi;
  const nx = (2 / width) * x - 1;
  const ny = (2 / height) * (height - y) - 1;
  const d = camera.directionWC;
  const r = camera.rightWC;
  const u = camera.upWC;
  const a = nx * tanTheta;
  const b = ny * tanPhi;
  const direction = Cesium.Cartesian3.normalize(
    new Cesium.Cartesian3(
      d.x + r.x * a + u.x * b,
      d.y + r.y * a + u.y * b,
      d.z + r.z * a + u.z * b,
    ),
    new Cesium.Cartesian3(),
  );
  return new Cesium.Ray(Cesium.Cartesian3.clone(camera.positionWC), direction);
}

/**
 * Where the pick ray through a canvas point meets the WGS84 ellipsoid, as
 * Cesium's `camera.pickEllipsoid` finds it in 3D, on `pickRayAt`'s ray.
 * @returns {Cesium.Cartesian3|undefined}
 */
export function pickEllipsoidAt(scene, camera, x, y) {
  if (scene.mode !== Cesium.SceneMode.SCENE3D)
    return camera.pickEllipsoid(new Cesium.Cartesian2(x, y));
  const ray = pickRayAt(scene, camera, x, y);
  if (!ray) return undefined;
  const hit = Cesium.IntersectionTests.rayEllipsoid(
    ray,
    Cesium.Ellipsoid.WGS84,
  );
  if (!hit) return undefined;
  const t = hit.start > 0 ? hit.start : hit.stop;
  return Cesium.Ray.getPoint(ray, t, new Cesium.Cartesian3());
}
