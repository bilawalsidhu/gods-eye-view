import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSearchIndex,
  lookAtView,
  matchScore,
  resolveTarget,
  satelliteSearchProvider,
  searchSky,
} from './skySearch.js';
import { makeView } from './skyMath.js';
import { parseSkyData } from './starData.js';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url)));
const data = parseSkyData(read('stars.json'), read('constellations.json'));
const index = buildSearchIndex(data);
const SATS = [
  { id: 25544, name: 'ISS (ZARYA)' },
  { id: 48274, name: 'CSS (TIANHE)' },
];
const satellites = (q) => SATS.filter((s) => s.name.toLowerCase().includes(q));

test('match scores: exact < prefix < word prefix < substring, accents folded', () => {
  assert.equal(matchScore('Orion', 'orion'), 0);
  assert.equal(matchScore('Orion', 'ori'), 1);
  assert.equal(matchScore('ISS (ZARYA)', 'zarya'), 2);
  assert.equal(matchScore('Betelgeuse', 'geuse'), 3);
  assert.equal(matchScore('Achernar', 'xyz'), null);
  assert.equal(matchScore('Ursa Major', ''), null);
  assert.equal(matchScore('Bootes', 'boötes'), 0);
});

test('search finds a constellation, a planet, a bright star and a satellite', () => {
  const top = (q) => searchSky(q, index, { satellites })[0];
  assert.deepEqual(
    [top('Orion').kind, top('Orion').target.iau],
    ['constellation', 'Ori'],
  );
  assert.equal(top('ori').target.iau, 'Ori'); // IAU abbreviation too
  const english = data.constellations.find((c) => c.iau === 'Ori').name;
  assert.ok(english);
  assert.equal(top(english).target.iau, 'Ori'); // English name too
  assert.deepEqual(
    [top('Jupiter').kind, top('jup').label],
    ['body', 'Jupiter'],
  );
  assert.deepEqual([top('Vega').kind, top('Vega').label], ['star', 'Vega']);
  assert.deepEqual(
    [top('ISS').kind, top('ISS').target.id],
    ['satellite', 25544],
  );
  assert.equal(top('Moon').label, 'Moon');
  assert.equal(searchSky('', index).length, 0);
  assert.equal(searchSky('zzzzzz', index).length, 0);
  assert.ok(searchSky('a', index).length <= 8);
  // without a satellite provider there are no satellite results
  assert.equal(
    searchSky('ISS', index).some((r) => r.kind === 'satellite'),
    false,
  );
});

test('targets resolve from the same sources the overlay draws', () => {
  const field = { pos: { e: [0, 1], n: [1, 0], u: [0, 0] } };
  assert.deepEqual(resolveTarget({ type: 'star', index: 1 }, { field }), {
    azDeg: 90,
    elDeg: 0,
  });
  const positioned = {
    centroids: { e: [0], n: [Math.SQRT1_2], u: [Math.SQRT1_2] },
  };
  const c = resolveTarget({ type: 'constellation', index: 0 }, { positioned });
  assert.ok(Math.abs(c.elDeg - 45) < 1e-9 && c.azDeg === 0);
  const ephemeris = {
    sun: { azDeg: 1, elDeg: 2 },
    moon: { azDeg: 3, elDeg: 4 },
    planets: [{ name: 'Mars', azDeg: 5, elDeg: 6 }],
  };
  assert.deepEqual(
    resolveTarget({ type: 'body', name: 'Mars' }, { ephemeris }),
    {
      azDeg: 5,
      elDeg: 6,
    },
  );
  assert.deepEqual(
    resolveTarget({ type: 'body', name: 'Moon' }, { ephemeris }),
    {
      azDeg: 3,
      elDeg: 4,
    },
  );
  assert.deepEqual(
    resolveTarget(
      { type: 'satellite', id: 7 },
      { satellite: (id) => (id === 7 ? { azDeg: 10, elDeg: 20 } : null) },
    ),
    { azDeg: 10, elDeg: 20 },
  );
  assert.equal(
    resolveTarget({ type: 'satellite', id: 8 }, { satellite: () => null }),
    null,
  );
  assert.equal(resolveTarget({ type: 'star', index: 0 }, {}), null);
  assert.equal(resolveTarget(null), null);
});

