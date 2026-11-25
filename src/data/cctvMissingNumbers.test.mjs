import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fallbackHeadingFromId,
  isLikelyCataloniaCoordinate,
  toFiniteNumber,
} from '../../server/providers/cctv/normalize.js';
import {
  loadCaltransSourcesFromOpenData,
  loadTallinnSourcesFromCatalog,
  loadTflSourcesFromOpenData,
  parseCataloniaXml,
} from '../../server/providers/cctv/sources.js';
import { cctvProxy } from '../../server/providers/cctv.js';
import { createCatalog } from '../layers/cctv/catalog.js';
import { createModel } from '../layers/cctv/model.js';

/** Values `Number` reads as 0 (or 1) although they carry no number. */
const ABSENT = [null, undefined, '', ' ', false, true];

/** Set env vars for one test and restore them afterwards. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Silence the loaders' progress and failure logging. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

/** The production browser model; only the catalog's pose pass is stubbed. */
function browserModel() {
  const parts = {};
  parts.model = createModel({
    state: {},
    services: { focus: {} },
    parts,
    source: {},
  });
  return parts.model;
}

/** The browser catalog over the production model. */
function browserCatalog(model, cityPois = {}) {
  return createCatalog({
    state: {},
    services: { locations: { CITY_POIS: cityPois } },
    parts: { model: { ...model, ensureCameraPose: () => {} } },
    source: {},
  });
}

/** GET /api/cctv/sources through the real proxy middleware. */
async function requestSources(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  const res = {
    writeHead(status, headers) {
      Object.assign(this, { status, headers });
    },
    end(body) {
      this.body = body;
    },
  };
  await handler({ url: '/sources', method: 'GET' }, res);
  assert.equal(res.status, 200);
  return JSON.parse(res.body);
}

test('absent, blank and boolean values take the fallback on both sides of the source list', () => {
  const { safeNumber } = browserModel();
  for (const value of ABSENT) {
    assert.ok(Number.isNaN(toFiniteNumber(value)), `server ${String(value)}`);
    assert.equal(toFiniteNumber(value, 15), 15, `server ${String(value)}`);
    assert.ok(Number.isNaN(safeNumber(value)), `browser ${String(value)}`);
    assert.equal(safeNumber(value, 74), 74, `browser ${String(value)}`);
  }
  for (const [value, expected] of [
    [0, 0],
    ['0', 0],
    [-17, -17],
    [' 12.5 ', 12.5],
  ]) {
    assert.equal(toFiniteNumber(value, 99), expected);
    assert.equal(safeNumber(value, 99), expected);
  }
});

test('a source-pack camera that omits or nulls its pose gets the browser defaults, not the clamp floors', async (t) => {
  quiet(t);
  const pose = {
    headingDeg: null,
    pitchDeg: null,
    fovDeg: null,
    rangeM: null,
    mountHeightM: null,
    groundElevationM: null,
  };
  const at = { cityId: 'austin', lat: 30.2672, lon: -97.7431 };
  withEnv(t, {
    CCTV_SOURCES_FILE: path.join(tmpdir(), 'gev-no-such-pack.json'),
    CCTV_SOURCES_JSON: JSON.stringify([
      { id: 'pack-pose-omitted', ...at, feedType: 'image' },
      { id: 'pack-pose-null', ...at, ...pose, feedType: 'image' },
      { id: 'pack-coords-null', lat: null, lon: null, feedType: 'image' },
      { id: 'pack-coords-blank', lat: '', lon: ' ', feedType: 'image' },
    ]),
  });

  const body = await requestSources(cctvProxy({ sourceRoot: tmpdir() }));
  const model = browserModel();
  const cameras = browserCatalog(model, {
    austin: { name: 'Austin', groundElevation: 150 },
  }).buildCatalogFromSources(body.sources);
  const byId = new Map(cameras.map((camera) => [camera.id, camera]));

  for (const id of ['pack-pose-omitted', 'pack-pose-null']) {
    const camera = byId.get(id);
    assert.ok(camera, id);
    assert.equal(camera.headingDeg, model.headingFromId(id), id);
    assert.equal(camera.pitchDeg, -17, id);
    assert.equal(camera.fovDeg, 74, id);
    assert.equal(camera.rangeM, 700, id);
    assert.equal(camera.mountHeightM, 24, id);
    assert.equal(camera.groundElevationM, 150, id);
  }
  // No position is not a camera in the Gulf of Guinea.
  assert.equal(byId.has('pack-coords-null'), false);
  assert.equal(byId.has('pack-coords-blank'), false);
});

test('Tallinn rows with a null heading or ground keep the low-confidence prior', (t) => {
  quiet(t);
  const root = mkdtempSync(path.join(tmpdir(), 'gev-tallinn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'tallinn.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        id: 'tln-null-heading',
        lat: 59.437,
        lon: 24.753,
        headingDeg: null,
        groundElevationM: null,
        url: 'https://ristmikud.tallinn.ee/last/cam001.jpg',
      },
    ]),
  );
  withEnv(t, { CCTV_TALLINN_SOURCES_FILE: file });

  const [camera] = loadTallinnSourcesFromCatalog({ sourceRoot: root });
  assert.equal(camera.headingConfidence, 'low');
  assert.equal(camera.headingDeg, fallbackHeadingFromId('tln-null-heading'));
  assert.equal(camera.groundElevationM, 15);
});

test('TfL JamCams with null coordinates are dropped instead of placed at 0,0', async (t) => {
  quiet(t);
  const jamCam = (id, lat, lon) => ({
    id: `JamCams_${id}`,
    commonName: `JamCam ${id}`,
    lat,
    lon,
    additionalProperties: [
      { key: 'available', value: 'true' },
      {
        key: 'imageUrl',
        value: `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${id}.jpg`,
      },
    ],
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json([
      jamCam('00001.00001', 51.5072, -0.1276),
      jamCam('00001.00002', null, null),
      jamCam('00001.00003', 51.5072, ''),
    ]),
  );

  const cameras = await loadTflSourcesFromOpenData();
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['tfl-00001.00001'],
  );
});

test('a Catalonia feature with a blank longitude is not read as the zero meridian', () => {
  const feature = (coordinates) => `<gml:featureMember>
    <cite:cameres fid="cameres.1">
      <gml:coordinates>${coordinates}</gml:coordinates>
      <cite:link>https://example.org/cam.jpg</cite:link>
    </cite:cameres>
  </gml:featureMember>`;
  const [blank, valid] = parseCataloniaXml(
    feature(',41.5') + feature('2.17,41.39'),
  );
  // 0 °E at 41.5 °N is inside the Catalonia box, so a zero would pass it.
  assert.ok(Number.isNaN(blank.lon));
  assert.equal(isLikelyCataloniaCoordinate(blank.lat, blank.lon), false);
  assert.equal(isLikelyCataloniaCoordinate(valid.lat, valid.lon), true);
});

test('a Caltrans camera with a blank elevation keeps the 150 m ground prior', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_CALTRANS_DISTRICTS: '4' });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [
        {
          cctv: {
            inService: 'true',
            location: {
              latitude: '37.8044',
              longitude: '-122.2712',
              elevation: '',
              locationName: 'TV101 -- I-880 : Test Ave',
            },
            imageData: {
              static: {
                currentImageURL:
                  'https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv101/tv101.jpg',
              },
            },
          },
        },
      ],
    }),
  );

  const [camera] = await loadCaltransSourcesFromOpenData();
  assert.ok(camera);
  assert.equal(camera.groundElevationM, 150);
});
