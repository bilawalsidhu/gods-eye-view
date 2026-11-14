import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayCoordinate,
  validateHistoricalWellPack,
  historicalWellDetails,
} from './historicalPack.mjs';

const resource = '8b02895f02c14dd1a749bcc5584a5c55';
function fixture() {
  const release = 'a'.repeat(64),
    input = 'b'.repeat(64),
    id = `USGWD-${release}-SYN_1`;
  const url = `https://www.hydroshare.org/resource/${resource}/data/contents/USGWD-Tabular/USGWD_New_Hampshire.csv`;
  const p = displayCoordinate('-71.5', '43.2', 'New Hampshire');
  const quantities = Object.fromEntries(
    [
      'Well Depth (Feet)',
      'Screen Depth (Feet)',
      'Length of Screen (Feet)',
      'Well Capacity (GPM)',
      'Surface Elevation (Feet)',
    ].map((k) => [
      k,
      {
        value: null,
        quality: 'missing',
        issue: null,
        unit: k === 'Well Capacity (GPM)' ? 'gal/min' : 'ft',
      },
    ]),
  );
  const site = {
    id,
    source: 'USGWD',
    sourceUrl: `https://www.hydroshare.org/resource/${resource}/`,
    coordinateReference: 'EPSG:4326',
    longitude: p.longitude,
    latitude: p.latitude,
    readings: [],
    metadataRetrievedAt: '2026-01-01T00:00:00Z',
    metadataSourceUrl: url,
    metadata: {
      id,
      recordType: 'historical-well-catalog-record',
      sourceRecordId: 'SYN_1',
      releaseSha256: release,
      sourceState: 'New Hampshire',
      activeWellStatus: 'not-verified',
      waterSafetyStatus: 'not-assessed',
      sourceCoordinates: {
        longitude: '-71.5',
        latitude: '43.2',
        crs: 'EPSG:4269',
        datum: 'NAD83',
        unit: 'decimal-degrees',
      },
      coordinateOperation: {
        operation: p.code,
        sourceCrs: 'EPSG:4269',
        targetCrs: 'EPSG:4326',
        method: 'EPSG:9603',
        translationMetres: p.translation,
        operationAccuracyMetres: p.accuracy,
        intermediateHeightMetres: 0,
        outputHeight: null,
        epoch: null,
      },
      locationFlags: {
        'Location Verified': 'Unknown',
        'Flag County': '2',
        'Flag State': '0',
        'Flag US': '0',
        'Flag Duplicate': '3',
      },
      provenance: { inputSha256: input, releaseSha256: release, sourceRow: 2 },
      normalizedContentSha256: 'c'.repeat(64),
      quantities,
      quantityErrors: [],
    },
  };
  return {
    schemaVersion: 1,
    kind: 'gev-us-groundwater-wells',
    mode: 'snapshot',
    coverage: { country: 'US', complete: false },
    acquisitions: [
      {
        collection: 'usgwd-historical-baseline',
        url,
        retrievedAt: site.metadataRetrievedAt,
        releaseSha256: release,
        inputSha256: input,
        normalizationManifestSha256: 'd'.repeat(64),
        license: 'CC-BY-4.0',
        attribution: 'Invented fixture; no downloaded records',
      },
    ],
    records: [site],
  };
}
test('regional operations preserve axis order and have explicit geographic limits', () => {
  assert.equal(
    displayCoordinate('-71.5', '43.2', 'New Hampshire').code,
    'EPSG:1188',
  );
  assert.equal(displayCoordinate('-157.8', '21.3', 'Hawaii').code, 'EPSG:1252');
  assert.equal(displayCoordinate('175', '52', 'Alaska').code, 'EPSG:1251');
  assert.equal(displayCoordinate('-175', '52', 'Alaska').code, 'EPSG:1251');
  for (const args of [
    ['43.2', '-71.5', 'New Hampshire'],
    ['-157.8', '21.3', 'Florida'],
    ['NaN', '43.2', 'New Hampshire'],
    ['-71.5', '43.2', 'Hawaii'],
  ])
    assert.equal(displayCoordinate(...args), null);
});
test('historical IDs and explicit invalid measurements remain visible without fake observations', () => {
  const pack = fixture(),
    r = pack.records[0];
  r.metadata.quantities['Length of Screen (Feet)'] = {
    value: null,
    quality: 'invalid',
    issue: 'negative',
    unit: 'ft',
  };
  r.metadata.quantityErrors = [
    { field: 'Length of Screen (Feet)', reason: 'negative', rawValue: '-5' },
  ];
  assert.equal(validateHistoricalWellPack(pack), pack);
  assert.ok(
    historicalWellDetails(r).warnings.some((s) => s.includes('original -5')),
  );
  assert.deepEqual(historicalWellDetails(r).readings, []);
});
test('wrong CRS, unsupported flags, operation tampering and invented precise points refuse', () => {
  const mutations = [
    (p) => (p.records[0].coordinateReference = 'EPSG:4269'),
    (p) => (p.records[0].latitude += 0.001),
    (p) => (p.records[0].metadata.coordinateOperation.operation = 'EPSG:1252'),
    (p) => (p.records[0].metadata.locationFlags['Flag State'] = '1.0'),
    (p) => (p.records[0].metadata.locationFlags['Flag US'] = '1'),
    (p) => p.records[0].readings.push({ value: 12 }),
    (p) => (p.records[0].id = 'USGS-1234'),
    (p) => (p.acquisitions[0].url += '?secret=not-used'),
    (p) => (p.acquisitions[0].license = 'unknown'),
    (p) => p.records.push(p.records[0]),
  ];
  for (const mutate of mutations) {
    const p = fixture();
    mutate(p);
    assert.throws(() => validateHistoricalWellPack(p));
  }
});
test('historical dispatch cannot exempt a USGS subset from the original validator', () => {
  const pack = fixture();
  pack.records.push({ id: 'USGS-1234' });
  pack.acquisitions.push({ collection: 'monitoring-locations' });
  let calls = 0;
  assert.throws(() =>
    validateHistoricalWellPack(pack, (subset) => {
      calls++;
      assert.deepEqual(subset.records, [{ id: 'USGS-1234' }]);
      assert.equal(subset.acquisitions.length, 1);
      throw new TypeError('strict USGS refusal');
    }),
  );
  assert.equal(calls, 1);
  assert.throws(() => validateHistoricalWellPack(pack));
});

