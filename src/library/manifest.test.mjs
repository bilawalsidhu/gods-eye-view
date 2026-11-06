import test from 'node:test';
import assert from 'node:assert/strict';
import {
  libraryEntryIdOf,
  libraryLayerId,
  libraryUpstreamUrl,
  parseLibraryIdList,
  validateLibraryCatalog,
  validateLibraryManifest,
} from './manifest.js';

const dataset = (overrides = {}) => ({
  id: 'example-points',
  kind: 'dataset',
  family: 'infrastructure',
  title: 'Example points',
  provider: 'Example',
  description: 'Points from an example provider.',
  maintainer: 'github:someone',
  coverage: { global: true },
  source: {
    format: 'geojson',
    url: 'https://data.example.org/points.geojson',
    fetch: 'browser-direct',
  },
  licence: {
    name: 'CC BY 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  attribution: { text: 'Example contributors' },
  status: 'community',
  ...overrides,
});

test('a minimal dataset validates and gets its caps filled', () => {
  const { ok, errors, entry } = validateLibraryManifest(dataset());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.equal(entry.source.cacheSeconds, 3600);
  assert.equal(entry.source.maxFeatures, 10_000);
  assert.equal(entry.source.maxBytes, 16 * 1024 * 1024);
  assert.equal(entry.source.key, null);
  assert.equal(entry.licence.operatorOptIn, false);
  assert.ok(Object.isFrozen(entry.source));
});

test('unknown fields are errors, so a typo cannot drop a cap or a licence', () => {
  const result = validateLibraryManifest(
    dataset({ license: {}, source: { ...dataset().source, maxFeature: 5 } }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('license is not a known field'));
  assert.ok(result.errors.includes('source.maxFeature is not a known field'));
});

test('upstream URLs must be https without credentials or fragments', () => {
  assert.ok(libraryUpstreamUrl('https://a.example.org/x?y=1'));
  assert.equal(libraryUpstreamUrl('http://a.example.org/x'), null);
  assert.equal(libraryUpstreamUrl('https://u:p@a.example.org/x'), null);
  assert.equal(libraryUpstreamUrl('https://a.example.org/x#f'), null);
  assert.equal(libraryUpstreamUrl('https://127.0.0.1/x'), null);
  assert.equal(libraryUpstreamUrl('https://localhost/x'), null);
  assert.ok(libraryUpstreamUrl('https://t.example.org/{z}/{x}/{y}.png'));
});

test('a keyed source must be proxied, so a key never reaches the browser', () => {
  const keyed = dataset({
    source: {
      ...dataset().source,
      key: { id: 'firms', in: 'query', name: 'MAP_KEY' },
    },
  });
  assert.ok(
    validateLibraryManifest(keyed).errors.includes(
      'a keyed source must use fetch: proxied',
    ),
  );
  keyed.source.fetch = 'proxied';
  assert.equal(validateLibraryManifest(keyed).ok, true);
});

test('tiles need a {z}/{x}/{y} template and a sane zoom range', () => {
  const tiles = {
    ...dataset(),
    kind: 'tiles',
    source: {
      format: 'xyz',
      url: 'https://t.example.org/{z}/{x}.png',
      fetch: 'browser-direct',
      minZoom: 9,
      maxZoom: 4,
    },
  };
  const { errors } = validateLibraryManifest(tiles);
  assert.ok(errors.includes('source.url must contain {y} or {reverseY}'));
  assert.ok(errors.includes('source.minZoom must not exceed source.maxZoom'));
});

test('a pack names its host switch and is always operator opt-in', () => {
  const pack = {
    ...dataset(),
    kind: 'pack',
    family: 'cameras',
    source: { format: 'host', url: 'https://cams.example.org/' },
    pack: { host: 'cctv', env: 'CCTV_EXAMPLE_ENABLED' },
  };
  assert.ok(
    validateLibraryManifest(pack).errors.includes(
      'a pack is switched by its host: licence.operatorOptIn: true',
    ),
  );
  pack.licence = { ...pack.licence, operatorOptIn: true };
  assert.equal(validateLibraryManifest(pack).ok, true);
  pack.pack = { host: 'radio', env: 'X' };
  assert.equal(validateLibraryManifest(pack).ok, false);
});

test('provider entries are refused with a clear reason until the kind ships', () => {
  assert.ok(
    validateLibraryManifest(dataset({ kind: 'provider' })).errors.includes(
      'provider entries are not supported by this build yet',
    ),
  );
});

test('coverage needs global, countries or a valid bbox', () => {
  assert.ok(
    validateLibraryManifest(dataset({ coverage: {} })).errors.includes(
      'coverage needs global, countries or bbox',
    ),
  );
  assert.equal(
    validateLibraryManifest(dataset({ coverage: { countries: ['us'] } })).ok,
    false,
  );
  assert.equal(
    validateLibraryManifest(dataset({ coverage: { bbox: [10, 0, 5, 1] } })).ok,
    false,
  );
});

test('catalog validation rejects duplicate ids', () => {
  const result = validateLibraryCatalog([dataset(), dataset()]);
  assert.equal(result.ok, false);
  assert.equal(result.entries.length, 1);
  assert.match(result.errors[0], /duplicate id/);
});

test('library layer ids are namespaced and reversible', () => {
  assert.equal(libraryLayerId('example-points'), 'lib-example-points');
  assert.equal(libraryEntryIdOf('lib-example-points'), 'example-points');
  assert.equal(libraryEntryIdOf('cctv'), null);
  assert.equal(libraryEntryIdOf('lib-X'), null);
});

test('operator id lists keep only well-formed ids', () => {
  assert.deepEqual(
    [...parseLibraryIdList(' a-b-c , ,BAD,x, cctv-nyc-dot ')],
    ['a-b-c', 'cctv-nyc-dot'],
  );
});

test('GeoParquet partitions must stay on the source host and be view-bounded', () => {
  const parquet = dataset({
    source: {
      format: 'geoparquet',
      url: 'https://bucket.example.org/set/',
      fetch: 'browser-direct',
      partitions: {
        listUrl: 'https://bucket.example.org?list-type=2&prefix=set/',
        keyBase: 'https://elsewhere.example.org/',
      },
    },
  });
  const { errors } = validateLibraryManifest(parquet);
  assert.ok(errors.some((error) => /partitions needs/.test(error)));
  assert.ok(
    errors.includes('a partitioned source must be view-bounded (source.view)'),
  );
});

test('colorBy needs valid colours and readable legend groups', () => {
  const coloured = dataset({
    display: { colorBy: { field: 'rating', colors: { A: '#008054' } } },
  });
  assert.equal(validateLibraryManifest(coloured).ok, true);
  coloured.display.colorBy.colors.B = 'green';
  assert.ok(
    validateLibraryManifest(coloured).errors.some((error) =>
      /colorBy needs a field/.test(error),
    ),
  );
});

test('a static legend needs labelled colours and cannot double a colorBy legend', () => {
  const tiles = {
    ...dataset(),
    kind: 'tiles',
    source: {
      format: 'xyz',
      url: 'https://t.example.org/{z}/{x}/{y}.png',
      fetch: 'browser-direct',
    },
    display: { legend: [{ label: '< 1', color: '#fff2d1' }] },
  };
  assert.equal(validateLibraryManifest(tiles).ok, true);
  tiles.display.legend.push({ label: '', color: 'red' });
  assert.ok(
    validateLibraryManifest(tiles).errors.some((error) =>
      /display.legend/.test(error),
    ),
  );
});

test('aerial tiles may be bounded, kept on top and hide a no-data fill', () => {
  const tiles = {
    ...dataset(),
    kind: 'tiles',
    coverage: { countries: ['NL'], bbox: [3.2, 50.7, 7.3, 53.6] },
    source: {
      format: 'xyz',
      url: 'https://t.example.org/{z}/{x}/{y}.jpeg',
      fetch: 'browser-direct',
      bounded: true,
    },
    display: { aerial: true, noDataColor: '#ffffff' },
  };
  assert.deepEqual(validateLibraryManifest(tiles).errors, []);
  const broken = {
    ...tiles,
    coverage: { global: true },
    display: { aerial: 'yes', noDataColor: 'white' },
  };
  const { errors } = validateLibraryManifest(broken);
  assert.ok(errors.includes('source.bounded needs coverage.bbox'));
  assert.ok(errors.includes('display.aerial is a boolean for tiles'));
  assert.ok(errors.includes('display.noDataColor must be #rrggbb'));
  const points = dataset({ display: { aerial: true, noDataColor: '#ffffff' } });
  const pointErrors = validateLibraryManifest(points).errors;
  assert.ok(pointErrors.includes('display.aerial is a boolean for tiles'));
  assert.ok(pointErrors.includes('display.noDataColor applies to tiles only'));
});
