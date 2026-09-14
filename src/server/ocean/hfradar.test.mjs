import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HDOP_REJECT,
  HFR_DATASETS,
  HFR_DEFAULT_HDOP,
  HFR_MAX_AGE_MS,
  HFR_MIN_VECTORS,
  HFR_VARS,
  HFR_WINDOW_HOURS,
  MAX_CURRENT_MS,
  assertHfrCsv0,
  boxIntersects,
  buildHfrProbeUrl,
  buildHfrUrl,
  clampBoxToDataset,
  fetchHfrField,
  floorToHourMs,
  lonIntervals,
  parseHfrCsv0,
  parseHfrProbe,
  selectHfrDatasets,
  wrapLon,
} from './hfradar.js';

/**
 * Real headerless griddap `.csv0`, captured 2026-09-01 from
 * `coastwatch.pfeg.noaa.gov/erddap/griddap/ucsdHfrW2.csv0` — Monterey Bay,
 * water_u/water_v/hdop at the then-latest hour 2026-08-31T22:00Z. It is the
 * first 60 rows of a 10x10 cell request over 36.597..36.759 N,
 * -122.094..-121.906 E; because griddap emits rows in (time, lat, lon) order,
 * those 60 rows are the first 6 COMPLETE latitude rows of 10 longitudes each,
 * so the committed capture spans 36.59694..36.68684 N over the full longitude
 * range — not the full latitude span of the request. 52 finite rows, 8 `NaN`
 * gap rows, hdop 0.26..0.66. Pins the real wire format: column order, row
 * order, `NaN` spelling, ISO stamp form, decimal precision.
 */
const FIXTURE = readFileSync(
  new URL('../../data/fixtures/hfr-ucsdhfrw2-monterey.csv0', import.meta.url),
  'utf8',
);

const HOUR = 3600000;

/** Builds one `.csv0` row with the griddap column order. */
function row(time, lat, lon, u, v, hdop) {
  return [time, lat, lon, u, v, hdop].join(',');
}

/** Builds a `.csv0` body from rows. */
function csv0(...rows) {
  return `${rows.join('\n')}\n`;
}

/**
 * ISO hour stamp for an epoch — the exact form ERDDAP's `time[(last)]` probe
 * returns, and the form the ladder must be fed for a staleness test to mean
 * anything. An earlier hand-rolled version of this produced
 * `2026-08-28T22:30:00:00Z` (a stray `:00` in place of the seconds field),
 * which `parseHfrProbe` rejects outright, so the rung fell through for being
 * UNREADABLE rather than for being stale and the `maxAgeMs` gate below went
 * entirely unexercised.
 */
function isoHour(ms) {
  return new Date(Math.floor(ms / HOUR) * HOUR).toISOString().replace('.000Z', 'Z');
}

/** Builds `count` QC-clean rows at one timestamp, spread over distinct cells. */
function goodRows(time, count, startIndex = 0) {
  return Array.from({ length: count }, (_, k) => {
    const i = startIndex + k;
    return row(time, (36.5 + i * 0.02).toFixed(5), (-122.5 + i * 0.02).toFixed(5), '0.10', '0.05', '0.50');
  });
}

/** A `fetch`-shaped stub resolving each URL against `routes` (substring match). */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [needle, reply] of routes) {
      if (url.includes(needle)) {
        const r = typeof reply === 'function' ? reply(url) : reply;
        if (r instanceof Error) throw r;
        return { ok: r.ok !== false, status: r.status ?? 200, text: async () => r.body };
      }
    }
    return { ok: false, status: 404, text: async () => 'Error {\n  code=404;\n}' };
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------- URL building

test('buildHfrUrl percent-encodes brackets and lays out griddap dimensions', () => {
  const url = buildHfrUrl(
    'ucsdHfrW2',
    ['water_u', 'water_v', 'hdop'],
    '2026-08-31T16:00:00Z',
    '2026-08-31T22:00:00Z',
    { latMin: 36.6, latMax: 36.75, lonMin: -122.1, lonMax: -121.9 },
  );
  assert.equal(
    url,
    'https://coastwatch.pfeg.noaa.gov/erddap/griddap/ucsdHfrW2.csv0'
    + '?water_u%5B(2026-08-31T16:00:00Z):1:(2026-08-31T22:00:00Z)%5D%5B(36.6):1:(36.75)%5D%5B(-122.1):1:(-121.9)%5D'
    + ',water_v%5B(2026-08-31T16:00:00Z):1:(2026-08-31T22:00:00Z)%5D%5B(36.6):1:(36.75)%5D%5B(-122.1):1:(-121.9)%5D'
    + ',hdop%5B(2026-08-31T16:00:00Z):1:(2026-08-31T22:00:00Z)%5D%5B(36.6):1:(36.75)%5D%5B(-122.1):1:(-121.9)%5D',
  );
  assert.ok(!url.includes('['), 'no raw [ may survive encoding');
  assert.ok(!url.includes(']'), 'no raw ] may survive encoding');
});

test('buildHfrUrl applies stride to space but never to time', () => {
  const url = buildHfrUrl(
    'ucsdHfrE6',
    ['water_u'],
    '2026-08-31T17:00:00Z',
    '2026-08-31T23:00:00Z',
    { latMin: 28, latMax: 28.3, lonMin: -90.3, lonMax: -90 },
    4,
  );
  assert.ok(url.includes('%5B(28):4:(28.3)%5D%5B(-90.3):4:(-90)%5D'), url);
  // Hourly data decimated in time would alias the tide, so the time stride is pinned to 1.
  assert.ok(url.includes('(2026-08-31T17:00:00Z):1:(2026-08-31T23:00:00Z)'), url);
});

test('buildHfrUrl accepts epoch ms and renders second-precision ISO', () => {
  const url = buildHfrUrl(
    'ucsdHfrW2',
    ['water_u'],
    Date.parse('2026-08-31T16:00:00Z'),
    Date.parse('2026-08-31T22:00:00Z'),
    { latMin: 36, latMax: 37, lonMin: -122, lonMax: -121 },
  );
  assert.ok(url.includes('(2026-08-31T16:00:00Z):1:(2026-08-31T22:00:00Z)'), url);
  assert.ok(!url.includes('.000Z'), 'millisecond precision must be stripped');
});

test('buildHfrUrl refuses malformed input instead of emitting a bad URL', () => {
  const box = { latMin: 36, latMax: 37, lonMin: -122, lonMax: -121 };
  const t = '2026-08-31T22:00:00Z';
  assert.throws(() => buildHfrUrl('', ['water_u'], t, t, box), TypeError);
  assert.throws(() => buildHfrUrl('ucsdHfrW2', [], t, t, box), TypeError);
  assert.throws(() => buildHfrUrl('ucsdHfrW2', ['water_u'], t, t, box, 0), TypeError);
  assert.throws(() => buildHfrUrl('ucsdHfrW2', ['water_u'], t, t, box, 1.5), TypeError);
  assert.throws(() => buildHfrUrl('ucsdHfrW2', ['water_u'], t, t, { ...box, latMin: NaN }), TypeError);
  // Descending edges would 404 at ERDDAP; fail locally instead.
  assert.throws(() => buildHfrUrl('ucsdHfrW2', ['water_u'], t, t, { ...box, latMin: 40 }), TypeError);
});

