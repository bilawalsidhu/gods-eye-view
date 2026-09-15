import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceMotion,
  reduceAnchor,
  reduceFleet,
  percentile,
} from './qaMetrics.js';
const rows = () =>
  Array.from({ length: 400 }, (_, i) => ({
    x: i / 6,
    y: 0,
    z: 0,
    displayT: (i * 1000) / 60,
    expectedMps: 10,
    segment: 1,
    mx: i,
    my: 20,
    ax: i,
    ay: 20,
    cpuMs: 0.5,
    intervalMs: 1000 / 60,
    uploadBytes: 128000,
    moving: 800,
    poll: Math.floor(i / 200),
  }));
test('ordinary 60 Hz motion passes; frozen motion, time and overspeed fail', () => {
  assert.equal(reduceMotion(rows()).pass, true);
  assert.equal(reduceMotion(rows().map((r) => ({ ...r, x: 0 }))).pass, false);
  assert.equal(
    reduceMotion(rows().map((r) => ({ ...r, displayT: 0 }))).pass,
    false,
  );
  assert.equal(
    reduceMotion(rows().map((r) => ({ ...r, x: r.x * 1.03 }))).pass,
    false,
  );
});
test('actual anchor agreement passes; equal travel with a fixed offset fails', () => {
  assert.equal(reduceAnchor(rows()).pass, true);
  assert.equal(
    reduceAnchor(rows().map((r) => ({ ...r, ax: r.ax + 2 }))).pass,
    false,
  );
  assert.equal(
    reduceAnchor(rows().map((r) => ({ ...r, ax: null }))).pass,
    false,
  );
});
test('empty samples and unmeasured allocation never pass acceptance', () => {
  assert.equal(percentile([]), Infinity);
  assert.equal(reduceMotion([]).pass, false);
  assert.equal(reduceAnchor([]).pass, false);
  assert.equal(reduceFleet([], 800, 0, 1, 1).pass, false);
  assert.equal(reduceFleet(rows(), 800, undefined, 1, 1).pass, false);
  assert.equal(reduceFleet(rows(), 800, 100, 10000, 800 * 128 * 48).pass, true);
  assert.equal(
    reduceFleet(
      rows().map((r) => ({ ...r, moving: 1 })),
      800,
      100,
      10000,
      10000,
    ).pass,
    false,
  );
});

test('ordinary frames judge drawn speed against elapsed time and name the offending pair', () => {
  const slow = rows().map((r, i) => ({
    ...r,
    key: 'mbta:sim-dup',
    monoMs: (i * 1000) / 60,
    displayT: r.displayT * 0.8858664517,
    x: r.x * 0.8858664517,
  }));
  const result = reduceMotion(slow);
  assert.equal(result.pass, false);
  assert.equal(result.worstFrame.key, 'mbta:sim-dup');
  assert.ok(result.worstRelativeError > 0.114);
});

test('per-scenario reducer resolves full vehicle keys and cannot pass empty lag', async () => {
  const { reduceScenario } = await import('./qaMetrics.js');
  const trace = {
    out: {
      'mbta:sim-straight': Array.from({ length: 5645 }, (_, i) => [
        i * 17,
        42 + i / 111320,
        -71,
        i * 17,
        0,
        1,
        0,
        i * 17 + 25000,
      ]),
    },
  };
  const result = reduceScenario(trace, 'straight');
  assert.equal(result.rows, 5645);
  assert.equal(result.keys, 'mbta:sim-straight');
  assert.equal(result.lagMin, 25);
  assert.equal(reduceScenario({ out: {} }, 'gap').lagValid, false);
});

test('anchor names its judged conditions and accepts 1128 aligned frames across two polls', () => {
  const fixture = Array.from({ length: 1128 }, (_, i) => ({
    mx: i,
    my: 0,
    ax: i + 4e-9,
    ay: 0,
    poll: i < 564 ? 1 : 2,
  }));
  const result = reduceAnchor([
    { mx: 0, my: 0, ax: null, ay: null },
    ...fixture,
  ]);
  assert.equal(result.pass, true);
  assert.equal(result.conditions.pollTransition, true);
  assert.equal(result.polls, 2);
  assert.equal(
    reduceAnchor(fixture.map((r) => ({ ...r, poll: 1 }))).pass,
    false,
  );
});

test('Boston mid-luma fixtures cannot qualify as bright or dark', async () => {
  const { reduceBackground } = await import('./qaMetrics.js');
  assert.equal(
    reduceBackground('bright', Array(4).fill({ background: 0.423 })).pass,
    false,
  );
  assert.equal(
    reduceBackground('dark', Array(4).fill({ background: 0.403 })).pass,
    false,
  );
  assert.equal(
    reduceBackground('bright', Array(4).fill({ background: 0.65 })).pass,
    true,
  );
  assert.equal(
    reduceBackground('dark', Array(4).fill({ background: 0.2 })).pass,
    true,
  );
});

