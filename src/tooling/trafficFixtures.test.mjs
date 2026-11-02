import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trafficFixtureResponse,
  trafficFixtureTile,
} from '../../scripts/traffic-fixtures.mjs';
import { decodeOpenFreeMapTile } from '../sources/openFreeMap.js';
import { isDrivableFlowSegment } from '../layers/traffic/roadModes.js';
import { decodeFlowTile } from '../layers/traffic/flowDecode.js';

test('traffic fixtures provide aligned current road tiles and partial flow coverage', () => {
  for (const z of [12, 14]) {
    const roads = decodeOpenFreeMapTile(
      trafficFixtureTile(z),
      z,
      935,
      1686,
    ).roads;
    const flow = decodeFlowTile(trafficFixtureTile(z, true), z, 935, 1686);
    assert.ok(roads.length > flow.length && flow.length > 0);
    for (const segment of flow) {
      assert.equal(segment.trafficLevel, 0.6);
      assert.equal(isDrivableFlowSegment(segment), true);
      assert.ok(
        roads.some(
          (road) =>
            JSON.stringify(road.coordinates) === JSON.stringify(segment.coords),
        ),
      );
    }
  }
});

test('fixture TileJSON and every road/flow request stay on intercepted sources', () => {
  const request = (url) => trafficFixtureResponse({ url: () => url });
  const tileJson = request('https://tiles.openfreemap.org/planet');
  assert.equal(tileJson.headers['access-control-allow-origin'], '*');
  const metadata = JSON.parse(tileJson.body);
  const tileUrl = metadata.tiles[0]
    .replace('{z}', '14')
    .replace('{x}', '935')
    .replace('{y}', '1686');
  assert.ok(
    decodeOpenFreeMapTile(request(tileUrl).body, 14, 935, 1686).roads.length,
  );
  assert.ok(
    decodeFlowTile(
      request('http://localhost/api/tomtom/flow/12/935/1686.pbf').body,
      12,
      935,
      1686,
    ).length,
  );
  assert.throws(
    () => request('https://tiles.openfreemap.org/unexpected'),
    /Unrecognized/,
  );
  assert.equal(request('http://localhost/api/unrelated'), null);
});

test('flat terrain fixture decodes through Cesium and advertises no network children', async () => {
  const { createServer } = await import('node:http');
  const { CesiumTerrainProvider } = await import('cesium');
  const server = createServer((req, res) => {
    const response = trafficFixtureResponse({
      url: () => `https://terrain.reearth.land${req.url}`,
    });
    res.writeHead(response.status, { 'content-type': response.contentType });
    res.end(response.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = await CesiumTerrainProvider.fromUrl(
      `http://127.0.0.1:${server.address().port}`,
    );
    for (const x of [0, 1]) {
      const data = await provider.requestTileGeometry(x, 0, 0);
      const rect = provider.tilingScheme.tileXYToRectangle(x, 0, 0);
      assert.equal(
        data.interpolateHeight(rect, (rect.west + rect.east) / 2, 0),
        0,
      );
      for (const dx of [0, 1])
        for (const dy of [0, 1]) {
          assert.equal(data.isChildAvailable(x, 0, x * 2 + dx, dy), false);
        }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fixture interception targets provider URLs and leaves app workers alone', async () => {
  const { installTrafficRoutes } =
    await import('../../scripts/traffic-fixtures.mjs');
  const sent = [];
  let paused;
  const session = {
    on: (_, handler) => {
      paused = handler;
    },
    send: async (name, args) => {
      sent.push({ name, args });
    },
  };
  await installTrafficRoutes(
    { createCDPSession: async () => session, isClosed: () => false },
    { origin: 'http://localhost:4173', fixtures: true },
  );
  const patterns = sent[0].args.patterns.map((p) => p.urlPattern);
  assert.deepEqual(patterns, [
    'http://localhost:4173/api/tomtom/status*',
    'http://localhost:4173/api/tomtom/flow/*',
    'https://tiles.openfreemap.org/*',
    'https://terrain.reearth.land/*',
  ]);
  await paused({
    requestId: 'terrain',
    request: { url: 'https://terrain.reearth.land/layer.json' },
  });
  const reply = sent.at(-1);
  assert.equal(reply.name, 'Fetch.fulfillRequest');
  assert.equal(
    JSON.parse(Buffer.from(reply.args.body, 'base64')).format,
    'heightmap-1.0',
  );
  assert.ok(
    reply.args.responseHeaders.some(
      (h) => h.name === 'access-control-allow-origin' && h.value === '*',
    ),
  );
});

test('keyless interception refuses and records unexpected flow requests', async () => {
  const { installTrafficRoutes } =
    await import('../../scripts/traffic-fixtures.mjs');
  const sent = [],
    flows = [];
  let paused;
  const session = {
    on: (_, handler) => {
      paused = handler;
    },
    send: async (name, args) => {
      sent.push({ name, args });
    },
  };
  await installTrafficRoutes(
    { createCDPSession: async () => session, isClosed: () => false },
    {
      origin: 'http://localhost:4173',
      keyless: true,
      onFlow: (url) => flows.push(url),
    },
  );
  await paused({
    requestId: 'status',
    request: { url: 'http://localhost:4173/api/tomtom/status' },
  });
  assert.deepEqual(JSON.parse(Buffer.from(sent.at(-1).args.body, 'base64')), {
    hasKey: false,
  });
  await paused({
    requestId: 'flow',
    request: { url: 'http://localhost:4173/api/tomtom/flow/12/1/1.pbf' },
  });
  assert.equal(sent.at(-1).args.responseCode, 503);
  assert.equal(flows.length, 1);
});
