import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadNswSourcesFromOpenData,
  nswCameraLabel,
  nswCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  cctvUpstreamUserAgent,
  fetchCctvImageFromUpstream,
} from '../../server/providers/cctv/media.js';
import {
  NSW_CAMERAS_URL,
  NSW_IMAGE_USER_AGENT,
} from '../../server/providers/cctv/constants.js';

const feature = (overrides = {}, props = {}) => ({
  type: 'Feature',
  id: '5_ways_miranda',
  geometry: { type: 'Point', coordinates: [151.1036, -34.0337] },
  properties: {
    region: 'SYD_SOUTH',
    title: '5 Ways (Miranda)',
    view: '5 Ways at The Boulevarde looking west towards Sutherland.',
    direction: 'W',
    href: 'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg',
    ...props,
  },
  ...overrides,
});

test('NSW label prefers the view sentence and falls back to the title for works notices', () => {
  assert.equal(
    nswCameraLabel({ title: '5 Ways (Miranda)', view: '5 Ways looking west.' }),
    '5 Ways looking west.',
  );
  assert.equal(
    nswCameraLabel({ title: 'Victoria Pass', view: 'x'.repeat(200) }),
    'Victoria Pass',
  );
  assert.equal(nswCameraLabel({ title: 'T', view: 'line one\nline two' }), 'T');
  assert.equal(nswCameraLabel({}), '');
});

test('NSW feature maps to a source with a compass heading and a pinned image host', () => {
  const source = nswCameraToSource(feature({}, { direction: 'N-E' }));
  assert.equal(source.id, 'nsw-5_ways_miranda');
  assert.equal(source.city, 'SYD SOUTH');
  assert.equal(source.provider, 'Live Traffic NSW');
  assert.equal(source.lat, -34.0337);
  assert.equal(source.lon, 151.1036);
  assert.equal(source.headingDeg, 45);
  assert.equal(source.headingConfidence, 'high');
  assert.equal(source.sourceKind, 'nsw-livetraffic');
  assert.match(source.license, /CC BY 4.0/);
  assert.equal(source.url, source.snapshotUrl);
});

test('NSW mapping rejects off-host images and unusable geometry', () => {
  assert.equal(
    nswCameraToSource(feature({}, { href: 'https://evil.example/x.jpeg' })),
    null,
  );
  assert.equal(nswCameraToSource(feature({ geometry: null })), null);
  assert.equal(nswCameraToSource(feature({ id: '' })), null);
  const noBearing = nswCameraToSource(feature({}, { direction: '' }));
  assert.equal(noBearing.headingConfidence, 'low');
  assert.ok(Number.isFinite(noBearing.headingDeg));
});

test('NSW loader reads the keyless feed and caps around Sydney', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({
      type: 'FeatureCollection',
      features: [
        feature(),
        feature({ id: 'other' }, { href: 'https://evil.example/x.jpeg' }),
      ],
    });
  });
  const cameras = await loadNswSourcesFromOpenData();
  assert.deepEqual(requested, [NSW_CAMERAS_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['nsw-5_ways_miranda'],
  );
});

test('the browser User-Agent applies to the NSW image host only', async () => {
  assert.equal(
    cctvUpstreamUserAgent(
      'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/x.jpeg',
    ),
    NSW_IMAGE_USER_AGENT,
  );
  assert.equal(
    cctvUpstreamUserAgent(
      'https://webcams.transport.nsw.gov.au.evil.test/x.jpeg',
    ),
    'gods-eye-view-cctv-proxy/1.0',
  );
  assert.equal(
    cctvUpstreamUserAgent(
      'https://example.test/webcams.transport.nsw.gov.au/x.jpeg',
    ),
    'gods-eye-view-cctv-proxy/1.0',
  );
  assert.equal(
    cctvUpstreamUserAgent('not a url'),
    'gods-eye-view-cctv-proxy/1.0',
  );

  const seen = [];
  await fetchCctvImageFromUpstream(
    'https://cctv.austinmobility.io/image/1.jpg',
    {
      timeoutMs: 100,
      fetchImpl: async (url, init) => {
        seen.push(init.headers['User-Agent']);
        return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      },
    },
  );
  assert.deepEqual(seen, ['gods-eye-view-cctv-proxy/1.0']);
});

test('the frame path follows redirects within the host only', async () => {
  const jpeg = () =>
    new Response(Buffer.from([0xff, 0xd8, 0xff]), {
      headers: { 'Content-Type': 'image/jpeg' },
    });
  const redirect = (location) =>
    new Response(null, { status: 302, headers: { location } });
  const start = 'https://cctv.austinmobility.io/image/1.jpg';

  const sameHost = [];
  const followed = await fetchCctvImageFromUpstream(start, {
    timeoutMs: 100,
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, 'manual', 'the fetch itself never follows');
      sameHost.push(url);
      return sameHost.length === 1 ? redirect('/image/moved/1.jpg') : jpeg();
    },
  });
  assert.equal(followed?.ok, true);
  assert.deepEqual(sameHost, [
    start,
    'https://cctv.austinmobility.io/image/moved/1.jpg',
  ]);

  const offHost = [];
  const refused = await fetchCctvImageFromUpstream(start, {
    timeoutMs: 100,
    fetchImpl: async (url) => {
      offHost.push(url);
      return redirect('https://evil.example/1.jpg');
    },
  });
  assert.equal(refused, null);
  assert.deepEqual(offHost, [start], 'the off-host target is never requested');

  // Same host on another port, a plaintext downgrade, and a protocol-relative
  // other host are all a different origin and are refused.
  for (const target of [
    'https://cctv.austinmobility.io:8443/image/1.jpg',
    'http://cctv.austinmobility.io/image/1.jpg',
    '//evil.example/1.jpg',
  ]) {
    const seen = [];
    const result = await fetchCctvImageFromUpstream(start, {
      timeoutMs: 100,
      fetchImpl: async (url) => {
        seen.push(url);
        return redirect(target);
      },
    });
    assert.equal(result, null, target);
    assert.deepEqual(seen, [start], target);
  }

  let hops = 0;
  const looped = await fetchCctvImageFromUpstream(start, {
    timeoutMs: 100,
    fetchImpl: async () => {
      hops += 1;
      return redirect('/image/again.jpg');
    },
  });
  assert.equal(looped, null);
  assert.equal(hops, 3, 'at most two redirect hops are followed');
});
