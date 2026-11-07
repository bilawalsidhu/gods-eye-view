import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInatObservations,
  normalizeAcartiaSightings,
  parseAcartiaTime,
  inatPhotoUrl,
  isOpenPhoto,
  obscuredCell,
  inatLicenceLabel,
  mergeSightings,
  isRecentWildlifeSighting,
} from './records.js';

const now = Date.UTC(2026, 10, 4, 18);
const hour = 3_600_000;
const photo = {
  url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/123/square.jpeg',
  license_code: 'cc-by-nc',
  attribution: '(c) Synthetic Photographer, some rights reserved',
};
const observation = (overrides = {}) => ({
  id: 123,
  uri: 'https://www.inaturalist.org/observations/123',
  geojson: { coordinates: [-122.351, 47.613] },
  positional_accuracy: 12,
  public_positional_accuracy: 12,
  obscured: false,
  geoprivacy: null,
  taxon_geoprivacy: null,
  time_observed_at: '2026-11-04T16:00:00Z',
  observed_on: '2026-11-04',
  created_at: '2026-11-04T17:00:00Z',
  quality_grade: 'research',
  license_code: 'cc-by-nc',
  faves_count: 6,
  num_identification_agreements: 3,
  taxon: {
    name: 'Calypte anna',
    preferred_common_name: "Anna's Hummingbird",
    iconic_taxon_name: 'Aves',
    threatened: false,
  },
  photos: [photo],
  user: { login: 'SHOULD_NEVER_ESCAPE' },
  ...overrides,
});
const sighting = (overrides = {}) => ({
  entry_id: 'abc',
  latitude: 48.12345,
  longitude: -122.54321,
  created: '2026-11-04 16:00:00',
  type: 'Orca',
  no_sighted: '5',
  photo_url: 'https://provider.example/photo.jpg',
  data_source_name: 'Synthetic Network',
  data_source_entity: 'Whale Alert',
  trusted: true,
  data_source_comments: 'PRIVATE PHONE AND NAME',
  ...overrides,
});

test('normalizers reject only non-array snapshots and dedupe validated ids', () => {
  for (const input of [null, {}, { results: [] }, '']) {
    assert.equal(normalizeInatObservations(input), null);
    assert.equal(normalizeAcartiaSightings(input, now), null);
  }
  assert.deepEqual(normalizeInatObservations([]), []);
  assert.equal(
    normalizeInatObservations([null, observation(), observation()]).length,
    1,
  );
  assert.equal(
    normalizeAcartiaSightings([null, sighting(), sighting()], now).length,
    1,
  );
});

test('iNaturalist projection retains only the listed display fields and aggregate photo rank', () => {
  const [row] = normalizeInatObservations([observation()]);
  assert.equal(row.stableId, 'inat:123');
  assert.equal(row.favesCount, 6);
  assert.equal(row.identificationAgreements, 3);
  assert.equal(row.photo.attribution, photo.attribution);
  assert.equal(row.observedAt, now - 2 * hour);
  for (const key of [
    'user',
    'login',
    'public_positional_accuracy',
    'geojson',
    'created_at',
  ])
    assert.equal(key in row, false);
  assert.doesNotMatch(JSON.stringify(row), /SHOULD_NEVER_ESCAPE/);
});

test('observation links accept only canonical source pages and fall back to the id', () => {
  for (const uri of [
    undefined,
    'https://www.inaturalist.org/observations/123\n',
    'https://www.inaturalist.org/observations/123?redirect=elsewhere',
    'http://www.inaturalist.org/observations/123',
    'https://www.inaturalist.org.evil.example/observations/123',
  ]) {
    const [row] = normalizeInatObservations([observation({ uri })]);
    assert.equal(
      row.link,
      observation().uri,
      'the existing detail card keeps its canonical fallback',
    );
  }
});

