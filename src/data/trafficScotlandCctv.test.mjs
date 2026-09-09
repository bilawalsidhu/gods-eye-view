import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRAFFIC_SCOTLAND_FRAME_CACHE_MS,
  fetchTrafficScotlandFrame,
  loadTrafficScotlandSourcesFromOpenData,
  parseTrafficScotlandFrameFragment,
  trafficScotlandFrameRef,
} from '../../vite.config.js';

// Smallest byte strings the parser accepts as raster stills (magic + padding).
const JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x41, 0x41, 0x41]);
const JPEG_B = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x42, 0x42, 0x42, 0x42]);
const PNG_C = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x43, 0x43]);

function fragment(views) {
  const links = views.length > 1
    ? `<div class="cam-links">${views.map(([tid, label]) => `<a class="cam-link" href="#" tid="${tid}"><span>${label}</span></a>`).join('')}</div>`
    : '';
  const images = views.map(([tid, , bytes, mime = 'jpeg'], index) =>
    `<div class="camera-image"${index ? ' style="display: none;"' : ''} tid="${tid}"><img src="data:image/${mime};base64,${bytes.toString('base64')}" /></div>`).join('');
  return `<div class="iw-holder"><div class="iw-header"><img src="/themes/ud/img/tsis-cameras.png"><span></span></div>${links}${images}</div>`;
}

const CATALOG = {
  status: 'ok',
  results: [
    { sid: '24', title: 'A720 Dreghorn', lat: '55.899100000000', lng: '-3.244200000000', roadname: 'A720', images: '43', region: 'SW Scotland, Lothian and Borders' },
    { sid: '77', title: 'A702  Boghall ', lat: '55.878', lng: '-3.212', roadname: 'A702', images: '143,144', region: 'SW Scotland, Lothian and Borders' },
    { sid: '901', title: 'No coordinates', lat: '', lng: null, roadname: 'A9', images: '900', region: 'Highland and Western Isles' },
    { sid: '902', title: 'Outside Scotland', lat: '51.5', lng: '-0.1', roadname: 'M25', images: '901', region: 'Strathclyde' },
    { sid: '903', title: 'No views', lat: '56.1', lng: '-3.9', roadname: 'M9', images: '', region: 'Central, Tayside and Fife' },
    { sid: 'abc', title: 'Bad site id', lat: '56.1', lng: '-3.9', roadname: 'M9', images: '77', region: 'Central, Tayside and Fife' },
    { sid: '904', title: 'Duplicate view', lat: '56.2', lng: '-3.8', roadname: 'M9', images: '43, x, 45', region: 'Central, Tayside and Fife' },
  ],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

test('Traffic Scotland loader emits one camera per published view with a stable id', async () => {
  const requested = [];
  const cameras = await loadTrafficScotlandSourcesFromOpenData({
    fetchImpl: async (url, options) => {
      requested.push({ url, signal: options?.signal });
      return jsonResponse(CATALOG);
    },
  });

  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, 'https://www.traffic.gov.scot/tsis/cameras');
  assert.ok(requested[0].signal instanceof AbortSignal, 'catalog fetch must carry a timeout signal');

  const ids = cameras.map((camera) => camera.id).sort();
  assert.deepEqual(ids, ['ts-143', 'ts-144', 'ts-43', 'ts-45']);

  const single = cameras.find((camera) => camera.id === 'ts-43');
  assert.equal(single.name, 'A720 Dreghorn');
  assert.equal(single.lat, 55.8991);
  assert.equal(single.lon, -3.2442);
  assert.equal(single.city, 'Scotland');
  assert.equal(single.provider, 'Traffic Scotland');
  assert.equal(single.sourceKind, 'traffic-scotland');
  assert.equal(single.feedType, 'image');
  assert.equal(single.headingConfidence, 'low');
  assert.equal(single.snapshotUrl, 'https://www.traffic.gov.scot/tsis/camerahtml?sid=24');
  assert.equal(single.url, single.snapshotUrl);
  assert.ok(Number.isFinite(single.headingDeg));

  const north = cameras.find((camera) => camera.id === 'ts-143');
  const south = cameras.find((camera) => camera.id === 'ts-144');
  assert.equal(north.name, 'A702 Boghall (cam 1)', 'multi-view titles are whitespace-normalized and numbered');
  assert.equal(south.name, 'A702 Boghall (cam 2)');
  assert.equal(north.snapshotUrl, south.snapshotUrl, 'views at one site share the site fragment');
  assert.notEqual(north.headingDeg, south.headingDeg, 'each view gets its own heading prior');

  const duplicate = cameras.find((camera) => camera.id === 'ts-45');
  assert.equal(duplicate.name, 'Duplicate view (cam 2)', 'a view id already claimed by another site is skipped, not re-registered');
});

