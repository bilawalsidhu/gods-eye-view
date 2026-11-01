import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { entryOf, tle } from '../testSupport/skyTleFixture.mjs';
import { lookAnglesAt } from '../data/satellitePass.js';
import {
  CATALOG_GROUPS,
  ISS_NORAD as LAYER_ISS_NORAD,
} from '../layers/satellites/policy.js';
import {
  DROP_DAYS,
  ISS_NORAD,
  MIN_EL_DEG,
  RECORD_FIELDS,
  SKY_CLASSES,
  SKY_CORE_GROUPS,
  STATE,
  STALE_DAYS,
  WARM_CALLS,
  createSatEngine,
  cullBounds,
  decodeFlags,
  describeLook,
  elementAge,
  groupInfo,
  makeObserver,
  packFlags,
  planTick,
  satelliteState,
  skyClassOf,
} from './satCore.js';

const REF_DIR = new URL('./reference/', import.meta.url);
const FIXTURE = readFileSync(new URL('satFixture200.tle', REF_DIR), 'utf8');
const REF = JSON.parse(
  readFileSync(new URL('satReference.json', REF_DIR), 'utf8'),
);
const D2R = Math.PI / 180;
const DAY = 86_400_000;

// Warmed like the worker does after every load (satWorker.js), so the
// accuracy tests below run on the warmed engine; the warm-up test compares
// it with an engine that never warmed.
function fixtureEngine(path = 'active', { warm = true } = {}) {
  const engine = createSatEngine();
  engine.loadGroup(path, FIXTURE);
  if (warm) engine.warmUp();
  engine.setObserver(REF.observer.latDeg, REF.observer.lonDeg);
  return engine;
}

function separationDeg(az1, el1, az2, el2) {
  const v = (az, el) => [
    Math.cos(el * D2R) * Math.sin(az * D2R),
    Math.cos(el * D2R) * Math.cos(az * D2R),
    Math.sin(el * D2R),
  ];
  const a = v(az1, el1);
  const b = v(az2, el2);
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, c))) / D2R;
}

test('core groups and ISS id mirror the satellites layer (policy.js)', () => {
  assert.deepEqual(
    SKY_CORE_GROUPS.map((g) => ({ ...g })),
    CATALOG_GROUPS.map((g) => ({ ...g })),
  );
  assert.equal(ISS_NORAD, LAYER_ISS_NORAD);
});

test('flags pack and decode round trip; three states from sunlit x dark', () => {
  for (const state of [0, 1, 2, 3])
    for (let classId = 0; classId < SKY_CLASSES.length; classId++)
      for (const setId of [0, 1, 2]) {
        const f = packFlags({
          sunlit: state !== STATE.SHADOW,
          dark: state === STATE.VISIBLE,
          state,
          classId,
          nakedEye: classId === 0,
          stale: setId === 1,
          setId,
        });
        assert.equal(Math.fround(f), f, 'exact in Float32');
        const d = decodeFlags(f);
        assert.equal(d.state, state);
        assert.equal(d.classId, classId);
        assert.equal(d.klass, SKY_CLASSES[classId]);
        assert.equal(d.setId, setId);
        assert.equal(d.nakedEye, classId === 0);
        assert.equal(d.stale, setId === 1);
      }
  assert.equal(satelliteState(true, true), STATE.VISIBLE);
  assert.equal(satelliteState(true, false), STATE.SUNLIT_BRIGHT_SKY);
  assert.equal(satelliteState(false, true), STATE.SHADOW);
  assert.equal(satelliteState(false, false), STATE.SHADOW);
});

test('groups: core priority, Starlink split out of active, classes', () => {
  assert.deepEqual(groupInfo('stations'), {
    tag: 'stations',
    set: 'core',
    priority: 0,
  });
  assert.equal(groupInfo('glo-ops').tag, 'glonass');
  assert.equal(groupInfo('active', 'STARLINK-1234').set, 'starlink');
  assert.equal(groupInfo('active', 'STARLINK-1234').tag, 'dense');
  assert.equal(groupInfo('active', 'NOAA 19').set, 'active');
  assert.equal(groupInfo('starlink').set, 'starlink');
  assert.equal(groupInfo('debris'), null);
  assert.equal(skyClassOf('active', 1), 'other');
  assert.equal(skyClassOf('active', ISS_NORAD), 'station');
  assert.equal(skyClassOf('glonass', 2), 'nav');
  assert.equal(skyClassOf('dense', 3), 'comms');
  assert.equal(skyClassOf('geo', 4), 'geo');
});

