import assert from 'node:assert/strict';
import test from 'node:test';
import { createPositionHistory } from './positionHistory.js';
import { createTimeTravel, DEFAULT_REWIND_MS } from './timeTravel.js';

function fakeCollection() {
  const items = new Set();
  return {
    items,
    add(options) {
      const item = { ...options };
      items.add(item);
      return item;
    },
    remove(item) {
      return items.delete(item);
    },
  };
}
function createHarness({ fixes = true } = {}) {
  let wall = 2_000_000;
  let mono = 0;
  const history = createPositionHistory({ now: () => wall });
  const plane = (lon) => ({
    id: 'a',
    icao24: 'a',
    lat: 0,
    lon,
    altitudeM: 100,
  });
  const ship = (lat) => ({ id: 's', mmsi: 's', lat, lon: 10, speedKts: 1 });
  if (fixes) {
    // Fixes at T-14min ... T (every 30 s), so the window spans 14 minutes.
    for (let t = wall - 14 * 60_000; t <= wall; t += 30_000) {
      history.recordSnapshot('flights', [plane((t - wall) / 60_000)], t);
      history.recordSnapshot(
        'ais-live-vessels',
        [ship((t - wall) / 60_000)],
        t,
      );
    }
  }
  const primitives = new Set();
  const scene = {
    primitives: {
      items: primitives,
      add: (primitive) => {
        primitives.add(primitive);
        return primitive;
      },
      remove: (primitive) => primitives.delete(primitive),
    },
    requestRender: () => {},
  };
  const viewer = {
    scene,
    camera: { positionCartographic: { latitude: 0, longitude: 0 } },
  };
  const calls = [];
  const modules = {
    flights: {
      setPresentationSuppressed: (on) => calls.push(['flights', on]),
    },
    military: null,
    'ais-live-vessels': {
      setPresentationSuppressed: (on) => calls.push(['vessels', on]),
    },
  };
  const frames = [];
  const changes = [];
  const collections = [];
  const timeTravel = createTimeTravel({
    viewer,
    history,
    resolveLayerModule: (id) => modules[id],
    requestRender: (reason) => calls.push(['render', reason]),
    holdRender: (owner) => calls.push(['hold', owner]),
    releaseRender: (owner) => calls.push(['release', owner]),
    onChange: (state, kind) => changes.push([kind, state.mode]),
    onEnterRewind: () => calls.push(['enter']),
    onExitRewind: (reason) => calls.push(['exit', reason]),
    raf: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    caf: () => calls.push(['caf']),
    now: () => mono,
    wallNow: () => wall,
    createPoints: () => {
      const c = fakeCollection();
      collections.push(['points', c]);
      return c;
    },
    createPolylines: () => {
      const c = fakeCollection();
      collections.push(['lines', c]);
      return c;
    },
    createTrailMaterial: (layerId) => ({ layerId }),
  });
  const flush = (dtMs) => {
    mono += dtMs;
    const pending = frames.splice(0);
    for (const cb of pending) cb(mono);
  };
  return {
    history,
    timeTravel,
    calls,
    changes,
    frames,
    flush,
    scene,
    collections,
    wall: () => wall,
    advanceWall: (ms) => {
      wall += ms;
    },
  };
}

test('rewind enters replay at the offset, hides live layers and draws the overlay', () => {
  const h = createHarness();
  assert.equal(h.timeTravel.state().mode, 'live');
  assert.equal(h.timeTravel.rewind(-600_000), true);
  const state = h.timeTravel.state();
  assert.equal(state.mode, 'rewind');
  assert.equal(state.displayTimeMs, h.wall() - 600_000);
  assert.equal(state.offsetMs, -600_000);
  assert.equal(state.rate, 1);
  assert.deepEqual(
    h.calls.filter(([kind]) => kind !== 'render'),
    [['flights', true], ['vessels', true], ['enter'], ['hold', 'time-travel']],
  );
  assert.equal(h.scene.primitives.items.size, 2, 'points + polylines added');
  const points = h.collections.find(([kind]) => kind === 'points')[1];
  assert.equal(points.items.size, 2);
  const lines = h.collections.find(([kind]) => kind === 'lines')[1];
  assert.equal(lines.items.size, 2, 'both contacts have 60 s of trail');
  const point = [...points.items].find((p) => p.id.layerId === 'flights');
  assert.equal(point.pixelSize, 6);
  assert.equal(point.disableDepthTestDistance, Number.POSITIVE_INFINITY);
  assert.equal(point.id.id, 'a');
  assert.ok(
    h.calls.some(
      ([kind, reason]) => kind === 'render' && reason === 'time-travel',
    ),
  );
  assert.equal(h.frames.length, 1, 'one animation frame armed');
  assert.deepEqual(h.changes.at(-1), ['mode', 'rewind']);
});

