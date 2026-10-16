// The flights logic draws only through its renderer (phase 3 Task 10a): with
// a renderer that is plain data (no Cesium), the layer builds its fleet,
// selects a contact on a click through the engine's selection dispatcher,
// tracks and follows it, and releases it on an empty click. This is the seam
// the Navara renderer (Task 10b) plugs into.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createApplicationFlights } from '../../app/layers/flights.js';
import { defaultSurface } from '../../data/surfaceServices.js';
import * as militaryRegistry from '../../data/militaryRegistry.js';
import { openSkySnapshot } from '../../sources/live/aircraft.js';
import { missingAircraftRendererMembers } from '../aircraft/render/contract.js';
import { Rgba } from '../shared/color.js';

globalThis.window ||= {};
globalThis.window.dispatchEvent ||= () => true;
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.CustomEvent ||= class CustomEvent extends Event {
  constructor(type, init) {
    super(type);
    this.detail = init?.detail;
  }
};
globalThis.document ||= {
  body: { classList: { contains: () => false } },
  addEventListener() {},
  removeEventListener() {},
};

/** A renderer of plain records, for the logic alone. */
function recordingRenderer(engine) {
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
      surfaceOwner: engine,
      surfaceScene: engine,
      frameNumber: () => 1,
      viewportHeightPx: () => 768,
      frustumTester: () => () => true,
      horizon: () => ({ isPointVisible: () => true }),
      worldToWindow: () => ({ x: 0, y: 0 }),
      requestRender: () => calls.push(['requestRender']),
      on: () => () => {},
      holdFrames() {},
      closeFrameLatch() {},
      releaseFrames() {},
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
  return renderer;
}

function snapshotOf(ids) {
  const nowSec = Math.floor(Date.now() / 1000);
  return openSkySnapshot({
    time: nowSec,
    states: ids.map((id, index) => [
      id,
      `TST${index} `,
      'United States',
      nowSec,
      nowSec,
      -97.6 + index * 0.1,
      30.3,
      10_668,
      false,
      250,
      95,
      5,
      null,
      10_700,
      null,
      null,
      null,
      5,
    ]),
  });
}

test('the flights logic draws, selects and follows only through its renderer', async () => {
  const engine = createFakeEngine();
  let renderer = null;
  const layer = createApplicationFlights({
    surface: defaultSurface,
    source: {
      label: 'Fixture aircraft',
      getSnapshot: async () => snapshotOf(['abc123', 'def456']),
    },
    militaryRegistry,
    renderer: {
      create: ({ viewer, engine: given }) => {
        assert.equal(viewer, null, 'no viewer on an engine without one');
        renderer = recordingRenderer(given);
        return renderer;
      },
    },
  });
  layer.init(null, { engine });
  assert.deepEqual(missingAircraftRendererMembers(renderer), []);
  layer.enable();
  try {
    await layer.update(null);
    assert.equal(renderer.sprites.size, 2, 'one sprite per contact');
    const [sprite] = renderer.sprites;
    assert.ok(sprite.color instanceof Rgba, 'colours are engine-neutral');
    assert.equal(sprite.id, 'abc123');
    assert.equal(layer.getAllPositions().length, 2);

    // A click on a contact: the engine's pick, through the dispatcher.
    engine.fake.script('pick', () => ({ id: 'def456' }));
    engine.fake.script('drillPick', () => [{ id: 'def456' }]);
    const click = () => {
      engine.fake.input('down', { position: { x: 10, y: 10 } });
      engine.fake.input('up', { position: { x: 10, y: 10 } });
      engine.fake.input('click', { position: { x: 10, y: 10 } });
    };
    click();
    assert.equal(layer.getTrackedInfo()?.icao24, 'def456');
    assert.deepEqual(
      renderer.calls.filter(
        ([name]) => name.startsWith('tracked') || name.startsWith('follow'),
      ),
      [
        ['tracked.create', 'tracked-1'],
        ['follow.start', 'tracked-1'],
      ],
    );

    // Clicking the tracked visual itself is a no-op.
    engine.fake.script('pick', () => ({ id: 'tracked-1' }));
    engine.fake.script('drillPick', () => [{ id: 'tracked-1' }]);
    click();
    assert.equal(layer.getTrackedInfo()?.icao24, 'def456');

    // Empty space releases the follow and removes the tracked visual.
    engine.fake.script('pick', () => undefined);
    engine.fake.script('drillPick', () => []);
    click();
    assert.equal(layer.getTrackedInfo(), null);
    assert.ok(
      renderer.calls.some(([name]) => name === 'follow.release') &&
        renderer.calls.some(
          ([name, id]) => name === 'tracked.remove' && id === 'tracked-1',
        ),
    );
  } finally {
    layer.disable();
    layer.destroy(null);
  }
  assert.ok(renderer.calls.some(([name]) => name === 'destroy'));
});