test('dedupe: a core group upgrades an active row in place (index kept)', () => {
  const engine = createSatEngine();
  const first = engine.loadGroup('active', FIXTURE);
  assert.equal(first.parsed, 200);
  assert.equal(first.added, 200);
  const iss = engine.byNorad(ISS_NORAD);
  const index = iss.index;
  assert.equal(iss.set, 'active');
  const second = engine.loadGroup('stations', tle(entryOf(25544)));
  assert.deepEqual(
    { added: second.added, updated: second.updated },
    { added: 0, updated: 1 },
  );
  assert.equal(engine.byNorad(ISS_NORAD).index, index);
  assert.equal(engine.byNorad(ISS_NORAD).set, 'core');
  assert.equal(engine.byNorad(ISS_NORAD).nakedEyeGroup, true);
  // active again does not demote it
  engine.loadGroup('active', FIXTURE);
  assert.equal(engine.byNorad(ISS_NORAD).set, 'core');
  assert.equal(engine.size, 200);
  // Starlink rows in the fixture sit in the starlink set
  const sl = engine.byNorad(REF.forced.starlink);
  assert.equal(sl.set, 'starlink');
  assert.equal(sl.klass, 'comms');
  // CRLF and LF parse alike; garbage parses to nothing
  assert.equal(
    createSatEngine().loadGroup('active', FIXTURE.replaceAll('\n', '\r\n'))
      .added,
    200,
  );
  assert.equal(createSatEngine().loadGroup('active', 'oops').parsed, 0);
});

test('fixture holds the ISS, a GEO, a Molniya-orbit object and a Starlink', () => {
  const engine = fixtureEngine();
  const { iss, geo, molniya, starlink } = REF.forced;
  assert.equal(iss, ISS_NORAD);
  assert.ok(
    Math.abs(engine.byNorad(geo).satrec.no * (1440 / (2 * Math.PI)) - 1.0027) <
      0.002,
  );
  assert.ok(engine.byNorad(molniya).satrec.ecco > 0.6);
  assert.match(engine.byNorad(starlink).name, /^STARLINK/);
  assert.equal(REF.objects.length, 200);
  assert.equal(REF.times.length, 5);
});

test('worker az/el IS lookAnglesAt(): 200 objects x 5 times to 1e-9 deg; packed Float32 = fround of it', () => {
  const engine = fixtureEngine();
  const observer = engine.observer;
  let compared = 0;
  let packedCompared = 0;
  for (const iso of REF.times) {
    const t = Date.parse(iso);
    const tick = engine.tick({
      timeMs: t,
      sets: ['core', 'active', 'starlink'],
      cull: false,
    });
    const packed = new Map();
    for (let o = 0; o < tick.records.length; o += RECORD_FIELDS)
      packed.set(tick.records[o], tick.records.subarray(o, o + RECORD_FIELDS));
    for (const entry of engine.entries) {
      const mine = describeLook(entry, t, observer);
      const ref = lookAnglesAt(
        entry.satrec,
        t,
        observer.latDeg,
        observer.lonDeg,
      );
      assert.ok(Math.abs(mine.azDeg - ref.azDeg) <= 1e-9, entry.name);
      assert.ok(Math.abs(mine.elDeg - ref.elevDeg) <= 1e-9, entry.name);
      compared += 1;
      const row = packed.get(entry.index);
      const expected =
        mine.elDeg > MIN_EL_DEG && elementAge(entry.epochMs, t) !== 'drop';
      assert.equal(Boolean(row), expected, entry.name);
      if (row) {
        assert.equal(row[1], Math.fround(mine.azDeg));
        assert.equal(row[2], Math.fround(mine.elDeg));
        assert.equal(row[3], Math.fround(mine.rangeKm));
        assert.equal(row[5], mine.flags);
        packedCompared += 1;
      }
    }
  }
  assert.equal(compared, 1000);
  assert.ok(packedCompared > 50, `packed rows compared: ${packedCompared}`);
});