test('buildHfrProbeUrl asks only for the last time index', () => {
  assert.equal(
    buildHfrProbeUrl('ucsdHfrH1'),
    'https://coastwatch.pfeg.noaa.gov/erddap/griddap/ucsdHfrH1.csv0?time%5B(last)%5D',
  );
});

// ------------------------------------------------------------------- QC gates

test('fixture: real capture parses to its known finite/NaN split', () => {
  const { observations, rejected, times } = parseHfrCsv0(FIXTURE);
  // 60 captured rows: 52 finite, 8 NaN-filled gap cells.
  assert.equal(observations.length + rejected, 60);
  assert.equal(observations.length, 52);
  assert.equal(rejected, 8);
  assert.deepEqual(times, ['2026-08-31T22:00:00Z']);

  const first = observations[0];
  assert.deepEqual(
    { lat: first.lat, lon: first.lon, u: first.u, v: first.v, hdop: first.hdop },
    { lat: 36.59694, lon: -122.09374, u: 0.1, v: 0.1, hdop: 0.64 },
  );
  assert.equal(first.time, '2026-08-31T22:00:00Z');
  assert.equal(first.timeMs, Date.parse('2026-08-31T22:00:00Z'));
  assert.equal(first.quality, 1 / 1.64);
  // Every surviving vector must satisfy both gates.
  for (const o of observations) {
    assert.ok(Math.abs(o.u) <= MAX_CURRENT_MS && Math.abs(o.v) <= MAX_CURRENT_MS);
    assert.ok(o.hdop <= HDOP_REJECT);
    assert.ok(o.quality > 0 && o.quality <= 1);
  }
});

test('QC drops non-finite lat/lon and unparseable timestamps', () => {
  const t = '2026-08-31T22:00:00Z';
  const { observations, rejected } = parseHfrCsv0(csv0(
    row(t, '36.6', '-122.0', '0.1', '0.1', '0.5'),
    row(t, 'NaN', '-122.0', '0.1', '0.1', '0.5'),
    row(t, '36.6', 'NaN', '0.1', '0.1', '0.5'),
    row('not-a-time', '36.6', '-122.0', '0.1', '0.1', '0.5'),
  ));
  assert.equal(observations.length, 1);
  assert.equal(rejected, 3);
  assert.equal(observations[0].lat, 36.6);
});

test('QC drops NaN u/v — the sparse-coverage fill — and keeps finite neighbours', () => {
  const t = '2026-08-31T22:00:00Z';
  const { observations, rejected } = parseHfrCsv0(csv0(
    row(t, '36.6', '-122.0', 'NaN', 'NaN', 'NaN'),
    row(t, '36.6', '-121.9', '0.08', 'NaN', '0.5'),
    row(t, '36.6', '-121.8', 'NaN', '0.08', '0.5'),
    row(t, '36.6', '-121.7', '0.08', '0.15', '0.48'),
  ));
  assert.equal(rejected, 3);
  assert.deepEqual(observations.map((o) => o.lon), [-121.7]);
});

test('QC speed gate rejects strictly above MAX_CURRENT_MS on either component', () => {
  const t = '2026-08-31T22:00:00Z';
  const { observations, rejected } = parseHfrCsv0(csv0(
    row(t, '36.6', '-122.0', String(MAX_CURRENT_MS), '0.1', '0.5'), // at bound: kept
    row(t, '36.6', '-121.9', String(-MAX_CURRENT_MS), '0.1', '0.5'), // negative at bound: kept
    row(t, '36.6', '-121.8', '2.41', '0.1', '0.5'), // u over: dropped
    row(t, '36.6', '-121.7', '0.1', '-2.41', '0.5'), // v over (signed): dropped
    row(t, '36.6', '-121.6', '99', '99', '0.5'), // unwrapping artifact: dropped
  ));
  assert.equal(rejected, 3);
  assert.deepEqual(observations.map((o) => o.lon), [-122.0, -121.9]);
});

test('QC hdop gate rejects strictly above HDOP_REJECT', () => {
  const t = '2026-08-31T22:00:00Z';
  const { observations, rejected } = parseHfrCsv0(csv0(
    row(t, '36.6', '-122.0', '0.1', '0.1', String(HDOP_REJECT)), // at bound: kept
    row(t, '36.6', '-121.9', '0.1', '0.1', '1.61'), // just over: dropped
    row(t, '36.6', '-121.8', '0.1', '0.1', '12.0'), // outside the site fence: dropped
  ));
  assert.equal(rejected, 2);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].hdop, HDOP_REJECT);
  assert.equal(observations[0].quality, 1 / (1 + HDOP_REJECT));
});

test('absent or NaN hdop is kept and scored with the 0.4 default, not treated as perfect', () => {
  const t = '2026-08-31T22:00:00Z';
  // hdop column present but NaN.
  const withNaN = parseHfrCsv0(csv0(row(t, '36.6', '-122.0', '0.1', '0.1', 'NaN')));
  assert.equal(withNaN.rejected, 0);
  assert.equal(withNaN.observations[0].hdop, 0.4);
  assert.equal(withNaN.observations[0].quality, 1 / 1.4);

  // hdop column not requested at all (5-column body).
  const withoutColumn = parseHfrCsv0(csv0([t, '36.6', '-122.0', '0.1', '0.1'].join(',')), { hasHdop: false });
  assert.equal(withoutColumn.rejected, 0);
  assert.equal(withoutColumn.observations[0].hdop, 0.4);
  assert.ok(withoutColumn.observations[0].quality < 1, 'a missing DOP must not imply perfect geometry');
});

test('a NEGATIVE hdop is treated as absent, never as certainty', () => {
  const t = '2026-08-31T22:00:00Z';
  // hdop is |(dopx, dopy)|, so a negative value is an undeclared fill or a
  // corrupt column, not a measurement. Read literally it inverts the weight:
  // -327.67 (a plausible leaked _FillValue) gives quality = -0.00306, and -1
  // gives exactly +Infinity. barnes.js documents that one infinite weight makes
  // Sum w infinite and takes EVERY analysed cell to NaN, so this module must
  // not emit one.
  const { observations, rejected } = parseHfrCsv0(csv0(
    row(t, '36.6', '-122.0', '0.1', '0.1', '-327.67'),
    row(t, '36.7', '-122.0', '0.1', '0.1', '-1'), // the divide-by-zero case
    row(t, '36.8', '-122.0', '0.1', '0.1', '0'), // zero IS a legal DOP: kept as measured
  ));
  assert.equal(rejected, 0, 'u and v are good, so the vectors are still usable');
  assert.deepEqual(observations.map((o) => o.hdop), [HFR_DEFAULT_HDOP, HFR_DEFAULT_HDOP, 0]);
  for (const o of observations) {
    assert.ok(Number.isFinite(o.quality), `quality must be finite, got ${o.quality}`);
    assert.ok(o.quality > 0 && o.quality <= 1, `quality must lie in (0,1], got ${o.quality}`);
  }
});