test('wildlife package entries construct without acquiring data or a DOM', async () => {
  const api = await import('gods-eye-view/layers/wildlife-sightings');
  const sources =
    await import('gods-eye-view/layers/wildlife-sightings/source');
  const layer = api.createWildlifeSightingsLayer({
    source: sources.createWildlifeSightingsSource({
      fetchImpl() {
        assert.fail('construction must not acquire');
      },
    }),
  });
  assert.equal(layer.id, 'wildlife-sightings');
  layer.destroy();
});

test('only allow-listed photo licences with square open-data hosts and attribution render', () => {
  for (const license_code of [
    'cc0',
    'cc-by',
    'cc-by-sa',
    'cc-by-nc',
    'cc-by-nc-sa',
  ]) {
    assert.equal(isOpenPhoto({ ...photo, license_code }), true);
    assert.ok(
      normalizeInatObservations([
        observation({ photos: [{ ...photo, license_code }] }),
      ])[0].photo,
    );
  }
  for (const badPhoto of [
    { ...photo, license_code: null },
    { ...photo, license_code: 'cc-by-nd' },
    { ...photo, license_code: 'cc-by-nc-nd' },
    { ...photo, license_code: 'all rights reserved' },
    { ...photo, url: 'https://static.inaturalist.org/photos/123/square.jpg' },
    { ...photo, url: `${photo.url}?size=square` },
    { ...photo, url: photo.url.replace('https:', 'http:') },
    { ...photo, attribution: '' },
    { ...photo, url: photo.url.replace('/square.', '/medium.') },
  ]) {
    assert.equal(isOpenPhoto(badPhoto), false);
    assert.equal(
      normalizeInatObservations([observation({ photos: [badPhoto] })])[0].photo,
      null,
    );
  }
  assert.equal(
    inatPhotoUrl(photo.url, 'medium'),
    'https://inaturalist-open-data.s3.amazonaws.com/photos/123/medium.jpeg',
  );
  for (const extension of ['jpg', 'jpeg', 'PNG']) {
    const square = photo.url.replace('square.jpeg', `square.${extension}`);
    assert.equal(
      inatPhotoUrl(square, 'medium'),
      square.replace('/square.', '/medium.'),
    );
  }
  for (const invalid of [
    null,
    new URL(photo.url),
    photo.url.replace('https:', 'http:'),
    photo.url.replace('amazonaws.com', 'amazonaws.com.evil.example'),
    photo.url.replace('https://', 'https://user:secret@'),
    photo.url.replace('https://', 'https://evil.example@'),
    photo.url.replace('/photos/', '/other/photos/'),
    photo.url.replace('/123/', '/abc/'),
    photo.url.replace('/square.', '/medium.'),
    photo.url.replace('/square.', '/large.'),
    photo.url.replace('.jpeg', '.webp'),
    `${photo.url}?size=large`,
    `${photo.url}#large`,
    `${photo.url}\n`,
  ]) {
    assert.equal(inatPhotoUrl(invalid, 'medium'), null, String(invalid));
  }
  for (const invalidSize of [
    'original',
    'small',
    'large',
    'Medium',
    '../medium',
    'medium?query=1',
    null,
  ]) {
    assert.equal(inatPhotoUrl(photo.url, invalidSize), null);
  }
  assert.equal(inatLicenceLabel('cc-by-nc-sa'), 'CC BY-NC-SA');
  assert.equal(inatLicenceLabel(null), 'All rights reserved');
});

test('photo attribution is trimmed, control-free and bounded', () => {
  const attribution = `  Photo\u0000\n${'A'.repeat(200)} `;
  const [row] = normalizeInatObservations([
    observation({ photos: [{ ...photo, attribution }] }),
  ]);
  assert.equal(row.photo.attribution.length, 160);
  assert.match(row.photo.attribution, /^PhotoA/);
  assert.doesNotMatch(row.photo.attribution, /[\u0000-\u001f]/);
});