test('matches the independent Skyfield/sgp4 reference: <= 0.25 deg and <= 1 km at 5 times (200 objects)', () => {
  const engine = fixtureEngine();
  const observer = engine.observer;
  let worstSep = 0;
  let worstRange = 0;
  for (const object of REF.objects) {
    const entry = engine.byNorad(object.noradId);
    assert.ok(entry, `fixture object ${object.noradId}`);
    for (const sample of object.samples) {
      const d = describeLook(entry, Date.parse(sample.t), observer);
      const sep = separationDeg(d.azDeg, d.elDeg, sample.azDeg, sample.elDeg);
      const dr = Math.abs(d.rangeKm - sample.rangeKm);
      worstSep = Math.max(worstSep, sep);
      worstRange = Math.max(worstRange, dr);
      assert.ok(sep <= 0.25, `${object.name} ${sample.t}: ${sep} deg`);
      assert.ok(dr <= 1, `${object.name} ${sample.t}: ${dr} km`);
    }
  }
  // Measured 2026-10-11: 0.0050 deg / 0.055 km (recorded in the card).
  assert.ok(worstSep < 0.02, `worst separation ${worstSep}`);
  assert.ok(worstRange < 0.2, `worst range ${worstRange}`);
});

test('sunlit flags match the reference (flips only within 5 s of the terminator)', () => {
  const engine = fixtureEngine();
  const observer = engine.observer;
  let mismatches = 0;
  let checked = 0;
  let first20 = 0;
  REF.objects.forEach((object, i) => {
    const entry = engine.byNorad(object.noradId);
    for (const sample of object.samples) {
      const d = describeLook(entry, Date.parse(sample.t), observer);
      checked += 1;
      if (i < 20) first20 += 1;
      if (d.sunlit !== sample.sunlit) {
        mismatches += 1;
        assert.ok(
          sample.terminator,
          `${object.name} ${sample.t}: sunlit ${d.sunlit} vs ${sample.sunlit} away from the terminator`,
        );
      }
    }
  });
  assert.equal(first20, 100, '20 objects x 5 times');
  assert.equal(checked, 1000);
  assert.ok(mismatches <= 5, `terminator flips ${mismatches}`);
});

test('tick: only objects above -2 deg, states from the dark-sky test, naked-eye only for stations/visual', () => {
  const engine = fixtureEngine();
  const t = Date.parse('2026-10-11T03:00:00Z'); // 22:00 CDT, dark
  const tick = engine.tick({ timeMs: t, sets: ['core', 'active', 'starlink'] });
  assert.equal(tick.dark, true);
  assert.ok(tick.sunAltDeg < -6);
  assert.equal(tick.records.length, tick.count * RECORD_FIELDS);
  assert.ok(tick.records instanceof Float32Array);
  for (let o = 0; o < tick.records.length; o += RECORD_FIELDS) {
    assert.ok(tick.records[o + 2] > MIN_EL_DEG);
    const f = decodeFlags(tick.records[o + 5]);
    assert.equal(f.dark, true);
    assert.equal(f.state, f.sunlit ? STATE.VISIBLE : STATE.SHADOW);
    const entry = engine.entry(tick.records[o]);
    assert.equal(f.nakedEye, f.state === STATE.VISIBLE && entry.nakedEyeGroup);
  }
  const day = engine.tick({
    timeMs: Date.parse('2026-10-11T18:00:00Z'),
    sets: ['core', 'active', 'starlink'],
  });
  assert.equal(day.dark, false);
  for (let o = 0; o < day.records.length; o += RECORD_FIELDS) {
    const f = decodeFlags(day.records[o + 5]);
    assert.notEqual(f.state, STATE.VISIBLE, 'nothing VISIBLE in daylight');
  }
  // sets filter
  const onlyStarlink = engine.tick({ timeMs: t, sets: ['starlink'] });
  for (let o = 0; o < onlyStarlink.records.length; o += RECORD_FIELDS)
    assert.equal(decodeFlags(onlyStarlink.records[o + 5]).set, 'starlink');
});

test('culling never changes the answer: hours of sky time, jumps forwards and backwards', () => {
  const culled = fixtureEngine();
  const full = fixtureEngine();
  const sets = ['core', 'active', 'starlink'];
  const start = Date.parse('2026-10-11T00:00:00Z');
  const times = [];
  for (let k = 0; k <= 6 * 180; k++) times.push(start + k * 20_000); // 6 h @ 20 s
  for (let k = 0; k < 120; k++) times.push(start + 6 * 3600_000 - k * 60_000); // backwards
  times.push(start + 86_400_000, start - 3_600_000, start + 2 * 86_400_000);
  let culledTotal = 0;
  for (const t of times) {
    const a = culled.tick({ timeMs: t, sets, cull: true });
    const b = full.tick({ timeMs: t, sets, cull: false });
    assert.deepEqual(
      Array.from(a.records),
      Array.from(b.records),
      `at ${new Date(t).toISOString()}`,
    );
    culledTotal += a.culled;
  }
  assert.ok(culledTotal > times.length * 100, `culled ${culledTotal}`);
  // moving the observer resets culling
  culled.setObserver(-33.87, 151.21);
  full.setObserver(-33.87, 151.21);
  const t = start + 3 * 3600_000;
  assert.deepEqual(
    Array.from(culled.tick({ timeMs: t, sets }).records),
    Array.from(full.tick({ timeMs: t, sets, cull: false }).records),
  );
});

