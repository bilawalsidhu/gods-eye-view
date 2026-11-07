// Regressions from the point-and-ask review: stale gestures, (0, 0) from
// missing coordinates, crop pixel targeting, canonical referent identity and
// late results repopulating a cleared registry.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POINTER_OPEN_MIC_RECENT_MS,
  buildPointerSnapshot,
  createPointerTracker,
} from './pointerContext.js';
import { resolveDeicticArgs } from './deixis.js';
import { createReferentRegistry } from './referents.js';

function tracker({ pick, cameraKey = () => 'pose-A' } = {}) {
  let clock = 1000;
  const timers = new Map();
  let next = 1;
  const picks = [];
  const element = {
    clientWidth: 1000,
    clientHeight: 500,
    addEventListener() {},
  };
  const t = createPointerTracker({
    element,
    now: () => clock,
    cameraKey,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    pick:
      pick ||
      ((x, y) => {
        picks.push([x, y]);
        return {
          entity: null,
          ground: { lat: y / 10, lon: x / 10 },
          radiusKm: 10,
        };
      }),
  });
  return {
    t,
    picks,
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
    },
  };
}

test('P1-2: a typed turn never reuses a Space snapshot; releasing the key ends the hold', () => {
  const h = tracker();
  h.t.moveTo(100, 100);
  const held = h.t.hold('keydown');
  h.t.moveTo(700, 300); // the user moved on
  const typed = h.t.beginTurn('text');
  assert.notEqual(typed, held);
  assert.equal(typed.lon, 70, 'typed turn read the pointer where it is now');
  assert.equal(
    h.t.isHeld(),
    true,
    'a typed turn does not end the Space gesture',
  );
  h.t.releaseHold();
  assert.equal(h.t.isHeld(), false);
  const spoken = h.t.beginTurn('speech_start');
  assert.notEqual(
    spoken,
    held,
    'after release, speech reads the pointer afresh',
  );
});

test('P2-8: open mic only counts a pointer that moved on the map recently', () => {
  const h = tracker();
  h.t.moveTo(400, 200);
  h.advance(POINTER_OPEN_MIC_RECENT_MS + 1);
  assert.equal(
    h.t.beginTurn('speech_start', { recentMs: POINTER_OPEN_MIC_RECENT_MS })
      .fresh,
    false,
  );
  assert.equal(
    h.t.beginTurn('keydown').fresh,
    true,
    'an explicit gesture still counts it',
  );
});

test('P2-4: a dwell pick taken under another camera pose is never reused', () => {
  let pose = 'pose-A';
  const h = tracker({ cameraKey: () => pose });
  h.t.moveTo(300, 150);
  h.advance(260);
  assert.equal(h.picks.length, 1, 'dwell pick');
  h.t.capture('keydown');
  assert.equal(h.picks.length, 1, 'same pose reuses it');
  pose = 'pose-B';
  h.t.capture('keydown');
  assert.equal(h.picks.length, 2, 'the camera moved: pick again');
});

test('P2-5: a missing entity position never becomes (0, 0) over a valid ground hit', () => {
  const snapshot = buildPointerSnapshot({
    at: 'keydown',
    x: 10,
    y: 10,
    width: 100,
    height: 100,
    pick: {
      entity: { layerId: 'flights', id: 'a', label: 'X', lat: null, lon: null },
      ground: { lat: 30.1, lon: -97.2 },
      radiusKm: null,
    },
  });
  assert.equal(snapshot.lat, 30.1);
  assert.equal(snapshot.lon, -97.2);
  assert.equal(snapshot.radiusKm, null);
  const out = resolveDeicticArgs(
    'analyst_query',
    { scope: { kind: 'pointer', km: null } },
    { pointer: { fresh: true, lat: 1, lon: 2, radiusKm: null } },
  );
  assert.equal(
    out.args.scope.km,
    50,
    'a null radius falls back, it is not 0 km',
  );
  const noCoords = { fresh: true, entity: null, lat: null, lon: null };
  assert.match(
    resolveDeicticArgs(
      'fly_to_location',
      { query: 'pointer' },
      { pointer: noCoords },
    ).error,
    /Nothing is under the pointer/,
  );
});

