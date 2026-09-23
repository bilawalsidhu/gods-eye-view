import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyAircraft } from '../data/aircraftClass.js';
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
  return Uint8Array.from(value.match(/../g), (pair) =>
    Number.parseInt(pair, 16),
  );
}

function synthesizeIq(
  bytes,
  { floor = 128, high = 255, preambleTail = null } = {},
) {
  const sampleCount = 16 + 112 * 2 + 8;
  const iq = new Uint8Array(sampleCount * 2).fill(128);
  for (let sample = 0; sample < sampleCount; sample += 1)
    iq[sample * 2] = floor;
  const pulse = (sample) => {
    iq[sample * 2] = high;
  };
  for (const offset of [0, 2, 7, 9]) pulse(offset);
  if (Number.isFinite(preambleTail)) {
    for (let sample = 10; sample < 16; sample += 1)
      iq[sample * 2] = preambleTail;
  }
  for (let index = 0; index < 112; index += 1) {
    const value = (bytes[index >> 3] >> (7 - (index & 7))) & 1;
    pulse(16 + index * 2 + (value ? 0 : 1));
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
  const even = decodeAdsbMessage(fromHex('8D40621D58C382D690C8AC2863A7'), {
    receivedAt: 1_000,
  });
  const odd = decodeAdsbMessage(fromHex('8D40621D58C386435CC412692AD6'), {
    receivedAt: 1_500,
  });
  updateAircraftTrack(tracks, even);
  const aircraft = updateAircraftTrack(tracks, odd);
  assert.ok(Math.abs(aircraft.latitude - 52.26578) < 0.0001);
  assert.ok(Math.abs(aircraft.longitude - 3.93891) < 0.0001);
  assert.equal(aircraft.lastPositionAt, 1_500);
  assert.equal(LOCAL_ADSB_STALE_MS, 60_000);
  assert.equal(
    pruneAircraftTracks(tracks, 61_499),
    0,
    'contact survives below 60 seconds',
  );
  assert.equal(
    pruneAircraftTracks(tracks, 61_500),
    1,
    'contact expires at 60 seconds',
  );
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
  const frames = extractAdsbMessages(
    synthesizeIq(bytes, { floor: 140, high: 150 }),
    2_000_000,
  );
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], bytes);
});

test('accepts a real-shaped preamble with energy trailing its final pulse', () => {
  const bytes = fromHex('8D4840D6202CC371C32CE0576098');
  const frames = extractAdsbMessages(
    synthesizeIq(bytes, {
      floor: 138,
      high: 148,
      preambleTail: 145,
    }),
    2_000_000,
  );
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
    new URL(
      '../data/fixtures/adsb-austin-dump1090-aircraft.json',
      import.meta.url,
    ),
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
    if (oracle.flight)
      assert.equal(track.callsign, oracle.flight.trim(), oracle.hex);
    if (Number.isFinite(oracle.alt_baro))
      assert.equal(track.altitudeFt, oracle.alt_baro, oracle.hex);
    if (Number.isFinite(oracle.gs))
      assert.ok(Math.abs(track.speedKt - oracle.gs) < 0.5, oracle.hex);
    if (Number.isFinite(oracle.track))
      assert.ok(Math.abs(track.headingDeg - oracle.track) < 0.5, oracle.hex);
    if (Number.isFinite(oracle.baro_rate))
      assert.equal(track.verticalRateFpm, oracle.baro_rate, oracle.hex);
    if (!Number.isFinite(oracle.lat)) continue;
    assert.ok(
      Math.abs(track.latitude - oracle.lat) < 0.01,
      `${oracle.hex} latitude`,
    );
    assert.ok(
      Math.abs(track.longitude - oracle.lon) < 0.01,
      `${oracle.hex} longitude`,
    );
  }
});

test('receiver-relative CPR positions an even-only aircraft that dump1090 left unpositioned', () => {
  // SKW3301 (a15c54) sent three airborne positions, all even-parity, so no
  // global even/odd pair exists. dump1090 ran without a receiver location and
  // could not position it; with one, the local decode places it near AUS.
  const skywest = fixtureFrames.filter(
    (bytes) =>
      decodeAdsbMessage(bytes)?.icao === 'A15C54' &&
      decodeAdsbMessage(bytes).cpr,
  );
  assert.equal(skywest.length, 3);
  assert.ok(
    skywest.every((bytes) => decodeAdsbMessage(bytes).cpr.odd === false),
  );

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
    dump1090.aircraft
      .filter((entry) => Number.isFinite(entry.lat))
      .map((entry) => entry.hex)
      .sort(),
    'without a receiver location the positioned set matches dump1090 exactly',
  );
});

