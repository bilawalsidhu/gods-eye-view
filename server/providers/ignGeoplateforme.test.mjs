import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IGN_MAX_ZOOM,
  IGN_TILE_MATRIX_SET,
  buildIgnTileUrl,
  createIgnGeoplateformeHandler,
  parseIgnTilePath,
} from './ignGeoplateforme.js';

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writableEnded: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
    on() {},
  };
}

function fakeReq(url, headers = {}) {
  return {
    url,
    method: 'GET',
    headers: { host: 'localhost', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
  };
}

test('the GetTile URL is the KVP form the Géoplateforme publishes', () => {
  const url = buildIgnTileUrl('PLANIGNV2', 16, 33195, 22545);
  assert.ok(url.startsWith('https://data.geopf.fr/wmts?'));
  assert.match(url, /SERVICE=WMTS/);
  assert.match(url, /REQUEST=GetTile/);
  assert.match(url, /VERSION=1\.0\.0/);
  assert.match(url, /LAYER=PLANIGNV2/);
  assert.match(url, /STYLE=normal/);
  assert.match(url, new RegExp(`TILEMATRIXSET=${IGN_TILE_MATRIX_SET}`));
  assert.match(url, /TILEMATRIX=16/);
  assert.match(url, /TILEROW=22545/);
  assert.match(url, /TILECOL=33195/);
  assert.match(url, /FORMAT=image%2Fpng/);
});

test('a tile path is validated against the grid', () => {
  assert.deepEqual(parseIgnTilePath('PLANIGNV2/16/33195/22545.png'), {
    layer: 'PLANIGNV2',
    z: 16,
    x: 33195,
    y: 22545,
  });
  assert.equal(parseIgnTilePath('PLANIGNV2/16/33195/22545.txt'), null);
  assert.equal(parseIgnTilePath('PLANIGNV2/99/1/1.png'), null);
  assert.equal(parseIgnTilePath('PLANIGNV2/1/2/1.png'), null, 'x beyond the grid');
  assert.equal(parseIgnTilePath('NOT-A-LAYER/1/0/0.png'), null);
});

test('the proxy answers a tile request with the upstream PNG', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const seen = [];
  const handler = createIgnGeoplateformeHandler({
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    },
  });
  const res = fakeRes();
  await handler(fakeReq('/tiles/PLANIGNV2/16/33195/22545.png'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes('TILEMATRIX=16'));
});

test('the browser never names an upstream URL: the proxy resolves it', async () => {
  const seen = [];
  const handler = createIgnGeoplateformeHandler({
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    },
  });
  const res = fakeRes();
  await handler(fakeReq('/tiles/PLANIGNV2/16/33195/22545.png'), res);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith('https://data.geopf.fr/wmts'));
});

test('a malformed tile path is refused with a clear message', async () => {
  const handler = createIgnGeoplateformeHandler({
    fetchImpl: async () => {
      throw new Error('the upstream must not be contacted');
    },
  });
  const res = fakeRes();
  await handler(fakeReq('/tiles/PLANIGNV2/nope.png'), res);
  assert.equal(res.statusCode, 400);
});

test('a non-PNG upstream body is refused rather than relayed as a tile', async () => {
  const handler = createIgnGeoplateformeHandler({
    fetchImpl: async () =>
      new Response('<xml/>', {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      }),
  });
  const res = fakeRes();
  await handler(fakeReq('/tiles/PLANIGNV2/16/33195/22545.png'), res);
  assert.equal(res.statusCode, 502);
});

test('the layer catalogue names the vector cadastre as unsupported', async () => {
  const handler = createIgnGeoplateformeHandler({
    fetchImpl: async () => {
      throw new Error('the upstream must not be contacted');
    },
  });
  const res = fakeRes();
  await handler(fakeReq('/layers'), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.vectorSupported, false);
  assert.ok(payload.vector.length >= 2);
  assert.equal(payload.maxZoom, IGN_MAX_ZOOM);
});