test('P1-3: pixel targets against the pointer crop map back to the canvas, or refuse after a move', () => {
  const imageFrame = {
    kind: 'crop',
    rect: { x: 0.25, y: 0.2, w: 0.3, h: 0.5 },
    cameraKey: 'pose-A',
  };
  const args = {
    annotations: [
      { type: 'pin', screenX: 0.5, screenY: 0.5 },
      { type: 'arrow', target: 'Capitol', toScreenX: 0, toScreenY: 1 },
      { type: 'route', points: [{ target: 'A' }, { screenX: 1, screenY: 0 }] },
    ],
  };
  const out = resolveDeicticArgs('annotate_map', args, {
    imageFrame,
    cameraKey: 'pose-A',
  });
  assert.equal(out.error, null);
  const [pin, arrow, route] = out.args.annotations;
  assert.deepEqual([pin.screenX, pin.screenY], [0.4, 0.45]);
  assert.deepEqual([arrow.toScreenX, arrow.toScreenY], [0.25, 0.7]);
  assert.deepEqual(
    [route.points[1].screenX, route.points[1].screenY],
    [0.55, 0.2],
  );
  assert.match(
    resolveDeicticArgs('annotate_map', args, {
      imageFrame,
      cameraKey: 'pose-B',
    }).error,
    /view has moved/,
  );
  assert.match(
    resolveDeicticArgs('annotate_map', args, {
      imageFrame: { ...imageFrame, rect: null },
      cameraKey: 'pose-A',
    }).error,
    /view has moved/,
    'a crop without bounds cannot be targeted',
  );
  const full = resolveDeicticArgs('annotate_map', args, {
    imageFrame: { kind: 'viewport' },
    cameraKey: 'pose-B',
  });
  assert.equal(
    full.args,
    args,
    'a whole-frame screenshot keeps its existing behaviour',
  );
});

test('P2-7: duplicate callsigns and names resolve by canonical identity', () => {
  const referents = createReferentRegistry();
  referents.recordResult('analyst_query', {
    ok: true,
    items: [
      {
        layerKey: 'flights',
        id: 'N123AB',
        icao24: 'aaa111',
        callsign: 'N123AB',
      },
      {
        layerKey: 'flights',
        id: 'N123AB',
        icao24: 'bbb222',
        callsign: 'N123AB',
      },
      {
        layerKey: 'ais-live-vessels',
        id: 'EVER GIVEN',
        mmsi: '353136000',
        name: 'EVER GIVEN',
      },
      {
        layerKey: 'ais-live-vessels',
        id: 'EVER GIVEN',
        mmsi: '353136001',
        name: 'EVER GIVEN',
      },
    ],
  });
  assert.deepEqual(
    [1, 2, 3, 4].map(
      (n) =>
        resolveDeicticArgs(
          'track_entity',
          { query: 'x', referent: n },
          { referents },
        ).args.query,
    ),
    ['aaa111', 'bbb222', '353136000', '353136001'],
  );
  assert.equal(
    referents.get(2).label,
    'N123AB',
    'the label stays the display text',
  );
});

test('P1-1: a result from before the last clear cannot repopulate the registry', () => {
  const referents = createReferentRegistry();
  const since = referents.generation();
  referents.clear(); // session ended while the query ran
  const late = { ok: true, items: [{ layerKey: 'flights', icao24: 'aaa111' }] };
  assert.equal(referents.recordResult('analyst_query', late, { since }), false);
  assert.equal(referents.get(1), null);
  assert.equal(
    referents.recordResult('analyst_query', late, {
      since: referents.generation(),
    }),
    true,
  );
});
