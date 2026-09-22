// src/data/convergenceDetection.test.mjs — Convergence detection engine.
//
// Drives the real engine over synthetic track histories: a planted rendezvous,
// a fly-by crossing (hard negative), parallel transit, and a scene with known
// ground truth for precision/recall. A source-level assertion pins the
// intent-restraint contract — the engine must never grow a field that asserts
// a meeting, transfer, or relationship.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONVERGENCE_DEFAULTS,
  analyzePair,
  createConvergenceEngine,
  detectConvergences,
  detectRecurringRendezvous,
  metersBetween,
  resampleTrack,
} from './convergenceDetection.js';

const SRC = fileURLToPath(
  new URL('./convergenceDetection.js', import.meta.url),
);

// A local metres→degrees helper so the fixtures can be written in metres and
// stay legible; ~1.1e-5 deg latitude per metre near the equator is plenty for
// a unit fixture.
const M = 1 / 111_320;
function fixes(fn, { t0 = 0, dur = 1800, dt = 15, lat0 = 0, lon0 = 0 } = {}) {
  const out = [];
  for (let i = 0; i * dt <= dur; i += 1) {
    const t = t0 + i * dt;
    const { x, y } = fn(t, i);
    out.push({ t, lat: lat0 + y * M, lon: lon0 + x * M });
  }
  return out;
}

test('metersBetween matches a known short baseline', () => {
  const d = metersBetween(0, 0, 0, 1000 * M);
  assert.ok(Math.abs(d - 1000) < 5, `expected ~1000 m, got ${d}`);
});

test('event shape asserts no intent (source contract)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // the returned event literal must not carry an intent-style key
  for (const banned of [
    'intent:',
    'relationship:',
    'meeting:',
    'transfer:',
    'classification:',
  ]) {
    assert.ok(!src.includes(banned), `event must not carry "${banned}"`);
  }
});

test('true rendezvous is detected with approach and departure', () => {
  const a = {
    layerKey: 'vessels',
    id: 'A',
    kind: 'vessel',
    fixes: fixes(() => ({ x: 5, y: 5 })),
  };
  const b = {
    layerKey: 'vessels',
    id: 'B',
    kind: 'vessel',
    fixes: fixes((t) => {
      if (t < 600) return { x: 3000 * (1 - t / 600) + 20, y: 5 }; // approach
      if (t <= 1100) return { x: 20 + ((t % 45) - 22), y: 5 + ((t % 30) - 15) }; // hold
      return { x: -3000 * ((t - 1100) / 700) - 20, y: 5 }; // depart
    }),
  };
  const ev = analyzePair(a, b);
  assert.ok(ev, 'expected a convergence event');
  assert.ok(ev.minSeparationM < CONVERGENCE_DEFAULTS.rNearM);
  assert.ok(ev.dwellS >= CONVERGENCE_DEFAULTS.tMinDwellS);
  assert.ok(ev.approached && ev.departed);
  assert.ok(ev.score > 0.7);
  assert.equal(ev.a.id, 'A');
  assert.equal(ev.b.id, 'B');
});

test('perpendicular fly-by is rejected (never holds)', () => {
  const a = {
    layerKey: 'vessels',
    id: 'A',
    fixes: fixes((t) => ({ x: -3000 + 8 * t, y: 0 })),
  };
  const b = {
    layerKey: 'vessels',
    id: 'B',
    fixes: fixes((t) => ({ x: 0, y: -3000 + 8 * t })),
  };
  assert.equal(analyzePair(a, b), null);
});

test('parallel far transit is rejected', () => {
  const a = {
    layerKey: 'vessels',
    id: 'A',
    fixes: fixes((t) => ({ x: 6 * t, y: 0 })),
  };
  const b = {
    layerKey: 'vessels',
    id: 'B',
    fixes: fixes((t) => ({ x: 6 * t, y: 5000 })),
  };
  assert.equal(analyzePair(a, b), null);
});

test('a gap longer than maxGapS is not interpolated', () => {
  const track = {
    layerKey: 'x',
    id: 'g',
    fixes: [
      { t: 0, lat: 0, lon: 0 },
      { t: 90, lat: 900 * M, lon: 0 },
    ],
  };
  const grid = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  const out = resampleTrack(track, grid, 30);
  assert.equal(out[5], null, 'midpoint of a too-long gap must stay null');
});

