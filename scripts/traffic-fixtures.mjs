import { PbfWriter } from 'pbf';

const corsHeaders = { 'access-control-allow-origin': '*' };
const json = (body) => ({
  status: 200,
  headers: corsHeaders,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

// Cesium heightmap-1.0: 65x65 little-endian uint16 heights, scale .2,
// offset -1000, followed by child availability and a uniform land mask.
const flatTerrain = Buffer.alloc(65 * 65 * 2 + 2);
for (let i = 0; i < 65 * 65; i++) flatTerrain.writeUInt16LE(5000, i * 2);

/** Synthetic, geographically aligned motor roads at both source zooms. */
export function trafficFixtureTile(zoom, flow = false) {
  const writer = new PbfWriter();
  writer.writeMessage(
    3,
    (_, layer) => {
      layer.writeVarintField(15, 2);
      layer.writeStringField(1, flow ? 'Traffic flow' : 'transportation');
      layer.writeVarintField(5, 4096);
      layer.writeStringField(3, flow ? 'traffic_level' : 'class');
      layer.writeMessage(
        4,
        (_, value) => {
          if (flow) value.writeDoubleField(3, 0.6);
          else value.writeStringField(1, 'primary');
        },
        null,
      );
      if (flow) {
        layer.writeStringField(3, 'road_type');
        layer.writeMessage(
          4,
          (_, value) => value.writeStringField(1, 'Major road'),
          null,
        );
      }
      // z12 has four times the span of z14. Keep the same world spacing,
      // and cover only alternate roads with flow to exercise hide/sim controls.
      const step = 256 * 2 ** (zoom - 14);
      for (let y = step; y < 4096; y += step) {
        if (flow && (y / step) % 2) continue;
        layer.writeMessage(
          2,
          (_, feature) => {
            feature.writeVarintField(3, 2);
            feature.writePackedVarint(2, flow ? [0, 0, 1, 1] : [0, 0]);
            feature.writePackedVarint(4, [9, 0, y * 2, 10, 8192, 0]);
          },
          null,
        );
      }
    },
    null,
  );
  return Buffer.from(writer.finish());
}

/** Intercept the current vector sources; never fall through to live roads. */
export function trafficFixtureResponse(request) {
  const url = new URL(request.url());
  if (url.hostname === 'terrain.reearth.land') {
    if (url.pathname.endsWith('/layer.json'))
      return json({
        tilejson: '2.1.0',
        format: 'heightmap-1.0',
        version: 'qa-flat',
        scheme: 'tms',
        projection: 'EPSG:4326',
        minzoom: 0,
        maxzoom: 0,
        tiles: ['{z}/{x}/{y}.terrain?v={version}'],
        available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
        attribution:
          'Synthetic flat terrain for Traffic QA; not live elevation data',
      });
    if (/\/0\/[01]\/0\.terrain$/.test(url.pathname))
      return {
        status: 200,
        contentType: 'application/octet-stream',
        headers: corsHeaders,
        body: flatTerrain,
      };
    throw new Error(`Unexpected terrain fixture request: ${url.pathname}`);
  }
  if (url.pathname === '/api/tomtom/status')
    return json({ hasKey: true, dailyCount: 0 });
  const flow = url.pathname.match(
    /^\/api\/tomtom\/flow\/(\d+)\/\d+\/\d+\.pbf$/,
  );
  if (flow)
    return {
      status: 200,
      contentType: 'application/x-protobuf',
      headers: corsHeaders,
      body: trafficFixtureTile(Number(flow[1]), true),
    };
  if (url.hostname !== 'tiles.openfreemap.org') return null;
  if (url.pathname === '/planet')
    return json({
      tilejson: '3.0.0',
      minzoom: 0,
      maxzoom: 14,
      tiles: ['https://tiles.openfreemap.org/qa-traffic/{z}/{x}/{y}.pbf'],
    });
  const road = url.pathname.match(/^\/qa-traffic\/(\d+)\/\d+\/\d+\.pbf$/);
  if (!road)
    throw new Error(`Unrecognized road fixture request: ${url.pathname}`);
  return {
    status: 200,
    contentType: 'application/x-protobuf',
    headers: corsHeaders,
    body: trafficFixtureTile(Number(road[1])),
  };
}

/** Intercept provider URLs only; Cesium worker/module loading stays untouched. */
export async function installTrafficRoutes(
  page,
  {
    origin,
    fixtures = false,
    keyless = false,
    onFlow = () => {},
    onError = () => {},
  },
) {
  const session = await page.createCDPSession();
  const patterns = [
    `${origin}/api/tomtom/status*`,
    `${origin}/api/tomtom/flow/*`,
    ...(fixtures
      ? ['https://tiles.openfreemap.org/*', 'https://terrain.reearth.land/*']
      : []),
  ].map((urlPattern) => ({ urlPattern, requestStage: 'Request' }));
  session.on('Fetch.requestPaused', async ({ requestId, request }) => {
    try {
      const url = new URL(request.url);
      let response;
      if (keyless && url.pathname === '/api/tomtom/status') {
        response = json({ hasKey: false });
      } else if (keyless && url.pathname.startsWith('/api/tomtom/flow/')) {
        onFlow(request.url);
        response = { ...json({ error: 'no_key' }), status: 503 };
      } else if (fixtures) {
        response = trafficFixtureResponse({ url: () => request.url });
      }
      if (!response) {
        await session.send('Fetch.continueRequest', { requestId });
        return;
      }
      await session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: response.status,
        responseHeaders: Object.entries({
          'content-type': response.contentType,
          ...response.headers,
        }).map(([name, value]) => ({ name, value })),
        body: Buffer.from(response.body).toString('base64'),
      });
    } catch (error) {
      if (page.isClosed()) return;
      onError(error);
      await session
        .send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
        .catch(() => {});
    }
  });
  await session.send('Fetch.enable', { patterns });
  return session;
}