test('variable GPU work after sampling cannot change the judged playback speed', async () => {
  const { reduceScriptedMotion } = await import('./qaMetrics.js');
  const frames = Array.from({ length: 400 }, (_, i) => {
    const r = Array(17).fill(0),
      stamp = (i * 1000) / 60;
    r[0] = stamp + (i % 2 ? 4 : 0);
    r[3] = stamp;
    r[9] = 10;
    r[10] = 1;
    r[11] = i / 6;
    r[14] = 2;
    r[15] = 'playing';
    r[16] = stamp;
    return r;
  });
  assert.equal(reduceScriptedMotion('mbta:sim-straight', frames).pass, true);
});

test('sensor thresholds retain in-scene NVG peak, halo and six-sprite minimum', async () => {
  const { reduceSensorContrast } = await import('./qaMetrics.js');
  const pixels = (p, n = 6) =>
    Array.from({ length: n }, (_, i) => ({
      key: `bus-${i}`,
      verified: true,
      ...p,
    }));
  assert.equal(
    reduceSensorContrast(
      pixels({ centre: 0.64, ringMin: 0.03, background: 0.3 }),
      'white',
      'surveillance',
    ).pass,
    true,
  );
  assert.equal(
    reduceSensorContrast(
      pixels({ centre: 0.64, ringMin: 0.03, background: 0.9 }),
      'white',
      'surveillance',
    ).pass,
    true,
  );
  assert.equal(
    reduceSensorContrast(
      pixels({ centre: 0.59, ringMin: 0.03, background: 0.1 }),
      'white',
      'surveillance',
    ).pass,
    false,
  );
  assert.equal(
    reduceSensorContrast(pixels({ centre: 0.64, ringMin: 0.03 })).pass,
    false,
  );
  assert.equal(
    reduceSensorContrast(pixels({ centre: 0.86, ringMin: 0.2 })).pass,
    true,
  );
  assert.equal(
    reduceSensorContrast(pixels({ centre: 0.14, ringMax: 0.8 }), 'black').pass,
    true,
  );
  assert.equal(
    reduceSensorContrast(pixels({ centre: 1, ringMin: 0.1 }, 5)).unexercised,
    true,
  );
});

test('initial scripted synchronization is disclosed but subsequent resets fail', async () => {
  const { reduceScenario } = await import('./qaMetrics.js');
  const trace = {
    out: {
      'mbta:sim-straight': Array.from({ length: 100 }, (_, i) => [
        i * 17,
        42 + i / 111320,
        -71,
        i * 17,
        i < 2 ? 0 : 1,
        i < 2 ? 0 : 1,
        0,
        i * 17 + 25000,
      ]),
    },
  };
  assert.equal(reduceScenario(trace, 'straight').resets, 0);
  assert.equal(reduceScenario(trace, 'straight').initialResets, 1);
  trace.out['mbta:sim-straight'][50][4] = 2;
  assert.equal(reduceScenario(trace, 'straight').resets, 1);
});

test('D2 and D3 gate authored allocation inclusively and metro CPU at four milliseconds', () => {
  const fleet = rows().map((r) => ({ ...r, moving: 3000, cpuMs: 3.4 }));
  assert.equal(
    reduceFleet(fleet, 3000, 8192, 10000, 3000 * 128 * 48).pass,
    true,
  );
  assert.equal(
    reduceFleet(fleet, 3000, 8193, 10000, 3000 * 128 * 48).pass,
    false,
  );
  assert.equal(
    reduceFleet(
      fleet.map((r) => ({ ...r, cpuMs: 4.1 })),
      3000,
      0,
      10000,
      10000,
    ).pass,
    false,
  );
});

test('anchor ignores explicitly hidden markers but exposes missing painted cards and nonfinite world positions', () => {
  const samples = rows();
  samples.splice(100, 0, {
    markerVisible: false,
    mx: 0,
    my: 0,
    ax: null,
    ay: null,
    worldFinite: true,
  });
  assert.equal(reduceAnchor(samples).pass, true);
  assert.equal(reduceAnchor(samples).hiddenFrames, 1);
  samples[100].markerVisible = true;
  assert.equal(reduceAnchor(samples).pass, false);
  assert.equal(reduceAnchor(samples).invalidSamples.length, 1);
  samples[100].markerVisible = false;
  samples[100].worldFinite = false;
  assert.equal(reduceAnchor(samples).pass, false);
});