test('cull bounds are conservative for LEO, GEO and Molniya', () => {
  const engine = fixtureEngine();
  const iss = cullBounds(engine.byNorad(ISS_NORAD).satrec);
  // ISS at ~420 km is visible to ~20 deg of central angle; bound must cover it.
  assert.ok(iss.lambdaMaxRad / D2R > 20 && iss.lambdaMaxRad / D2R < 30);
  assert.ok(iss.maxRateRadS > (2 * Math.PI) / (93 * 60));
  const geo = cullBounds(engine.byNorad(REF.forced.geo).satrec);
  assert.ok(geo.lambdaMaxRad / D2R > 81);
  const mol = cullBounds(engine.byNorad(REF.forced.molniya).satrec);
  assert.ok(mol.lambdaMaxRad / D2R > 80);
  assert.deepEqual(cullBounds({}), {
    lambdaMaxRad: Infinity,
    maxRateRadS: Infinity,
  });
});

test('element age: grey beyond 7 days, removed beyond 30 days, summary counts', () => {
  assert.equal(elementAge(0, 6.9 * DAY), 'ok');
  assert.equal(elementAge(0, 7.1 * DAY), 'stale');
  assert.equal(elementAge(0, -7.1 * DAY), 'stale');
  assert.equal(elementAge(0, 30.1 * DAY), 'drop');
  assert.equal(elementAge(NaN, 0), 'drop');
  const engine = fixtureEngine();
  const iss = engine.byNorad(ISS_NORAD);
  const sets = ['core', 'active', 'starlink'];
  const stale = iss.epochMs + (STALE_DAYS + 1) * DAY;
  const tick = engine.tick({ timeMs: stale, sets, cull: false });
  let staleRows = 0;
  for (let o = 0; o < tick.records.length; o += RECORD_FIELDS) {
    const f = decodeFlags(tick.records[o + 5]);
    const e = engine.entry(tick.records[o]);
    assert.equal(f.stale, elementAge(e.epochMs, stale) === 'stale');
    staleRows += f.stale ? 1 : 0;
  }
  assert.ok(staleRows > 0);
  const gone = engine.tick({
    timeMs: iss.epochMs + (DROP_DAYS + 5) * DAY,
    sets,
    cull: false,
  });
  assert.equal(gone.count, 0);
  assert.equal(gone.dropped, 200);
  const summary = engine.ageSummary(iss.epochMs + (DROP_DAYS + 5) * DAY, sets);
  assert.equal(summary.total, 200);
  assert.equal(summary.dropped, 200);
  assert.ok(Number.isFinite(summary.newestEpochMs));
});

test('tick plan: core+active every tick, Starlink every other tick, every tick after a jump or at speed', () => {
  const base = { timeMs: 1_000_000, starlinkOn: true };
  assert.deepEqual(planTick({ ...base, tickNo: 1, lastStarlinkMs: 999_000 }), [
    'core',
    'active',
  ]);
  assert.deepEqual(planTick({ ...base, tickNo: 2, lastStarlinkMs: 999_000 }), [
    'core',
    'active',
    'starlink',
  ]);
  assert.ok(
    planTick({ ...base, tickNo: 3, lastStarlinkMs: null }).includes('starlink'),
  );
  assert.ok(
    planTick({
      ...base,
      tickNo: 3,
      lastStarlinkMs: 999_000,
      force: true,
    }).includes('starlink'),
  );
  assert.ok(
    planTick({
      ...base,
      tickNo: 3,
      lastStarlinkMs: 1_000_000 - 60_000,
    }).includes('starlink'),
    'x60 play',
  );
  assert.deepEqual(planTick({ ...base, tickNo: 2, starlinkOn: false }), [
    'core',
    'active',
  ]);
  assert.deepEqual(
    planTick({ ...base, tickNo: 2, activeOn: false, starlinkOn: false }),
    ['core'],
  );
});

