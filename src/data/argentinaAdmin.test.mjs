import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
  buildPack,
  contentHash,
} from '../../scripts/build-argentina-admin.mjs';
import {
  findAdminArea,
  findAdminAreaAt,
  packLoads,
  decodeRing,
  polygonsContain,
} from './adminBoundaries.js';

const URL = new globalThis.URL(
  './local_data/argentina_admin/departments.json',
  import.meta.url,
);
const pack = JSON.parse(readFileSync(URL, 'utf8'));

test('Argentine outlines load once, only when asked, without the global or US packs', async () => {
  assert.deepEqual(packLoads, {
    admin1: 0,
    counties: 0,
    countries: 0,
    argentina: 0,
  });
  for (const query of [
    'Partido de La Matanza, Buenos Aires, Argentina',
    'La Matanza partido, 06',
    'PARTIDO LA MATANZA, AR',
  ]) {
    const result = await findAdminArea(query);
    assert.equal(result?.id, '06427', query);
    assert.equal(result.source, 'ign-argentina');
    assert.equal(result.kind, 'county');
    assert.equal(result.name, 'Partido de La Matanza');
    assert.equal(result.region, 'Buenos Aires');
    assert.equal(result.country, 'Argentina');
    assert.ok(polygonsContain(result.polygons, -34.68, -58.56));
  }
  assert.deepEqual(packLoads, {
    admin1: 0,
    counties: 0,
    countries: 0,
    argentina: 1,
  });
});

test('department names respect province, country, type and near-camera disambiguation', async () => {
  assert.equal(
    (await findAdminArea('Departamento Capital, Misiones'))?.id,
    '54028',
  );
  assert.equal(
    (await findAdminArea('Departamento Capital, Córdoba, República Argentina'))
      ?.id,
    '14014',
  );
  assert.equal(
    (
      await findAdminArea('Departamento Capital', {
        near: { lat: -27.37, lon: -55.9 },
      })
    )?.id,
    '54028',
  );
  assert.equal(
    (await findAdminArea('Departamento San Martín, Mendoza'))?.id,
    '50098',
  );
  assert.equal((await findAdminArea('Comuna 1, CABA, Argentina'))?.id, '02007');
  for (const query of [
    'Departamento Capital, Paraguay',
    'Partido de La Matanza, Córdoba',
    'Partido Capital, Misiones',
    'Comuna 1, Buenos Aires',
    'Departamento Capital hospital, Misiones',
  ])
    assert.equal(await findAdminArea(query), null, query);
});

test('geocoder-confirmed county asks require the matching name and containing geometry', async () => {
  assert.equal(
    (await findAdminAreaAt(['Capital'], -27.37, -55.9, 'county'))?.id,
    '54028',
  );
  assert.equal(
    (await findAdminAreaAt(['La Matanza'], -34.68, -58.56, 'county'))?.id,
    '06427',
  );
  assert.equal(
    await findAdminAreaAt(['La Matanza'], -27.37, -55.9, 'county'),
    null,
  );
  assert.notEqual(
    (await findAdminAreaAt(['Capital'], -27.37, -55.9, 'state'))?.source,
    'ign-argentina',
  );
  assert.notEqual(
    (await findAdminArea('Posadas'))?.source,
    'ign-argentina',
    'bare cities keep their existing lookup',
  );
  assert.notEqual((await findAdminArea('Córdoba'))?.source, 'ign-argentina');
});

test('all 529 official units retain names, IDs, provenance and usable bounded geometry', () => {
  assert.equal(pack.features.length, 529);
  assert.equal(new Set(pack.features.map((f) => f.id)).size, 529);
  assert.deepEqual(
    Object.fromEntries(
      ['Departamento', 'Partido', 'Comuna'].map((kind) => [
        kind,
        pack.features.filter((f) => f.type === kind).length,
      ]),
    ),
    { Departamento: 379, Partido: 135, Comuna: 15 },
  );
  assert.ok(statSync(URL).size < 1_000_000, 'lazy pack stays under 1 MB');
  assert.equal(pack.meta.sourceUpdatedAt, null);
  assert.equal(pack.meta.retrievedAt, '2026-10-15');
  for (const feature of pack.features) {
    assert.equal(feature.id, feature.sourceProperties.in1);
    assert.equal(feature.full, feature.sourceProperties.fna);
    assert.equal(feature.regionCode, feature.id.slice(0, 2));
    assert.ok(feature.polygons.length, feature.id);
    for (const poly of feature.polygons)
      for (const encoded of poly) {
        assert.ok(encoded.length >= 8 && encoded.length % 2 === 0, feature.id);
        assert.ok(encoded.every(Number.isInteger));
        const ring = decodeRing(encoded, feature.d ?? pack.meta.decimals);
        assert.ok(
          ring.every(
            ([lon, lat]) =>
              Number.isFinite(lon) &&
              Number.isFinite(lat) &&
              Math.abs(lon) <= 180 &&
              Math.abs(lat) <= 90,
          ),
        );
      }
  }
});

test('source digest ignores response timestamps/order, but catches altered coordinates', () => {
  const first = {
    properties: { in1: '02' },
    geometry: { type: 'Point', coordinates: [-58, -34] },
  };
  const second = { properties: { in1: '06' }, geometry: null };
  assert.equal(
    contentHash({ timeStamp: 'old', features: [first, second] }),
    contentHash({ timeStamp: 'new', features: [second, first] }),
  );
  const before = contentHash({ features: [first] });
  first.geometry.coordinates[0] = -60;
  assert.notEqual(contentHash({ features: [first] }), before);
});

test('builder rejects duplicate IDs, missing provinces, incomplete responses and invalid geometry', () => {
  const provinces = {
    features: [
      { properties: { in1: '02', nam: 'Ciudad Autónoma de Buenos Aires' } },
    ],
  };
  const feature = {
    id: 'departamento.1',
    properties: {
      in1: '02007',
      fna: 'Comuna 1',
      nam: 'Comuna 1',
      gna: 'Comuna',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-58.4, -34.6],
          [-58.3, -34.6],
          [-58.3, -34.5],
          [-58.4, -34.5],
          [-58.4, -34.6],
        ],
      ],
    },
  };
  const departments = { totalFeatures: 1, features: [feature] };
  const provenance = {
    sources: {
      departments: { featureCount: 1 },
      provinces: { featureCount: 1 },
    },
  };
  assert.equal(
    buildPack(departments, provinces, provenance).features[0].id,
    '02007',
  );
  assert.throws(
    () =>
      buildPack({ ...departments, totalFeatures: 2 }, provinces, provenance),
    /Incomplete/,
  );
  assert.throws(
    () =>
      buildPack(
        departments,
        { features: [{ properties: { in1: '06' } }] },
        provenance,
      ),
    /Invalid/,
  );
  assert.throws(
    () =>
      buildPack({ totalFeatures: 2, features: [feature, feature] }, provinces, {
        sources: {
          departments: { featureCount: 2 },
          provinces: { featureCount: 1 },
        },
      }),
    /Invalid/,
  );
  feature.geometry.coordinates[0][0][1] = -95;
  assert.throws(
    () => buildPack(departments, provinces, provenance),
    /Invalid IGN coordinate/,
  );
});