test('numeric native ID refuses before renderer string operations', () => {
  const p = fixture();
  p.records[0].metadata.sourceRecordId = 123;
  p.records[0].id = `USGWD-${'a'.repeat(64)}-123`;
  p.records[0].metadata.id = p.records[0].id;
  assert.throws(() => validateHistoricalWellPack(p));
});

function derivedFixture() {
  const p = fixture(),
    a = p.acquisitions[0];
  a.url = a.url
    .replace('USGWD-Tabular', 'USGWD-Geospatial')
    .replace('.csv', '.zip');
  p.records[0].metadataSourceUrl = a.url;
  a.derivation = {
    policy: 'usgwd-dbf-attributes-v1',
    archiveSha256: 'e'.repeat(64),
    archiveMd5: 'f'.repeat(32),
    member: 'USGWD_New Hampshire.dbf',
    memberSha256: 'a'.repeat(64),
    sourceCrs: 'EPSG:4269',
    recordCount: 1,
  };
  return p;
}
test('verified DBF derivation survives strict historical admission', () => {
  const p = derivedFixture();
  assert.equal(validateHistoricalWellPack(p), p);
});
test('ZIP artifacts cannot hide missing or contradictory derivation evidence', () => {
  for (const mutate of [
    (p) => delete p.acquisitions[0].derivation,
    (p) => (p.acquisitions[0].derivation = null),
    (p) => (p.acquisitions[0].derivation.sourceCrs = 'EPSG:4326'),
    (p) => (p.acquisitions[0].derivation.member = '../source.dbf'),
    (p) => (p.acquisitions[0].derivation.archiveSha256 = 'wrong'),
    (p) => (p.acquisitions[0].derivation.archiveMd5 = ['f'.repeat(32)]),
    (p) => (p.acquisitions[0].derivation.recordCount = 0),
    (p) => (p.acquisitions[0].derivation.recordCount = 2000001),
    (p) => (p.acquisitions[0].derivation.extra = true),
    (p) => (p.records[0].metadata.provenance.sourceRow = 3),
    (p) => (p.acquisitions[0].url += '?token=not-used'),
  ]) {
    const p = derivedFixture();
    mutate(p);
    assert.throws(() => validateHistoricalWellPack(p));
  }
  const p = fixture();
  p.acquisitions[0].derivation = derivedFixture().acquisitions[0].derivation;
  assert.throws(() => validateHistoricalWellPack(p));
});
