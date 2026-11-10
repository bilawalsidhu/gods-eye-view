import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createAirportsLayer } from './airports.js';
import { localInfrastructureOverlayCopy } from './localGeojsonCore.js';
import {
  createInfrastructureSource,
  parseGeojsonLines,
} from '../sources/infrastructureData.js';

const text = readFileSync(
  new URL('./local_data/airports/airports.geojsonl', import.meta.url),
  'utf8',
);
const features = parseGeojsonLines(text);
const aerodromes = features.filter((f) => f.properties.type === 'aerodrome');
const byIcao = new Map(aerodromes.map((f) => [f.properties.tags.icao, f]));
const newBodo = aerodromes.find(
  (f) => f.properties.tags.name === 'Nye Bodø lufthavn',
);

test('the bundled Norway airports keep their identities, codes and runways', () => {
  assert.equal(features.length, 229);
  assert.equal(aerodromes.length, 90);
  assert.equal(new Set(features.map((f) => f.id)).size, 229);
  for (const f of aerodromes.filter((f) => f !== newBodo))
    assert.match(f.properties.tags.icao, /^EN[A-Z]{2}$/);
  for (const [icao, name] of [
    ['ENGM', 'Oslo lufthavn, Gardermoen'],
    ['ENBO', 'Bodø lufthavn - Bådådjo girddesalljo'],
    ['ENZV', 'Stavanger lufthavn, Sola'],
    ['ENSB', 'Svalbard lufthavn'],
  ])
    assert.equal(byIcao.get(icao).properties.tags.name, name);
  const runways = features.filter((f) => f.properties.role === 'runway');
  assert.equal(runways.length, 137);
  assert.ok(runways.every((f) => f.geometry.type === 'Polygon'));
  assert.equal(
    runways.filter((f) => f.properties.tags.icao === 'ENGM').length,
    2,
  );
});

test('new Bodø Airport is drawn as construction with its project facts', () => {
  assert.deepEqual(
    features
      .filter((f) => f.properties.stroke === '#ffb000')
      .map((f) => [f.id, f.geometry.type, f.properties.role ?? null]),
    [
      [714425964, 'Point', null],
      ['714425964:site', 'Polygon', 'site'],
      [1019473337, 'Polygon', 'runway'],
      [539307318, 'Polygon', 'terminal'],
    ],
  );
  assert.deepEqual(localInfrastructureOverlayCopy(newBodo.properties, 'local-airports'), {
    title: 'Nye Bodø lufthavn',
    details: ['Avinor', 'Under construction · opens 2029 · runway 2750 m'],
  });
  assert.deepEqual(
    localInfrastructureOverlayCopy(
      byIcao.get('ENBO').properties,
      'local-airports',
    ),
    {
      title: 'Bodø lufthavn',
      details: ['ENBO · BOO · Avinor', 'Military / public'],
    },
  );
});

test('analyst records list airports, never their drawn runways', async () => {
  const source = createInfrastructureSource({
    fetchImpl: async () => ({ ok: true, text: async () => text }),
  });
  const records = await source.getRecords('local-airports');
  assert.equal(records.length, 90);
  const torp = records.find((r) => r.icao === 'ENTO');
  assert.equal(torp.name, 'Sandefjord lufthavn, Torp');
  assert.equal(torp.iata, 'TRF');
  assert.equal(
    records.find((r) => r.name === 'Nye Bodø lufthavn').status,
    'under construction',
  );
});

test('a runway is drawn without a stem, card or picking context', async (t) => {
  const aerodrome = byIcao.get('ENBO');
  const runway = features.find(
    (f) => f.properties.role === 'runway' && f.properties.tags.icao === 'ENBO',
  );
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    text: async () => `${JSON.stringify(aerodrome)}\n${JSON.stringify(runway)}\n`,
  }));
  const records = new Map();
  const layer = createAirportsLayer(
    {
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    registerEntityContext: (entity, metadata) =>
      records.set(metadata.id, metadata),
    selectEntityContext() {},
    clearSelectedEntityContextForLayer() {},
    removeEntityContextsForLayer() {},
    governorRequestRender() {},
    showOsmCredit() {},
    hideOsmCredit() {},
    },
    {
      screenSpaceEventHandlerFactory: () => ({
        setInputAction() {},
        destroy() {},
      }),
    },
  );
  const sources = new Cesium.DataSourceCollection();
  const viewer = {
    dataSources: sources,
    scene: {
      canvas: {},
      preRender: new Cesium.Event(),
      requestRender() {},
      screenSpaceCameraController: { enableInputs: true },
      pick: () => undefined,
    },
    camera: { moveEnd: new Cesium.Event(), flyTo() {} },
  };
  t.after(() => layer.destroy(viewer));
  await layer.enable(viewer);
  assert.equal(layer.getStats().count, 1);
  assert.deepEqual(
    [...records.values()].map((r) => r.label),
    ['Bodø lufthavn'],
  );
  const drawn = sources.get(0).entities.values.find((e) => e.properties.role);
  assert.ok(drawn.polygon);
  assert.equal(drawn.polyline, undefined, 'no stem');
});
