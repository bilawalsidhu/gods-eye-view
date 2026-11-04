import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  indexImagingSensors,
  matchImagingSensor,
  zoomableSwathKm,
} from './sensors.js';
import { loadImagingSensors } from '../../data/imagingSensors.js';

const PACK_URL = new URL(
  '../../data/local_data/imaging_sensors/imaging_sensors.json',
  import.meta.url,
);

const PACK = {
  entries: [
    {
      id: 'worldview-3',
      label: 'WorldView-3',
      match: { norad: [40115], nameRegex: '^WORLDVIEW-3' },
      narrowestSwathKm: 13.1,
      swathConfirmed: true,
    },
    {
      id: 'iceye',
      label: 'ICEYE',
      match: { nameRegex: '^ICEYE-X\\d+' },
      narrowestSwathKm: 5,
      swathConfirmed: true,
    },
    {
      id: 'broken',
      label: 'Broken pattern',
      match: { norad: [1], nameRegex: '([' },
      narrowestSwathKm: 9,
      swathConfirmed: true,
    },
    {
      id: 'blacksky',
      label: 'BlackSky',
      match: { nameRegex: '^GLOBAL-\\d+$' },
      narrowestSwathKm: null,
      swathConfirmed: false,
    },
  ],
};

test('a satellite matches its sensor by NORAD number, then by name', () => {
  const index = indexImagingSensors(PACK);
  assert.equal(
    matchImagingSensor(index, { noradId: 40115 })?.id,
    'worldview-3',
  );
  // An id match wins over a name that says otherwise.
  assert.equal(
    matchImagingSensor(index, { noradId: 40115, name: 'ICEYE-X9' })?.id,
    'worldview-3',
  );
  assert.equal(
    matchImagingSensor(index, { noradId: 99999, name: ' iceye-x14 ' })?.id,
    'iceye',
  );
  assert.equal(matchImagingSensor(index, { noradId: 1 })?.id, 'broken');
  assert.equal(matchImagingSensor(index, { name: 'STARLINK-1007' }), null);
  assert.equal(matchImagingSensor(null, { noradId: 40115 }), null);
});

test('only a confirmed swath opens zoom steps past 8x', () => {
  const index = indexImagingSensors(PACK);
  assert.equal(
    zoomableSwathKm(matchImagingSensor(index, { noradId: 40115 })),
    13.1,
  );
  assert.equal(
    zoomableSwathKm(matchImagingSensor(index, { name: 'GLOBAL-21' })),
    null,
  );
  assert.equal(zoomableSwathKm(null), null);
  assert.equal(
    zoomableSwathKm({ swathConfirmed: true, narrowestSwathKm: 0 }),
    null,
    'no swath to zoom to',
  );
});

test('the bundled pack is well formed and cites its sources', () => {
  const pack = JSON.parse(readFileSync(PACK_URL, 'utf8'));
  assert.ok(pack.entries.length >= 40);
  assert.ok(
    readFileSync(PACK_URL).length < 60_000,
    'small enough for the layer',
  );
  const ids = new Set();
  for (const entry of pack.entries) {
    assert.ok(entry.id && !ids.has(entry.id), `unique id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.match.norad || entry.match.nameRegex, entry.id);
    if (entry.match.nameRegex) new RegExp(entry.match.nameRegex);
    assert.ok(entry.sources.length > 0, `${entry.id} cites a source`);
    if (entry.swathConfirmed) {
      assert.ok(entry.narrowestSwathKm > 0, entry.id);
      // The narrowest *standard* swath: sampling modes (Himawari's landmark
      // area) and older generations (Dove Classic) may be narrower.
      const swaths = entry.modes
        .map((mode) => mode.swathKm)
        .filter(Number.isFinite);
      assert.ok(
        swaths.includes(entry.narrowestSwathKm),
        `${entry.id}: the narrowest swath is one of its modes`,
      );
    }
  }
});

test('the pack cites no reseller, links its datasheets and names its own fields', () => {
  const pack = JSON.parse(readFileSync(PACK_URL, 'utf8'));
  // Resellers, Gunter's Space Page, and the Copernicus portal whose terms
  // forbid reuse.
  const excluded =
    /euspaceimaging\.com|apollomapping\.com|landinfo\.com|satimagingcorp\.com|space\.skyrocket\.de|dataspace\.copernicus\.eu/;
  const fields = new Set(['altitudeKm', 'narrowestSwathKm', 'swathKm', 'gsdM']);
  for (const entry of pack.entries) {
    for (const source of entry.sources)
      assert.doesNotMatch(source, excluded, `${entry.id}: ${source}`);
    // A bare file-host datasheet is cited beside the operator page that
    // links it.
    if (entry.sources.some((source) => /cdn\.sanity\.io/.test(source)))
      assert.ok(
        entry.sources.some((source) => /^https:\/\/vantor\.com\//.test(source)),
        `${entry.id}: the Vantor page for its datasheet`,
      );
    // An unverified value is named by the pack's own field.
    for (const note of entry.unverified) {
      const [field] = /^[A-Za-z_]+/.exec(note) ?? [''];
      if (/^[a-z]+(_[a-z]+)+$|^[a-z]+[A-Z]\w*$/.test(field))
        assert.ok(fields.has(field), `${entry.id}: unknown field ${field}`);
    }
  }
});

test('the pack loads once and matches real catalog names', async () => {
  const index = await loadImagingSensors();
  assert.equal(index, await loadImagingSensors(), 'loaded once');
  const cases = [
    [{ noradId: 49260, name: 'LANDSAT 9' }, 'landsat-8-9'],
    [{ noradId: 40115, name: 'WORLDVIEW-3 (WV-3)' }, 'worldview-3'],
    [{ noradId: 1, name: 'FLOCK 4Q-12' }, 'planetscope'],
    [{ noradId: 1, name: 'ICEYE-X40' }, 'iceye'],
    [{ noradId: 1, name: 'SKYSAT-C19' }, 'skysat'],
  ];
  for (const [satellite, id] of cases)
    assert.equal(matchImagingSensor(index, satellite)?.id, id, satellite.name);
});