test('obscured rows reveal only cell centres and date, without accuracy', () => {
  assert.deepEqual(obscuredCell(47.613, -122.351), {
    south: 47.6,
    north: 47.8,
    west: -122.4,
    east: -122.2,
  });
  for (const hiding of [
    { obscured: true },
    { geoprivacy: 'obscured' },
    { taxon_geoprivacy: 'obscured' },
  ]) {
    const [row] = normalizeInatObservations([observation(hiding)]);
    assert.equal(row.obscured, true);
    assert.equal(row.lat, 47.7);
    assert.equal(row.lon, -122.3);
    assert.equal('accuracyM' in row, false);
    assert.equal(row.observedAt, null);
    assert.equal(row.observedOn, '2026-11-04');
    assert.doesNotMatch(JSON.stringify(row), /47\.613|-122\.351|16:00/);
  }
  assert.deepEqual(obscuredCell(90, 180), {
    south: 89.8,
    north: 90,
    west: 179.8,
    east: 180,
  });
});

test('private, casual, invalid coordinates and invalid ids are skipped', () => {
  const invalid = [
    observation({ geoprivacy: 'private' }),
    observation({ taxon_geoprivacy: 'private' }),
    observation({ quality_grade: 'casual' }),
    observation({ id: -1 }),
    observation({ id: 1.5 }),
    observation({ geojson: { coordinates: [181, 47] } }),
    observation({ geojson: null }),
  ];
  assert.deepEqual(normalizeInatObservations(invalid), []);
  const [fallback] = normalizeInatObservations([
    observation({
      geojson: null,
      location: '47.613,-122.351',
      uri: 'https://bad.example',
    }),
  ]);
  assert.equal(fallback.lat, 47.613);
  assert.equal(fallback.link, 'https://www.inaturalist.org/observations/123');
  assert.deepEqual(
    normalizeInatObservations([observation({ geojson: null, location: ',0' })]),
    [],
  );
});

test('Acartia accepts only the two stated UTC timestamp formats', () => {
  assert.equal(parseAcartiaTime('2026-11-04 16:00:00'), now - 2 * hour);
  assert.equal(parseAcartiaTime('2026-11-04T16:00:00Z'), now - 2 * hour);
  assert.equal(parseAcartiaTime('2026-11-04T18:00:00+02:00'), now - 2 * hour);
  for (const value of [
    '2026-11-04T16:00:00',
    '11/04/2026',
    '2026-02-30 12:00:00',
    '2026-11-04 25:00:00',
    123,
    null,
  ])
    assert.equal(parseAcartiaTime(value), null);
});

test('Acartia coarsens before returning data, keeps provider, and never reads comments', () => {
  const raw = sighting();
  Object.defineProperty(raw, 'data_source_comments', {
    get() {
      assert.fail('comments read');
    },
  });
  const [row] = normalizeAcartiaSightings([raw], now);
  assert.equal(row.lat, 48.12);
  assert.equal(row.lon, -122.54);
  assert.deepEqual(row.provider, {
    name: 'Synthetic Network',
    entity: 'Whale Alert',
  });
  assert.equal(row.quality, 'research');
  assert.equal(row.photo, null);
  assert.doesNotMatch(
    JSON.stringify(row),
    /data_source_comments|PRIVATE|48\.12345|-122\.54321/,
  );
});

test('Acartia requires flat provider text, handles trust, and sanitizes type', () => {
  for (const provider of ['', null, {}, { name: 'Invented nested shape' }]) {
    assert.deepEqual(
      normalizeAcartiaSightings(
        [sighting({ data_source_name: provider })],
        now,
      ),
      [],
    );
  }
  for (const trusted of [true, 1, 'true'])
    assert.equal(
      normalizeAcartiaSightings([sighting({ trusted })], now)[0].quality,
      'research',
    );
  for (const trusted of [false, 0, 'false', '1'])
    assert.equal(
      normalizeAcartiaSightings([sighting({ trusted })], now)[0].quality,
      'needs_id',
    );
  assert.deepEqual(
    normalizeAcartiaSightings([sighting({ type: ' \u0000 ' })], now),
    [],
  );
});

