import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTrack,
  createLagReservoir,
  createHistoryBudget,
  insertFix,
  readFix,
  advance,
  sampleAt,
  seek,
  setRate,
  setTimeOffsetMs,
  mergeHistory,
  correctHeight,
  trimTrack,
  destroyTrack,
  FIX_BYTES,
  FIX_FLAGS,
} from './contactPlayback.js';
const fix = (t, metres = t / 100) => ({
  t,
  lat: 42 + metres / 111320,
  lon: -71,
  bearingDeg: 0,
});
const clocks = (t) => ({ wallNowMs: t, monoNowMs: t });
const put = (track, t, metres, receipt = t) =>
  insertFix(track, fix(t, metres), { receivedAt: receipt, wallNowMs: receipt });

test('10 s reports / 15 s polls and a 6 m crawl move at report speed on ordinary frames', () => {
  for (const speed of [10, 0.6]) {
    const track = createTrack(),
      out = {};
    let prior = null,
      moving = 0,
      pollJumps = 0;
    for (let now = 5000; now <= 180000; now += 16) {
      if (
        !prior ||
        Math.floor((now - 5000) / 15000) !== Math.floor((now - 5016) / 15000)
      ) {
        const t = Math.floor((now - 5000) / 10000) * 10000;
        put(track, t, (t / 1000) * speed, now);
      }
      advance(track, clocks(now), out);
      if (prior && out.displayT >= 0 && prior.displayT >= 0) {
        const d = (out.lat - prior.lat) * 111320;
        const dt = out.displayT - prior.displayT;
        assert.ok(dt >= 0 && dt <= 16.0001);
        if (dt > 0 && d > 0) {
          assert.ok(Math.abs(d / (dt / 1000) - speed) < speed * 0.02);
          moving++;
        }
        if (d > speed * 0.0161) pollJumps++;
      }
      prior = { ...out };
    }
    assert.ok(
      moving > 5000,
      `non-vacuous ${speed} m/s trace: ${moving} moving frames`,
    );
    assert.equal(pollJumps, 0);
  }
});
test('stationary observations survive, schedule departure, and distinguish underflow', () => {
  const track = createTrack(),
    out = {};
  put(track, 0, 0);
  put(track, 15000, 0);
  put(track, 30000, 6);
  setTimeOffsetMs(track, 0, clocks(35000));
  advance(track, clocks(35000), out);
  assert.equal(out.motion, 'stopped');
  assert.equal(out.nextWakeMonoMs, 40000);
  advance(track, clocks(40000), out);
  assert.equal(out.motion, 'moving');
  advance(track, clocks(55000), out);
  assert.equal(out.phase, 'held');
  assert.equal(out.segmentSpeedMps, 0);
});
test('same-time conflicts and invalid coordinates never make zero-duration segments', () => {
  const track = createTrack();
  put(track, 0, 0);
  assert.equal(put(track, 0, 0).reason, 'repeat');
  assert.equal(put(track, 0, 1).reason, 'conflict');
  for (const value of [
    { t: 1, lat: 91, lon: 0 },
    { t: 1, lat: 0, lon: NaN },
    { t: -1, lat: 0, lon: 0 },
  ])
    assert.equal(insertFix(track, value).accepted, false);
  assert.equal(track.count, 1);
  assert.equal(put(track, 15000, 0).accepted, true);
});
test('ring wrap retains 15 minutes and pins an active bracket under capacity pressure', () => {
  const track = createTrack({ capacity: 8 });
  for (let i = 0; i < 8; i++) put(track, i * 10000, i);
  seek(track, 5000, clocks(80000));
  for (let i = 8; i < 30; i++) put(track, i * 10000, i);
  const sample = sampleAt(track, 5000, {});
  assert.equal(sample.fromT, 0);
  assert.equal(sample.toT, 10000);
  assert.equal(track.count, 8);
  assert.equal(track.storage.byteLength, 8 * FIX_BYTES);
  assert.equal(track.truncated, true);
  assert.ok(readFix(track, 2).flags & FIX_FLAGS.BREAK);
  seek(track, 250000, clocks(300000));
  trimTrack(track, 300000, 2);
  assert.ok(track.count <= 5);
});
test('backward seek and history merge leave clock and live health alone', () => {
  const track = createTrack(),
    out = {};
  put(track, 30000, 30);
  put(track, 45000, 45);
  seek(track, 37500, clocks(80000));
  const health = track.acceptedAt;
  mergeHistory(track, [fix(0, 0), fix(15000, 15), fix(30000, 999)]);
  assert.equal(track.displayT, 37500);
  assert.equal(track.acceptedAt, health);
  assert.equal(readFix(track, 2).lat, fix(30000, 30).lat);
  seek(track, 7500, clocks(80000));
  advance(track, clocks(90000), out);
  assert.equal(out.displayT, 7500);
  assert.equal(out.phase, 'paused');
  setRate(track, 1, clocks(90000));
  advance(track, clocks(91000), out);
  assert.equal(out.displayT, 8500);
});
test('system-clock changes do not alter animation elapsed time', () => {
  const track = createTrack(),
    out = {};
  put(track, 0, 0);
  put(track, 60000, 600);
  advance(track, clocks(60000), out);
  const before = out.displayT;
  advance(track, { wallNowMs: 999999999, monoNowMs: 60016 }, out);
  assert.equal(out.displayT - before, 16);
  setTimeOffsetMs(track, -10000, clocks(60016));
  assert.equal(track.resetReason, 'time-offset');
  assert.equal(track.resets, 1);
});
test('a 90 s outage holds, then resumes without a sprint; backlog reset adds no second delay', () => {
  const track = createTrack(),
    out = {};
  put(track, 0, 0);
  put(track, 15000, 15);
  for (let t = 25000; t <= 120000; t += 100) advance(track, clocks(t), out);
  assert.equal(out.displayT, 15000);
  put(track, 105000, 105, 120000);
  advance(track, clocks(120100), out);
  assert.ok(out.displayT - 15000 <= 100);
  track.targetDelayMs = 25000;
  put(track, 300000, 300, 300000);
  track.targetDelayMs = 25000;
  advance(track, clocks(300000), out);
  assert.equal(track.resets, 1);
  assert.equal(track.resetReason, 'backlog');
  assert.equal(out.displayT, 275000);
});
test('lag measures receipt of current minus report of previous and ignores cached deliveries', () => {
  const feedLag = createLagReservoir(),
    track = createTrack({ policy: { feedLag } });
  put(track, 0, 0, 5000);
  put(track, 10000, 100, 20000);
  assert.equal(track.lag.values[0], 20000);
  put(track, 10000, 100, 80000);
  assert.equal(track.lag.count, 1);
  put(track, 20000, 200, 50000);
  assert.equal(track.targetDelayMs, 45000);
});
test('displayed bearing never reads a future fix; height corrections revise typed storage', () => {
  const track = createTrack();
  insertFix(track, { ...fix(0, 0), bearingDeg: 90 });
  insertFix(track, { ...fix(15000, 6), bearingDeg: 270 });
  const out = sampleAt(track, 7500, {});
  assert.equal(out.segmentCourseDeg, 90);
  assert.ok(Number.isNaN(out.heightM));
  correctHeight(track, out.fromSeq, 11.5);
  correctHeight(track, out.toSeq, 21.5);
  assert.equal(sampleAt(track, 7500, out).heightM, 16.5);
});
test('allocation budget is hard and destruction returns payload bytes', () => {
  const budget = createHistoryBudget(48 * 16),
    tracks = Array.from({ length: 3 }, () => createTrack({ budget }));
  for (const track of tracks)
    for (let t = 0; t < 100; t++) put(track, t * 1000, t);
  assert.ok(budget.allocatedBytes <= budget.maxBytes);
  for (const track of tracks) destroyTrack(track);
  assert.equal(budget.allocatedBytes, 0);
});