test('frames advance the display clock by rate; pause holds; rates scale', () => {
  const h = createHarness();
  h.timeTravel.rewind(-600_000);
  const start = h.timeTravel.state().displayTimeMs;
  h.flush(16); // first frame only anchors the clock
  h.flush(1_000);
  assert.equal(h.timeTravel.state().displayTimeMs, start + 1_000);
  h.timeTravel.setRate(0);
  assert.ok(h.calls.some(([kind]) => kind === 'release'));
  h.flush(1_000);
  h.flush(1_000);
  assert.equal(h.timeTravel.state().displayTimeMs, start + 1_000, 'paused');
  h.timeTravel.setRate(4);
  h.flush(16);
  h.flush(500);
  assert.equal(h.timeTravel.state().displayTimeMs, start + 1_000 + 2_000);
  assert.equal(h.timeTravel.setRate(-1), 4, 'invalid rate ignored');
  assert.equal(h.timeTravel.setRate(16), 16);
  assert.ok(h.frames.length >= 1, 'loop keeps running while rewound');
});

test('replaying forward past the newest fix resumes live and restores visuals', () => {
  const h = createHarness();
  h.timeTravel.rewind(-30_000);
  h.timeTravel.setRate(16);
  h.calls.length = 0;
  h.flush(16);
  h.flush(1_000); // 16 s of replay
  h.flush(1_000); // crosses the 30 s window
  const state = h.timeTravel.state();
  assert.equal(state.mode, 'live');
  assert.equal(state.offsetMs, 0);
  assert.equal(state.rate, 1);
  assert.equal(h.scene.primitives.items.size, 0, 'overlay removed');
  const restore = (call) =>
    call[0] === 'exit' ||
    call[0] === 'release' ||
    ((call[0] === 'flights' || call[0] === 'vessels') && call[1] === false);
  assert.deepEqual(h.calls.filter(restore), [
    ['release', 'time-travel'],
    ['flights', false],
    ['vessels', false],
    ['exit', 'caught-up'],
  ]);
  h.flush(1_000);
  assert.equal(h.frames.length, 0, 'loop stopped');
  assert.deepEqual(h.changes.at(-1), ['mode', 'live']);
});

test('seekTo clamps into the recorded range and enters rewind from live', () => {
  const h = createHarness();
  const { oldestT, newestT } = h.history.range();
  assert.equal(h.timeTravel.seekTo(oldestT - 1_000_000), true);
  assert.equal(h.timeTravel.state().displayTimeMs, oldestT);
  assert.equal(h.timeTravel.state().mode, 'rewind');
  assert.equal(h.timeTravel.seekTo(newestT + 5), true);
  assert.equal(h.timeTravel.state().displayTimeMs, newestT);
  assert.equal(h.timeTravel.seekTo(NaN), false);
  assert.equal(h.timeTravel.rewind(-15 * 60_000), true, 'clamped to oldest');
  assert.equal(h.timeTravel.state().displayTimeMs, oldestT);
  assert.equal(h.timeTravel.rewind(0), false);
  assert.equal(h.timeTravel.resumeLive(), true);
  assert.equal(h.timeTravel.resumeLive(), false, 'already live');
  assert.deepEqual(h.timeTravel.range(), h.history.range());
});

test('rewind refuses without history; destroy from rewind restores live visuals', () => {
  const empty = createHarness({ fixes: false });
  assert.equal(empty.timeTravel.rewind(DEFAULT_REWIND_MS), false);
  assert.equal(empty.timeTravel.state().mode, 'live');
  assert.equal(empty.calls.length, 0);

  const h = createHarness();
  h.timeTravel.rewind(-120_000);
  h.calls.length = 0;
  h.timeTravel.destroy();
  assert.equal(h.timeTravel.destroyed, true);
  assert.equal(h.scene.primitives.items.size, 0);
  assert.deepEqual(
    h.calls.filter(([kind]) => ['flights', 'vessels', 'exit'].includes(kind)),
    [
      ['flights', false],
      ['vessels', false],
      ['exit', 'destroy'],
    ],
  );
  assert.equal(
    h.timeTravel.rewind(-60_000),
    false,
    'destroyed controller is inert',
  );
});

test('new polls while rewound refresh the overlay and re-assert suppression', () => {
  const h = createHarness();
  h.timeTravel.rewind(-60_000);
  h.timeTravel.setRate(0);
  h.calls.length = 0;
  h.advanceWall(60_000); // the new fix lands 120 s after the display time
  h.history.recordSnapshot(
    'flights',
    [{ id: 'b', icao24: 'b', lat: 5, lon: 5, altitudeM: 0 }],
    h.wall(),
  );
  h.flush(16);
  h.flush(1_100); // suppression re-assert interval
  assert.ok(h.calls.some(([kind, on]) => kind === 'flights' && on === true));
  const points = h.collections.find(([kind]) => kind === 'points')[1];
  const ids = [...points.items].map((p) => p.id.id).sort();
  assert.deepEqual(
    ids,
    ['a', 's'],
    'a fix beyond the 90 s tolerance is not shown',
  );
});
