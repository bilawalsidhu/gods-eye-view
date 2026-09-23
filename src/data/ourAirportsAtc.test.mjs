// src/data/ourAirportsAtc.test.mjs
// Gates on the bundled OurAirports ATC frequency pack and its lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
  ADVISORY_CLASSES,
  CLASS_LABELS,
  CONTROLLED_CLASSES,
  airportByIdent,
  frequenciesByClass,
  isControlled,
  loadAtcFrequencies,
  nearestAirportsWithFrequencies,
} from './ourAirportsAtc.js';

const PACK = new URL(
  './local_data/ourairports_atc/frequencies.json',
  import.meta.url,
);
const BUDGET_BYTES = 1024 * 1024;

test('pack byte-size budget: frequencies.json <= 1 MB', () => {
  // The whole point of curating this pack rather than bundling the 14 MB of raw
  // OurAirports CSV. A rebuild is expected to move this number (the upstream is
  // a live database) — it is not expected to move it past the budget. If it
  // does, tighten the curation in scripts/build-atc-frequencies.mjs; do not
  // raise the number here without saying why in the pack README.
  const bytes = statSync(PACK).size;
  assert.ok(
    bytes <= BUDGET_BYTES,
    `pack is ${bytes} bytes, over the ${BUDGET_BYTES} byte budget`,
  );
});

