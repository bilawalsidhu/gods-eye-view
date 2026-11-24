import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlightSnapshotRenderer } from './snapshotRenderer.js';
import { createMotion } from './motion.js';
import { createFlightState } from './state.js';
import { createFlightFeed, createIngestion } from './ingestion.js';
import { createClockFollow } from './clockFollow.js';

// Back at live from another time, the first live snapshot stands in for
// every contact: those it has keep their icon and ease on from where they
// are drawn, and only those it lacks go (src/time/snapshotTimeline.js).

/** Any property is a no-op function unless given. */
function stub(overrides = {}) {
  return new Proxy(overrides, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

function harness() {
  const iconIds = new Set();
  const calls = [];
  const landed = new Set();
  const groundFloor = stub({
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
    GROUND_FLOOR_LIFT_M: 0.5,
  });
  const services = stub({
    geoid: { geoidHeight: () => 0 },
    camera: stub(),
    focus: stub(),
    groundFloor,
    meshFloor: stub(),
    groundSnap: stub({ createGroundSnap: () => stub() }),
    placement: null,
  });
  const flightState = createFlightState({
    services,
    source: { label: 'Fixture aircraft' },
  });
  flightState._icons = {
    has: (id) => iconIds.has(id),
    ids: () => [...iconIds],
    get count() {
      return iconIds.size;
    },
  };
  const parts = {
    rendering: stub({ _modelOwnsVisual: () => false }),
    icons: stub({
      _addIcon: (id) => {
        calls.push(['add', id]);
        iconIds.add(id);
      },
      _forgetContact: (id) => {
        calls.push(['forget', id]);
        iconIds.delete(id);
      },
      _planIcon: (id, options) => calls.push(['plan', id, options]),
    }),
    tracking: stub({
      _militaryLayerSuppresses: () => false,
      _appendTrailFix: () => calls.push(['trail-append']),
      _startTrail: (id) => calls.push(['trail-start', id]),
      _clearTrail: () => calls.push(['trail-clear']),
    }),
  };
  parts.motion = createMotion({ flightState, services, parts, layer: {} });
  const apply = createFlightSnapshotRenderer({
    flightState,
    records: flightState.records,
    militaryRegistry: stub({ isMilitaryIcao: () => false }),
    groundFloor,
    rendering: parts.rendering,
    tracking: parts.tracking,
    motion: parts.motion,
    icons: parts.icons,
    enrichment: stub(),
    queries: stub({ _likelyLanded: (id) => landed.has(id) }),
  });
  const clockFollow = createClockFollow({ flightState, services, parts });
  return {
    calls,
    iconIds,
    flightState,
    clockFollow,
    landed,
    // `ids`: an id, or [id, fix age ms, on the ground].
    snapshot: (ids, fields = {}) => ({
      observedAtMs: Date.now(),
      records: ids.map((entry, k) => {
        const [id, ageMs = 5_000, onGround = false] = [entry].flat();
        return {
          id,
          reference: id,
          longitude: -115 + k,
          latitude: 36,
          callsign: 'TEST1',
          baroAltitudeM: onGround ? 0 : 9_000,
          onGround,
          speedMps: onGround ? 5 : 220,
          courseDeg: 90,
          positionTimeMs: Date.now() - ageMs,
        };
      }),
      complete: true,
      ...fields,
    }),
    apply(ids, options, fields) {
      calls.length = 0;
      return apply(this.snapshot(ids, fields), null, options);
    },
    // Back at live, as the layer applies its first live snapshot.
    handOver(ids, fields) {
      calls.length = 0;
      const snapshot = this.snapshot(ids, fields);
      clockFollow.handOverMotion(clockFollow.absentAtHandover(snapshot));
      return apply(snapshot, null, { handover: true });
    },
  };
}

test('the first live snapshot keeps the icons of contacts it has and drops only those it lacks', () => {
  const h = harness();
  h.apply(['a00001', 'a00002']);
  assert.deepEqual([...h.iconIds].sort(), ['a00001', 'a00002']);

  const accepted = h.handOver(['a00001', 'a00003']);
  assert.deepEqual([...h.iconIds].sort(), ['a00001', 'a00003']);
  assert.equal(accepted.count, 2);
  // The contact it has keeps its icon: no remove and add, and its motion is
  // planned as a handover, easing from where it is drawn.
  assert.equal(
    h.calls.some(
      ([kind, id]) => id === 'a00001' && (kind === 'add' || kind === 'forget'),
    ),
    false,
  );
  assert.deepEqual(
    h.calls.find(([kind, id]) => kind === 'plan' && id === 'a00001'),
    ['plan', 'a00001', { handover: true }],
  );
  assert.ok(h.calls.some(([kind, id]) => kind === 'forget' && id === 'a00002'));
  assert.ok(h.calls.some(([kind, id]) => kind === 'add' && id === 'a00003'));
});

test('a plain live poll keeps a missing contact as its absence rules say', () => {
  const h = harness();
  h.apply(['a00001', 'a00002']);
  h.apply(['a00001']);
  assert.deepEqual([...h.iconIds].sort(), ['a00001', 'a00002']);
  assert.deepEqual(
    h.calls.find(([kind]) => kind === 'plan'),
    ['plan', 'a00001', undefined],
  );
});

test('back at live, only the first live snapshot applied takes over; a failed poll says so', async () => {
  const applied = [];
  let fail = false;
  const feed = createFlightFeed({
    async getSnapshot() {
      if (fail) throw new Error('down');
      return { records: [], observedAtMs: Date.now(), freshness: 'current' };
    },
  });
  const { methods } = createIngestion({
    feed,
    getQuery: () => ({}),
    applySnapshot: (_snapshot, _viewer, options) => {
      applied.push(options);
      return { count: 0, ids: new Set() };
    },
    setSourceLabel: () => {},
    applyPendingTrackingRestore: () => {},
  });
  assert.equal(await methods.resumeLive(null), true);
  await methods.update(null);
  assert.deepEqual(applied, [{ handover: true }, undefined]);

  fail = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await methods.resumeLive(null), false);
  } finally {
    console.warn = warn;
  }
});