// --- synthetic scene with ground truth: precision / recall -----------------
function buildScene(seed = 7) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const gauss = (sd) => sd * (rnd() + rnd() + rnd() + rnd() - 2) * 0.7071;
  const AREA = 40000;
  const DUR = 3600;
  const DT = 15;
  const tracks = [];
  const truth = [];
  let id = 0;

  const straight = (spd) => {
    const ang = rnd() * 2 * Math.PI;
    const x0 = rnd() * AREA;
    const y0 = rnd() * AREA;
    const vx = spd * Math.cos(ang);
    const vy = spd * Math.sin(ang);
    return fixes(
      (t) => ({ x: x0 + vx * t + gauss(6), y: y0 + vy * t + gauss(6) }),
      { dur: DUR, dt: DT },
    );
  };

  for (let i = 0; i < 40; i += 1)
    tracks.push({
      layerKey: 'vessels',
      id: `BG${id++}`,
      fixes: straight(2 + rnd() * 3),
    });

  for (let i = 0; i < 5; i += 1) {
    const meetT = 900 + rnd() * 1500;
    const hold = 240 + rnd() * 360;
    const mx = 8000 + rnd() * (AREA - 16000);
    const my = 8000 + rnd() * (AREA - 16000);
    const leg = (sign) => {
      const ang = rnd() * 2 * Math.PI;
      const sx = mx + Math.cos(ang) * 9000;
      const sy = my + Math.sin(ang) * 9000;
      return fixes(
        (t) => {
          if (t < meetT) {
            const a = t / meetT;
            return {
              x: sx + (mx - sx) * a + gauss(5),
              y: sy + (my - sy) * a + gauss(5),
            };
          }
          if (t <= meetT + hold)
            return {
              x: mx + gauss(25 + 20 * sign),
              y: my + gauss(25 + 20 * sign),
            };
          const a = (t - (meetT + hold)) / (DUR - (meetT + hold));
          return {
            x: mx + Math.cos(ang + Math.PI * sign) * 9000 * a + gauss(5),
            y: my + Math.sin(ang + Math.PI * sign) * 9000 * a + gauss(5),
          };
        },
        { dur: DUR, dt: DT },
      );
    };
    const A = `R${id}a`;
    const B = `R${id}b`;
    id += 1;
    tracks.push({ layerKey: 'vessels', id: A, fixes: leg(0) });
    tracks.push({ layerKey: 'vessels', id: B, fixes: leg(1) });
    truth.push([A, B].sort().join('|'));
  }

  for (let i = 0; i < 5; i += 1) {
    const crossT = 900 + rnd() * 1500;
    const cx = 6000 + rnd() * (AREA - 12000);
    const cy = 6000 + rnd() * (AREA - 12000);
    const c = rnd() * Math.PI;
    const spd = 4 + rnd() * 2;
    const leg = (course) =>
      fixes(
        (t) => ({
          x: cx + spd * Math.cos(course) * (t - crossT) + gauss(5),
          y: cy + spd * Math.sin(course) * (t - crossT) + gauss(5),
        }),
        { dur: DUR, dt: DT },
      );
    tracks.push({ layerKey: 'vessels', id: `X${id}a`, fixes: leg(c) });
    tracks.push({
      layerKey: 'vessels',
      id: `X${id}b`,
      fixes: leg(c + Math.PI / 2),
    });
    id += 1;
  }
  return { tracks, truth };
}

test('recall is total and the planted rendezvous rank above coincidences', () => {
  const { tracks, truth } = buildScene(7);
  const events = detectConvergences(tracks);
  const found = new Set(events.map((e) => [e.a.id, e.b.id].sort().join('|')));
  const truthSet = new Set(truth);
  const recalled = [...truthSet].filter((p) => found.has(p)).length;
  assert.equal(
    recalled,
    truthSet.size,
    'every planted rendezvous must be found',
  );
  // The real guarantee is separability by score: the N highest-scoring events
  // are exactly the N planted rendezvous. A coincidental near-hold between two
  // background transits can still appear (that is the point — the engine reports
  // geometry, it does not assert intent), but it ranks below every rendezvous.
  const topN = new Set(
    events
      .slice(0, truthSet.size)
      .map((e) => [e.a.id, e.b.id].sort().join('|')),
  );
  assert.deepEqual(
    [...topN].sort(),
    [...truthSet].sort(),
    'top-N by score must be exactly the planted rendezvous',
  );
});