test('Traffic Scotland loader fails soft on upstream errors and malformed payloads', async () => {
  assert.deepEqual(await loadTrafficScotlandSourcesFromOpenData({ fetchImpl: async () => jsonResponse({}, 503) }), []);
  assert.deepEqual(await loadTrafficScotlandSourcesFromOpenData({ fetchImpl: async () => jsonResponse({ status: 'ok', results: 'nope' }) }), []);
  assert.deepEqual(await loadTrafficScotlandSourcesFromOpenData({ fetchImpl: async () => { throw new Error('offline'); } }), []);
});

test('trafficScotlandFrameRef only resolves loader-shaped sources on the official origin', () => {
  assert.deepEqual(
    trafficScotlandFrameRef({ id: 'ts-144', sourceKind: 'traffic-scotland', snapshotUrl: 'https://www.traffic.gov.scot/tsis/camerahtml?sid=77' }),
    { sid: '77', tid: '144' },
  );
  assert.equal(trafficScotlandFrameRef({ id: 'ts-144', sourceKind: 'tfl-open-data', snapshotUrl: 'https://www.traffic.gov.scot/tsis/camerahtml?sid=77' }), null);
  assert.equal(trafficScotlandFrameRef({ id: 'tfl-144', sourceKind: 'traffic-scotland', snapshotUrl: 'https://www.traffic.gov.scot/tsis/camerahtml?sid=77' }), null);
  assert.equal(trafficScotlandFrameRef({ id: 'ts-144', sourceKind: 'traffic-scotland', snapshotUrl: 'https://evil.example/tsis/camerahtml?sid=77' }), null);
  assert.equal(trafficScotlandFrameRef({ id: 'ts-144', sourceKind: 'traffic-scotland', snapshotUrl: 'https://www.traffic.gov.scot/tsis/camerahtml?sid=77;drop' }), null);
  assert.equal(trafficScotlandFrameRef(null), null);
});

test('parseTrafficScotlandFrameFragment decodes every raster view and ignores everything else', () => {
  const html = fragment([
    ['143', 'A702 Boghall North', JPEG_A],
    ['144', 'A702 Boghall South', PNG_C, 'png'],
  ]) + '<div class="camera-image" tid="145"><img src="data:image/svg+xml;base64,PHN2Zy8+" /></div>'
    + `<div class="camera-image" tid="146"><img src="data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}" /></div>`
    + '<div class="camera-image" tid="147"><img src="https://www.traffic.gov.scot/not-inline.jpg" /></div>';

  const frames = parseTrafficScotlandFrameFragment(html);
  assert.deepEqual([...frames.keys()], ['143', '144']);
  assert.deepEqual(frames.get('143').body, JPEG_A);
  assert.equal(frames.get('143').contentType, 'image/jpeg');
  assert.deepEqual(frames.get('144').body, PNG_C);
  assert.equal(frames.get('144').contentType, 'image/png');
  assert.equal(parseTrafficScotlandFrameFragment('').size, 0);
  assert.equal(parseTrafficScotlandFrameFragment(null).size, 0);
});

