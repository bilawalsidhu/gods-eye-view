import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AdsbStreamDecoder,
  LOCAL_ADSB_STALE_MS,
  decodeAdsbMessage,
  extractAdsbMessages,
  modeSChecksum,
  pruneAircraftTracks,
  updateAircraftTrack,
} from './adsbDecoder.js';

function fromHex(value) {
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

function synthesizeIq(bytes, { floor = 128, high = 255, preambleTail = null } = {}) {
  const sampleCount = 16 + (112 * 2) + 8;
  const iq = new Uint8Array(sampleCount * 2).fill(128);
  for (let sample = 0; sample < sampleCount; sample += 1) iq[sample * 2] = floor;
  const pulse = (sample) => { iq[sample * 2] = high; };
  for (const offset of [0, 2, 7, 9]) pulse(offset);
  if (Number.isFinite(preambleTail)) {
    for (let sample = 10; sample < 16; sample += 1) iq[sample * 2] = preambleTail;
  }
  for (let index = 0; index < 112; index += 1) {
    const value = (bytes[index >> 3] >> (7 - (index & 7))) & 1;
    pulse(16 + (index * 2) + (value ? 0 : 1));
  }
  return iq.buffer;
}

test('decodes standard callsign, velocity, and altitude examples', () => {
  const callsign = decodeAdsbMessage(fromHex('8D4840D6202CC371C32CE0576098'));
  assert.equal(callsign.callsign, 'KLM1023');
  assert.equal(callsign.icao, '4840D6');

  const velocity = decodeAdsbMessage(fromHex('8D485020994409940838175B284F'));
  assert.ok(Math.abs(velocity.speedKt - 159.2) < 0.1);
  assert.ok(Math.abs(velocity.headingDeg - 182.88) < 0.1);
  assert.equal(velocity.verticalRateFpm, -832);

  const position = decodeAdsbMessage(fromHex('8D40621D58C382D690C8AC2863A7'));
  assert.equal(position.altitudeFt, 38_000);
  assert.equal(position.cpr.odd, false);
});

test('globally decodes a valid even/odd CPR pair and expires tracks at 60 seconds', () => {
  const tracks = new Map();
  const even = decodeAdsbMessage(fromHex('8D40621D58C382D690C8AC2863A7'), { receivedAt: 1_000 });
  const odd = decodeAdsbMessage(fromHex('8D40621D58C386435CC412692AD6'), { receivedAt: 1_500 });
  updateAircraftTrack(tracks, even);
  const aircraft = updateAircraftTrack(tracks, odd);
  assert.ok(Math.abs(aircraft.latitude - 52.26578) < 0.0001);
  assert.ok(Math.abs(aircraft.longitude - 3.93891) < 0.0001);
  assert.equal(aircraft.lastPositionAt, 1_500);
  assert.equal(LOCAL_ADSB_STALE_MS, 60_000);
  assert.equal(pruneAircraftTracks(tracks, 61_499), 0, 'contact survives below 60 seconds');
  assert.equal(pruneAircraftTracks(tracks, 61_500), 1, 'contact expires at 60 seconds');
  assert.equal(tracks.size, 0);
});

test('extracts a CRC-valid Mode S frame from synthetic 2 Msps IQ', () => {
  const bytes = fromHex('8D4840D6202CC371C32CE0576098');
  assert.equal(modeSChecksum(bytes), 0);
  const frames = extractAdsbMessages(synthesizeIq(bytes), 2_000_000);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], bytes);
});

test('accepts a valid weak frame above an elevated local noise floor', () => {
  const bytes = fromHex('8D4840D6202CC371C32CE0576098');
  const frames = extractAdsbMessages(synthesizeIq(bytes, { floor: 140, high: 150 }), 2_000_000);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], bytes);
});

test('accepts a real-shaped preamble with energy trailing its final pulse', () => {
  const bytes = fromHex('8D4840D6202CC371C32CE0576098');
  const frames = extractAdsbMessages(synthesizeIq(bytes, {
    floor: 138,
    high: 148,
    preambleTail: 145,
  }), 2_000_000);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], bytes);
});

test('preserves a Mode S frame split across consecutive USB blocks', () => {
  const bytes = fromHex('8D4840D6202CC371C32CE0576098');
  const iq = new Uint8Array(synthesizeIq(bytes));
  const decoder = new AdsbStreamDecoder();
  assert.deepEqual(decoder.extract(iq.slice(0, 300).buffer, 2_000_000), []);
  assert.deepEqual(decoder.extract(iq.slice(300).buffer, 2_000_000), [bytes]);
  decoder.reset();
  assert.deepEqual(decoder.extract(iq.slice(300).buffer, 2_000_000), []);
});