// A second real capture over Austin with receive times: 846 extended
// squitters from six aircraft, each frame timed by interpolating between the
// frames whose decoded position matches a dump1090 fix (dump1090's `t -
// seen_pos`), plus dump1090's own positions for the same interval.
const timed = JSON.parse(
  readFileSync(
    new URL('../data/fixtures/adsb-austin-capture-timed.json', import.meta.url),
    'utf8',
  ),
);

function nauticalMiles(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
}

function replayTimed({ inject = null, receiver = timed.receiver } = {}) {
  const tracks = new Map();
  const stats = {};
  const accepted = new Map();
  for (const [receivedAt, hex] of timed.frames) {
    const message = decodeAdsbMessage(fromHex(hex), { receivedAt });
    if (!message) continue;
    for (const extra of inject?.(message) || []) {
      updateAircraftTrack(tracks, extra, receiver, stats);
    }
    const track = updateAircraftTrack(tracks, message, receiver, stats);
    if (message.cpr && track.lastPositionAt === receivedAt) {
      const key = message.icao.toLowerCase();
      if (!accepted.has(key)) accepted.set(key, []);
      accepted.get(key).push({
        at: receivedAt,
        lat: track.latitude,
        lon: track.longitude,
      });
    }
  }
  return { tracks, stats, accepted };
}

function dump1090Final(hex) {
  const [, lat, lon] = timed.dump1090[hex].fixes.at(-1);
  return { lat, lon };
}

test('identification messages decode to the dump1090 emitter category strings', () => {
  const { tracks } = replayTimed();
  const decoded = Object.fromEntries(
    Object.keys(timed.dump1090).map((hex) => [
      hex,
      tracks.get(hex.toUpperCase()).category,
    ]),
  );
  assert.deepEqual(decoded, {
    '0d0c07': 'A2',
    a3627d: 'A3',
    a0b702: 'A7',
    a5b3a7: 'A3',
    abe7c5: 'A3',
    a27e81: 'A1',
  });
  for (const [hex, oracle] of Object.entries(timed.dump1090))
    assert.equal(decoded[hex], oracle.category, hex);
  // Category set D (type code 1) and C (type code 2) follow the same rule.
  const message = decodeAdsbMessage(fromHex('8D4840D6202CC371C32CE0576098'));
  assert.equal(message.typeCode, 4);
  assert.equal(message.category, 'A0');
});

test('145TX, a rotorcraft (A7), classifies as a helicopter', () => {
  const { tracks } = replayTimed();
  const heli = tracks.get('A0B702');
  assert.equal(heli.callsign, '145TX');
  assert.equal(classifyAircraft({ category: heli.category }), 'helicopter');
  assert.equal(
    classifyAircraft({ category: tracks.get('A27E81').category }),
    'light',
  );
});

test('the speed check refuses none of the capture and every track ends on dump1090', () => {
  const { tracks, stats, accepted } = replayTimed();
  assert.equal(stats.positionsRejected || 0, 0);
  for (const hex of Object.keys(timed.dump1090)) {
    const track = tracks.get(hex.toUpperCase());
    assert.equal(track.rejectedPositions, 0, `${hex} rejected a fix`);
    const fixes = accepted.get(hex);
    assert.ok(fixes.length >= 20, `${hex}: ${fixes.length} fixes`);
    const delta = nauticalMiles(fixes.at(-1), dump1090Final(hex));
    assert.ok(delta < 0.3, `${hex} ends ${delta.toFixed(3)} nm from dump1090`);
  }
});

test("N26VB's 1.0 nm step spans a 27 s reception gap at its reported speed", () => {
  // The field report read this as a bad decode. The step follows single odd
  // frames decoded against the receiver location, which dump1090 (run without
  // one) never positions; the implied speed matches the reported 134 kt.
  const { tracks, accepted } = replayTimed();
  const fixes = accepted.get('a27e81');
  let widest = null;
  for (let index = 1; index < fixes.length; index += 1) {
    const step = nauticalMiles(fixes[index - 1], fixes[index]);
    if (!widest || step > widest.step)
      widest = {
        step,
        seconds: (fixes[index].at - fixes[index - 1].at) / 1000,
      };
  }
  assert.ok(Math.abs(widest.step - 1.0) < 0.05, `${widest.step} nm`);
  assert.ok(widest.seconds > 25, `${widest.seconds} s`);
  const impliedKt = widest.step / (widest.seconds / 3600);
  assert.ok(Math.abs(impliedKt - 134) < 10, `${impliedKt.toFixed(0)} kt`);
  assert.equal(tracks.get('A27E81').rejectedPositions, 0);
});