test('the pack records its own provenance, including that it has no commit', () => {
  // OurAirports is community-edited and has no version to pin, so the fetch
  // timestamp and the row counts ARE the provenance. A pack that cannot say
  // when it was taken cannot be audited later.
  const pack = JSON.parse(readFileSync(PACK, 'utf8'));
  assert.match(pack.meta.fetched, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(
    pack.meta.commit,
    null,
    'a live database must not claim a pinned commit',
  );
  assert.match(pack.meta.license, /[Pp]ublic domain/);
  assert.ok(
    pack.meta.coverage.sourceFrequencyRows > pack.meta.coverage.frequencies,
  );
});

test('every frequency is inside the VHF air band and carries a known class', async () => {
  // Rows outside 108–137 MHz in the source are HF, UHF military, prose ranges
  // and blanks; shipping one would render as a plausible-looking number a
  // listener could never tune.
  const { airports } = await loadAtcFrequencies();
  assert.ok(airports.length > 5_000, 'pack looks truncated');
  const known = new Set([...CONTROLLED_CLASSES, ...ADVISORY_CLASSES]);
  for (const airport of airports) {
    assert.ok(
      airport.frequencies.length > 0,
      `${airport.ident} has no frequencies`,
    );
    assert.ok(Number.isFinite(airport.lat) && Number.isFinite(airport.lon));
    for (const { type, mhz, label } of airport.frequencies) {
      assert.ok(known.has(type), `${airport.ident}: unknown class ${type}`);
      assert.equal(label, CLASS_LABELS[type]);
      assert.ok(
        mhz >= 108 && mhz <= 137,
        `${airport.ident}: ${mhz} MHz is out of band`,
      );
    }
  }
});

test('most of the pack has no controller, and the loader says so', async () => {
  // The rule the UI has to respect: "uncontrolled field — CTAF" is the MAJORITY
  // answer, not an edge case. A build that silently drops the advisory classes
  // would leave the feature able only to describe airports that have a tower.
  const { airports, meta } = await loadAtcFrequencies();
  const advisoryOnly = airports.filter(
    (a) =>
      !a.frequencies.some((f) =>
        ['TWR', 'GND', 'APP', 'ATIS'].includes(f.type),
      ),
  );
  assert.ok(
    advisoryOnly.length > airports.length / 2,
    'the pack should still be majority no-tower; if not, check the curation',
  );
  assert.equal(
    meta.coverage.advisoryOnly + meta.coverage.centerOnlyNoTower,
    advisoryOnly.length,
  );
  // ...and at least one of them must actually answer false, or isControlled()
  // is not doing the work the UI depends on.
  const uncontrolled = advisoryOnly.find(
    (a) => !a.frequencies.some((f) => f.type === 'CNTR'),
  );
  assert.equal(isControlled(uncontrolled), false);
});

test('a tower airport groups by class and reads as controlled', async () => {
  const austin = await airportByIdent('kaus');
  assert.ok(austin, 'KAUS must be in the pack');
  assert.equal(isControlled(austin), true);
  const byClass = frequenciesByClass(austin);
  assert.ok(byClass.TWR?.length, 'KAUS must publish a tower frequency');
  // Absent means absent — a class the airport does not publish must not appear
  // as an empty array a caller could render as a blank row.
  for (const [type, entries] of Object.entries(byClass)) {
    assert.ok(entries.length > 0, `${type} present but empty`);
  }
});

test('nearest lookup is ordered, bounded by maxKm, and can demand a controller', async () => {
  const AUSTIN = [30.1975, -97.662];
  // Limit high enough that the radius, not the limit, is what cuts the list —
  // otherwise "maxKm is honoured" is proved by the sort and not by the filter.
  const near = await nearestAirportsWithFrequencies(...AUSTIN, {
    limit: 50,
    maxKm: 60,
  });
  assert.ok(near.length > 0);
  assert.equal(
    near[0].ident,
    'KAUS',
    'the field you are standing on comes first',
  );
  assert.equal(near[0].distanceKm < 1, true);
  for (let i = 1; i < near.length; i += 1) {
    assert.ok(
      near[i].distanceKm >= near[i - 1].distanceKm,
      'results must be nearest-first',
    );
    assert.ok(near[i].distanceKm <= 60, 'maxKm must be honoured');
  }
  // The lat/lon pre-filter is a RECTANGLE, so its corners reach ~1.4 × maxKm.
  // XS12 (63.4 km) and KBAZ (65.9 km) sit inside that box and outside the
  // circle: if the great-circle check after it is dropped they come back, and
  // "airports within 60 km" quietly becomes "airports within 60-85 km,
  // depending on bearing".
  const idents = new Set(near.map((a) => a.ident));
  for (const outside of ['XS12', 'KBAZ']) {
    assert.equal(
      idents.has(outside),
      false,
      `${outside} is in the box but out of range`,
    );
  }
  const controlled = await nearestAirportsWithFrequencies(...AUSTIN, {
    limit: 10,
    maxKm: 120,
    controlledOnly: true,
  });
  assert.ok(controlled.every(isControlled), 'controlledOnly must filter');
  assert.ok(controlled.length < near.length + 10);
});

test('the longitude window wraps the antimeridian instead of rejecting across it', async () => {
  // Anadyr (UHMA, 177.741°E) and Provideniya (UHMD, 173.243°W) are the closest
  // cross-antimeridian pair in the pack — 432 km apart, 9.0° apart the short
  // way round and 351.0° apart the long way. At this latitude a 500 km search
  // opens a ±10.6° longitude window, so the short way is inside it and the long
  // way is not: a plain `Math.abs(a.lon - lon)` rejects Provideniya outright
  // and reports no airport across the strait.
  const hits = await nearestAirportsWithFrequencies(64.7349, 177.741, {
    maxKm: 500,
    limit: 20,
  });
  const provideniya = hits.find((a) => a.ident === 'UHMD');
  assert.ok(
    provideniya,
    'an airport west of the antimeridian must be reachable from east of it',
  );
  assert.ok(
    Math.round(provideniya.distanceKm) === 432,
    'and at its real distance',
  );
});

test('a nonsense position returns nothing rather than throwing', async () => {
  for (const [lat, lon] of [
    [Number.NaN, 0],
    [0, undefined],
    ['30', '-97'],
  ]) {
    assert.deepEqual(await nearestAirportsWithFrequencies(lat, lon), []);
  }
  assert.equal(await airportByIdent('  '), null);
  assert.equal(await airportByIdent('ZZZZ9'), null);
});