test('scenario speed and catch-up use sampling time, not variable GPU completion time', async () => {
  const { reduceScenario } = await import('./qaMetrics.js');
  const rows = Array.from({ length: 100 }, (_, i) => {
    const r = Array(17).fill(0);
    r[0] = i * 17 + (i % 2 ? 4 : 0);
    r[1] = 42 + (i * 0.17) / 111320;
    r[2] = -71;
    r[3] = i * 17;
    r[5] = 1;
    r[7] = r[3] + 25000;
    r[16] = i * 17;
    return r;
  });
  const result = reduceScenario(
    { out: { 'mbta:sim-straight': rows } },
    'straight',
  );
  assert.ok(Math.abs(result.worstJump - 10) < 1e-6);
  assert.equal(result.wallFaster, 0);
  for (const r of rows) r[16] *= 0.8;
  const fast = reduceScenario(
    { out: { 'mbta:sim-straight': rows } },
    'straight',
  );
  assert.ok(fast.worstJump > 12);
  assert.ok(fast.wallFaster > 0);
});

test('trail-head acceptance names every missing and failed condition', async () => {
  const { reduceTrailHead } = await import('./qaMetrics.js');
  const missing = reduceTrailHead({ selected: false }, { entityCount: 0 });
  assert.equal(missing.pass, false);
  assert.deepEqual(missing.conditions, {
    selected: false,
    enoughHeadSamples: false,
    aligned: false,
    stableBody: false,
    stableEntityCount: false,
  });
  const good = {
    selected: true,
    headSamples: 100,
    headErrorPx: 0,
    bodyMutation: 0,
    entityCount: 0,
  };
  assert.equal(reduceTrailHead(good, { entityCount: 0 }).pass, true);
  assert.equal(
    reduceTrailHead({ ...good, headErrorPx: 2 }, { entityCount: 0 }).pass,
    false,
  );
});

const trailPatch = (rgb) => Array.from({ length: 49 }, () => [...rgb, 255]).flat();
const trailEvidence = (on, off) => ({
  onAgain: on, offAgain: off, tilesReady: true,
  samples: Array.from({ length: 8 }, (_, i) => ({ x: i * 20 + 20, y: 20, radius: 3, inFront: true })),
  sprite: { x: 300, y: 20, radius: 24 },
});

test('trail pixels require repeatable contrast at six distinct samples outside the sprite', async () => {
  const { reduceTrailPixels } = await import('./qaMetrics.js');
  const off = Array.from({ length: 8 }, () => trailPatch([150, 150, 150]));
  const on = off.map((p, i) => i < 6 ? trailPatch([94, 240, 138]) : p);
  const evidence = trailEvidence(on, off);
  assert.equal(reduceTrailPixels(on, off, evidence).pass, true);
  const five = on.map((p, i) => i === 5 ? off[i] : p);
  assert.equal(reduceTrailPixels(five, off, trailEvidence(five, off)).pass, false);
  for (const rgb of [[5, 8, 12], [126, 126, 126]]) {
    const patches = off.map(() => trailPatch(rgb));
    assert.equal(reduceTrailPixels(patches, off, trailEvidence(patches, off)).present, rgb[0] === 5 ? 8 : 0);
    assert.equal(reduceTrailPixels(patches, patches, trailEvidence(patches, patches)).present, 0);
  }
  assert.equal(reduceTrailPixels(on, off).pass, false, 'two reads are insufficient');
  assert.equal(reduceTrailPixels(on, off, { ...evidence, tilesReady: false }).pass, false);
  assert.equal(reduceTrailPixels(on, off, { ...evidence, samples: Array(8).fill(evidence.samples[0]) }).pass, false);
  assert.equal(reduceTrailPixels(on, off, { ...evidence, sprite: { x: 80, y: 20, radius: 200 } }).pass, false);
  assert.equal(reduceTrailPixels([], [], trailEvidence([], [])).pass, false);
});

test('background refinement without a trail cannot pass repeated off/on acceptance', async () => {
  const { reduceTrailPixels } = await import('./qaMetrics.js');
  const grey = (n) => Array.from({ length: 8 }, () => trailPatch([n, n, n]));
  const off = grey(100), on = grey(30);
  const evidence = trailEvidence(on, off);
  assert.equal(reduceTrailPixels(on, off, { ...evidence, offAgain: grey(30) }).pass, false, 'one background transition is not a trail');
  assert.equal(reduceTrailPixels(on, off, { ...evidence, offAgain: grey(170), onAgain: grey(100) }).pass, false, 'equal deltas on a drifting baseline are not a trail');
  assert.equal(reduceTrailPixels(on, off, { ...evidence, onAgain: off }).pass, false, 'contrast must repeat');
  const first = off.map((p) => p.map((v, i) => i < 8 ? on[0][i] : v));
  const second = off.map((p) => p.map((v, i) => i >= 8 && i < 16 ? on[0][i] : v));
  assert.equal(reduceTrailPixels(first, off, { ...evidence, onAgain: second }).pass, false, 'the same pixels must change twice');
});