test('timestamps are read as UTC whatever the process timezone', () => {
  // ERDDAP time axes are `seconds since 1970-01-01T00:00:00Z`, but the ES Date
  // Time String Format reads a date-TIME with no offset as LOCAL time, so bare
  // Date.parse would put this row 7 h out under this zone — and every freshness
  // decision in the module with it.
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.notEqual(new Date('2026-08-31T22:00:00Z').getTimezoneOffset(), 0,
      'this test is vacuous unless the process is genuinely off UTC');

    const expected = Date.parse('2026-08-31T22:00:00Z');
    const noZone = parseHfrCsv0(csv0(row('2026-08-31T22:00:00', '36.6', '-122.0', '0.1', '0.1', '0.5')));
    assert.equal(noZone.observations[0].timeMs, expected);
    assert.equal(noZone.observations[0].time, '2026-08-31T22:00:00Z');
    assert.equal(parseHfrProbe('2026-08-31T22:00:00\n'), expected);
    // The explicit forms must agree with it, and an offset form must be honoured.
    assert.equal(parseHfrProbe('2026-08-31T22:00:00Z\n'), expected);
    assert.equal(parseHfrProbe('2026-08-31T18:00:00-04:00\n'), expected);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('a sub-second stamp keeps `time` and `timeMs` describing the same instant', () => {
  // Truncating `.500Z` to `Z` would silently move the observation half a second
  // and, worse, make the row advertise one hour while bucketing into another.
  const { observations } = parseHfrCsv0(csv0(
    row('2026-08-31T22:00:00.500Z', '36.6', '-122.0', '0.1', '0.1', '0.5'),
    row('2026-08-31T22:00:00.000Z', '36.7', '-122.0', '0.1', '0.1', '0.5'),
  ));
  for (const o of observations) {
    assert.equal(Date.parse(o.time), o.timeMs, `${o.time} must round-trip to its own timeMs`);
  }
  // An exactly-zero millisecond field is still dropped, which is the wire form.
  assert.equal(observations[1].time, '2026-08-31T22:00:00Z');
});

test('parseHfrCsv0 refuses gate options that would disable a gate or break quality', () => {
  const body = csv0(row('2026-08-31T22:00:00Z', '36.6', '-122.0', '0.1', '0.1', '0.5'));
  // defaultHdop = -1 would make quality = 1/(1 + -1) = +Infinity for every
  // hdop-less row — the exact value barnes.js calls globally destructive.
  assert.throws(() => parseHfrCsv0(body, { defaultHdop: -1 }), TypeError);
  assert.throws(() => parseHfrCsv0(body, { defaultHdop: NaN }), TypeError);
  assert.throws(() => parseHfrCsv0(body, { maxCurrentMs: NaN }), TypeError);
  assert.throws(() => parseHfrCsv0(body, { hdopReject: -1 }), TypeError);
  // Zero is a legitimate, if brutal, gate — not an error.
  assert.equal(parseHfrCsv0(body, { maxCurrentMs: 0 }).rejected, 1);
});

test('parseHfrCsv0 is deterministic: observations keep input row order', () => {
  const t = '2026-08-31T22:00:00Z';
  const lons = ['-121.7', '-122.3', '-121.9', '-122.1'];
  const { observations } = parseHfrCsv0(csv0(
    ...lons.map((lon, k) => row(t, (36.6 + k * 0.01).toFixed(2), lon, '0.1', '0.1', '0.5')),
  ));
  // Not sorted, not de-duplicated, not reordered — the Barnes sweep downstream
  // is order-independent only if the input order is stable across runs.
  assert.deepEqual(observations.map((o) => String(o.lon)), lons);
});

test('QC drops rows whose column count does not match the requested variables', () => {
  const t = '2026-08-31T22:00:00Z';
  const { observations, rejected } = parseHfrCsv0(csv0(
    row(t, '36.6', '-122.0', '0.1', '0.1', '0.5'),
    [t, '36.6', '-122.0', '0.1'].join(','),
    [t, '36.6', '-122.0', '0.1', '0.1', '0.5', '7'].join(','),
  ));
  assert.equal(observations.length, 1);
  assert.equal(rejected, 2);
});

test('times lists distinct hours of KEPT rows only, ascending', () => {
  const { times, observations } = parseHfrCsv0(csv0(
    row('2026-08-31T22:00:00Z', '36.6', '-122.0', '0.1', '0.1', '0.5'),
    row('2026-08-31T20:00:00Z', '36.6', '-122.0', '0.1', '0.1', '0.5'),
    row('2026-08-31T21:00:00Z', '36.6', '-122.0', '0.1', '0.1', '0.5'),
    row('2026-08-31T19:00:00Z', '36.6', '-122.0', 'NaN', 'NaN', 'NaN'), // dropped, so absent
  ));
  assert.equal(observations.length, 3);
  assert.deepEqual(times, ['2026-08-31T20:00:00Z', '2026-08-31T21:00:00Z', '2026-08-31T22:00:00Z']);
});

// ------------------------------------------------------- error-body refusal

test('an ERDDAP error envelope is refused whole, never partially parsed', () => {
  // Verbatim shape returned live by ERDDAP for an out-of-range constraint.
  const envelope = 'Error {\n'
    + '    code=404;\n'
    + '    message="Not Found: Your query produced no matching results. Query error: '
    + 'For variable=water_u axis#1=latitude Constraint=\\"[(10.0):1:(11.0)]\\": '
    + 'Start=\\"10.0\\" is less than the axis minimum=30.25 (and even 30.24101).";\n'
    + '}\n';
  assert.throws(() => parseHfrCsv0(envelope), /ERDDAP error envelope/);
  assert.throws(() => assertHfrCsv0(envelope), /ERDDAP error envelope/);
});

test('HTML, JSON and empty bodies are refused rather than yielding a partial field', () => {
  assert.throws(() => parseHfrCsv0('<!DOCTYPE html>\n<html><body>502 Bad Gateway</body></html>'), /markup/);
  assert.throws(() => parseHfrCsv0('{"table":{"rows":[]}}'), /error envelope/);
  assert.throws(() => parseHfrCsv0(''), /empty/);
  assert.throws(() => parseHfrCsv0('   \n\n'), /empty/);
  // A headered .csv (wrong extension requested) must fail loudly, not skip a row.
  assert.throws(() => parseHfrCsv0('time,latitude,longitude,water_u\nUTC,degrees_north,degrees_east,m s-1\n'), /data row/);
});

test('parseHfrProbe reads a timestamp and rejects an error body', () => {
  assert.equal(parseHfrProbe('2026-08-31T22:00:00Z\n'), Date.parse('2026-08-31T22:00:00Z'));
  assert.equal(parseHfrProbe('Error {\n  code=404;\n}'), null);
  assert.equal(parseHfrProbe(''), null);
});

// ------------------------------------------------------------- dataset table

test('HFR_DATASETS is frozen, finest-first per domain, and free of the deleted W6', () => {
  assert.ok(Object.isFrozen(HFR_DATASETS));
  for (const d of HFR_DATASETS) assert.ok(Object.isFrozen(d) && Object.isFrozen(d.bbox));

  // ucsdHfrW6 was deleted from the ERDDAP griddap index (verified 2026-09-01).
  assert.ok(!HFR_DATASETS.some((d) => d.id.startsWith('ucsdHfrW6')));
  // The *_Lon0360 twins are deliberately excluded: every bbox is on [-180,180).
  assert.ok(!HFR_DATASETS.some((d) => d.id.includes('Lon0360')));
  for (const d of HFR_DATASETS) {
    assert.ok(d.bbox.lonMin >= -180 && d.bbox.lonMax <= 180, d.id);
    assert.ok(d.bbox.latMin < d.bbox.latMax && d.bbox.lonMin < d.bbox.lonMax, d.id);
  }

  for (const domain of new Set(HFR_DATASETS.map((d) => d.domain))) {
    const res = HFR_DATASETS.filter((d) => d.domain === domain).map((d) => d.resolutionKm);
    assert.deepEqual(res, [...res].sort((a, b) => a - b), `${domain} must be finest-first`);
  }
});

test('lengthScaleM puts the two-pass half-amplitude wavelength at 4x the observation spacing', () => {
  // The property that matters, asserted from the response function itself
  // rather than from remembered constants. Koch, DesJardins & Kocin (1983):
  // D1 = exp(-pi^2 L^2 / lambda^2); pass 2 re-analyses the residual at
  // L2 = L*sqrt(gamma), so D2 = D1 + D1^gamma (1 - D1).
  const GAMMA = 0.3;
  const d1 = (L, lam) => Math.exp(-(Math.PI ** 2) * L * L / (lam * lam));
  const d2 = (L, lam) => { const a = d1(L, lam); return a + a ** GAMMA * (1 - a); };
  const halfPowerKm = (Lkm) => {
    let lo = 0.01;
    let hi = 800;
    for (let i = 0; i < 300; i += 1) { const m = (lo + hi) / 2; if (d2(Lkm, m) < 0.5) lo = m; else hi = m; }
    return hi;
  };

  const FLOOR_M = 2050;
  for (const dataset of HFR_DATASETS) {
    const Lkm = dataset.lengthScaleM / 1000;
    if (dataset.lengthScaleM > FLOOR_M) {
      // Unfloored rungs must land on 4x spacing to within rounding.
      const ratio = halfPowerKm(Lkm) / dataset.resolutionKm;
      assert.ok(Math.abs(ratio - 4) < 0.01,
        `${dataset.id}: half-amplitude at ${ratio.toFixed(3)}x spacing, expected 4x`);
    } else {
      // Floored rungs may be smoother than 4x, never rougher.
      assert.ok(halfPowerKm(Lkm) >= 4 * dataset.resolutionKm - 1e-6, dataset.id);
    }
  }

  // The floor binds only where the spacing rule would go below it, and it is
  // the decorrelation scale of the current field, not the sampling grid.
  const byId = Object.fromEntries(HFR_DATASETS.map((x) => [x.id, x.lengthScaleM]));
  assert.equal(byId.ucsdHfrW500, FLOOR_M, '0.5 km product is floored');
  assert.equal(byId.ucsdHfrW1, FLOOR_M, '1 km product is floored');
  assert.equal(byId.ucsdHfrW2, 4100);
  assert.equal(byId.ucsdHfrE6, 12299);
  for (const dataset of HFR_DATASETS) assert.ok(dataset.lengthScaleM >= FLOOR_M, dataset.id);

  // Regression on the defect this replaced: the old L = 2d + 6 km put the 2 km
  // product's half-amplitude wavelength at 19.5 km, 10.5x its measured 1.86 km
  // observation spacing. No SPACING-DRIVEN rung may drift back above 5x. The
  // floored rungs are deliberately smoother than their spacing (that is what a
  // decorrelation floor MEANS), so they are bounded in absolute terms instead.
  for (const dataset of HFR_DATASETS) {
    const halfPower = halfPowerKm(dataset.lengthScaleM / 1000);
    if (dataset.lengthScaleM > FLOOR_M) {
      assert.ok(halfPower / dataset.resolutionKm <= 5,
        `${dataset.id} over-smooths at ${(halfPower / dataset.resolutionKm).toFixed(1)}x spacing`);
    } else {
      assert.ok(halfPower <= 4.5,
        `${dataset.id} floored rung smooths to ${halfPower.toFixed(1)} km, past the decorrelation floor`);
    }
  }
});

// -------------------------------------------------------- geographic selection

test('wrapLon and lonIntervals handle both conventions and the antimeridian', () => {
  assert.equal(wrapLon(-122), -122);
  assert.equal(wrapLon(238), -122); // the 0..360 form of the same meridian
  assert.deepEqual(lonIntervals(-122.6, -122.0), [[-122.6, -122]]);
  assert.deepEqual(lonIntervals(229.64, 244.19), [[-130.36, -115.81]]);
  assert.deepEqual(lonIntervals(178, -178), [[178, 180], [-180, -178]]);
  assert.deepEqual(lonIntervals(-180, 180), [[-180, 180]]);
  assert.deepEqual(lonIntervals(0, 360), [[-180, 180]]); // whole world, not a point
});

test('wrapLon is half-open at +/-180 and propagates non-finite input', () => {
  assert.equal(wrapLon(-180), -180);
  assert.equal(wrapLon(180), -180, 'the range is [-180, 180), so +180 folds to -180');
  assert.equal(wrapLon(360), 0);
  assert.equal(wrapLon(-181), 179);
  assert.ok(Number.isNaN(wrapLon(NaN)));
  assert.ok(Number.isNaN(wrapLon(Infinity)));
  // The identity fast path is load-bearing, not an optimisation: the modular
  // form is lossy in binary floating point and would corrupt griddap URLs.
  assert.equal(wrapLon(-122.6), -122.6);
  assert.equal(String(wrapLon(-122.6)), '-122.6');
});

test('lonIntervals never emits a degenerate antimeridian tail', () => {
  // wrapLon sends the east edge +180 to -180, so a span merely ENDING on the
  // antimeridian used to yield a spurious zero-width [-180,-180] second
  // interval that can only ever produce a false edge-touch match.
  assert.deepEqual(lonIntervals(0, 180), [[0, 180]]);
  assert.deepEqual(lonIntervals(170, 180), [[170, 180]]);
  assert.deepEqual(lonIntervals(-170, 180), [[-170, 180]]);
  // A genuine crossing still splits.
  assert.deepEqual(lonIntervals(178, -178), [[178, 180], [-180, -178]]);
  // Starting on the antimeridian is unaffected.
  assert.deepEqual(lonIntervals(180, 190), [[-180, -170]]);
  assert.deepEqual(lonIntervals(NaN, 10), []);
  for (const intervals of [lonIntervals(0, 180), lonIntervals(178, -178), lonIntervals(-122.6, -122)]) {
    for (const [a, b] of intervals) assert.ok(a <= b, `[${a}, ${b}] must be ascending`);
  }
});

test('boxIntersects counts touching edges as overlap, as documented', () => {
  const cov = { latMin: 30, latMax: 40, lonMin: -130, lonMax: -120 };
  assert.ok(boxIntersects({ latMin: 40, latMax: 45, lonMin: -125, lonMax: -121 }, cov), 'lat touches at 40');
  assert.ok(boxIntersects({ latMin: 20, latMax: 30, lonMin: -125, lonMax: -121 }, cov), 'lat touches at 30');
  assert.ok(boxIntersects({ latMin: 32, latMax: 35, lonMin: -140, lonMax: -130 }, cov), 'lon touches at -130');
  assert.ok(boxIntersects({ latMin: 32, latMax: 35, lonMin: -120, lonMax: -110 }, cov), 'lon touches at -120');
  assert.ok(!boxIntersects({ latMin: 40.001, latMax: 45, lonMin: -125, lonMax: -121 }, cov));
  // A descending latitude pair is normalised rather than read as empty.
  assert.ok(boxIntersects({ latMin: 35, latMax: 32, lonMin: -125, lonMax: -121 }, cov));
});

test('floorToHourMs floors toward -Infinity and propagates non-finite input', () => {
  assert.equal(floorToHourMs(Date.parse('2026-08-31T22:59:59.999Z')), Date.parse('2026-08-31T22:00:00Z'));
  assert.equal(floorToHourMs(Date.parse('2026-08-31T22:00:00Z')), Date.parse('2026-08-31T22:00:00Z'));
  // Pre-epoch: truncation toward zero would round the WRONG WAY here.
  assert.equal(floorToHourMs(-1), -HOUR);
  assert.equal(floorToHourMs(-HOUR), -HOUR);
  assert.ok(Number.isNaN(floorToHourMs(NaN)));
});

test('selectHfrDatasets returns the US West ladder finest-first for Monterey Bay', () => {
  const picked = selectHfrDatasets({ latMin: 36.5, latMax: 36.8, lonMin: -122.2, lonMax: -121.8 });
  // W500 covers only San Francisco Bay (37.46..38.14 N), so Monterey misses it.
  assert.deepEqual(picked.map((d) => d.id), ['ucsdHfrW1', 'ucsdHfrW2']);
  assert.deepEqual(picked.map((d) => d.resolutionKm), [1, 2]);
});

test('selectHfrDatasets includes the 500 m rung only inside its San Francisco box', () => {
  const sf = selectHfrDatasets({ latMin: 37.7, latMax: 37.85, lonMin: -122.55, lonMax: -122.4 });
  assert.deepEqual(sf.map((d) => d.id), ['ucsdHfrW500', 'ucsdHfrW1', 'ucsdHfrW2']);
});

test('selectHfrDatasets resolves the other verified domains', () => {
  const gulf = selectHfrDatasets({ latMin: 28, latMax: 28.3, lonMin: -90.3, lonMax: -90 });
  // The Gulf of Mexico has no dataset of its own; the ucsdHfrE* boxes reach it.
  assert.deepEqual(gulf.map((d) => d.id), ['ucsdHfrE1', 'ucsdHfrE2', 'ucsdHfrE6']);

  const oahu = selectHfrDatasets({ latMin: 21.2, latMax: 21.4, lonMin: -158, lonMax: -157.7 });
  assert.deepEqual(oahu.map((d) => d.id), ['ucsdHfrH1']);

  const pr = selectHfrDatasets({ latMin: 18.3, latMax: 18.5, lonMin: -66.2, lonMax: -66 });
  assert.deepEqual(pr.map((d) => d.id), ['ucsdHfrP2', 'ucsdHfrP6']);
});

test('selectHfrDatasets accepts a 0..360 box and matches the same rungs', () => {
  const wrapped = selectHfrDatasets({ latMin: 36.5, latMax: 36.8, lonMin: 237.8, lonMax: 238.2 });
  assert.deepEqual(wrapped.map((d) => d.id), ['ucsdHfrW1', 'ucsdHfrW2']);
});

test('a dateline-adjacent box matches nothing, and dateline crossing does not alias', () => {
  // Mid-Pacific at the antimeridian: no HFRNet coverage exists there at all.
  assert.deepEqual(selectHfrDatasets({ latMin: 20, latMax: 25, lonMin: 178, lonMax: -178 }), []);
  // A naive [min,max] intersection of the wrapped span 178..-178 would become
  // [-178,178] and falsely hit Hawaii (-163..-152) and both US coasts.
  assert.ok(!boxIntersects({ latMin: 20, latMax: 25, lonMin: 178, lonMax: -178 },
    { latMin: 16.2204, latMax: 24.91688, lonMin: -163.1444, lonMax: -151.9565 }));
  // A box that genuinely straddles the dateline AND reaches Hawaii still hits it.
  assert.deepEqual(
    selectHfrDatasets({ latMin: 20, latMax: 22, lonMin: 170, lonMax: -155 }).map((d) => d.id),
    ['ucsdHfrH1'],
  );
});

test('selectHfrDatasets returns nothing for off-coverage or malformed boxes', () => {
  assert.deepEqual(selectHfrDatasets({ latMin: -40, latMax: -35, lonMin: 150, lonMax: 155 }), []); // Tasman Sea
  assert.deepEqual(selectHfrDatasets({ latMin: 70, latMax: 72, lonMin: -150, lonMax: -145 }), []); // Alaska: no dataset
  assert.deepEqual(selectHfrDatasets({ latMin: NaN, latMax: 37, lonMin: -122, lonMax: -121 }), []);
  assert.deepEqual(selectHfrDatasets(null), []);
});

test('clampBoxToDataset intersects rather than letting ERDDAP 404', () => {
  const w2 = HFR_DATASETS.find((d) => d.id === 'ucsdHfrW2').bbox;
  // A viewport wider than the dataset gets trimmed to the axis limits.
  assert.deepEqual(
    clampBoxToDataset({ latMin: 10, latMax: 60, lonMin: -140, lonMax: -110 }, w2),
    { latMin: 30.25, latMax: 49.99204, lonMin: -130.36, lonMax: -115.8056 },
  );
  // An interior box is untouched.
  assert.deepEqual(
    clampBoxToDataset({ latMin: 36.6, latMax: 36.75, lonMin: -122.1, lonMax: -121.9 }, w2),
    { latMin: 36.6, latMax: 36.75, lonMin: -122.1, lonMax: -121.9 },
  );
  assert.equal(clampBoxToDataset({ latMin: 10, latMax: 20, lonMin: -122, lonMax: -121 }, w2), null);
});

test('clampBoxToDataset refuses a missing or non-finite box instead of emitting NaN edges', () => {
  const w2 = HFR_DATASETS.find((d) => d.id === 'ucsdHfrW2').bbox;
  // Math.max(NaN, x) is NaN and NaN > NaN is false, so the ordering guard alone
  // cannot catch this: the function used to hand back {latMin: NaN, ...}, which
  // only surfaced as a TypeError from buildHfrUrl deep inside the ladder.
  for (const bad of [
    { latMin: NaN, latMax: NaN, lonMin: -122, lonMax: -121 },
    { latMin: 36, latMax: 37, lonMin: NaN, lonMax: -121 },
    { latMin: 36, latMax: Infinity, lonMin: -122, lonMax: -121 },
    {},
    null,
    undefined,
  ]) {
    assert.equal(clampBoxToDataset(bad, w2), null, JSON.stringify(bad));
  }
  assert.equal(clampBoxToDataset({ latMin: 36, latMax: 37, lonMin: -122, lonMax: -121 }, null), null);
  // Every edge of a successful clamp is finite.
  const ok = clampBoxToDataset({ latMin: 10, latMax: 60, lonMin: -140, lonMax: -110 }, w2);
  for (const edge of Object.values(ok)) assert.ok(Number.isFinite(edge));
});

test('clampBoxToDataset resolves a dateline-crossing box to its widest overlapping side', () => {
  // griddap cannot express a wrapped span, so the crossing box must collapse to
  // one interval — and it must be the side that actually holds coverage.
  const hawaii = HFR_DATASETS.find((d) => d.id === 'ucsdHfrH1').bbox;
  const clamped = clampBoxToDataset({ latMin: 20, latMax: 22, lonMin: 170, lonMax: -155 }, hawaii);
  // The 170..180 half misses Hawaii entirely; the -180..-155 half holds it.
  assert.deepEqual(clamped, {
    latMin: 20, latMax: 22, lonMin: hawaii.lonMin, lonMax: -155,
  });
  // And the result is a legal ascending hyperslab, which is the whole point.
  assert.doesNotThrow(() => buildHfrUrl('ucsdHfrH1', ['water_u'], 0, 0, clamped));
});

// ------------------------------------------------------------------ the ladder

const MONTEREY = { latMin: 36.5, latMax: 36.8, lonMin: -122.2, lonMax: -121.8 };
const AT = Date.parse('2026-08-31T22:30:00Z');
const TARGET_HOUR = '2026-08-31T22:00:00Z';

test('ladder serves the finest rung when it has enough vectors', async () => {
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, HFR_MIN_VECTORS)) }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });

  assert.equal(field.datasetId, 'ucsdHfrW1');
  assert.equal(field.resolutionKm, 1);
  assert.equal(field.lengthScaleM, 2050);
  assert.equal(field.observations.length, HFR_MIN_VECTORS);
  assert.equal(field.validAtMs, Date.parse(TARGET_HOUR));
  assert.equal(field.ageMs, AT - Date.parse(TARGET_HOUR));
  assert.equal(field.rejected, 0);
  assert.equal(field.source.id, 'hfr-ucsdHfrW1');
  assert.equal(field.source.records, HFR_MIN_VECTORS);
  assert.ok(field.source.url.includes('ucsdHfrW1.csv0?water_u%5B'));
  // NARROW FIRST: when the target hour is itself servable, only that hour is
  // requested — not the HFR_WINDOW_HOURS hyperslab. Measured 2026-09-01, the
  // window costs 7x the bytes (3.85 MiB vs 0.55 MiB on ucsdHfrW1 over a 1°×1°
  // box) to return the same single hour.
  assert.ok(field.source.url.includes('(2026-08-31T22:00:00Z):1:(2026-08-31T22:00:00Z)'), field.source.url);
  assert.ok(!field.source.url.includes('(2026-08-31T16:00:00Z)'), 'must not widen when the target hour serves');
  // Exactly two calls on the winning rung: one probe, one data request.
  assert.equal(fetchImpl.calls.filter((u) => u.includes('ucsdHfrW1')).length, 2);
  // The coarser rung is never touched once the finer one succeeds.
  assert.ok(!fetchImpl.calls.some((u) => u.includes('ucsdHfrW2')));
});

