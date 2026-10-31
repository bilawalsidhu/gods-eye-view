import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  B1875_MS,
  MAG_LIMIT,
  buildBoundaries,
  buildConstellations,
  buildSkyData,
  buildStars,
  parseCsv,
} from '../../scripts/build-sky-data.mjs';
import { julianCenturies, precessToDate, precessionMatrix } from './skyMath.js';

const HEADER = 'id,hip,proper,mag,ci,pmra,pmdec,rarad,decrad,bf';
const csv = (rows) => `${[HEADER, ...rows].join('\n')}\n`;
const WESTERN = {
  edges_epoch: 'B1875',
  edges: [
    '001:002 M+ 00:00:00 +00:00:00 00:00:00 +02:00:00 AAA ZZZ',
    '002:003 P+ 23:00:00 +60:00:00 01:00:00 +60:00:00 AAA ZZZ',
  ],
  constellations: [
    {
      iau: 'Zzz',
      common_name: { english: 'Last', native: 'Ultima' },
      lines: [[3, 1]],
    },
    {
      iau: 'Aaa',
      common_name: { english: 'First', native: 'Prima' },
      lines: [['thin', 1, 2], [2]],
    },
  ],
};
const ROWS = [
  '0,,Sol,-26.7,0.656,0,0,0,0,""',
  '1,1,"Star, One",1.5,0.5,10.25,-3.33,0.1,0.2,"1Alp Aaa"',
  '2,2,,6.4,,0,0,6.2,-1.5,""',
  '3,3,,7.9,1.1,0,0,3.0,0.5,""', // fainter than the limit but on a line
  '4,4,,8.0,1.2,0,0,4.0,0.6,""', // fainter and unused: dropped
  '5,,,0.5,0.1,0,0,1.0,0.1,""', // no HIP id
];

test('CSV parser handles quotes, doubled quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\r\n1,,3\n'), [
    ['a', 'b,c', 'd"e'],
    ['1', '', '3'],
  ]);
});

test('constellations: sorted by IAU, style markers and one-star chains dropped', () => {
  const out = buildConstellations(WESTERN);
  assert.deepEqual(
    out.map((c) => c.iau),
    ['Aaa', 'Zzz'],
  );
  assert.deepEqual(out[0].lines, [[1, 2]]);
  assert.equal(out[0].native, 'Prima');
  assert.throws(() => buildConstellations({}), /no constellations/);
});

test('stars: mag <= 6.5 plus line stars, Sol dropped, sorted by magnitude', () => {
  const out = buildStars(parseCsv(csv(ROWS)), new Set([1, 2, 3]), MAG_LIMIT);
  assert.deepEqual(out.hip, [0, 1, 2, 3]);
  assert.deepEqual(out.mag, [0.5, 1.5, 6.4, 7.9]);
  assert.deepEqual(out.names, [[1, 'Star, One']]);
  assert.deepEqual(out.bf, [[1, '1Alp Aaa']]);
  assert.equal(out.bv[2], null);
  assert.equal(out.pmRa[1], 10.3); // 1 decimal
  assert.ok(Math.abs(out.ra[1] - 5.7296) < 1e-9); // 0.1 rad, 4 decimals
  assert.throws(
    () => buildStars(parseCsv(csv(ROWS)), new Set([1, 99])),
    /no row for line HIP ids: 99/,
  );
});

test('buildSkyData is deterministic and records checksums', () => {
  const hyg = gzipSync(Buffer.from(csv(ROWS)));
  const western = Buffer.from(JSON.stringify(WESTERN));
  const a = buildSkyData(hyg, western);
  const b = buildSkyData(hyg, western);
  assert.deepEqual(a, b);
  const manifest = JSON.parse(a['manifest.json']);
  assert.equal(manifest.counts.stars, 4);
  assert.equal(manifest.counts.lineStars, 3);
  assert.equal(manifest.counts.lineSegments, 2);
  assert.match(manifest.outputs['stars.json'].sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.inputs.hyg.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.counts.boundaryEdges, 2);
  const boundaries = JSON.parse(a['boundaries.json']);
  assert.equal(boundaries.format, 'gev-sky-boundaries/1');
  assert.equal(boundaries.edges.length, 2);
});

test('boundaries: B1875 edges densified to <= 1 deg and precessed to J2000 (inverse round trip, size of the shift)', () => {
  const edges = buildBoundaries(
    WESTERN,
    precessionMatrix,
    julianCenturies(B1875_MS),
  );
  assert.deepEqual(
    edges.map((e) => [e.a, e.b]),
    [
      ['AAA', 'ZZZ'],
      ['AAA', 'ZZZ'],
    ],
  );
  // meridian 0h, Dec 0..+2 -> 3 points (2 steps of 1 deg)
  const meridian = edges[0].points;
  assert.equal(meridian.length, 6);
  // precessing back to B1875 lands on the input (2 dp rounding)
  for (let i = 0; i < meridian.length; i += 2) {
    const back = precessToDate(meridian[i], meridian[i + 1], B1875_MS);
    const ra = back.raDeg > 180 ? back.raDeg - 360 : back.raDeg;
    assert.ok(Math.abs(ra - 0) < 0.012, `ra ${ra}`);
    assert.ok(Math.abs(back.decDeg - i / 2) < 0.012, `dec ${back.decDeg}`);
  }
  // 125 years of general precession moves RA 0h/Dec 0 by ~ +1.60 deg
  // (m = 3.075 s/yr * 125 yr = 384 s of time) and Dec by n*125 = +0.70 deg.
  assert.ok(Math.abs(meridian[0] - 1.6) < 0.03, `ra shift ${meridian[0]}`);
  assert.ok(Math.abs(meridian[1] - 0.7) < 0.03, `dec shift ${meridian[1]}`);
  // a parallel at +60 spanning 23:00 -> 01:00 (30 deg of RA, 15 deg of arc)
  // takes the short way through 0h and has 16 points
  const parallel = edges[1].points;
  assert.equal(parallel.length, 32);
  for (let i = 0; i < parallel.length; i += 2) {
    const ra = parallel[i];
    assert.ok(ra > 340 || ra < 20, `parallel ra ${ra}`);
  }
  assert.throws(
    () => buildBoundaries({ edges: ['nonsense'] }, precessionMatrix, -1.25),
    /bad boundary edge/,
  );
  assert.throws(() => buildBoundaries({}, precessionMatrix, -1.25), /no edges/);
});
