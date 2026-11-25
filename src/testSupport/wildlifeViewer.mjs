/**
 * Ports over a wildlife-layer test's Cesium-shaped viewer double: the
 * Cesium camera port over its fake camera (`bindFakeCesiumCamera`), a fake
 * draw port that keeps the badges, glow and privacy cells, a frame port
 * over the double's scene events, and a globe port whose load progress and
 * surface version follow the double's `scene.globe` events (a
 * `tileLoadProgressEvent` reports terrain tiles pending; a
 * `terrainProviderChanged` changes the surface). `query.project` answers
 * through the test's own projector; `query` adds other query answers.
 */
import { bindFakeCesiumCamera } from './fakeCameraPort.mjs';
import { fakeDrawPort } from './fakeDrawPort.mjs';

/** The badges' set, the density glow's and the privacy cells', by role. */
export function wildlifeSets(draw) {
  const live = (suffix) =>
    [...draw.sets.values()].find(
      (record) => !record.disposed && record.spec.id.endsWith(suffix),
    );
  return {
    badges: live(':badges'),
    glow: live(':density'),
    cells: live(':cells'),
    outlines: live(':cell-outlines'),
  };
}

/**
 * @param {object} viewer - The double (`camera`, `scene`).
 * @param {{project?: (position: object) => ({x: number, y: number}|null),
 *   query?: object}} [options]
 * @returns {{draw: ReturnType<typeof fakeDrawPort>, sets: () => ReturnType<typeof wildlifeSets>}}
 */
export function bindWildlifeViewer(
  viewer,
  { project = () => null, query = {} } = {},
) {
  const draw = fakeDrawPort();
  const scene = viewer.scene ?? {};
  let version = 0;
  let progress = { tilesPending: 0, imageryPending: 0, terrainPending: 0 };
  const progressListeners = new Set();
  const globe = {
    surfaceVersion: () => version,
    isSettled: () => true,
    on(event, cb) {
      if (event !== 'progress') return () => {};
      progressListeners.add(cb);
      const offs = [
        () => progressListeners.delete(cb),
        scene.globe?.tileLoadProgressEvent?.addEventListener?.((pending) => {
          progress = { ...progress, terrainPending: pending };
          cb({ ...progress });
        }),
        scene.globe?.terrainProviderChanged?.addEventListener?.(() => {
          version += 1;
          cb({ ...progress });
        }),
      ];
      return () => offs.forEach((off) => off?.());
    },
  };
  const frame = {
    on(phase, cb) {
      const event = scene[phase];
      const off = event?.addEventListener?.(cb);
      if (typeof off === 'function') return off;
      return () => event?.removeEventListener?.(cb);
    },
    requestRender() {},
  };
  bindFakeCesiumCamera(viewer, {
    draw,
    globe,
    frame,
    query: { project: (position) => project(position), ...query },
  });
  return {
    draw,
    sets: () => wildlifeSets(draw),
    /** Report load progress, as the globe port does while tiles load. */
    progress(next) {
      progress = { ...progress, ...next };
      for (const cb of [...progressListeners]) cb({ ...progress });
    },
    /** Change what heights answer against (shown tilesets, terrain). */
    changeSurface() {
      version += 1;
      for (const cb of [...progressListeners]) cb({ ...progress });
    },
    progressListeners: () => progressListeners.size,
  };
}
