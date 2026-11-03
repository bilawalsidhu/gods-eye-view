import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateWellPack, wellDetails, WELL_LIMITS } from './pack.js';
import { createWellPackSource } from './source.js';
const fixture = new URL(
  '../../../fixtures/us-groundwater/v1/',
  import.meta.url,
);
const load = () =>
  JSON.parse(fs.readFileSync(new URL('expected-pack.json', fixture)));
const capture = JSON.parse(fs.readFileSync(new URL('capture.json', fixture)));

test('versioned capture hashes and every well/observation join match original evidence', () => {
  const hashes = JSON.parse(fs.readFileSync(new URL('sha256.json', fixture)));
  for (const [name, hash] of Object.entries(hashes))
    assert.equal(
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(new URL(name, fixture)))
        .digest('hex'),
      hash,
    );
  const pack = validateWellPack(load());
  assert.equal(pack.records.length, 6);
  assert.equal(new Set(pack.records.map((s) => s.metadata.state_code)).size, 6);
  assert.equal(pack.coverage.complete, false);
  for (const site of pack.records) {
    const original = capture.acquisitions[0].response.features.find(
      (f) => f.id === site.id,
    );
    assert.deepEqual(site.metadata, original.properties);
    assert.deepEqual(
      [site.longitude, site.latitude],
      original.geometry.coordinates,
    );
    for (const reading of site.readings) {
      const collection =
        reading.kind === 'continuous'
          ? 'latest-continuous'
          : 'field-measurements';
      const acquisition = capture.acquisitions.find(
        (a) => a.collection === collection,
      );
      assert.deepEqual(
        reading.raw,
        acquisition.response.features.find((f) => f.id === reading.id)
          .properties,
      );
      assert.equal(reading.retrievedAt, acquisition.retrievedAt);
    }
  }
});

test('continuous may be old; discrete dates never become invented UTC instants', () => {
  const rows = load().records.flatMap((s) => s.readings);
  assert.equal(rows.filter((r) => r.kind === 'continuous').length, 3);
  assert.equal(rows.filter((r) => r.kind === 'discrete').length, 3);
  assert(
    rows.some(
      (r) => r.kind === 'continuous' && r.observedAt.startsWith('2014-'),
    ),
  );
  const site = load().records.find((s) =>
    s.readings.some((r) => r.observedAt === '1939-11-07'),
  );
  assert.equal(
    wellDetails(site).readings[0].observed,
    '1939-11-07 (day precision)',
  );
});

test('missing values, zero, negative and provider text remain distinct', () => {
  for (const [value, numericValue] of [
    [null, null],
    ['', null],
    ['Ice', null],
    ['0', 0],
    ['-2.5', -2.5],
  ]) {
    const pack = load();
    const row = pack.records[0].readings[0];
    row.value = value;
    row.raw.value = value;
    row.numericValue = numericValue;
    validateWellPack(pack);
    assert.equal(
      wellDetails(pack.records[0]).readings[0].value.startsWith('No numeric'),
      numericValue === null,
    );
  }
  const pack = load();
  pack.records[0].name = '<img src=x onerror=alert(1)>';
  assert.equal(
    wellDetails(validateWellPack(pack).records[0]).name,
    pack.records[0].name,
  );
});

test('metadata-only well means unknown observations, not zero water', () => {
  const pack = load();
  pack.records[0].readings = [];
  validateWellPack(pack);
  assert.deepEqual(wellDetails(pack.records[0]).readings, []);
});

test('elevation datum is separate from depth and is never converted', () => {
  const pack = load();
  const row = pack.records[0].readings[0];
  row.parameterCode = '62611';
  row.raw.parameter_code = '62611';
  row.reference = 'water-level-elevation';
  row.datum = 'NAVD88';
  validateWellPack(pack);
  assert.match(
    wellDetails(pack.records[0]).readings[0].reference,
    /NAVD88; no datum conversion/,
  );
  row.reference = 'depth-below-land-surface';
  assert.throws(() => validateWellPack(pack));
});

test('refuses stream sites, forged links, locations, joins, duplicate IDs, bad dates and excessive packs', () => {
  const mutations = [
    (p) => (p.records[0].metadata.site_type_code = 'ST'),
    (p) => (p.records[0].metadata.agency_code = 'OTHER'),
    (p) => (p.records[0].metadata.country_code = 'CA'),
    (p) => (p.records[0].longitude = null),
    (p) => (p.records[0].latitude = 91),
    (p) => (p.records[0].sourceUrl = 'javascript:alert(1)'),
    (p) => (p.records[0].readings[0].raw.monitoring_location_id = 'USGS-12345'),
    (p) => p.records.push(p.records[0]),
    (p) => {
      const r = p.records[0].readings[0];
      r.raw.time = r.observedAt = '2026-02-30T00:00:00Z';
    },
    (p) => (p.records[0].readings[0].numericValue = 0),
    (p) => (p.acquisitions[0].url = 'https://example.com/'),
    (p) => (p.records = Array(WELL_LIMITS.sites + 1).fill(p.records[0])),
    (p) =>
      (p.records[0].readings = Array(WELL_LIMITS.readings + 1).fill(
        p.records[0].readings[0],
      )),
  ];
  for (const mutate of mutations) {
    const pack = load();
    mutate(pack);
    assert.throws(() => validateWellPack(pack));
  }
});

test('pack source omits credentials, refuses redirects and external locations', async () => {
  for (const url of [
    'https://example.com/pack',
    '//example.com/pack',
    '/\\example.com',
  ])
    assert.throws(() => createWellPackSource({ url }));
  let request;
  const source = createWellPackSource({
    url: '/fixture.json',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(load()));
    },
  });
  assert.equal((await source.getSnapshot()).records.length, 6);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
});

test('pack URL admission rejects control-character authority escapes before any fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify(load()));
  };
  for (const control of ['\t', '\n', '\r', '\0', '\u001f', '\u007f']) {
    assert.throws(
      () =>
        createWellPackSource({
          url: `/${control}/example.org/pack`,
          fetchImpl,
        }),
      /same-origin/,
    );
  }
  const safe = createWellPackSource({
    url: '/fixtures/../pack.json?encoded=%09',
    fetchImpl: async (value) => {
      calls++;
      const resolved = new URL(value);
      assert.equal(resolved.origin, 'https://gev.invalid');
      assert.equal(resolved.pathname, '/pack.json');
      assert.equal(resolved.search, '?encoded=%09');
      return new Response(JSON.stringify(load()));
    },
  });
  assert.equal(calls, 0);
  await safe.getSnapshot();
  assert.equal(calls, 1);
});

test('pack source bounds response bytes and preserves cancellation and HTTP failure', async () => {
  const source = (fetchImpl) =>
    createWellPackSource({ url: '/fixture.json', fetchImpl });
  await assert.rejects(
    source(async () => new Response('{}', { status: 404 })).getSnapshot(),
    /404/,
  );
  await assert.rejects(
    source(
      async () =>
        new Response('{}', {
          headers: { 'content-length': String(WELL_LIMITS.bytes + 1) },
        }),
    ).getSnapshot(),
    /too large/,
  );
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    source(async () => {
      calls++;
    }).getSnapshot({ signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    source(async () => new Response('{broken')).getSnapshot(),
    SyntaxError,
  );
});
