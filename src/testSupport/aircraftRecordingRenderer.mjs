// An aircraft renderer of plain records (src/layers/aircraft/render/
// contract.js), for testing an aircraft layer's logic alone: no Cesium, no
// Navara. `calls` logs the tracked/follow calls; `sprites` holds the fleet.

import * as geo from '../geo/index.js';

/** A renderer of plain records, for the logic alone. */
export function recordingAircraftRenderer(engine, ports = {}) {
  const calls = [];
  const sprites = new Set();
  const camera = {
    positionWC: geo.cartesian3.fromDegrees(-97.7, 30.2, 400_000),
    positionCartographic: geo.cartographic.fromDegrees(-97.7, 30.2, 400_000),
    rightWC: geo.cartesian3.create(1, 0, 0),
    upWC: geo.cartesian3.create(0, 0, 1),
    directionWC: geo.cartesian3.create(0, -1, 0),
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
    frustum: { fovy: 1 },
  };
  const scene = {
    camera,
    canvas: { clientHeight: 768 },
    frameState: { frameNumber: 1 },
  };
  let trackedSeq = 0;
  let following;
  const renderer = {
    kind: 'record',
    engine,
    calls,
    sprites,
    view: {
      camera,
      scene,
      engine,
      frameNumber: () => 1,
      viewportHeightPx: () => 768,
      frustumTester: () => () => true,
      horizon: () => ({ isPointVisible: () => true }),
      worldToWindow: () => ({ x: 0, y: 0 }),
      requestRender: () => calls.push(['requestRender']),
      on: () => () => {},
    },
    fleet: {
      shown: false,
      attach: () => calls.push(['attach']),
      detach: () => calls.push(['detach']),
      attached: () => true,
      visible: () => renderer.fleet.shown,
      setVisible(visible) {
        renderer.fleet.shown = visible;
      },
      add(spec) {
        const sprite = { ...spec };
        sprites.add(sprite);
        return sprite;
      },
      remove: (sprite) => sprites.delete(sprite),
      restoreOrder() {},
      restoreOrderOnEnable() {},
    },
    models: {
      live: () => true,
      setVisible() {},
      loadFleet: () => Promise.reject(new Error('no models here')),
      loadTracked: () => Promise.reject(new Error('no models here')),
      preload: () => Promise.reject(new Error('no models here')),
      add() {},
      remove() {},
      destroy() {},
      setPose() {},
    },
    tracked: {
      create(spec) {
        const handle = { id: `tracked-${++trackedSeq}`, spec };
        calls.push(['tracked.create', handle.id]);
        return handle;
      },
      remove: (handle) => calls.push(['tracked.remove', handle.id]),
      isLive: () => true,
      setImage() {},
      setViewFrom(handle, offset) {
        handle.viewFrom = offset;
      },
      billboardSize: () => null,
    },
    follow: {
      start(handle) {
        following = handle;
        calls.push(['follow.start', handle.id]);
        return () => calls.push(['follow.frameStop']);
      },
      refocus: (handle) => renderer.follow.start(handle),
      release() {
        following = undefined;
        calls.push(['follow.release']);
      },
      isFollowing: (handle) => following === handle,
      current: () => following,
      onChanged: () => () => {},
    },
    trails: {
      create: () => ({
        setPositions() {},
        setVisible() {},
        clear() {},
        destroy() {},
      }),
      createHead: ({ id }) => ({ id, show: true }),
      removeHead() {},
    },
    surfaceExclusions: () => [],
    destroy: () => calls.push(['destroy']),
  };
  for (const [name, values] of Object.entries(ports))
    Object.assign(renderer[name], values);
  return renderer;
}