test('engine factory returns items and the intent-restraint disclaimer', () => {
  const { tracks } = buildScene(3);
  const engine = createConvergenceEngine({ getTracks: () => tracks });
  const res = engine.detect();
  assert.ok(Array.isArray(res.items));
  assert.match(res.disclaimer, /no meeting, transfer, or relationship/i);
});

test('createConvergenceEngine requires a getTracks provider', () => {
  assert.throws(() => createConvergenceEngine({}), /getTracks/);
});

// --- rendezvous signature: deliberate meet vs coincidental drift-by --------
// The hard case geometry alone cannot answer with proximity + dwell: two
// entities that DO hold within range for minutes but only because they were
// already near and drifting, not because they came together and stopped. The
// signature separates them; these tests pin that.

// A deliberate meet: A from the far east, B from the far west, both hold
// station near the origin for ~9 min, then leave.
function deliberatePair() {
  const a = {
    layerKey: 'vessels',
    id: 'A',
    fixes: fixes((t) => {
      if (t < 600) return { x: 4000 * (1 - t / 600), y: 0 };
      if (t <= 1100)
        return { x: 15 + ((t * 7) % 20) - 10, y: ((t * 5) % 20) - 10 };
      return { x: -4000 * ((t - 1100) / 700), y: 0 };
    }),
  };
  const b = {
    layerKey: 'vessels',
    id: 'B',
    fixes: fixes((t) => {
      if (t < 600) return { x: -4000 * (1 - t / 600), y: 0 };
      if (t <= 1100)
        return { x: -15 + ((t * 3) % 20) - 10, y: ((t * 11) % 20) - 10 };
      return { x: 4000 * ((t - 1100) / 700), y: 0 };
    }),
  };
  return { a, b };
}

// A coincidental hold: two entities crawling at ~1.5 m/s on shallow-converging
// courses. They linger within range for minutes, but never came from far and
// never slowed — no station-keeping.
function coincidentalHoldPair() {
  const c = {
    layerKey: 'vessels',
    id: 'C',
    fixes: fixes((t) => ({ x: -1350 + 1.5 * t, y: 0 })),
  };
  const d = {
    layerKey: 'vessels',
    id: 'D',
    fixes: fixes((t) => ({ x: -1350 + 1.4 * t, y: 420 - 0.3 * t })),
  };
  return { c, d };
}

test('a deliberate meet has a strong signature and reads as station-keeping', () => {
  const { a, b } = deliberatePair();
  const ev = analyzePair(a, b);
  assert.ok(ev);
  assert.ok(
    ev.signatureStrength > 0.7,
    `expected strong signature, got ${ev.signatureStrength}`,
  );
  assert.ok(
    ev.signature.stationKeeping,
    'both entities should read as station-keeping',
  );
  assert.ok(
    ev.signature.closedFromM > 3000,
    'they should have closed real distance',
  );
});

test('a coincidental hold is detected but its signature is weak', () => {
  const { c, d } = coincidentalHoldPair();
  const ev = analyzePair(c, d);
  assert.ok(ev, 'it holds within range, so it is a convergence...');
  // ...but the behaviour does not match a deliberate meet:
  assert.ok(
    ev.signatureStrength < 0.45,
    `expected weak signature, got ${ev.signatureStrength}`,
  );
  assert.equal(ev.signature.stationKeeping, false, 'neither entity slowed');
});

