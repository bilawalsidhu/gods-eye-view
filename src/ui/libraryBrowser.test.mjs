import test from 'node:test';
import assert from 'node:assert/strict';
import {
  libraryReasonText,
  libraryRowMatches,
  libraryStatTiles,
  sortLibraryRows,
} from './libraryBrowser.js';
import { libraryEntry } from '../library/catalog.js';
import { localInfrastructureOverlayCopy } from '../data/localGeojsonCore.js';

const row = (id, extra = {}) => ({
  entry: libraryEntry(id),
  available: true,
  added: false,
  ...extra,
});
const all = { query: '', family: '', availableOnly: false };

test('Browse filters by text, theme and what this instance serves', () => {
  assert.ok(
    libraryRowMatches(row('eia-power-plants'), { ...all, query: 'eia' }),
  );
  assert.ok(
    libraryRowMatches(row('eia-power-plants'), { ...all, query: 'us' }),
  );
  assert.equal(
    libraryRowMatches(row('eia-power-plants'), { ...all, query: 'volcano' }),
    false,
  );
  assert.equal(
    libraryRowMatches(row('eia-power-plants'), { ...all, family: 'events' }),
    false,
  );
  assert.equal(
    libraryRowMatches(row('cctv-nyc-dot', { available: false }), {
      ...all,
      availableOnly: true,
    }),
    false,
  );
});

test('the guidance names the exact operator switch', () => {
  assert.match(
    libraryReasonText({ ...row('cctv-nyc-dot'), available: false }),
    /CCTV_NYC_ENABLED=1/,
  );
  assert.match(
    libraryReasonText({ ...row('cctv-nyc-dot'), available: true }),
    /part of the CCTV layer/,
  );
  assert.match(
    libraryReasonText({
      ...row('gvp-holocene-volcanoes'),
      available: false,
      reason: 'server-unavailable',
    }),
    /static build/,
  );
  assert.equal(libraryReasonText(row('nasa-eonet-events')), '');
});

test('library features show their manifest card lines on the map', () => {
  const copy = localInfrastructureOverlayCopy(
    {
      name: 'Grand Coulee',
      __gevDetails: ['PrimSource: hydroelectric', 'Total_MW: 6809', 'extra'],
    },
    'lib-eia-power-plants',
  );
  assert.deepEqual(copy, {
    title: 'Grand Coulee',
    details: ['PrimSource: hydroelectric', 'Total_MW: 6809'],
  });
});

test('Browse lists what a viewer can add first and packs last', () => {
  const order = sortLibraryRows([
    row('cctv-nyc-dot', { available: false }),
    row('nasa-eonet-events'),
    row('gvp-holocene-volcanoes', { available: false }),
    row('eia-power-plants'),
  ]).map(({ entry }) => entry.id);
  assert.deepEqual(order, [
    'nasa-eonet-events',
    'eia-power-plants',
    'gvp-holocene-volcanoes',
    'cctv-nyc-dot',
  ]);
});

test('the stat tiles summarise the library in words and compact numbers', () => {
  const tiles = libraryStatTiles({
    entries: 8,
    kinds: { dataset: 3, tiles: 2, pack: 3 },
    themes: ['cameras', 'environment', 'events', 'imagery', 'infrastructure'],
    available: 5,
    unavailable: 3,
    added: 2,
    on: 1,
    features: 3712,
    featureLayers: 2,
  });
  assert.deepEqual(
    tiles.map(({ id, value, detail }) => [id, value, detail]),
    [
      ['entries', '8', '3 datasets · 2 tile layers · 3 packs'],
      ['themes', '5', ''],
      ['added', '2', '1 on the map'],
      ['features', '3.7K', 'from 2 datasets'],
    ],
  );
  const empty = libraryStatTiles({
    entries: 1,
    kinds: { dataset: 1, tiles: 0, pack: 0 },
    themes: ['events'],
    available: 1,
    unavailable: 0,
    added: 0,
    on: 0,
    features: 0,
    featureLayers: 0,
  });
  assert.deepEqual(
    empty.map(({ value, detail }) => [value, detail]),
    [
      ['1', '1 dataset · 0 tile layers · 0 packs'],
      ['1', ''],
      ['0', 'none yet'],
      ['—', 'switch on a dataset to load features'],
    ],
  );
});

test('an imagery card lists type, resolution, years flown and refresh', async () => {
  const { imagerySpecs } = await import('./libraryBrowser.js');
  const specs = imagerySpecs({
    imagery: {
      type: 'ortho',
      trueOrtho: true,
      resolution: '5 cm',
      vintage: '2024',
      updateCycle: 'Annual',
    },
  });
  assert.deepEqual(
    specs.map(({ label }) => label),
    ['Type', 'Resolution', 'Flown', 'Updates'],
  );
  assert.equal(specs[0].value, 'True orthophoto');
  assert.equal(specs[1].value, '5 cm');
  assert.equal(
    imagerySpecs(libraryEntry('ign-orthophotos-france'))[0].value,
    'Orthophoto',
  );
  assert.deepEqual(imagerySpecs(libraryEntry('eia-power-plants')), []);
});