test('observer validation and an engine without an observer returns nothing', () => {
  assert.equal(makeObserver('x', 1), null);
  const engine = createSatEngine();
  engine.loadGroup('active', FIXTURE);
  assert.equal(engine.setObserver(NaN, 0), false);
  assert.equal(engine.tick({ timeMs: Date.now() }).count, 0);
});

test('JIT warm-up changes no answer and no cull state; bounded; only new entries', () => {
  const cold = fixtureEngine('active', { warm: false });
  const warm = createSatEngine();
  warm.loadGroup('active', FIXTURE);
  const first = warm.warmUp();
  assert.ok(first.calls > 0 && first.calls <= 200 * 4, `calls ${first.calls}`);
  assert.ok(Number.isFinite(first.durationMs));
  // nothing new loaded -> nothing to warm
  assert.deepEqual(warm.warmUp(), { calls: 0, durationMs: 0 });
  // warming before the observer is set, and again after it, is harmless
  warm.setObserver(REF.observer.latDeg, REF.observer.lonDeg);
  const sets = ['core', 'active', 'starlink'];
  const start = Date.parse(REF.times[0]);
  const times = [...REF.times.map(Date.parse)];
  for (let k = 0; k < 90; k++) times.push(start + k * 20_000);
  times.push(start + 86_400_000, start - 3_600_000);
  for (const t of times) {
    for (const cull of [true, false]) {
      const a = cold.tick({ timeMs: t, sets, cull });
      const b = warm.tick({ timeMs: t, sets, cull });
      assert.deepEqual(
        Array.from(b.records),
        Array.from(a.records),
        `records at ${new Date(t).toISOString()} cull ${cull}`,
      );
      assert.equal(b.computed, a.computed, 'same cull state');
      assert.equal(b.culled, a.culled, 'same cull state');
    }
  }
  // a large catalogue: about WARM_CALLS propagations, not one per object
  const big = createSatEngine();
  big.loadGroup('active', FIXTURE);
  const many = big.warmUp({ calls: 40 });
  assert.ok(many.calls <= 40 + 4, `calls ${many.calls}`);
  assert.ok(WARM_CALLS >= 1000 && WARM_CALLS <= 5000);
});

test('ticks pack the brightness estimate for sunlit objects with an RCS (NaN otherwise); setRcs reaches later loads', () => {
  const engine = fixtureEngine();
  const ids = engine.entries.map((e) => e.noradId);
  const rcs = { 999999999: 3, bad: 'x', [ids[1]]: -1, [ids[3]]: '' };
  ids.forEach((id, i) => {
    if (i % 2 === 0) rcs[id] = 2;
  });
  const result = engine.setRcs(rcs);
  assert.equal(result.matched, Math.ceil(ids.length / 2));
  assert.equal(engine.rcsVersion, 1);
  const t = Date.parse('2026-10-12T01:00:00Z');
  const tick = engine.tick({ timeMs: t, cull: false });
  let withMag = 0;
  for (let o = 0; o < tick.records.length; o += RECORD_FIELDS) {
    const entry = engine.entry(tick.records[o]);
    const flags = decodeFlags(tick.records[o + 5]);
    const estMag = tick.records[o + 6];
    if (!flags.sunlit || entry.rcsM2 == null) {
      assert.ok(Number.isNaN(estMag), `${entry.name} has no estimate`);
      continue;
    }
    withMag += 1;
    const d = describeLook(entry, t, engine.observer);
    assert.ok(Math.abs(estMag - d.estMag) < 1e-4, entry.name);
    assert.ok(estMag > -10 && estMag < 20);
  }
  assert.ok(withMag > 0, `${withMag} with an estimate`);
  const bare = engine.entries.find((e) => e.rcsM2 == null);
  assert.equal(describeLook(bare, t, engine.observer).estMag, null);
  // groups loaded after the RCS map pick it up too
  const late = createSatEngine();
  late.setRcs({ 25544: 399.0524 });
  late.loadGroup('stations', FIXTURE);
  assert.equal(late.byNorad(25544).rcsM2, 399.0524);
  assert.equal(late.meta().find((m) => m.noradId === 25544).rcsM2, 399.0524);
  // pass-scanned groups bump passVersion, others do not
  const v = late.passVersion;
  late.loadGroup('gps-ops', FIXTURE);
  assert.equal(late.passVersion, v);
});