test('back at live, the tracked contact and those the snapshot retains stay, stale, and a partial snapshot drops none', () => {
  const h = harness();
  h.apply(['a00001', 'a00002', 'a00003', 'a00004']);
  h.flightState._trackedIcao = 'a00001';
  const history = [{ epochMs: Date.now() - 60_000 }];
  h.flightState._positionHistory.set('a00001', history);
  h.handOver(['a00004'], { retainIds: new Set(['a00002']) });
  assert.deepEqual([...h.iconIds].sort(), ['a00001', 'a00002', 'a00004']);
  assert.equal(
    h.flightState._positionHistory.get('a00001'),
    history,
    'the tracked contact keeps its fixes for the next poll to judge',
  );
  assert.ok(h.flightState.records.data.has('a00001'));
  assert.equal(
    h.calls.some(([kind]) => kind === 'trail-clear' || kind === 'trail-start'),
    false,
    'its trail goes on',
  );

  const partial = harness();
  partial.apply(['a00001', 'a00002']);
  partial.handOver(['a00003'], { complete: false });
  assert.deepEqual([...partial.iconIds].sort(), ['a00001', 'a00002', 'a00003']);
});

test('back at live, the tracked contact the snapshot has goes on adding to its trail', () => {
  const h = harness();
  h.apply(['a00001']);
  h.flightState._trackedIcao = 'a00001';
  h.handOver(['a00001']);
  assert.deepEqual(
    h.calls.filter(([kind]) => kind.startsWith('trail')),
    [['trail-append']],
  );
});

const HOURS_3 = 3 * 3_600_000;

test('back at live, a partial snapshot keeps only contacts whose newest fix is recent, by the real absence rules', () => {
  const h = harness();
  // Shown from a time three hours back, and one from a minute ago.
  h.apply([
    ['a00001', HOURS_3],
    ['a00002', 60_000],
  ]);
  h.handOver(['a00003'], { complete: false });
  assert.deepEqual(
    [...h.iconIds].sort(),
    ['a00002', 'a00003'],
    'the three-hour-old contact is no ghost',
  );
});

test('back at live, a tracked aircraft is kept only while its newest fix is recent and it has not landed', () => {
  for (const [label, setUp, kept] of [
    ['recent', (h) => h.apply([['a00001', 60_000]]), true],
    ['three hours old', (h) => h.apply([['a00001', HOURS_3]]), false],
    [
      'landed',
      (h) => {
        h.apply([['a00001', 120_000]]);
        h.apply([['a00001', 60_000, true]]);
        h.landed.add('a00001');
      },
      false,
    ],
  ]) {
    const h = harness();
    setUp(h);
    h.flightState._trackedIcao = 'a00001';
    h.handOver(['a00002']);
    assert.equal(h.iconIds.has('a00001'), kept, label);
  }
});
