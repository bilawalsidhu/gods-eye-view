import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freeShare,
  normalizeParkingContributors,
  normalizeParkingPage,
  normalizeParkingSite,
  occupancyBand,
} from './records.js';

/** A Stuttgart garage as ParkAPI v3 publishes it. */
const SITE = {
  id: 41808,
  source_id: 64,
  original_uid: 'P1',
  name: 'LBBW (Hbf.)',
  operator_name: 'Stuttgarter Parkraum GmbH',
  public_url: 'https://example.org/parken/lbbw',
  address: 'Heilbronner Straße 9, 70173 Stuttgart',
  type: 'UNDERGROUND',
  purpose: 'CAR',
  max_height: 200,
  has_realtime_data: true,
  realtime_data_updated_at: '2026-10-24T02:12:22Z',
  lat: 48.7849,
  lon: 9.1836,
  capacity: 1290,
  realtime_capacity: 1280,
  realtime_free_capacity: 992,
  restrictions: [
    { type: 'DISABLED', capacity: 12 },
    { type: 'WOMEN', capacity: 30 },
    { type: 'CHARGING', capacity: 8 },
    { type: 'CHARGING', capacity: 2 },
  ],
};

test('a live site carries its free count, live total and reading time', () => {
  assert.deepEqual(normalizeParkingSite(SITE), {
    id: 'parking:41808',
    siteId: 41808,
    sourceId: 64,
    name: 'LBBW (Hbf.)',
    operator: 'Stuttgarter Parkraum GmbH',
    address: 'Heilbronner Straße 9, 70173 Stuttgart',
    type: 'UNDERGROUND',
    latitude: 48.7849,
    longitude: 9.1836,
    capacity: 1290,
    free: 992,
    liveCapacity: 1280,
    updatedAt: Date.UTC(2026, 9, 24, 2, 12, 22),
    disabled: 12,
    charging: 10,
    url: 'https://example.org/parken/lbbw',
  });
});

test('positions published as decimal strings are read; unusable ones drop the site', () => {
  const record = normalizeParkingSite({
    ...SITE,
    lat: '48.7849',
    lon: '9.1836',
  });
  assert.equal(record.latitude, 48.7849);
  assert.equal(record.longitude, 9.1836);
  for (const bad of [
    { lat: null },
    { lon: '' },
    { lat: 'north' },
    { lat: 91 },
    { lon: -181 },
    { id: undefined },
    { id: 'abc' },
  ])
    assert.equal(normalizeParkingSite({ ...SITE, ...bad }), null, bad);
  assert.equal(normalizeParkingSite(null), null);
});

test('a free count ParkAPI marks outdated is not shown as live', () => {
  // ParkAPI keeps the old realtime fields on an outdated site and sets
  // has_realtime_data false.
  const record = normalizeParkingSite({ ...SITE, has_realtime_data: false });
  assert.equal(record.free, null);
  assert.equal(record.liveCapacity, null);
  assert.equal(record.updatedAt, null);
  assert.equal(record.capacity, 1290, 'the static capacity stays');
  assert.equal(occupancyBand(record), 'static');
  // A live flag without a usable count is static too.
  assert.equal(
    normalizeParkingSite({ ...SITE, realtime_free_capacity: -3 }).free,
    null,
  );
});

test('only http(s) operator links are kept', () => {
  for (const [link, expected] of [
    ['http://example.org/p', 'http://example.org/p'],
    ['javascript:alert(1)', null],
    ['not a url', null],
    ['', null],
    [undefined, null],
  ])
    assert.equal(
      normalizeParkingSite({ ...SITE, public_url: link }).url,
      expected,
    );
});

test('missing names, operators and restrictions stay absent rather than invented', () => {
  const record = normalizeParkingSite({
    ...SITE,
    name: '  ',
    operator_name: null,
    address: undefined,
    restrictions: [{ type: 'WOMEN', capacity: 4 }],
  });
  assert.equal(record.name, null);
  assert.equal(record.operator, null);
  assert.equal(record.address, null);
  assert.equal(record.disabled, null);
  assert.equal(record.charging, null);
});

test('occupancy reads the live total first and bands by free share', () => {
  const at = (free, extra = {}) =>
    normalizeParkingSite({ ...SITE, realtime_free_capacity: free, ...extra });
  assert.equal(freeShare(at(640)), 0.5);
  assert.equal(freeShare(at(640, { realtime_capacity: null })), 640 / 1290);
  // A free count past the total (a reporting glitch) is capped at all free.
  assert.equal(freeShare(at(2000)), 1);
  assert.equal(occupancyBand(at(384)), 'free');
  assert.equal(occupancyBand(at(383)), 'filling');
  assert.equal(occupancyBand(at(128)), 'filling');
  assert.equal(occupancyBand(at(127)), 'full');
  assert.equal(occupancyBand(at(0)), 'full');
  assert.equal(
    freeShare(at(5, { capacity: null, realtime_capacity: null })),
    null,
  );
});

test('a page decodes its sites once each and reports the matched total', () => {
  const page = normalizeParkingPage({
    items: [SITE, { ...SITE }, { ...SITE, id: 7, lat: null }],
    total_count: 79,
    next_path: '/api/public/v3/parking-sites?start=7',
  });
  assert.equal(page.records.length, 1);
  assert.equal(page.total, 79);
  assert.equal(page.returned, 3);
  assert.deepEqual(normalizeParkingPage({ items: [], total_count: 0 }), {
    records: [],
    total: 0,
    returned: 0,
  });
  for (const bad of [null, {}, { items: {} }, { items: [], total_count: -1 }])
    assert.equal(normalizeParkingPage(bad), null);
});

test('contributors are named only where a source publishes one', () => {
  const contributors = normalizeParkingContributors({
    items: [
      { id: 12, attribution_contributor: 'Stadt Karlsruhe' },
      { id: 64, attribution_contributor: '' },
      { id: 7, attribution_contributor: null },
    ],
  });
  assert.deepEqual([...contributors], [[12, 'Stadt Karlsruhe']]);
  assert.equal(normalizeParkingContributors(null).size, 0);
});