test('Acartia rejects invalid times/positions and its link is always the Acartia site', () => {
  for (const overrides of [
    { created: new Date(now - 8 * 24 * hour - 1).toISOString() },
    { created: new Date(now + 10 * 60_000 + 1).toISOString() },
    { created: 'not a timestamp' },
    { latitude: 91 },
    { longitude: -181 },
    { entry_id: '' },
  ])
    assert.deepEqual(normalizeAcartiaSightings([sighting(overrides)], now), []);
  for (const photo_url of [
    // A contributor-supplied URL is never labelled as the Acartia source.
    'https://provider.example/photo.jpg',
    'https://phishing.example/acartia.io/login',
    'https://acartia.io.attacker.example/',
    'http://provider.example/p.jpg',
    'https://user:secret@provider.example/p.jpg',
    'javascript:bad()',
    'https://' + 'x'.repeat(501),
    null,
  ]) {
    assert.equal(
      normalizeAcartiaSightings([sighting({ photo_url })], now)[0].link,
      'https://acartia.io/',
    );
  }
});

test('merge applies Acartia windows, trust, preset and iNat dedupe', () => {
  const inat = normalizeInatObservations([observation()]);
  const rows = normalizeAcartiaSightings(
    [
      sighting(),
      sighting({
        entry_id: 'old',
        created: new Date(now - 3 * 24 * hour).toISOString(),
      }),
      sighting({ entry_id: 'untrusted', trusted: false }),
      sighting({
        entry_id: 'inat',
        data_source_name: 'iNaturalist observations',
      }),
    ],
    now,
  );
  const ids = (options) =>
    mergeSightings(inat, rows, { nowMs: now, ...options }).map(
      (row) => row.stableId,
    );
  assert.deepEqual(ids({}), ['inat:123', 'acartia:abc', 'acartia:untrusted']);
  assert.deepEqual(ids({ confirmed: true }), ['inat:123', 'acartia:abc']);
  assert.ok(ids({ taxa: 'whales' }).includes('acartia:old'));
  assert.deepEqual(ids({ taxa: 'Aves' }), ['inat:123']);
});

test('iNaturalist recency uses observation time and the exact preset window', () => {
  const raw = [
    observation({
      id: 1,
      time_observed_at: '2010-11-04T16:00:00Z',
      observed_on: '2010-11-04',
      created_at: new Date(now).toISOString(),
    }),
    observation({
      id: 2,
      time_observed_at: new Date(now - 48 * hour - 1).toISOString(),
      observed_on: '2026-11-02',
    }),
    observation({
      id: 3,
      time_observed_at: new Date(now - 48 * hour).toISOString(),
      observed_on: '2026-11-02',
      created_at: '2026-10-01T00:00:00Z',
    }),
    observation({
      id: 4,
      time_observed_at: new Date(now - 3 * 24 * hour).toISOString(),
      observed_on: '2026-11-01',
    }),
  ];
  const ids = (rows) => rows.map((row) => row.stableId);
  assert.deepEqual(ids(normalizeInatObservations(raw, { nowMs: now })), [
    'inat:3',
  ]);
  assert.deepEqual(
    ids(
      normalizeInatObservations(raw, { nowMs: now, windowMs: 7 * 24 * hour }),
    ),
    ['inat:2', 'inat:3', 'inat:4'],
  );
  // Recheck cached/projected rows as the clock moves between server refreshes.
  assert.deepEqual(
    ids(mergeSightings(normalizeInatObservations(raw), [], { nowMs: now })),
    ['inat:3'],
  );
  assert.deepEqual(
    mergeSightings(normalizeInatObservations([raw[2]]), [], { nowMs: now + 1 }),
    [],
  );
});

test('date-only and obscured iNaturalist recency never includes a partly expired date', () => {
  const rows = normalizeInatObservations(
    [
      observation({ id: 1, time_observed_at: null, observed_on: '2026-11-02' }),
      observation({ id: 2, time_observed_at: null, observed_on: '2026-11-03' }),
      observation({ id: 3, time_observed_at: null, observed_on: null }),
      observation({
        id: 4,
        obscured: true,
        time_observed_at: '2010-11-04T16:00:00Z',
        observed_on: '2010-11-04',
      }),
    ],
    { nowMs: now },
  );
  assert.deepEqual(
    rows.map((row) => row.stableId),
    ['inat:2'],
  );
});