test('the ladder widens to the full window when the target hour is too thin', async () => {
  // The target hour holds one vector below the floor; an earlier hour inside
  // HFR_WINDOW_HOURS is servable. The rung must widen rather than fall through
  // to a coarser product — falling back in TIME beats falling back in space.
  const thinHour = csv0(...goodRows(TARGET_HOUR, HFR_MIN_VECTORS - 1));
  const earlier = isoHour(Date.parse(TARGET_HOUR) - 2 * HOUR);
  const windowBody = csv0(
    ...goodRows(TARGET_HOUR, HFR_MIN_VECTORS - 1),
    ...goodRows(earlier, HFR_MIN_VECTORS),
  );
  let dataCalls = 0;
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', () => {
      dataCalls += 1;
      return { body: dataCalls === 1 ? thinHour : windowBody };
    }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });

  assert.equal(dataCalls, 2, 'narrow attempt then the widened one');
  assert.equal(field.datasetId, 'ucsdHfrW1', 'must stay on the fine rung');
  assert.equal(field.validAtMs, Date.parse(earlier), 'serves the older hour that has the vectors');
  assert.equal(field.observations.length, HFR_MIN_VECTORS);
  // Every returned vector belongs to the served hour — never a multi-hour pool.
  assert.ok(field.observations.every((o) => o.timeMs === Date.parse(earlier)));
  assert.ok(field.source.url.includes('(2026-08-31T16:00:00Z):1:(2026-08-31T22:00:00Z)'), field.source.url);
});

