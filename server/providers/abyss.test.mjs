import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePmelVentsHtml, abyssProxy } from './abyss.js';

const SAMPLE_HTML = `
<html>
<body>
<table>
  <tr>
    <th>Vent Name</th>
    <th>Lon</th>
    <th>Lat</th>
    <th>Site Activity</th>
    <th>Activity</th>
    <th>Tectonic Setting</th>
    <th>Spreading Rate</th>
    <th>Depth (m)</th>
  </tr>
  <tr>
    <td>Axial Seamount</td>
    <td>-130.00</td>
    <td>45.95</td>
    <td>confirmed</td>
    <td>active</td>
    <td>ocean ridge</td>
    <td>intermediate</td>
    <td>1500</td>
  </tr>
  <tr>
    <td>TAG Hydrothermal Field</td>
    <td>-44.82</td>
    <td>26.14</td>
    <td>confirmed</td>
    <td>active</td>
    <td>mid-atlantic ridge</td>
    <td>slow</td>
    <td>3620 - 3670</td>
  </tr>
</table>
</body>
</html>
`;

test('parsePmelVentsHtml parses table rows into normalized vent objects', () => {
  const vents = parsePmelVentsHtml(SAMPLE_HTML);
  assert.equal(vents.length, 2);

  const axial = vents[0];
  assert.equal(axial.name, 'Axial Seamount');
  assert.equal(axial.lon, -130);
  assert.equal(axial.lat, 45.95);
  assert.equal(axial.activity, 'active');
  assert.equal(axial.depthM, 1500);

  const tag = vents[1];
  assert.equal(tag.name, 'TAG Hydrothermal Field');
  assert.equal(tag.depthM, 3670);
  assert.equal(tag.tectonicSetting, 'mid-atlantic ridge');
  assert.equal(tag.spreadingRate, 'slow');
});

test('parsePmelVentsHtml returns empty array on invalid HTML', () => {
  assert.deepEqual(parsePmelVentsHtml(''), []);
  assert.deepEqual(parsePmelVentsHtml('<div>no table</div>'), []);
});

test('abyssProxy serves vents and handles caching and fallback', async () => {
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  };

  const plugin = abyssProxy({ fetchImpl: mockFetch });
  assert.equal(plugin.name, 'abyss');

  let middlewareHandler = null;
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        if (route === '/api/abyss') middlewareHandler = handler;
      },
    },
  });
  assert.ok(middlewareHandler);

  // Test successful GET /vents
  let resStatus = null;
  let resHeaders = {};
  let resBody = '';
  const mockRes = {
    writeHead(status, headers) {
      resStatus = status;
      resHeaders = headers;
    },
    end(body) {
      resBody = body;
    },
  };

  await middlewareHandler({ method: 'GET', url: '/vents' }, mockRes);
  assert.equal(resStatus, 200);
  assert.equal(fetchCount, 1);
  const data = JSON.parse(resBody);
  assert.equal(data.length, 2);
  assert.equal(data[0].name, 'Axial Seamount');

  // Test caching (second request should not hit fetch)
  await middlewareHandler({ method: 'GET', url: '/vents' }, mockRes);
  assert.equal(fetchCount, 1);

  // Test 404 on unknown route
  await middlewareHandler({ method: 'GET', url: '/unknown' }, mockRes);
  assert.equal(resStatus, 404);

  // Test 405 on POST
  await middlewareHandler({ method: 'POST', url: '/vents' }, mockRes);
  assert.equal(resStatus, 405);
});
