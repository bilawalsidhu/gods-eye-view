import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAnnotationResolver } from './resolver.js';
import { createAnalystEngine } from '../data/analystEngine.js';
import { decodeRing, findAdminArea } from '../data/adminBoundaries.js';
import { FEATURE_SOURCE_METHODS } from '../sources/featureSource.js';

const pack = JSON.parse(
  readFileSync(
    new URL(
      '../data/local_data/argentina_admin/departments.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const CAPITALS = [
  ['Catamarca', -28.47, -65.78],
  ['Córdoba', -31.42, -64.19],
  ['Corrientes', -27.47, -58.83],
  ['La Pampa', -36.62, -64.29],
  ['La Rioja', -29.41, -66.86],
  ['Mendoza', -32.89, -68.85],
  ['Misiones', -27.37, -55.9],
  ['Salta', -24.79, -65.41],
  ['San Juan', -31.54, -68.53],
  ['Santiago del Estero', -27.79, -64.26],
  ['Tucumán', -26.83, -65.2],
];

function viewerAt(lat, lon) {
  return {
    camera: {
      positionCartographic: {
        latitude: (lat * Math.PI) / 180,
        longitude: (lon * Math.PI) / 180,
        height: 20_000,
      },
    },
  };
}

function resolver() {
  return createAnnotationResolver({
    featureSource: Object.fromEntries(
      FEATURE_SOURCE_METHODS.map((method) => [
        method,
        async () => {
          assert.fail(`Unexpected remote boundary lookup: ${method}`);
        },
      ]),
    ),
  });
}

function geocoder(place = null) {
  const calls = [];
  return {
    calls,
    async geocode(name) {
      calls.push(name);
      return { place };
    },
  };
}

const POSADAS = {
  lat: -27.37,
  lng: -55.9,
  label: 'Capital, Misiones, Argentina',
  name: 'Capital',
  types: ['administrative_area_level_2', 'political'],
};

test('IGN analyst: all 529 qualified units retain their original rings and source', async () => {
  const { resolveRegionRingForQuery } = resolver();
  const search = geocoder();
  assert.equal(pack.features.length, 529);
  for (const entry of pack.features) {
    const query = `${entry.full}, ${entry.region}, Argentina`;
    const result = await resolveRegionRingForQuery(query, undefined, search);
    assert.deepEqual(
      result?.ring,
      decodeRing(entry.polygons[0][0], entry.d ?? pack.meta.decimals),
      query,
    );
    assert.equal(result.source, 'ign-argentina', query);
  }
  assert.deepEqual(search.calls, []);
});

test('IGN analyst and annotations: camera selects each of the eleven Capital departments', async () => {
  const { resolveRegionRingForQuery, resolveAnnotationTarget } = resolver();
  const search = geocoder();
  for (const [province, lat, lon] of CAPITALS) {
    const viewer = viewerAt(lat, lon);
    const expected = await findAdminArea(`Departamento Capital, ${province}`);
    const region = await resolveRegionRingForQuery(
      'Departamento Capital',
      undefined,
      search,
      { viewer },
    );
    assert.deepEqual(region?.ring, expected.ring, province);
    const annotation = await resolveAnnotationTarget({
      target: 'Departamento Capital',
      viewer,
      placeSearch: search,
      footprint: true,
    });
    assert.deepEqual(annotation?.polygons, expected.polygons, province);
    const explicit = await resolveRegionRingForQuery(
      'Departamento Capital, Misiones',
      undefined,
      search,
      { viewer },
    );
    assert.deepEqual(
      explicit.ring,
      (await findAdminArea('Departamento Capital, Misiones')).ring,
      'an explicit province wins over a camera in another province',
    );
  }
  assert.deepEqual(search.calls, []);
});

test('IGN analyst: an unanchored duplicate needs geocoding instead of choosing the largest department', async () => {
  const { resolveRegionRingForQuery } = resolver();
  const miss = geocoder();
  assert.equal(
    await resolveRegionRingForQuery('Departamento Capital', undefined, miss),
    null,
  );
  assert.deepEqual(miss.calls, ['Departamento Capital']);
  const search = geocoder(POSADAS);
  const result = await resolveRegionRingForQuery(
    'Departamento Capital',
    undefined,
    search,
  );
  assert.deepEqual(
    result?.ring,
    (await findAdminArea('Departamento Capital, Misiones')).ring,
  );
  assert.equal(result.source, 'ign-argentina');
  assert.deepEqual(search.calls, ['Departamento Capital']);
});

test('IGN analyst: geocoder-confirmed county retains provenance and activates the IGN credit', async () => {
  const { resolveRegionRingForQuery } = resolver();
  const credits = [];
  const viewer = {
    ...viewerAt(-27.37, -55.9),
    creditDisplay: {
      addStaticCredit: (credit) => credits.push(credit.html),
    },
  };
  const result = await resolveRegionRingForQuery(
    'Capital',
    undefined,
    geocoder(POSADAS),
    { viewer },
  );
  assert.equal(result?.source, 'ign-argentina');
  assert.deepEqual(
    result.ring,
    (await findAdminArea('Departamento Capital, Misiones')).ring,
  );
  assert.ok(
    credits.some(
      (html) =>
        html.includes(
          'Instituto Geográfico Nacional de la República Argentina',
        ) && html.includes('https://www.ign.gob.ar/descargas/tyc1.html'),
    ),
  );
});

for (const cancel of ['abort', 'supersede']) {
  test(`IGN analyst: ${cancel} preserves the previous IGN cohort and source after a late geocode`, async () => {
    const started = Promise.withResolvers();
    const late = Promise.withResolvers();
    const controller = new AbortController();
    let current = true;
    const { resolveRegionRingForQuery } = resolver();
    const search = {
      geocode() {
        started.resolve();
        return late.promise;
      },
    };
    const engine = createAnalystEngine({
      getRecords: () => [
        { id: 'POSADAS', lat: -27.37, lon: -55.9, onGround: false },
        { id: 'CORDOBA', lat: -31.42, lon: -64.19, onGround: true },
      ],
      resolveRegionRing: (name, signal) =>
        resolveRegionRingForQuery(name, signal, search, { budgetMs: Infinity }),
    });
    const first = await engine.query({
      layers: ['flights'],
      scope: { kind: 'region', name: 'Departamento Capital, Misiones' },
    });
    assert.deepEqual(
      first.items.map((item) => item.id),
      ['POSADAS'],
    );
    assert.equal(first.coverage.scopeSource, 'ign-argentina');
    let commits = 0;
    const pending = engine.query(
      { layers: ['flights'], scope: { kind: 'region', name: 'Capital' } },
      {
        signal: controller.signal,
        isCurrent: () => current,
        beforeCommit: () => {
          commits++;
        },
      },
    );
    await started.promise;
    if (cancel === 'abort') controller.abort();
    else current = false;
    late.resolve({ place: { ...POSADAS, lat: -31.42, lng: -64.19 } });
    assert.equal((await pending).code, 'CANCELLED');
    assert.equal(commits, 0);
    const followUp = await engine.query({
      followUp: true,
      filters: [{ field: 'onGround', op: 'eq', value: false }],
    });
    assert.deepEqual(
      followUp.items.map((item) => item.id),
      ['POSADAS'],
    );
    assert.equal(followUp.coverage.scopeSource, 'ign-argentina');
    assert.equal(followUp.coverage.scope, first.coverage.scope);
  });
}

test('IGN annotation: cancellation during the deferred bundled county lookup cannot return an obsolete outline', async () => {
  const controller = new AbortController();
  const { resolveAnnotationTarget } = resolver();
  const target = await resolveAnnotationTarget({
    target: 'Capital',
    viewer: viewerAt(-27.37, -55.9),
    placeSearch: geocoder(POSADAS),
    footprint: true,
    deferFootprint: true,
    signal: controller.signal,
  });
  const pending = target.resolveOutline();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
