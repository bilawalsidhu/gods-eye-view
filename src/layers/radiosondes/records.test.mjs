import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSondeFrame,
  mergeFrame,
  decimateTrack,
  flightPhase,
  SONDE_RETAIN_MS,
} from './records.js';
const now = 1_800_000_000_000;
const raw = {
  serial: 'TEST123',
  datetime: new Date(now).toISOString(),
  lat: 50,
  lon: 10,
  alt: 18000,
  vel_v: 5.2,
  uploader_callsign: 'PRIVATE',
  uploader_position: [1, 2],
  uploader_future: 'private',
  rssi: -20,
  snr: 20,
};
test('projection discards all receiver fields and new upstream fields', () => {
  const frame = normalizeSondeFrame(
    { ...raw, new_private_field: 'secret', temp: 'wrong' },
    now,
  );
  assert.equal(frame.stableId, 'sonde:TEST123');
  assert.equal(frame.tempC, null);
  assert.equal(frame.receivedMs, now);
  assert.equal(frame.vVelMps, 5.2);
  assert.doesNotMatch(
    JSON.stringify(frame),
    /PRIVATE|private|uploader|rssi|snr/,
  );
  for (const patch of [
    { lat: 91 },
    { lon: -181 },
    { alt: 50001 },
    { alt: null },
    { lat: '50' },
    { serial: '../bad' },
    { datetime: 'bad' },
    { datetime: new Date(now - SONDE_RETAIN_MS - 1).toISOString() },
    { datetime: new Date(now + 60001).toISOString() },
  ])
    assert.equal(normalizeSondeFrame({ ...raw, ...patch }, now), null);
  assert.ok(
    normalizeSondeFrame({ ...raw, alt: -500, lat: -90, lon: 180 }, now),
  );
});
test('newest datetime wins, equal receiver copies do not change telemetry', () => {
  const frame = normalizeSondeFrame(raw, now);
  assert.equal(mergeFrame(frame, { ...frame, altM: 99 }), frame);
  assert.equal(mergeFrame(frame, { ...frame, timeMs: now - 1 }), frame);
  const newer = { ...frame, timeMs: now + 1 };
  assert.equal(mergeFrame(frame, newer), newer);
});
test('track decimation preserves endpoints and observed burst; descent and quiet landing are distinct', () => {
  const track = Array.from({ length: 4000 }, (_, i) => ({
    timeMs: now + i * 10000,
    lat: 50,
    lon: 10,
    altM: i < 2000 ? i * 10 : 40000 - i * 10,
  }));
  const small = decimateTrack(track, 640);
  assert.equal(small.length, 640);
  assert.deepEqual(small[0], track[0]);
  assert.deepEqual(small.at(-1), track.at(-1));
  assert.ok(small.some((p) => p.altM === 20000));
  assert.equal(flightPhase(track.slice(0, 100)).phase, 'ascending');
  assert.deepEqual(flightPhase(track), {
    phase: 'descending',
    burstIndex: 2000,
  });
  const quiet = [0, 60000, 120000].map((t) => ({
    timeMs: now + t,
    lat: 50,
    lon: 10,
    altM: 100,
  }));
  assert.equal(
    flightPhase(quiet, { ...quiet.at(-1), vVelMps: 0 }).phase,
    'landed',
  );
  assert.equal(
    flightPhase(quiet.slice(1), { ...quiet.at(-1), vVelMps: 0 }).phase,
    'unknown',
  );
});

test('landing spans a full two minutes even when samples straddle the boundary', () => {
  const track = [-121000, -61000, -1000, 0].map((time) => ({
    timeMs: now + time,
    lat: 50,
    lon: 10,
    altM: 150,
  }));
  assert.equal(flightPhase(track).phase, 'landed');
});

test('direction needs velocity or a track change beyond the noise floor in either direction', () => {
  const frame = normalizeSondeFrame(raw, now);
  assert.equal(flightPhase([]).phase, 'unknown');
  for (const vVelMps of [null, 0, 0.05, -0.05, 0.5, -0.5])
    assert.equal(
      flightPhase([], { ...frame, vVelMps }).phase,
      'unknown',
      `${vVelMps}`,
    );
  for (const [vVelMps, phase] of [
    [0.501, 'ascending'],
    [-0.501, 'descending'],
  ])
    assert.equal(flightPhase([], { ...frame, vVelMps }).phase, phase);
  for (const [delta, phase] of [
    [99, 'unknown'],
    [100, 'ascending'],
    [-99, 'unknown'],
    [-100, 'descending'],
  ]) {
    const current = { ...frame, vVelMps: null };
    const track = [
      { ...current, timeMs: now - 60000, altM: current.altM - delta },
      current,
    ];
    assert.equal(flightPhase(track, current).phase, phase, `${delta} m`);
  }
});

test('silence is classified from last-fix time with evidence required for a low inferred landing', () => {
  const frame = normalizeSondeFrame(raw, now);
  const silentNow = now + 600001;
  for (const [altM, vVelMps, phase] of [
    [104, 0.05, 'landed-inferred'],
    [1999, -3, 'landed-inferred'],
    [1800, 0, 'landed-inferred'],
    [2000, -3, 'signal-lost'],
    [18000, 0, 'signal-lost'],
    [104, 5, 'signal-lost'],
    [104, null, 'signal-lost'],
  ]) {
    const fix = { ...frame, altM, vVelMps, receivedMs: silentNow };
    assert.equal(
      flightPhase([fix], fix, silentNow).phase,
      phase,
      `${altM} m / ${vVelMps} m/s`,
    );
  }
  assert.equal(flightPhase([], frame, now + 600000).phase, 'ascending');
  assert.equal(flightPhase([], frame, silentNow).phase, 'signal-lost');
  const low = { ...frame, altM: 104, vVelMps: null };
  const descent = [{ ...low, timeMs: now - 60000, altM: 500 }, low];
  assert.equal(
    flightPhase(descent, low, now + 161 * 60000).phase,
    'landed-inferred',
  );
  const quiet = [-120000, -60000, 0].map((delta) => ({
    ...low,
    timeMs: now + delta,
  }));
  assert.equal(flightPhase(quiet, low, silentNow).phase, 'landed');
  const highQuiet = quiet.map((p) => ({ ...p, altM: 1800 }));
  assert.equal(
    flightPhase(highQuiet, highQuiet.at(-1), silentNow).phase,
    'landed-inferred',
  );
  assert.equal(
    flightPhase([], { ...low, timeMs: silentNow, vVelMps: 5 }, silentNow).phase,
    'ascending',
  );
});