test('ladder falls through a STALE fine rung to a fresh coarse one', async () => {
  // ucsdHfrW1 stopped three days ago — far outside HFR_MAX_AGE_MS.
  const staleHour = isoHour(AT - 72 * HOUR);
  // The probe body must be READABLE, or the rung falls through on a parse
  // failure and this test says nothing at all about the freshness gate.
  assert.equal(parseHfrProbe(staleHour), Date.parse(staleHour));
  assert.ok(AT - Date.parse(staleHour) > HFR_MAX_AGE_MS, 'fixture must actually be stale');
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${staleHour}\n` }],
    ['ucsdHfrW2.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW2.csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, 50)) }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });

  assert.equal(field.datasetId, 'ucsdHfrW2');
  assert.equal(field.lengthScaleM, 4100);
  assert.ok(field.ageMs <= HFR_MAX_AGE_MS);
  // The stale rung was probed but never asked for data.
  assert.ok(fetchImpl.calls.some((u) => u.includes('ucsdHfrW1.csv0?time')));
  assert.ok(!fetchImpl.calls.some((u) => u.includes('ucsdHfrW1.csv0?water_u')));
});

test('ladder falls through a fresh rung that is fresh but EMPTY over the box', async () => {
  // Measured live: ucsdHfrW1 at Monterey returns all-NaN across an 8 h window
  // while ucsdHfrW2 over the same box is 92% finite. Fresh != usable.
  const nanRows = Array.from({ length: 80 }, (_, k) => row(TARGET_HOUR, (36.5 + k * 0.01).toFixed(5), '-122.0', 'NaN', 'NaN', 'NaN'));
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', { body: csv0(...nanRows) }],
    ['ucsdHfrW2.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW2.csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, 45)) }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });
  assert.equal(field.datasetId, 'ucsdHfrW2');
  assert.equal(field.observations.length, 45);
});

test('ladder survives a rung whose time probe works but whose data request dies', async () => {
  // Exactly the ucsdHfrW6_Lon0360 failure measured on 2026-09-01: cached axis
  // metadata answered time[(last)] while every data request 500'd.
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', {
      ok: false,
      status: 500,
      body: 'Error {\n  code=500;\n  message="(underlying local datasetID=ucsdHfrW1 not found)";\n}',
    }],
    ['ucsdHfrW2.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW2.csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, 41)) }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });
  assert.equal(field.datasetId, 'ucsdHfrW2');

  // Same again, but the rung returns HTTP 200 with an error envelope body —
  // the case the reference implementation would have partially parsed.
  const sneaky = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', { body: 'Error {\n  code=404;\n  message="Not Found: x,y,z";\n}\n' }],
    ['ucsdHfrW2.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW2.csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, 41)) }],
  ]);
  const field2 = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl: sneaky });
  assert.equal(field2.datasetId, 'ucsdHfrW2');
  assert.equal(field2.observations.length, 41);
});

test('ladder survives a rung whose fetch rejects outright', async () => {
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', new Error('ETIMEDOUT')],
    ['ucsdHfrW2.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW2.csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, 44)) }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });
  assert.equal(field.datasetId, 'ucsdHfrW2');
});

test('ladder returns exactly one hour, the newest clearing the vector floor', async () => {
  // Newest hour is thin (below the floor); the hour before it is full. Pooling
  // both would blend currents an hour apart, so only the full hour is served.
  const body = csv0(
    ...goodRows('2026-08-31T21:00:00Z', 48),
    ...goodRows(TARGET_HOUR, HFR_MIN_VECTORS - 1, 100),
  );
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', { body }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });

  assert.equal(field.validAtMs, Date.parse('2026-08-31T21:00:00Z'));
  assert.equal(field.observations.length, 48);
  assert.ok(field.observations.every((o) => o.timeMs === field.validAtMs), 'field must be one hour only');
  assert.equal(field.ageMs, AT - Date.parse('2026-08-31T21:00:00Z'));
});

test('ladder returns null when every rung is too stale', async () => {
  const ancient = '2023-03-05T12:00:00Z'; // the noaacwBlendednrtWinds6hr trap
  const fetchImpl = stubFetch([
    ['csv0?time', { body: `${ancient}\n` }],
    ['csv0?water_u', { body: csv0(...goodRows(ancient, 200)) }],
  ]);
  assert.equal(await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl }), null);
  // No rung was ever asked for data; staleness is settled by the probe alone.
  assert.ok(!fetchImpl.calls.some((u) => u.includes('water_u')));
});

test('ladder returns null when every rung is fresh but under the vector floor', async () => {
  const fetchImpl = stubFetch([
    ['csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, HFR_MIN_VECTORS - 1)) }],
  ]);
  assert.equal(await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl }), null);
  // Both US West rungs were tried before giving up.
  assert.ok(fetchImpl.calls.some((u) => u.includes('ucsdHfrW1.csv0?water_u')));
  assert.ok(fetchImpl.calls.some((u) => u.includes('ucsdHfrW2.csv0?water_u')));
});

test('ladder returns null for an off-coverage box without any network call', async () => {
  const fetchImpl = stubFetch([]);
  const tasman = { latMin: -40, latMax: -35, lonMin: 150, lonMax: 155 };
  assert.equal(await fetchHfrField({ box: tasman, atMs: AT, fetchImpl }), null);
  assert.deepEqual(fetchImpl.calls, []);
});

test('ladder never requests a future hour when asked for one', async () => {
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, 42)) }],
  ]);
  // Requested time sits 2 h ahead of the newest published hour but inside the bound.
  const field = await fetchHfrField({
    box: MONTEREY,
    atMs: Date.parse('2026-09-01T00:00:00Z'),
    fetchImpl,
  });
  assert.equal(field.validAtMs, Date.parse(TARGET_HOUR));
  assert.equal(field.ageMs, 2 * HOUR);
  assert.ok(field.source.url.includes(':1:(2026-08-31T22:00:00Z)'), field.source.url);
});

test('ladder clamps an oversized viewport into the dataset box before requesting', async () => {
  const fetchImpl = stubFetch([
    ['ucsdHfrW2.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW2.csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, 60)) }],
  ]);
  const field = await fetchHfrField({
    box: { latMin: 10, latMax: 60, lonMin: -140, lonMax: -110 },
    atMs: AT,
    fetchImpl,
    datasets: HFR_DATASETS.filter((d) => d.id === 'ucsdHfrW2'),
  });
  // Raw edges would 404 at ERDDAP ("Start=10.0 is less than the axis minimum=30.25").
  assert.ok(field.source.url.includes('(30.25):1:(49.99204)'), field.source.url);
  assert.ok(field.source.url.includes('(-130.36):1:(-115.8056)'), field.source.url);
});

test('ladder forwards stride and requests the documented variables in order', async () => {
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, 42)) }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl, stride: 3 });
  assert.deepEqual(HFR_VARS, ['water_u', 'water_v', 'hdop']);
  assert.ok(field.source.url.includes(':3:'), field.source.url);
  assert.ok(field.source.url.indexOf('water_u') < field.source.url.indexOf('water_v'), field.source.url);
  assert.ok(field.source.url.indexOf('water_v') < field.source.url.indexOf('hdop'), field.source.url);
});

test('ladder counts window-wide rejects while serving one hour', async () => {
  const body = csv0(
    ...goodRows(TARGET_HOUR, 42),
    row(TARGET_HOUR, '36.6', '-122.0', '9.9', '0.1', '0.5'), // speed gate
    row('2026-08-31T20:00:00Z', '36.6', '-122.0', 'NaN', 'NaN', 'NaN'), // earlier hour, coverage gap
  );
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', { body }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });
  assert.equal(field.observations.length, 42);
  // rejected spans the whole requested window, not just validAtMs.
  assert.equal(field.rejected, 2);
});

test('the freshness bound is enforced on the SERVED hour, not just on the probe', async () => {
  // The gap the probe gate cannot see. The rung's newest hour is 11.5 h old —
  // inside the 12 h bound, so it passes step 2 and IS asked for data. But the
  // only hour in the returned window that clears the vector floor sits at the
  // far end of the 6 h hyperslab, 17.5 h behind `atMs`. Bounding only the
  // request end let that hour be served: measured ageMs 17.5 h against
  // maxAgeMs 12 h before the fix.
  const probeHour = isoHour(AT - 11.5 * HOUR); // 2026-08-31T11:00:00Z
  const oldHour = isoHour(AT - 17.5 * HOUR); //   2026-08-31T05:00:00Z
  assert.ok(AT - Date.parse(probeHour) <= HFR_MAX_AGE_MS, 'the probe must PASS, or nothing is proved');
  assert.ok(AT - Date.parse(oldHour) > HFR_MAX_AGE_MS, 'the served hour must be over-age');
  assert.equal(Date.parse(probeHour) - Date.parse(oldHour), HFR_WINDOW_HOURS * HOUR,
    'the over-age hour must lie inside the window the ladder actually requests');

  const routes = [
    ['csv0?time', { body: `${probeHour}\n` }],
    ['csv0?water_u', { body: csv0(...goodRows(oldHour, 50)) }],
  ];
  const fetchImpl = stubFetch(routes);
  assert.equal(await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl }), null);
  // It must be the age gate that refused, not the probe gate: the data request
  // was genuinely made and its 50 vectors genuinely cleared the vector floor.
  assert.ok(fetchImpl.calls.some((u) => u.includes('water_u')), 'the rung was asked for data');

  // Same body, same rung, bound widened past 17.5 h — now it is served. This is
  // what pins the refusal above to maxAgeMs rather than to any other gate.
  const relaxed = stubFetch(routes);
  const field = await fetchHfrField({
    box: MONTEREY, atMs: AT, fetchImpl: relaxed, maxAgeMs: 18 * HOUR,
  });
  assert.equal(field.validAtMs, Date.parse(oldHour));
  assert.equal(field.ageMs, 17.5 * HOUR);
});

test('every served field satisfies 0 <= ageMs <= maxAgeMs', async () => {
  // The invariant the two gates exist to produce, asserted over a spread of
  // probe/served-hour combinations rather than at one hand-picked point.
  for (const [probeOffsetH, servedOffsetH] of [[0.5, 0.5], [0.5, 6.5], [9.5, 9.5], [6, 11.5]]) {
    const probeHour = isoHour(AT - probeOffsetH * HOUR);
    const servedHour = isoHour(AT - servedOffsetH * HOUR);
    const fetchImpl = stubFetch([
      ['csv0?time', { body: `${probeHour}\n` }],
      ['csv0?water_u', { body: csv0(...goodRows(servedHour, 50)) }],
    ]);
    const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });
    assert.ok(field, `expected a field for probe -${probeOffsetH} h / served -${servedOffsetH} h`);
    assert.ok(field.ageMs >= 0, `ageMs must not be negative, got ${field.ageMs}`);
    assert.ok(field.ageMs <= HFR_MAX_AGE_MS, `ageMs must respect the bound, got ${field.ageMs}`);
    assert.equal(field.ageMs, AT - field.validAtMs);
  }
});

test('an hour newer than the target is ignored, so ageMs is never negative', async () => {
  // A mirror serving a snapped index or a stale cache can return a row past the
  // end of the hyperslab we asked for. Taking the newest hour unconditionally
  // reported ageMs = -30 min: a measurement claimed from the future.
  const futureHour = isoHour(AT + 0.5 * HOUR); // 2026-08-31T23:00:00Z, past the target
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['ucsdHfrW1.csv0?water_u', {
      body: csv0(
        ...goodRows(futureHour, 60), // newest, and comfortably over the floor
        ...goodRows(TARGET_HOUR, 45, 100),
      ),
    }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl });
  assert.equal(field.validAtMs, Date.parse(TARGET_HOUR));
  assert.equal(field.observations.length, 45);
  assert.ok(field.ageMs > 0, `ageMs must be positive, got ${field.ageMs}`);
  assert.ok(field.observations.every((o) => o.timeMs <= Date.parse(TARGET_HOUR)));
});

test('fetchHfrField refuses a non-function fetchImpl instead of touching the network', async () => {
  await assert.rejects(
    () => fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl: null }),
    TypeError,
  );
});

test('caller-error options throw rather than being reported as "no data here"', async () => {
  // These used to be swallowed by the ladder's catch, one rung at a time, and
  // surface as a plain `null` — indistinguishable from a genuine coverage hole,
  // which is a far more alarming claim than "you passed stride 0".
  const fetchImpl = stubFetch([
    ['csv0?time', { body: `${TARGET_HOUR}\n` }],
    ['csv0?water_u', { body: csv0(...goodRows(TARGET_HOUR, 60)) }],
  ]);
  for (const bad of [
    { stride: 0 },
    { stride: 1.5 },
    { stride: -2 },
    { atMs: NaN },
    { windowHours: NaN },
    { maxAgeMs: -1 },
    { minVectors: NaN },
  ]) {
    await assert.rejects(
      () => fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl, ...bad }),
      TypeError,
      JSON.stringify(bad),
    );
  }
  assert.deepEqual(fetchImpl.calls, [], 'a caller bug must be caught before any request');
});

test('an aborted signal stops the ladder and rejects, rather than reporting no data', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('should not be reached'); };
  await assert.rejects(
    () => fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(calls, 0, 'an already-aborted request must not hit the network at all');
});

test('an abort mid-ladder does not fall through to the remaining rungs', async () => {
  // Monterey resolves to two rungs. Cancelling during the first must not spend a
  // request on the second, and must not turn the cancellation into `null`.
  const controller = new AbortController();
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(
    () => fetchHfrField({ box: MONTEREY, atMs: AT, fetchImpl, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(seen.length, 1, `expected one attempt, got ${seen.length}: ${seen.join(' ')}`);
  assert.ok(seen[0].includes('ucsdHfrW1'), seen[0]);
});

test('an abort during the LAST rung still rejects instead of returning null', async () => {
  // The per-iteration pre-check cannot cover this: there is no next iteration
  // to run it in. Only rethrowing from the catch keeps a cancellation on the
  // final rung from falling out of the loop as an ordinary "no data" answer.
  const controller = new AbortController();
  const fetchImpl = async () => {
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(
    () => fetchHfrField({
      box: MONTEREY,
      atMs: AT,
      fetchImpl,
      signal: controller.signal,
      datasets: HFR_DATASETS.filter((d) => d.id === 'ucsdHfrW2'), // exactly one rung
    }),
    (error) => error.name === 'AbortError',
  );
});

test('the fixture drives the ladder end to end', async () => {
  const fixtureHour = Date.parse('2026-08-31T22:00:00Z');
  const fetchImpl = stubFetch([
    ['ucsdHfrW1.csv0?time', { body: '2026-08-31T22:00:00Z\n' }],
    ['ucsdHfrW1.csv0?water_u', { body: FIXTURE }],
  ]);
  const field = await fetchHfrField({ box: MONTEREY, atMs: fixtureHour + 30 * 60000, fetchImpl });

  assert.equal(field.datasetId, 'ucsdHfrW1');
  assert.equal(field.observations.length, 52); // the fixture's finite rows clear the 40 floor
  assert.equal(field.rejected, 8);
  assert.equal(field.validAtMs, fixtureHour);
  assert.equal(field.ageMs, 30 * 60000);
  assert.equal(field.source.kind, 'observed');
});