test('look-at animation: eased, short way round, lands exactly on the target', () => {
  const from = makeView({ azDeg: 350, elDeg: 10, fovDeg: 60 });
  const to = { azDeg: 20, elDeg: 40 };
  assert.deepEqual(lookAtView(from, to, 0), from);
  const end = lookAtView(from, to, 1);
  assert.equal(end.azDeg, 20);
  assert.equal(end.elDeg, 40);
  assert.equal(end.fovDeg, 60);
  const mid = lookAtView(from, to, 0.5);
  assert.ok(Math.abs(mid.azDeg - 5) < 1e-9, `through north: ${mid.azDeg}`);
  assert.ok(Math.abs(mid.elDeg - 25) < 1e-9);
  // below the horizon: view clamps at -10 instead of flipping
  assert.equal(lookAtView(from, { azDeg: 0, elDeg: -40 }, 1).elDeg, -10);
});

/** Same shape as satSky.createSatSky's api (meta, status, lookup). */
class FakeSatSky {
  constructor() {
    this.meta = [
      { name: 'ISS (ZARYA)', noradId: 25544 },
      { name: 'CSS (TIANHE)', noradId: 48274 },
      { name: 'ISS (NAUKA)', noradId: 49044 },
      { name: 'STARLINK-1007', noradId: 44713 },
    ];
    this.rows = new Map([[0, { azDeg: 210.5, elDeg: 42.25 }]]);
    this.status = 'ready';
    this.lookups = 0;
  }
  lookup(index) {
    this.lookups += 1;
    const m = this.meta[index];
    return m ? { meta: m, row: this.rows.get(index) ?? null } : null;
  }
}

test('satellite provider over the satellite engine: names from meta, catalogue order breaks ties', () => {
  const sky = new FakeSatSky();
  const provider = satelliteSearchProvider(sky);
  assert.deepEqual(provider.search('iss'), [
    { id: 0, name: 'ISS (ZARYA)' },
    { id: 2, name: 'ISS (NAUKA)' },
  ]);
  assert.deepEqual(provider.search('ISS (ZARYA)'), [
    { id: 0, name: 'ISS (ZARYA)' },
  ]);
  assert.deepEqual(provider.search('tianhe'), [
    { id: 1, name: 'CSS (TIANHE)' },
  ]);
  assert.deepEqual(provider.search(''), []);
  // through searchSky (method called via the provider): ISS beats Meissa
  const hits = searchSky('ISS', index, {
    satellites: (q) => provider.search(q),
  });
  assert.equal(hits[0].kind, 'satellite');
  assert.equal(hits[0].label, 'ISS (ZARYA)');
  assert.ok(hits.some((h) => h.label === 'Meissa' && h.score === 3));
  // positions: the newest worker row; none below -2 deg / before a tick
  assert.deepEqual(provider.position(0), { azDeg: 210.5, elDeg: 42.25 });
  assert.equal(provider.position(2), null);
  assert.equal(provider.position(99), null);
  assert.ok(sky.lookups >= 3, 'lookup ran with its receiver');
  assert.equal(provider.status, 'ready');
  // a new catalogue (worker reload) is picked up
  sky.meta = [{ name: 'HUBBLE SPACE TELESCOPE', noradId: 20580 }];
  assert.deepEqual(provider.search('hubble'), [
    { id: 0, name: 'HUBBLE SPACE TELESCOPE' },
  ]);
  // positionOf overrides (the drawn, extrapolated az/el)
  const drawn = satelliteSearchProvider(sky, {
    positionOf: (id) => (id === 0 ? { azDeg: 1, elDeg: 2 } : null),
  });
  assert.deepEqual(drawn.position(0), { azDeg: 1, elDeg: 2 });
  // no engine at all
  const none = satelliteSearchProvider(null);
  assert.deepEqual(none.search('iss'), []);
  assert.equal(none.position(0), null);
  assert.equal(none.status, 'unavailable');
});
