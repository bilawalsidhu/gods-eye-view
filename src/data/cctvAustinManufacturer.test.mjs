import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_AUSTIN_ROWS_URL } from '../../server/providers/cctv/constants.js';
import { loadAustinSourcesFromOpenData } from '../../server/providers/cctv/sources.js';
import { extractAustinManufacturer } from '../../server/providers/cctv/normalize.js';
import { cctvProxy } from '../../server/providers/cctv.js';
import { createCatalog } from '../layers/cctv/catalog.js';
import {
  hardwareHudToken,
  hardwareLabel,
  isPtzOnlyLine,
} from '../layers/cctv/hardware.js';

/** Set (or, for `undefined`, delete) environment variables for one test. */
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

const COLUMNS = [
  'camera_id',
  'location_name',
  'camera_status',
  'camera_mfg',
  'latitude',
  'longitude',
].map((fieldName) => ({ fieldName }));

/** A Socrata rows.json payload shaped like Austin's b4k4-adkb export. */
function austinRows(rows) {
  return {
    meta: { view: { columns: COLUMNS } },
    data: rows.map(
      ({ id, mfg, status = 'TURNED_ON', lat = 30.27, lon = -97.74 }) => [
        id,
        `Test St / Avenue ${id}`,
        status,
        mfg,
        lat,
        lon,
      ],
    ),
  };
}

test('extractAustinManufacturer maps camera_mfg to the maker or product line', () => {
  assert.equal(
    extractAustinManufacturer({ camera_mfg: 'Wisenet' }),
    'Hanwha Wisenet',
  );
  assert.equal(extractAustinManufacturer({ camera_mfg: 'Advidia' }), 'Advidia');
  assert.equal(
    extractAustinManufacturer({ camera_mfg: 'Sarix' }),
    'Pelco Sarix',
  );
  assert.equal(
    extractAustinManufacturer({ camera_mfg: ' spectra  ENHANCED ' }),
    'Pelco Spectra Enhanced',
  );
  assert.equal(extractAustinManufacturer({ camera_mfg: 'Axis' }), 'Axis');
  // An unknown maker still shows, trimmed; a blank or missing one is empty.
  assert.equal(extractAustinManufacturer({ camera_mfg: ' Bosch ' }), 'Bosch');
  assert.equal(extractAustinManufacturer({ camera_mfg: '   ' }), '');
  assert.equal(extractAustinManufacturer({ camera_mfg: null }), '');
  assert.equal(extractAustinManufacturer({}), '');
});

test('Austin loader carries the maker on each camera and omits it when blank', async (t) => {
  quiet(t);
  withEnv(t, {
    CCTV_AUSTIN_ROWS_URL: undefined,
    CCTV_AUSTIN_MAX_SOURCES: undefined,
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      austinRows([
        { id: '101', mfg: 'Wisenet' },
        { id: '102', mfg: 'Spectra Enhanced' },
        { id: '103', mfg: null },
        { id: '104', mfg: 'Advidia', status: 'REMOVED' },
      ]),
    ),
  );

  const cameras = await loadAustinSourcesFromOpenData();
  const byId = new Map(cameras.map((camera) => [camera.id, camera]));
  assert.deepEqual([...byId.keys()].sort(), ['101', '102', '103']);
  assert.equal(byId.get('101').manufacturer, 'Hanwha Wisenet');
  assert.equal(byId.get('102').manufacturer, 'Pelco Spectra Enhanced');
  assert.equal(byId.get('103').manufacturer, undefined);
  // The maker never changes the pose: no model, no FOV claim.
  assert.equal(byId.get('101').fovDeg, byId.get('103').fovDeg);
  assert.equal(byId.get('101').model, undefined);
});

/** Drive the real `/api/cctv/sources` middleware and return its parsed body. */
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

/** The browser catalog with the pose math stubbed out: only field
 * passthrough is under test here. */
function browserCatalog() {
  const model = {
    safeNumber: (value, fallback = NaN) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    normalizeHeading: (deg) => ((deg % 360) + 360) % 360,
    clamp: (value, lo, hi) => Math.min(hi, Math.max(lo, value)),
    headingFromId: () => 0,
    normalizeFeedType: (type) => type,
    ensureCameraPose: () => {},
  };
  return createCatalog({
    state: {},
    services: { locations: { CITY_POIS: {} } },
    parts: { model },
    source: {},
  });
}

test('Austin maker survives the /api/cctv/sources boundary into the browser catalog', async (t) => {
  quiet(t);
  const root = mkdtempSync(path.join(tmpdir(), 'gev-austin-mfg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // No file/env catalog, so the live packs load; every pack but Austin sees
  // an upstream failure and contributes nothing.
  withEnv(t, {
    CCTV_SOURCES_FILE: undefined,
    CCTV_SOURCES_JSON: undefined,
    CCTV_FORCE_AUSTIN: undefined,
    CCTV_PREFER_AUSTIN: undefined,
    CCTV_AUSTIN_ROWS_URL: undefined,
    CCTV_AUSTIN_MAX_SOURCES: undefined,
    CCTV_MAX_SOURCES: undefined,
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) !== DEFAULT_AUSTIN_ROWS_URL)
      return new Response('', { status: 503 });
    return Response.json(
      austinRows([
        { id: '201', mfg: 'Spectra Enhanced' },
        { id: '202', mfg: '' },
      ]),
    );
  });

  const body = await requestSources(cctvProxy({ sourceRoot: root }));
  const served = new Map(body.sources.map((source) => [source.id, source]));
  assert.equal(served.get('201').manufacturer, 'Pelco Spectra Enhanced');
  assert.equal(served.get('202').manufacturer, '');

  const cameras = browserCatalog().buildCatalogFromSources(body.sources);
  const byId = new Map(cameras.map((camera) => [camera.id, camera]));
  assert.equal(byId.get('201').manufacturer, 'Pelco Spectra Enhanced');
  assert.equal(
    hardwareHudToken(byId.get('201')),
    'HW PELCO SPECTRA ENHANCED (PTZ)',
  );
  assert.equal(hardwareHudToken(byId.get('202')), null);
});

test('hardware labels flag only PTZ-only product lines', () => {
  assert.equal(isPtzOnlyLine('Pelco Spectra Enhanced'), true);
  // Lines that mix fixed and PTZ hardware are never called PTZ.
  assert.equal(isPtzOnlyLine('Pelco Sarix'), false);
  assert.equal(isPtzOnlyLine('Hanwha Wisenet'), false);
  assert.equal(isPtzOnlyLine(''), false);

  assert.equal(
    hardwareLabel({ manufacturer: 'Hanwha Wisenet' }),
    'Hanwha Wisenet',
  );
  assert.equal(
    hardwareLabel({ manufacturer: 'Pelco Spectra Enhanced' }),
    'Pelco Spectra Enhanced (PTZ)',
  );
  assert.equal(hardwareLabel({ manufacturer: '  ' }), '');
  assert.equal(hardwareLabel(null), '');
  assert.equal(hardwareHudToken({ manufacturer: 'Advidia' }), 'HW ADVIDIA');
  assert.equal(hardwareHudToken({}), null);
});
