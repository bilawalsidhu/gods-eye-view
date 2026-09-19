import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadTaiwanFreewaySourcesFromOpenData,
  normalizeTaiwanFreewayStreamUrl,
  parseTaiwanFreewayCatalog,
} from '../../server/providers/cctv/sources.js';
import { fetchCctvImageFromUpstream } from '../../server/providers/cctv/media.js';
import { TAIWAN_FREEWAY_CCTV_URL } from '../../server/providers/cctv/constants.js';

const catalog = `<?xml version="1.0" encoding="UTF-8"?>
<CCTVList xmlns="http://traffic.transportdata.tw/standard/traffic/schema/">
  <CCTVs>
    <CCTV>
      <CCTVID>CCTV-N1-S-69.190-M</CCTVID>
      <VideoStreamURL>https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=16910</VideoStreamURL>
      <PositionLon>121.164220898059</PositionLon>
      <PositionLat>24.908710303985</PositionLat>
      <RoadName>國道1號</RoadName>
      <RoadDirection>S</RoadDirection>
      <RoadSection><Start>幼獅交流道</Start><End>楊梅交流道</End></RoadSection>
      <LocationMile>69K+190</LocationMile>
    </CCTV>
  </CCTVs>
</CCTVList>`;

test('Taiwan MOTC XML maps to the shared CCTV source contract', () => {
  const [source] = parseTaiwanFreewayCatalog(catalog);
  assert.equal(source.id, 'tw-freeway-CCTV-N1-S-69.190-M');
  assert.equal(source.name, '國道1號 69K+190 南向 · 幼獅交流道－楊梅交流道');
  assert.equal(source.cityId, 'taiwan');
  assert.equal(source.provider, '交通部高速公路局');
  assert.equal(source.lat, 24.908710303985);
  assert.equal(source.lon, 121.164220898059);
  assert.equal(source.headingDeg, 180);
  assert.equal(source.headingConfidence, 'high');
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'taiwan-freeway-open-data');
});

test('Taiwan stream URLs are pinned to official hosts and the MJPEG path', () => {
  const official =
    'https://cctv-ss02.thb.gov.tw:443/abs2mjpg/bmjpg?camera=3001';
  assert.equal(
    normalizeTaiwanFreewayStreamUrl(official),
    'https://cctv-ss02.thb.gov.tw/abs2mjpg/bmjpg?camera=3001',
  );
  for (const url of [
    'https://evil.example/abs2mjpg/bmjpg?camera=1',
    'https://cctvn.freeway.gov.tw.evil.test/abs2mjpg/bmjpg?camera=1',
    'http://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=1',
    'https://cctvn.freeway.gov.tw/other?camera=1',
    'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg',
  ]) {
    assert.equal(normalizeTaiwanFreewayStreamUrl(url), null, url);
  }
});

test('the Taiwan loader fetches and parses the bounded keyless catalog', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push([String(url), init.redirect, init.headers.Accept]);
    return new Response(catalog, {
      headers: { 'Content-Type': 'application/xml' },
    });
  });
  const sources = await loadTaiwanFreewaySourcesFromOpenData();
  assert.deepEqual(requested, [
    [TAIWAN_FREEWAY_CCTV_URL, 'manual', 'application/xml'],
  ]);
  assert.deepEqual(
    sources.map((source) => source.id),
    ['tw-freeway-CCTV-N1-S-69.190-M'],
  );
});

test('the frame proxy extracts one JPEG from an unbounded MJPEG stream', async () => {
  let cancelled = false;
  const multipart = new ReadableStream({
    start(controller) {
      controller.enqueue(
        Buffer.concat([
          Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'),
          Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
        ]),
      );
      controller.enqueue(Buffer.from([0x00, 0x01, 0xff, 0xd9, 0x0d, 0x0a]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await fetchCctvImageFromUpstream(
    'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=16910',
    {
      timeoutMs: 100,
      fetchImpl: async () =>
        new Response(multipart, {
          headers: {
            'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
          },
        }),
    },
  );
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(
    [...result.body],
    [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9],
  );
  assert.equal(cancelled, true);
});