test('signature separates deliberate from coincidental where raw proximity does not', () => {
  const del = analyzePair(deliberatePair().a, deliberatePair().b);
  const co = analyzePair(coincidentalHoldPair().c, coincidentalHoldPair().d);
  // raw proximity score alone does NOT cleanly separate them...
  assert.ok(
    co.score > 0.6,
    'the coincidental hold scores high on raw proximity',
  );
  // ...but the signature does, by a wide margin.
  assert.ok(
    del.signatureStrength - co.signatureStrength > 0.4,
    `signature gap too small: ${del.signatureStrength} vs ${co.signatureStrength}`,
  );
});

test('ranking by signature puts the deliberate meet above a coincidental hold', () => {
  const { a, b } = deliberatePair();
  const { c, d } = coincidentalHoldPair();
  // C transits through the meet area while A and B are holding there, so other
  // incidental convergences can appear too — that is realistic. The claim is
  // about ordering: the deliberate meet ranks first, and the C–D coincidental
  // hold ranks strictly below it.
  const events = detectConvergences([a, b, c, d]);
  const pairId = (e) => [e.a.id, e.b.id].sort().join('|');
  assert.deepEqual([events[0].a.id, events[0].b.id].sort(), ['A', 'B']);
  const rankAB = events.findIndex((e) => pairId(e) === 'A|B');
  const rankCD = events.findIndex((e) => pairId(e) === 'C|D');
  assert.ok(
    rankCD > rankAB,
    'the coincidental hold must rank below the deliberate meet',
  );
});

// --- recurring rendezvous: repetition is the strongest observed signal -----
const DAY = 86400;
function meetEvent(a, b, t, lat, lon, sig = 0.85) {
  return {
    a: { layerKey: 'vessels', id: a },
    b: { layerKey: 'vessels', id: b },
    tClosest: t,
    closest: { lat, lon },
    signatureStrength: sig,
  };
}

test('a single meet is not a recurring rendezvous', () => {
  const out = detectRecurringRendezvous([meetEvent('T', 'U', 0, 37.7, -122.5)]);
  assert.equal(out.length, 0);
});

test('same-place, regular-cadence meets score as strong recurrence', () => {
  const events = [
    meetEvent('P', 'Q', 0, 37.7, -122.5),
    meetEvent('P', 'Q', 7 * DAY, 37.7001, -122.4998),
    meetEvent('P', 'Q', 14 * DAY, 37.6999, -122.5001),
  ];
  const [r] = detectRecurringRendezvous(events);
  assert.ok(r, 'expected a recurring pair');
  assert.equal(r.occurrences, 3);
  assert.ok(r.locationSpreadM < 100, 'meets should cluster tightly');
  assert.ok(r.cadenceRegularity > 0.9, 'weekly cadence is regular');
  assert.ok(
    r.recurrenceStrength > 0.7,
    `expected strong recurrence, got ${r.recurrenceStrength}`,
  );
});

test('scattered, irregular meets score far weaker than a tight regular pattern', () => {
  const tight = [
    meetEvent('P', 'Q', 0, 37.7, -122.5),
    meetEvent('P', 'Q', 7 * DAY, 37.7001, -122.4998),
    meetEvent('P', 'Q', 14 * DAY, 37.6999, -122.5001),
  ];
  const scattered = [
    meetEvent('R', 'S', 0, 37.7, -122.5, 0.5),
    meetEvent('R', 'S', 2 * DAY, 37.9, -122.2, 0.5),
    meetEvent('R', 'S', 11 * DAY, 37.5, -122.9, 0.5),
  ];
  const out = detectRecurringRendezvous([...tight, ...scattered]);
  const pq = out.find((r) => r.a.id === 'P');
  const rs = out.find((r) => r.a.id === 'R');
  assert.ok(pq && rs);
  assert.ok(
    pq.recurrenceStrength - rs.recurrenceStrength > 0.3,
    `tight pattern should dominate: ${pq.recurrenceStrength} vs ${rs.recurrenceStrength}`,
  );
  assert.deepEqual([out[0].a.id, out[0].b.id].sort(), ['P', 'Q']);
});

test('recurrence groups events regardless of a/b order', () => {
  const out = detectRecurringRendezvous([
    meetEvent('P', 'Q', 0, 37.7, -122.5),
    meetEvent('Q', 'P', 7 * DAY, 37.7, -122.5), // same pair, swapped order
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].occurrences, 2);
});
