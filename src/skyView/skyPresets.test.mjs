import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { twoline2satrec } from 'satellite.js';
import { lookAnglesAt } from '../data/satellitePass.js';
import { parseTleText } from '../sources/tle.js';
import { bodyPosition } from './ephemeris.js';
import {
  ISS_MIN_ELEV_DEG,
  ISS_NORAD,
  PRESETS,
  astronomicalPreset,
  createIssPassFinder,
  presetTime,
} from './skyPresets.js';

const SITES = {
  Houston: { latDeg: 29.7604, lonDeg: -95.3698, groundHeightM: 15 },
  Sydney: { latDeg: -33.8688, lonDeg: 151.2093, groundHeightM: 50 },
  Reykjavik: { latDeg: 64.1466, lonDeg: -21.9426, groundHeightM: 30 },
};
const FROMS = [
  '2026-10-12T03:30:00Z',
  '2027-06-21T12:00:00Z',
  '2031-01-05T00:00:00Z',
].map(Date.parse);
const H = 3600_000;
const sun = (ms, site, refraction) =>
  bodyPosition(
    'Sun',
    ms,
    { latDeg: site.latDeg, lonDeg: site.lonDeg, heightM: site.groundHeightM },
    { refraction },
  );

test('preset list: Sunset, Twilight end, Midnight, Moonrise, ISS pass', () => {
  assert.deepEqual(
    PRESETS.map((p) => p.id),
    ['sunset', 'dusk', 'midnight', 'moonrise', 'iss'],
  );
  for (const p of PRESETS) assert.ok(p.label && p.title);
});

test('ACCEPT: Sunset puts the Sun at altitude 0 +/- 0.3 deg (apparent, refraction-aware) at 3 sites x 3 dates; descending; next one', () => {
  for (const [name, site] of Object.entries(SITES))
    for (const from of FROMS) {
      const r = astronomicalPreset('sunset', from, site);
      assert.equal(r.ok, true, `${name} ${from}`);
      assert.ok(
        r.timeMs > from && r.timeMs - from <= 26 * H,
        'the next sunset',
      );
      const app = sun(r.timeMs, site, true).elDeg;
      assert.ok(
        Math.abs(app) <= 0.3,
        `${name}: apparent Sun ${app.toFixed(3)}`,
      );
      assert.ok(sun(r.timeMs + 600_000, site, true).elDeg < app, 'setting');
      // pressing again from the sunset walks to the next day's sunset
      const again = astronomicalPreset('sunset', r.timeMs, site);
      assert.ok(
        again.timeMs - r.timeMs > 23 * H && again.timeMs - r.timeMs < 25 * H,
      );
    }
});

test('Twilight end: Sun centre at -18 deg (airless, by convention), descending', () => {
  for (const site of Object.values(SITES)) {
    const r = astronomicalPreset('dusk', FROMS[0], site);
    assert.equal(r.ok, true);
    const el = sun(r.timeMs, site, false).elDeg;
    assert.ok(Math.abs(el + 18) < 0.02, el);
    assert.ok(sun(r.timeMs + 600_000, site, false).elDeg < el);
  }
});

test('Midnight: solar midnight is the Sun lowest point (lower than 20 min either side)', () => {
  for (const site of Object.values(SITES)) {
    const r = astronomicalPreset('midnight', FROMS[0], site);
    assert.equal(r.ok, true);
    const el = sun(r.timeMs, site, false).elDeg;
    assert.ok(el < sun(r.timeMs - 1_200_000, site, false).elDeg);
    assert.ok(el < sun(r.timeMs + 1_200_000, site, false).elDeg);
    assert.ok(el < 0, 'Sun below the horizon at midnight here');
  }
});

test('Moonrise: the Moon centre is within a Moon radius of the apparent horizon, rising', () => {
  for (const site of Object.values(SITES)) {
    const r = astronomicalPreset('moonrise', FROMS[0], site);
    assert.equal(r.ok, true);
    const at = (ms) =>
      bodyPosition(
        'Moon',
        ms,
        {
          latDeg: site.latDeg,
          lonDeg: site.lonDeg,
          heightM: site.groundHeightM,
        },
        { refraction: true },
      ).elDeg;
    const el = at(r.timeMs);
    assert.ok(el > -0.6 && el < 0.1, `apparent Moon centre ${el}`);
    assert.ok(at(r.timeMs + 600_000) > el, 'rising');
  }
});

test('empty states: no sunset in polar night, no astronomical dusk in a white night, no observer', () => {
  const polar = { latDeg: 78.2, lonDeg: 15.6 };
  const r = astronomicalPreset(
    'sunset',
    Date.parse('2026-12-20T00:00:00Z'),
    polar,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not set/);
  const white = astronomicalPreset(
    'dusk',
    Date.parse('2026-06-21T00:00:00Z'),
    SITES.Reykjavik,
  );
  assert.equal(white.ok, false);
  assert.match(white.reason, /-18/);
  assert.match(
    astronomicalPreset('sunset', FROMS[0], null).reason,
    /where you stand/,
  );
  assert.match(
    astronomicalPreset('bogus', FROMS[0], SITES.Houston).reason,
    /Unknown/,
  );
});

const FIXTURE = readFileSync(
  new URL('./reference/satFixture200.tle', import.meta.url),
  'utf8',
);
const issLines = parseTleText(FIXTURE).find(
  (r) => Number(r.line1.slice(2, 7)) === ISS_NORAD,
);
const issRec = twoline2satrec(issLines.line1, issLines.line2);
const fixtureEpoch = (() => {
  const jd = issRec.jdsatepoch + (issRec.jdsatepochF || 0);
  return (jd - 2440587.5) * 86_400_000;
})();

test('Next ISS pass: rise at 10 deg elevation from the stations elements; pressing again walks to the following pass', async () => {
  const fetched = [];
  const finder = createIssPassFinder({
    fetchText: async (path) => {
      fetched.push(path);
      return FIXTURE;
    },
  });
  const site = SITES.Houston;
  const r = await presetTime('iss', fixtureEpoch, site, {
    nextIssPass: finder,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(fetched, ['stations']);
  assert.ok(r.timeMs > fixtureEpoch && r.timeMs - fixtureEpoch < 48 * H);
  const el = lookAnglesAt(issRec, r.timeMs, site.latDeg, site.lonDeg).elevDeg;
  assert.ok(Math.abs(el - ISS_MIN_ELEV_DEG) < 0.3, `ISS at rise ${el}`);
  const next = await presetTime('iss', r.timeMs, site, { nextIssPass: finder });
  assert.equal(next.ok, true);
  assert.ok(next.timeMs > r.pass.setMs, 'the pass after this one');
});

test('ISS empty/error states: no elements, fetch failure, no finder', async () => {
  const none = createIssPassFinder({ fetchText: async () => '' });
  assert.match(
    (await none(fixtureEpoch, SITES.Houston)).reason,
    /No ISS elements/,
  );
  const broken = createIssPassFinder({
    fetchText: async () => {
      throw new Error('HTTP 503');
    },
  });
  assert.match(
    (await broken(fixtureEpoch, SITES.Houston)).reason,
    /could not be loaded/,
  );
  assert.match(
    (await presetTime('iss', fixtureEpoch, SITES.Houston)).reason,
    /not available/,
  );
  const never = createIssPassFinder({
    fetchText: async () => FIXTURE,
    findPass: () => null,
  });
  assert.match(
    (await never(fixtureEpoch, SITES.Houston)).reason,
    /No ISS pass/,
  );
});
