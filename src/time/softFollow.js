import { Cartesian3, Matrix4, Transforms } from 'cesium';
import { findCamera } from '../render/rendererOf.js';

/**
 * Follow a contact the layers' own follow does not (a vessel) along its
 * observed journey, through the camera port: the eye keeps where it stands
 * from the contact (its east-north-up offset when the follow starts) and the
 * contact slides to the middle, as a click on an aircraft does. The person can
 * still orbit and zoom. Path fixes are `[seconds, lat, lon, altitude m, heading]`.
 *
 * @param {() => object|null} getViewer
 */
export function createSoftFollow(getViewer) {
  let path = null;
  let key = null;
  const state = { set: 0, camera: false, start: false, followed: null };

  const at = (ms) => {
    if (!path?.length) return null;
    const t = ms / 1000;
    if (t < path[0][0] || t > path.at(-1)[0]) return null;
    let index = path.findIndex((fix) => fix[0] > t);
    if (index <= 0) index = path.length - 1;
    const a = path[index - 1] ?? path[index];
    const b = path[index];
    const k = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    return Cartesian3.fromDegrees(
      a[2] + (b[2] - a[2]) * k,
      a[1] + (b[1] - a[1]) * k,
      Number.isFinite(a[3]) ? a[3] : 0,
    );
  };

  // Where the eye stands from `target`, metres east, north and up of it.
  const offsetFrom = (viewer, target) => {
    const toLocal = Matrix4.inverse(
      Transforms.eastNorthUpToFixedFrame(target),
      new Matrix4(),
    );
    const eye = Matrix4.multiplyByPoint(toLocal, viewer.camera.positionWC, new Cartesian3());
    return { x: eye.x, y: eye.y, z: eye.z };
  };

  const release = () => {
    const camera = findCamera(getViewer());
    if (key && camera?.followed?.key === key) camera.follow(null);
    key = null;
  };

  return {
    state,
    /** Follow along `nextPath` from the time `timeMs()` shows; null lets go. */
    set(nextPath, timeMs, id = 'subject') {
      release();
      path = nextPath?.length ? nextPath : null;
      const viewer = getViewer();
      const camera = findCamera(viewer);
      state.set += 1;
      state.camera = Boolean(camera);
      if (!path || !camera || !viewer) return;
      const start = at(timeMs());
      state.start = Boolean(start);
      if (!start) return;
      key = `journey:${id}`;
      camera.follow({
        key,
        frame: 'enu',
        position: () => at(timeMs()),
        viewFrom: offsetFrom(viewer, start),
        minRange: 300,
        transitionS: 0.8,
      });
      state.followed = camera.followed?.key ?? null;
    },
    stop() {
      release();
      path = null;
    },
  };
}