test('tiny displacement holds a preceding reliable course instead of a changed bearing', () => {
  const track = createTrack();
  insertFix(track, { ...fix(0, 0), bearingDeg: 90 });
  insertFix(track, { ...fix(15000, 100), bearingDeg: 270 });
  insertFix(track, { ...fix(30000, 106), bearingDeg: 180 });
  assert.equal(sampleAt(track, 20000, {}).segmentCourseDeg, 0);
});
test('an epoch gap wakes at its far boundary without drawing a connecting segment', () => {
  const track = createTrack(),
    out = {};
  insertFix(track, { ...fix(0, 0), epoch: 1 });
  insertFix(track, { ...fix(30000, 100), epoch: 2 });
  advance(track, clocks(40000), out);
  assert.equal(out.segmentSpeedMps, 0);
  assert.equal(out.nextWakeMonoMs, 65000);
});

test('increased lag is adopted while rebuffering, with one monotonic wake and no slow playback', () => {
  const track = createTrack(),
    out = {};
  put(track, 0, 0);
  put(track, 15000, 15);
  for (let now = 25000; now <= 120000; now += 100)
    advance(track, clocks(now), out);
  insertFix(track, fix(105000, 105), {
    receivedAt: 120000,
    wallNowMs: 120000,
    monoNowMs: 120000,
  });
  advance(track, clocks(120100), out);
  assert.equal(out.displayT, 15000);
  assert.equal(out.phase, 'buffering');
  assert.equal(out.nextWakeMonoMs, 125000);
  advance(track, { wallNowMs: -9999999, monoNowMs: 125000 }, out);
  assert.equal(out.displayT, 15000);
  advance(track, { wallNowMs: 9999999, monoNowMs: 125016 }, out);
  assert.equal(out.displayT, 15016);
});

test('capacity rejection leaves both lag reservoirs and clock policy unchanged', () => {
  const feedLag = createLagReservoir();
  const track = createTrack({ capacity: 2, policy: { feedLag } });
  put(track, 0, 0);
  put(track, 10000, 10);
  seek(track, 5000, clocks(10000));
  const policyState = () =>
    structuredClone({
      lag: track.lag,
      feedLag,
      targetDelayMs: track.targetDelayMs,
      acceptedAt: track.acceptedAt,
      acceptedMono: track.acceptedMono,
      resumePending: track.resumePending,
      displayT: track.displayT,
      wallAnchor: track.wallAnchor,
      monoAnchor: track.monoAnchor,
      resetReason: track.resetReason,
      resets: track.resets,
    });
  const before = policyState();
  assert.deepEqual(put(track, 20000, 20, 300000), {
    accepted: false,
    reason: 'capacity',
  });
  assert.deepEqual(policyState(), before);
});

test('sampleAt writes the supplied output without replacing nested scratch', () => {
  const track = createTrack();
  put(track, 0, 0);
  put(track, 15000, 150);
  const out = {},
    from = track.from,
    to = track.to,
    metrics = track.metrics;
  for (let i = 0; i < 10000; i++) {
    assert.equal(sampleAt(track, i, out), out);
    assert.equal(track.from, from);
    assert.equal(track.to, to);
    assert.equal(track.metrics, metrics);
  }
});