test('a corrupt even/odd pair is refused and the track stays on dump1090', () => {
  // Pair a foreign odd frame (ENY3344, 27 nm away) with N26VB's fresh even
  // frame: the global decode lands far off the track, as a mixed-up pair does.
  const foreign = timed.frames
    .map(([, hex]) => decodeAdsbMessage(fromHex(hex)))
    .find((message) => message?.icao === 'A3627D' && message.cpr?.odd);
  let injected = 0;
  const { tracks, stats, accepted } = replayTimed({
    inject(message) {
      if (message.icao !== 'A27E81' || message.cpr?.odd !== false) return [];
      if (injected >= 2) return [];
      injected += 1;
      return [
        {
          ...foreign,
          icao: 'A27E81',
          receivedAt: message.receivedAt - 1,
          cpr: { ...foreign.cpr, receivedAt: message.receivedAt - 1 },
        },
      ];
    },
  });
  const track = tracks.get('A27E81');
  assert.ok(track.rejectedPositions >= 1);
  assert.equal(stats.positionsRejected, track.rejectedPositions);
  for (const fix of accepted.get('a27e81'))
    assert.ok(
      nauticalMiles(fix, { lat: 30.32, lon: -97.91 }) < 3,
      'no accepted fix leaves the track',
    );
  assert.ok(
    nauticalMiles(accepted.get('a27e81').at(-1), dump1090Final('a27e81')) <
      0.3,
  );
});

test('a lone frame decodes relative to the aircraft own recent position', () => {
  const tracks = new Map();
  const even = decodeAdsbMessage(fromHex('8D40621D58C382D690C8AC2863A7'), {
    receivedAt: 1_000,
  });
  const odd = decodeAdsbMessage(fromHex('8D40621D58C386435CC412692AD6'), {
    receivedAt: 1_500,
  });
  updateAircraftTrack(tracks, even);
  updateAircraftTrack(tracks, odd);
  // 20 s later the pair has expired and there is no receiver location.
  const later = decodeAdsbMessage(fromHex('8D40621D58C386435CC412692AD6'), {
    receivedAt: 20_000,
  });
  const track = updateAircraftTrack(tracks, later, null);
  assert.equal(track.lastPositionAt, 20_000);
  assert.ok(Math.abs(track.latitude - 52.26578) < 0.0001);
  assert.ok(Math.abs(track.longitude - 3.93891) < 0.0001);
});

test('three refused global fixes in a row re-anchor the track', () => {
  const tracks = new Map();
  const stats = {};
  updateAircraftTrack(
    tracks,
    decodeAdsbMessage(fromHex('8D40621D58C382D690C8AC2863A7'), {
      receivedAt: 1_000,
    }),
  );
  updateAircraftTrack(
    tracks,
    decodeAdsbMessage(fromHex('8D40621D58C386435CC412692AD6'), {
      receivedAt: 1_500,
    }),
  );
  // Austin pairs relabelled as this aircraft: global decodes 8,000 km away.
  const austin = timed.frames
    .map(([, hex]) => decodeAdsbMessage(fromHex(hex)))
    .filter((message) => message?.icao === 'A0B702' && message.cpr);
  const firstOdd = austin.find((message) => message.cpr.odd);
  const firstEven = austin.find((message) => !message.cpr.odd);
  let at = 2_000;
  const feed = (message) => {
    at += 500;
    return updateAircraftTrack(
      tracks,
      {
        ...message,
        icao: '40621D',
        receivedAt: at,
        cpr: { ...message.cpr, receivedAt: at },
      },
      null,
      stats,
    );
  };
  feed(firstEven);
  let track = feed(firstOdd);
  assert.equal(track.rejectedPositions, 2);
  assert.ok(Math.abs(track.latitude - 52.26578) < 0.0001, 'still anchored');
  track = feed(firstEven);
  assert.equal(stats.positionsRejected, 2, 'the third global fix re-anchors');
  assert.ok(Math.abs(track.latitude - 30.2) < 0.2, 'moved to the new stream');
  assert.equal(track.rejectStreak, 0);
});
