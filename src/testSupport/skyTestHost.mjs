/**
 * Test double for the Sky view tests: the in-memory stub renderer
 * (`src/render/stub`) bound to a scene host (`createSceneHost`), as the
 * application binds its renderer, so Sky finds every port (camera, frame,
 * query, input, globe) the way it does in the app. Nothing here reaches the
 * engine behind the default renderer.
 *
 * The camera starts where the old test viewer's did: Austin, 3000 m up,
 * heading 0.4, pitch -0.7. `pickHeight` is the height a depth pick at any
 * pixel answers at Houston (the ellipsoid pick answers 0 there); the stub's
 * ground height is unknown until a test sets some (`renderer.testing`).
 */
import { fromDegrees } from '../geo/ellipsoid.js';
import { createSceneHost } from '../render/rendererOf.js';
import { createStubRenderer } from '../render/stub/index.js';

export const HOUSTON_PICK = { lon: -95.3698, lat: 29.7604 };

/**
 * @param {object} [options]
 * @param {{append: Function}} [options.container] Where Sky appends its overlay.
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.pickHeight]
 * @param {number} [options.time] Scene time, epoch ms.
 * @returns {{host: object, renderer: ReturnType<typeof createStubRenderer>,
 *   camera: object, frame: object, globe: object,
 *   renderRequests: () => number, release: () => void}}
 */
export function createSkyTestHost({
  container,
  width = 1200,
  height = 800,
  pickHeight = 20,
  time = Date.parse('2026-10-11T12:00:00Z'),
} = {}) {
  const renderer = createStubRenderer({ viewport: { width, height }, time });
  const { camera, query } = renderer;
  camera.setView({
    destination: { lon: -97.7431, lat: 30.2672, height: 3000 },
    orientation: { heading: 0.4, pitch: -0.7, roll: 0 },
  });
  query.pickPosition = () =>
    fromDegrees(HOUSTON_PICK.lon, HOUSTON_PICK.lat, pickHeight);
  query.pickEllipsoid = () =>
    fromDegrees(HOUSTON_PICK.lon, HOUSTON_PICK.lat, 0);
  // Every frame request, counted: what "no render request" tests read.
  let renders = 0;
  const requestRender = renderer.frame.requestRender;
  renderer.frame.requestRender = (reason) => {
    renders += 1;
    requestRender(reason);
  };
  const { host, release } = createSceneHost(renderer, { container });
  return {
    host,
    renderer,
    camera,
    frame: renderer.frame,
    globe: renderer.globe,
    renderRequests: () => renders,
    release,
  };
}
