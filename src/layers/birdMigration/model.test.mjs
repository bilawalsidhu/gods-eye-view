import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFrame, mergeMotion } from './model.js';
import { parseMotion } from './wire.js';
import { compositeTileTemplate, recolorPattern } from './pattern.js';

const TIME = '2026-10-11T03:30:00.000Z';
const position = { lat: 35.333, lon: -97.278, elevM: 389 };
const fit = {
  velocityProduct: 'N0U',
  maskProduct: 'N0C',
  gateCount: 7000,
  azimuthCoverageDeg: 359,
  residualMs: 2.4,
  annulusKm: [5, 60],
  beamHeightM: [45, 735],
};
const tracked = {
  kind: 'tracked',
  site: 'KTLX',
  position,
  scanTime: '2026-10-11T03:27:13.000Z',
  track: { towardDeg: 196, speedMs: 12 },
  fit,
};
const reduced = (stations, final = true) => ({
  schemaVersion: 1,
  time: TIME,
  motion: {
    kind: 'reduced',
    reducedAt: '2026-10-11T03:41:02.120Z',
    final,
    sampleRadiusKm: 60,
    stations,
  },
});

test('a tracked station without its fit fails the whole motion document', () => {
  const { fit: _dropped, ...withoutFit } = tracked;
  assert.throws(
    () => parseMotion(reduced([withoutFit]), TIME),
    /tracked station without a complete fit/,
  );
  assert.throws(
    () =>
      parseMotion(
        reduced([{ ...tracked, fit: { ...fit, gateCount: 0 } }]),
        TIME,
      ),
    /tracked station without a complete fit/,
  );
  assert.throws(
    () => parseMotion(reduced([{ ...tracked, track: { speedMs: 12 } }]), TIME),
    /station track/,
  );
});

test('only a tracked station may hold a direction', () => {
  assert.throws(
    () =>
      parseMotion(
        reduced([
          {
            kind: 'precipitation',
            site: 'KDVN',
            position,
            scanTime: tracked.scanTime,
            rainFraction: 0.8,
            track: { towardDeg: 10, speedMs: 4 },
          },
        ]),
        TIME,
      ),
    /precipitation station holding a direction/,
  );
  const motion = parseMotion(
    reduced([
      tracked,
      { kind: 'quiet', site: 'KICT', position, scanTime: tracked.scanTime },
      { kind: 'no-scan', site: 'KAMA', position },
    ]),
    TIME,
  );
  assert.deepEqual(
    motion.stations.map((station) => [station.kind, 'track' in station]),
    [
      ['tracked', true],
      ['quiet', false],
      ['no-scan', false],
    ],
  );
  assert.equal(motion.stations[0].track.towardDeg, 196);
});

test('a motion document for a different tick is rejected', () => {
  assert.throws(
    () => parseMotion(reduced([tracked]), '2026-10-11T04:00:00.000Z'),
    /Malformed bird migration motion/,
  );
});

test('a pending frame states no direction and no degree value', () => {
  const card = describeFrame({ time: TIME, motion: { kind: 'pending' } });
  const text = JSON.stringify(card);
  assert.doesNotMatch(text, /°|\bdeg/i);
  assert.equal(card.counts, null);
  assert.equal(
    card.lines.find(({ id }) => id === 'direction').text,
    'Direction for this time: reducing radar velocity…',
  );
  assert.equal(
    card.lines.some(({ id }) => id === 'arrows'),
    false,
  );
});

test('a reduced frame counts radars and names what the arrows and wash claim', () => {
  const card = describeFrame({
    time: TIME,
    motion: parseMotion(
      reduced(
        [
          tracked,
          {
            kind: 'precipitation',
            site: 'KDVN',
            position,
            scanTime: tracked.scanTime,
            rainFraction: 0.8,
          },
        ],
        false,
      ),
      TIME,
    ),
  });
  assert.deepEqual(card.counts, {
    tracked: 1,
    precipitation: 1,
    quiet: 0,
    unfit: 0,
    'no-scan': 0,
  });
  const text = Object.fromEntries(card.lines.map(({ id, text }) => [id, text]));
  assert.equal(
    text.arrows,
    'Arrows: ground track of dual-pol-filtered biological echo 45–735 m up, one hour of travel. Not bird heading. Birds and insects are not separated.',
  );
  assert.equal(
    text.pattern,
    'Pattern: all low-altitude echo, 5–35 dBZ. Light rain is not removed from the wash.',
  );
  assert.equal(text.partial, 'Partial: newer scans still arriving');
  assert.equal(
    card.attribution,
    'NWS radar · reflectivity tiles via Iowa State IEM · not endorsed by NOAA',
  );
});

test('a reduced result replaces pending, and pending or unavailable never replaces reduced', () => {
  const first = parseMotion(reduced([tracked], false), TIME);
  const pending = { kind: 'pending' };
  const unavailable = { kind: 'unavailable', reason: 'down' };
  assert.equal(mergeMotion(pending, first), first);
  assert.equal(mergeMotion(first, pending), first);
  assert.equal(mergeMotion(first, unavailable), first);
  assert.equal(mergeMotion(undefined, pending), pending);
  const second = parseMotion(reduced([tracked], true), TIME);
  assert.equal(mergeMotion(first, second), second);
});

test('the wash keeps only 5 to 35 dBZ from IEM N0Q pixels', () => {
  assert.equal(
    compositeTileTemplate(TIME),
    'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-202610110330/{z}/{x}/{y}.png',
  );
  assert.throws(() => compositeTileTemplate('2026-10-11T03:31:00.000Z'));
  const pixels = new Uint8ClampedArray([
    0x63,
    0x76,
    0xa8,
    255, // 5 dBZ
    0x32,
    0x73,
    0x08,
    255, // 35 dBZ
    0x5b,
    0x88,
    0x07,
    255, // 36 dBZ, heavier echo
    0x78,
    0x86,
    0xae,
    255, // 2.5 dBZ
  ]);
  recolorPattern(pixels);
  assert.deepEqual(
    [...pixels],
    [
      38, 166, 154, 64, 255, 255, 255, 179, 0x5b, 0x88, 0x07, 0, 0x78, 0x86,
      0xae, 0,
    ],
  );
});