test('retained sightings use the same exact, date-only and preset recency limits', () => {
  const boundary = { observedAt: now - 48 * hour };
  assert.equal(isRecentWildlifeSighting(boundary, now), true);
  assert.equal(isRecentWildlifeSighting(boundary, now + 1), false);
  assert.equal(isRecentWildlifeSighting(boundary, now + 1, 'whales'), true);
  const whaleBoundary = { observedAt: now - 7 * 24 * hour };
  assert.equal(isRecentWildlifeSighting(whaleBoundary, now, 'whales'), true);
  assert.equal(
    isRecentWildlifeSighting(whaleBoundary, now + 1, 'whales'),
    false,
  );
  assert.equal(isRecentWildlifeSighting(whaleBoundary, now, 'Mammalia'), false);
  for (const [observedOn, expected] of [
    ['2026-11-02', false],
    ['2026-11-03', true],
    ['2026-11-04', true],
  ]) {
    assert.equal(
      isRecentWildlifeSighting({ observedAt: null, observedOn }, now),
      expected,
    );
  }
  assert.equal(
    isRecentWildlifeSighting({ observedOn: '2026-11-03' }, now + 24 * hour),
    false,
  );
  for (const row of [
    null,
    {},
    { observedOn: '2010-11-04' },
    { observedOn: 'invalid' },
  ]) {
    assert.equal(isRecentWildlifeSighting(row, now), false);
  }
  assert.equal(isRecentWildlifeSighting(boundary, NaN), false);
});

test('Acartia validates the documented type field before applying the WHALES preset', () => {
  const rows = normalizeAcartiaSightings(
    [
      sighting({ entry_id: 'orca', type: 'Orca' }),
      sighting({ entry_id: 'scientific', type: 'Phocoena phocoena' }),
      sighting({ entry_id: 'seal', type: 'Harbor seal' }),
      sighting({
        entry_id: 'unidentified',
        type: 'Unidentified marine mammal',
      }),
      sighting({ entry_id: 'unknown-whale', type: 'Unidentified whale' }),
      sighting({ entry_id: 'unknown', type: 'Unknown' }),
      sighting({ entry_id: 'empty', type: '' }),
      sighting({ entry_id: 'fish', type: 'Whale shark' }),
      sighting({ entry_id: 'text', type: 'Maybe an Orca or a seal' }),
      sighting({ entry_id: 'prefix', type: `Orca${' '.repeat(120)}or a seal` }),
      sighting({ entry_id: 'invented-shape', type: { species: 'Orca' } }),
    ],
    now,
  );
  const ids = (taxa) =>
    mergeSightings([], rows, { nowMs: now, taxa }).map((row) => row.stableId);
  assert.deepEqual(ids('whales'), ['acartia:orca', 'acartia:scientific']);
  const mammals = [
    'acartia:orca',
    'acartia:scientific',
    'acartia:seal',
    'acartia:unidentified',
    'acartia:unknown-whale',
  ];
  assert.deepEqual(ids('all'), mammals);
  assert.deepEqual(ids('Mammalia'), mammals);
  assert.deepEqual(ids('Aves'), []);
});

test('Acartia rejects out-of-coverage rows before rounding or caching', () => {
  for (const position of [
    { latitude: 45.49999 },
    { latitude: 50.50001 },
    { longitude: -126.00001 },
    { longitude: -120.99999 },
    { latitude: 37.8, longitude: -122.4 },
  ]) {
    assert.deepEqual(normalizeAcartiaSightings([sighting(position)], now), []);
  }
  for (const position of [
    { latitude: 45.5, longitude: -126 },
    { latitude: 50.5, longitude: -121 },
  ]) {
    assert.equal(
      normalizeAcartiaSightings([sighting(position)], now).length,
      1,
    );
  }
});