test('rejects corrupt frames and unsupported sample rates', () => {
  const bytes = fromHex('8D4840D6202CC371C32CE0576098');
  bytes[5] ^= 0x01;
  assert.notEqual(modeSChecksum(bytes), 0);
  assert.equal(decodeAdsbMessage(bytes), null);
  assert.deepEqual(extractAdsbMessages(synthesizeIq(bytes), 1_024_000), []);
});

const AUSTIN_RECEIVER = Object.freeze({ latitude: 30.27, longitude: -97.8 });
const fixtureFrames = readFileSync(
  new URL('../data/fixtures/adsb-austin-frames.txt', import.meta.url),
  'utf8',
)
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => fromHex(line.replace(/^\*|;$/g, '')));
const dump1090 = JSON.parse(
  readFileSync(
    new URL('../data/fixtures/adsb-austin-dump1090-aircraft.json', import.meta.url),
    'utf8',
  ),
);

// The capture keeps receive order but not receive times, so frames are spaced
// 100 ms apart: every even/odd pair then falls inside the 10 s CPR window.
function decodeFixture(receiverLocation) {
  const tracks = new Map();
  fixtureFrames.forEach((bytes, index) => {
    const message = decodeAdsbMessage(bytes, { receivedAt: (index + 1) * 100 });
    if (message) updateAircraftTrack(tracks, message, receiverLocation);
  });
  return tracks;
}

test('real Austin frames decode to the same aircraft, callsigns and positions as dump1090', () => {
  assert.equal(fixtureFrames.length, 112);
  const tracks = decodeFixture(AUSTIN_RECEIVER);
  const heard = [...tracks.keys()].map((icao) => icao.toLowerCase()).sort();
  assert.deepEqual(heard, dump1090.aircraft.map((entry) => entry.hex).sort());
  for (const oracle of dump1090.aircraft) {
    const track = tracks.get(oracle.hex.toUpperCase());
    if (oracle.flight) assert.equal(track.callsign, oracle.flight.trim(), oracle.hex);
    if (Number.isFinite(oracle.alt_baro)) assert.equal(track.altitudeFt, oracle.alt_baro, oracle.hex);
    if (Number.isFinite(oracle.gs)) assert.ok(Math.abs(track.speedKt - oracle.gs) < 0.5, oracle.hex);
    if (Number.isFinite(oracle.track)) assert.ok(Math.abs(track.headingDeg - oracle.track) < 0.5, oracle.hex);
    if (Number.isFinite(oracle.baro_rate)) assert.equal(track.verticalRateFpm, oracle.baro_rate, oracle.hex);
    if (!Number.isFinite(oracle.lat)) continue;
    assert.ok(Math.abs(track.latitude - oracle.lat) < 0.01, `${oracle.hex} latitude`);
    assert.ok(Math.abs(track.longitude - oracle.lon) < 0.01, `${oracle.hex} longitude`);
  }
});

test('receiver-relative CPR positions an even-only aircraft that dump1090 left unpositioned', () => {
  // SKW3301 (a15c54) sent three airborne positions, all even-parity, so no
  // global even/odd pair exists. dump1090 ran without a receiver location and
  // could not position it; with one, the local decode places it near AUS.
  const skywest = fixtureFrames.filter(
    (bytes) => decodeAdsbMessage(bytes)?.icao === 'A15C54' && decodeAdsbMessage(bytes).cpr,
  );
  assert.equal(skywest.length, 3);
  assert.ok(skywest.every((bytes) => decodeAdsbMessage(bytes).cpr.odd === false));

  const located = decodeFixture(AUSTIN_RECEIVER).get('A15C54');
  assert.ok(Math.abs(located.latitude - 30.1599) < 0.01);
  assert.ok(Math.abs(located.longitude + 97.7903) < 0.01);

  const unlocated = decodeFixture(null);
  assert.equal(unlocated.get('A15C54').latitude, null);
  const positioned = [...unlocated.values()]
    .filter((track) => Number.isFinite(track.latitude))
    .map((track) => track.icao.toLowerCase())
    .sort();
  assert.deepEqual(
    positioned,
    dump1090.aircraft.filter((entry) => Number.isFinite(entry.lat)).map((entry) => entry.hex).sort(),
    'without a receiver location the positioned set matches dump1090 exactly',
  );
});