test('fetchTrafficScotlandFrame shares one upstream fragment across views and cache windows', async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return htmlResponse(fragment([['2143', 'North', JPEG_A], ['2144', 'South', JPEG_B]]));
  };
  const site = 'https://www.traffic.gov.scot/tsis/camerahtml?sid=2077';
  const north = { id: 'ts-2143', sourceKind: 'traffic-scotland', snapshotUrl: site };
  const south = { id: 'ts-2144', sourceKind: 'traffic-scotland', snapshotUrl: site };
  const t0 = 1_000_000;

  const [first, second] = await Promise.all([
    fetchTrafficScotlandFrame(north, { fetchImpl, nowMs: t0 }),
    fetchTrafficScotlandFrame(south, { fetchImpl, nowMs: t0 }),
  ]);
  assert.equal(fetches, 1, 'concurrent views at one site share a single in-flight fetch');
  assert.equal(first.ok, true);
  assert.deepEqual(first.body, JPEG_A);
  assert.equal(first.contentType, 'image/jpeg');
  assert.equal(first.cached, false);
  assert.deepEqual(second.body, JPEG_B);

  const again = await fetchTrafficScotlandFrame(south, { fetchImpl, nowMs: t0 + TRAFFIC_SCOTLAND_FRAME_CACHE_MS - 1 });
  assert.equal(fetches, 1, 'inside the window the decoded set is served from cache');
  assert.equal(again.cached, true);
  assert.deepEqual(again.body, JPEG_B);

  const missing = await fetchTrafficScotlandFrame({ id: 'ts-2999', sourceKind: 'traffic-scotland', snapshotUrl: site }, { fetchImpl, nowMs: t0 });
  assert.equal(missing, null, 'a view the site no longer publishes falls through to the fallback chain');

  const refreshed = await fetchTrafficScotlandFrame(north, { fetchImpl, nowMs: t0 + TRAFFIC_SCOTLAND_FRAME_CACHE_MS + 1 });
  assert.equal(fetches, 2, 'an expired window refetches once');
  assert.equal(refreshed.cached, false);
});

test('fetchTrafficScotlandFrame serves a stale frame when the refresh fails and null when nothing is known', async () => {
  const site = 'https://www.traffic.gov.scot/tsis/camerahtml?sid=3077';
  const source = { id: 'ts-3143', sourceKind: 'traffic-scotland', snapshotUrl: site };
  const t0 = 5_000_000;

  const warm = await fetchTrafficScotlandFrame(source, {
    fetchImpl: async () => htmlResponse(fragment([['3143', 'Only', JPEG_A]])),
    nowMs: t0,
  });
  assert.equal(warm?.ok, true);

  const stale = await fetchTrafficScotlandFrame(source, {
    fetchImpl: async () => htmlResponse('<html>maintenance</html>', 503),
    nowMs: t0 + TRAFFIC_SCOTLAND_FRAME_CACHE_MS + 1,
  });
  assert.equal(stale?.ok, true);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.body, JPEG_A);

  const wrongType = await fetchTrafficScotlandFrame(
    { id: 'ts-4143', sourceKind: 'traffic-scotland', snapshotUrl: 'https://www.traffic.gov.scot/tsis/camerahtml?sid=4077' },
    { fetchImpl: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }), nowMs: t0 },
  );
  assert.equal(wrongType, null, 'a non-HTML upstream body is never parsed');

  let observedSignal = null;
  const startedAt = Date.now();
  const timedOut = await fetchTrafficScotlandFrame(
    { id: 'ts-5143', sourceKind: 'traffic-scotland', snapshotUrl: 'https://www.traffic.gov.scot/tsis/camerahtml?sid=5077' },
    {
      timeoutMs: 20,
      nowMs: t0,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        observedSignal = options.signal;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    },
  );
  assert.equal(timedOut, null);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, 'timeout must settle promptly');

  assert.equal(await fetchTrafficScotlandFrame({ id: 'tfl-1', sourceKind: 'tfl-open-data', snapshotUrl: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/1.jpg' }), null);
});
