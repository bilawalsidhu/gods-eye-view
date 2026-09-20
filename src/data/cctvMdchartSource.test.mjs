import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mdchartRowToSource,
  mdchartCatalogId,
  mdchartHlsUrl,
  mdchartCameraLabel,
  loadMdchartSourcesFromOpenData,
  MDCHART_EXCLUDED_OP_STATUS,
} from '../../server/providers/cctv/mdchart.js';
import { MDCHART_CAMERAS_URL } from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const sampleRow = {
  cameraCategories: ['Baltimore'],
  cctvIp: 'strmr3.sha.maryland.gov',
  commMode: 'ONLINE',
  description: 'I-97 AT NEW CUT ROAD',
  id: '00012848007300bc004c823633235daa',
  lat: 39.128563,
  lon: -76.64165,
  name: '502021',
  opStatus: 'OK',
  publicVideoURL:
    'https://chart.maryland.gov/Video/GetVideo/00012848007300bc004c823633235daa',
  routeNumber: 97,
  routePrefix: 'IS',
  routeSuffix: '',
};

test('mdchartCatalogId prefixes stable ids', () => {
  assert.equal(
    mdchartCatalogId('00012848007300bc004c823633235daa'),
    'mdchart:00012848007300bc004c823633235daa',
  );
  assert.equal(mdchartCatalogId(''), null);
});

test('mdchartHlsUrl pins official stream hosts only', () => {
  assert.equal(
    mdchartHlsUrl('strmr3.sha.maryland.gov', 'abc123'),
    'https://strmr3.sha.maryland.gov/rtplive/abc123/playlist.m3u8',
  );
  assert.equal(
    mdchartHlsUrl('chart.maryland.gov', 'abc123'),
    null,
  );
  assert.equal(
    mdchartHlsUrl('evil.example.com', 'abc123'),
    null,
  );
});

test('mdchartRowToSource maps a representative CHART row to HLS catalog source', () => {
  const source = mdchartRowToSource(sampleRow);
  assert.ok(source);
  assert.equal(source.id, 'mdchart:00012848007300bc004c823633235daa');
  assert.equal(source.feedType, 'hls');
  assert.match(source.url, /playlist\.m3u8$/);
  assert.equal(source.provider, 'Maryland Department of Transportation / CHART');
  assert.equal(source.city, 'Baltimore');
  assert.equal(source.sourceKind, 'mdchart-open-data');
  assert.equal(
    mdchartCameraLabel(sampleRow),
    'I-97 AT NEW CUT ROAD',
  );
});

test('mdchartRowToSource rejects invalid coordinates', () => {
  assert.equal(mdchartRowToSource({ ...sampleRow, lat: 51.5, lon: -0.1 }), null);
  assert.equal(mdchartRowToSource({ ...sampleRow, lat: null, lon: -76.6 }), null);
});

test('mdchartRowToSource rejects missing stream host', () => {
  assert.equal(mdchartRowToSource({ ...sampleRow, cctvIp: 'bad.host' }), null);
});

test('mdchartRowToSource rejects out-of-service statuses', () => {
  for (const status of MDCHART_EXCLUDED_OP_STATUS) {
    assert.equal(mdchartRowToSource({ ...sampleRow, opStatus: status }), null);
  }
});

test('mdchartRowToSource rejects offline comm modes', () => {
  assert.equal(mdchartRowToSource({ ...sampleRow, commMode: 'OFFLINE' }), null);
  assert.equal(mdchartRowToSource({ ...sampleRow, commMode: 'MAINT_MODE' }), null);
});

test('mdchartRowToSource does not register publicVideoURL HTML player pages', () => {
  const source = mdchartRowToSource(sampleRow);
  assert.notEqual(source.url, sampleRow.publicVideoURL);
});

test('duplicate mdchart ids collapse to one source', () => {
  const a = mdchartRowToSource(sampleRow);
  const b = mdchartRowToSource({ ...sampleRow, description: 'duplicate' });
  assert.equal(a.id, b.id);
});

test('mdchart loader parses representative payload and honors cap', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([
      sampleRow,
      { ...sampleRow, id: 'dup-id', cctvIp: 'not-allowed.example' },
      {
        ...sampleRow,
        id: 'fail-status',
        opStatus: 'COMM_FAILURE',
      },
    ]);
  });
  const prev = process.env.CCTV_MDCHART_MAX_SOURCES;
  process.env.CCTV_MDCHART_MAX_SOURCES = '1';
  try {
    const cameras = await loadMdchartSourcesFromOpenData();
    assert.deepEqual(requested, [MDCHART_CAMERAS_URL]);
    assert.equal(cameras.length, 1);
    assert.equal(cameras[0].id, 'mdchart:00012848007300bc004c823633235daa');
  } finally {
    if (prev === undefined) delete process.env.CCTV_MDCHART_MAX_SOURCES;
    else process.env.CCTV_MDCHART_MAX_SOURCES = prev;
  }
});

test('mdchart pack failure does not break other CCTV providers', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const text = String(url);
    if (text.includes('GetCamerasJson')) {
      throw new Error('CHART offline');
    }
    if (text.includes('data.austintexas.gov')) {
      return Response.json({ meta: { view: { columns: [] } }, data: [] });
    }
    return Response.json([]);
  });
  const prevForce = process.env.CCTV_FORCE_AUSTIN;
  const prevMd = process.env.CCTV_MDCHART_ENABLED;
  process.env.CCTV_FORCE_AUSTIN = '1';
  process.env.CCTV_MDCHART_ENABLED = '1';
  try {
    const getSources = createCctvCatalog({ sourceRoot: process.cwd() });
    const sources = await getSources();
    assert.ok(Array.isArray(sources));
    assert.ok(!sources.some((s) => s.sourceKind === 'mdchart-open-data'));
  } finally {
    if (prevForce === undefined) delete process.env.CCTV_FORCE_AUSTIN;
    else process.env.CCTV_FORCE_AUSTIN = prevForce;
    if (prevMd === undefined) delete process.env.CCTV_MDCHART_ENABLED;
    else process.env.CCTV_MDCHART_ENABLED = prevMd;
  }
});
