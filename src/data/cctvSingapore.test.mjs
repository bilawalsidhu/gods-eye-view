import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SINGAPORE_SOURCE_KIND,
  createSingaporeFrameResolver,
  loadSingaporeSourcesFromOpenData,
  normalizeSingaporeImageUrl,
  singaporeCameraName,
  singaporeCameraNumber,
  singaporeCameraRows,
  singaporeCameraToSource,
  singaporeTrafficImagesNotice,
} from '../../server/providers/cctv/singapore.js';
import {
  CCTV_SHARED_SOURCE_SLOTS,
  DEFAULT_SINGAPORE_MAX_SOURCES,
  SINGAPORE_FRAME_LINK_REFRESH_MS,
  SINGAPORE_IMAGE_ORIGIN,
  SINGAPORE_MAX_CATALOG_BYTES,
  SINGAPORE_TRAFFIC_IMAGES_URL,
} from '../../server/providers/cctv/constants.js';
import {
  CAMERA_CODE_MAX_CHARS,
  fallbackHeadingFromId,
  isLikelySingaporeCoordinate,
} from '../../server/providers/cctv/normalize.js';
import {
  cctvOctetStreamJpegAllowed,
  fetchCctvImageFromUpstream,
} from '../../server/providers/cctv/media.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { cctvProxy } from '../../server/providers/cctv.js';
import { DATA_CREDITS } from './dataCredits.js';

/** A frame link inside the pinned directory, as the live API shapes it. */
const frameUrl = (name) => `${SINGAPORE_IMAGE_ORIGIN}2026/11/${name}.jpg`;

/** One API camera row, shaped like the live answer on 2026-11-11. */
const row = (overrides = {}) => ({
  timestamp: '2026-11-11T13:30:44+08:00',
  image: frameUrl('7b00d0ca-69be-4b48-904f-bbcae219fd76'),
  location: { latitude: 1.447023728, longitude: 103.7716543 },
  camera_id: '2701',
  image_metadata: { height: 1080, width: 1920, md5: 'x' },
  ...overrides,
});

/** The API envelope around camera rows. */
const payload = (cameras) => ({
  items: [{ timestamp: '2026-11-11T13:32:44+08:00', cameras }],
  api_info: { status: 'healthy' },
});

/** The 8 cameras the live feed listed on 2026-11-11. */
const LIVE_ROWS = [
  ['2701', 1.447023728, 103.7716543],
  ['2702', 1.445554109, 103.7683397],
  ['2704', 1.429588536, 103.769311],
  ['4703', 1.348697862, 103.6350413],
  ['4712', 1.341244001, 103.6439134],
  ['4713', 1.347645829, 103.6366955],
  ['4798', 1.25999999687243, 103.823611110166],
  ['4799', 1.26027777363278, 103.823888890049],
].map(([id, latitude, longitude]) =>
  row({
    camera_id: id,
    location: { latitude, longitude },
    image: frameUrl(`cam-${id}`),
  }),
);

/** A JPEG-signed body, as data.gov.sg serves it. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

/** A frame answer with a given type and body, and a flag for cancellation. */
const frameResponse = (contentType, body = JPEG) => {
  const state = { cancelled: false };
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(body));
          controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { status: 200, headers: { 'Content-Type': contentType } },
  );
  return { response, state };
};

/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled, so a refusal test can prove it released the transport.
 */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

/** Silence the loader's progress and failure logging. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

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

test('a Singapore camera row maps to a pinned source with the licence notice', () => {
  const source = singaporeCameraToSource(row(), { notice: 'NOTICE' });
  assert.equal(source.id, 'singapore-2701');
  assert.equal(source.name, 'Woodlands Causeway (Towards Johor)');
  assert.equal(source.city, 'Singapore');
  assert.equal(source.cityId, 'singapore');
  assert.equal(source.provider, 'Land Transport Authority');
  assert.equal(source.lat, 1.447023728);
  assert.equal(source.lon, 103.7716543);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, SINGAPORE_SOURCE_KIND);
  assert.equal(source.url, frameUrl('7b00d0ca-69be-4b48-904f-bbcae219fd76'));
  assert.equal(source.snapshotUrl, source.url);
  assert.ok(source.url.startsWith(SINGAPORE_IMAGE_ORIGIN));
  assert.equal(source.frameRefreshMs, SINGAPORE_FRAME_LINK_REFRESH_MS);
  assert.equal(source.license, 'NOTICE');
  // The feed publishes no bearing, and "(Towards Johor)" is not one either.
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.headingDeg, fallbackHeadingFromId('singapore-2701'));
  assert.equal(source.code.length, CAMERA_CODE_MAX_CHARS);
  assert.ok(source.code.startsWith('WOODLANDS CAUSEWAY'));
});

test('the licence notice carries the access date and the licence link', () => {
  assert.equal(
    singaporeTrafficImagesNotice(new Date('2026-11-11T05:33:06Z')),
    'Contains information from Traffic Images accessed on 2026-11-11 from data.gov.sg ' +
      'which is made available under the terms of the Singapore Open Data Licence version 1.0 ' +
      '(https://data.gov.sg/open-data-licence)',
  );
  // An unusable date still gives a dated notice, not "Invalid Date".
  assert.match(
    singaporeTrafficImagesNotice(new Date(NaN)),
    /accessed on \d{4}-\d{2}-\d{2} from data\.gov\.sg/,
  );
  const credit = DATA_CREDITS.find((entry) => entry.key === 'singapore-cctv');
  assert.ok(credit, 'the attribution popover credits the Singapore cameras');
  assert.match(
    credit.html,
    /Contains information from Traffic Images accessed on \d{4}-\d{2}-\d{2} from/,
  );
  assert.match(
    credit.html,
    /href="https:\/\/data\.gov\.sg\/open-data-licence"/,
  );
  assert.match(credit.html, /Singapore Open Data Licence version 1\.0/);
  assert.match(credit.html, /Land Transport Authority/);
});

test('names come from the OneMotoring table, else from the id alone', () => {
  assert.deepEqual(
    LIVE_ROWS.map((r) => singaporeCameraName(r.camera_id)),
    [
      'Woodlands Causeway (Towards Johor)',
      'Woodlands Checkpoint (Towards BKE)',
      'Woodlands Flyover (Towards Checkpoint)',
      'Second Link at Tuas',
      'After Tuas West Road',
      'Tuas Checkpoint',
      'Sentosa Gateway (Towards Telok Blangah)',
      'Sentosa Gateway (Towards Sentosa)',
    ],
  );
  // A camera without a primary-source name gets no guessed place name.
  assert.equal(singaporeCameraName('1001'), 'Singapore camera 1001');
  const unnamed = singaporeCameraToSource(row({ camera_id: '1001' }));
  assert.equal(unnamed.name, 'Singapore camera 1001');
  assert.equal(unnamed.code, 'SINGAPORE CAMERA 1001');
});

test('rows with missing or malformed camera ids are dropped', () => {
  assert.equal(singaporeCameraNumber('2701'), '2701');
  assert.equal(singaporeCameraNumber(4798), '4798');
  for (const camera_id of [
    undefined,
    null,
    '',
    ' 2701',
    '2701 ',
    '27 01',
    '0',
    '0701',
    '-2701',
    '2701.5',
    27.5,
    '123456789',
    '2701/../x',
    'abc',
    true,
    {},
    ['2701'],
  ]) {
    assert.equal(
      singaporeCameraToSource(row({ camera_id })),
      null,
      JSON.stringify(camera_id),
    );
  }
});

test('rows with missing, malformed or out-of-area coordinates are dropped', () => {
  for (const location of [
    undefined,
    null,
    {},
    { latitude: 1.447 },
    { longitude: 103.77 },
    { latitude: null, longitude: null },
    { latitude: '', longitude: '' },
    { latitude: 'north', longitude: 'east' },
    { latitude: 0, longitude: 0 },
    // Latitude and longitude swapped.
    { latitude: 103.7716543, longitude: 1.447023728 },
    // Skudai, Johor: north of the strait slack.
    { latitude: 1.535, longitude: 103.66 },
    // Kuala Lumpur.
    { latitude: 3.139, longitude: 101.6869 },
    // Batam, Indonesia.
    { latitude: 1.08, longitude: 104.03 },
    // Hong Kong.
    { latitude: 22.3, longitude: 114.17 },
  ]) {
    assert.equal(
      singaporeCameraToSource(row({ location })),
      null,
      JSON.stringify(location),
    );
  }
  // String coordinates are read as numbers, as the other packs do.
  assert.equal(
    singaporeCameraToSource(
      row({ location: { latitude: '1.4470', longitude: '103.7717' } }),
    ).lat,
    1.447,
  );
  // The box covers Tuas, Changi and the southern islands.
  assert.equal(isLikelySingaporeCoordinate(1.3487, 103.635), true);
  assert.equal(isLikelySingaporeCoordinate(1.3644, 103.9915), true);
  assert.equal(isLikelySingaporeCoordinate(1.16, 103.74), true);
  assert.equal(isLikelySingaporeCoordinate(NaN, 103.8), false);
});

test('frame links outside the pinned data.gov.sg directory are dropped', () => {
  assert.equal(
    normalizeSingaporeImageUrl(frameUrl('a-b-c')),
    'https://images.data.gov.sg/api/traffic-images/2026/11/a-b-c.jpg',
  );
  // A default port and dot segments that stay inside resolve to the same pin.
  assert.equal(
    normalizeSingaporeImageUrl(
      'https://images.data.gov.sg:443/api/traffic-images/2026/./11/a.jpg',
    ),
    'https://images.data.gov.sg/api/traffic-images/2026/11/a.jpg',
  );
  for (const image of [
    undefined,
    null,
    '',
    'not a url',
    // Another scheme, including the plaintext one.
    'http://images.data.gov.sg/api/traffic-images/2026/11/a.jpg',
    'ftp://images.data.gov.sg/api/traffic-images/2026/11/a.jpg',
    'file:///etc/passwd',
    'javascript:alert(1)',
    // Another host, a look-alike host and a parent domain.
    'https://evil.example/api/traffic-images/2026/11/a.jpg',
    'https://images.data.gov.sg.evil.test/api/traffic-images/2026/11/a.jpg',
    'https://data.gov.sg/api/traffic-images/2026/11/a.jpg',
    'https://api.data.gov.sg/api/traffic-images/2026/11/a.jpg',
    // Another path on the right host.
    'https://images.data.gov.sg/api/other/2026/11/a.jpg',
    'https://images.data.gov.sg/api/traffic-images-x/a.jpg',
    'https://images.data.gov.sg/api/traffic-images/../other/a.jpg',
    'https://images.data.gov.sg/api/traffic-images/%2e%2e/other/a.jpg',
    'https://images.data.gov.sg/api/traffic-images/..%2fother/a.jpg',
    'https://images.data.gov.sg/api/traffic-images/..%5Cother/a.jpg',
    // Credentials and another port.
    'https://user:pass@images.data.gov.sg/api/traffic-images/2026/11/a.jpg',
    'https://images.data.gov.sg:8443/api/traffic-images/2026/11/a.jpg',
    // Not a JPEG file.
    'https://images.data.gov.sg/api/traffic-images/2026/11/a.html',
    'https://images.data.gov.sg/api/traffic-images/',
  ]) {
    assert.equal(normalizeSingaporeImageUrl(image), null, String(image));
    assert.equal(singaporeCameraToSource(row({ image })), null, String(image));
  }
});

test('the API envelope is read only in its documented shape', () => {
  assert.equal(singaporeCameraRows(null), null);
  assert.equal(singaporeCameraRows([]), null);
  assert.equal(singaporeCameraRows({}), null);
  assert.equal(singaporeCameraRows({ items: {} }), null);
  assert.deepEqual(singaporeCameraRows({ items: [] }), []);
  assert.deepEqual(singaporeCameraRows({ items: [{}, { cameras: 'x' }] }), []);
  assert.deepEqual(singaporeCameraRows(payload([row()])), [row()]);
});

test('the loader makes one keyless request and collapses duplicate ids', async (t) => {
  quiet(t);
  const requested = [];
  const cameras = await loadSingaporeSourcesFromOpenData({
    env: {},
    now: () => Date.parse('2026-11-11T05:33:06Z'),
    fetchImpl: async (url, init) => {
      requested.push([
        String(url),
        init.redirect,
        init.signal instanceof AbortSignal,
      ]);
      return Response.json(
        payload([
          ...LIVE_ROWS,
          // The same camera twice: the first valid row wins.
          row({ image: frameUrl('duplicate') }),
          row({ camera_id: 'bad' }),
          row({ camera_id: '9001', image: 'https://evil.example/x.jpg' }),
        ]),
      );
    },
  });
  assert.deepEqual(requested, [[SINGAPORE_TRAFFIC_IMAGES_URL, 'manual', true]]);
  assert.doesNotMatch(SINGAPORE_TRAFFIC_IMAGES_URL, /key|token/i);
  assert.equal(cameras.length, 8);
  assert.equal(
    cameras.find((c) => c.id === 'singapore-2701').url,
    frameUrl('cam-2701'),
  );
  // Nearest City Hall first: Sentosa Gateway, then Woodlands and Tuas.
  assert.deepEqual(
    cameras.slice(0, 2).map((c) => c.id),
    ['singapore-4799', 'singapore-4798'],
  );
  assert.equal(
    cameras[0].license,
    singaporeTrafficImagesNotice(new Date('2026-11-11T05:33:06Z')),
  );
});

test('the pack cap keeps the cameras nearest the city centre, within bounds', async (t) => {
  quiet(t);
  // Twenty cameras on a line from the city centre to Woodlands.
  const rows = Array.from({ length: 20 }, (_, i) =>
    row({
      camera_id: String(5000 + i),
      image: frameUrl(`line-${i}`),
      location: {
        latitude: 1.2932 + i * 0.0075,
        longitude: 103.852 - i * 0.004,
      },
    }),
  );
  const load = (env, list = rows) =>
    loadSingaporeSourcesFromOpenData({
      env,
      fetchImpl: async () => Response.json(payload(list)),
    });

  const capped = await load({ CCTV_SINGAPORE_MAX_SOURCES: '8' });
  assert.deepEqual(
    capped.map((c) => c.id),
    Array.from({ length: 8 }, (_, i) => `singapore-${5000 + i}`),
  );
  // Below the floor clamps to 8; junk falls back to the default.
  assert.equal((await load({ CCTV_SINGAPORE_MAX_SOURCES: '1' })).length, 8);
  assert.equal((await load({ CCTV_SINGAPORE_MAX_SOURCES: 'many' })).length, 20);
  assert.equal(DEFAULT_SINGAPORE_MAX_SOURCES, 100);

  // The ceiling is 200, whatever the setting asks for.
  const many = Array.from({ length: 230 }, (_, i) =>
    row({
      camera_id: String(6000 + i),
      image: frameUrl(`many-${i}`),
      location: { latitude: 1.3, longitude: 103.7 + i * 0.001 },
    }),
  );
  assert.equal(
    (await load({ CCTV_SINGAPORE_MAX_SOURCES: '5000' }, many)).length,
    200,
  );
  assert.equal((await load({}, many)).length, DEFAULT_SINGAPORE_MAX_SOURCES);
});

test('the list fetch refuses redirects and releases the body', async (t) => {
  quiet(t);
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/traffic-images' },
  });
  const seen = [];
  const cameras = await loadSingaporeSourcesFromOpenData({
    env: {},
    fetchImpl: async (url, init) => {
      seen.push([String(url), init.redirect]);
      return redirected.response;
    },
  });
  assert.deepEqual(cameras, []);
  assert.deepEqual(seen, [[SINGAPORE_TRAFFIC_IMAGES_URL, 'manual']]);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );
});

test('an oversized list is refused, declared or streamed', async (t) => {
  quiet(t);
  const declared = await loadSingaporeSourcesFromOpenData({
    env: {},
    fetchImpl: async () =>
      new Response(JSON.stringify(payload([row()])), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(SINGAPORE_MAX_CATALOG_BYTES + 1),
        },
      }),
  });
  assert.deepEqual(declared, []);

  let cancelled = false;
  const streamed = await loadSingaporeSourcesFromOpenData({
    env: {},
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(256 * 1024).fill(0x20));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  });
  assert.deepEqual(streamed, []);
  assert.equal(cancelled, true, 'the stream stops at the cap');
});

test('a list that never answers times out to an empty pack', async (t) => {
  quiet(t);
  let observed = null;
  const startedAt = Date.now();
  const cameras = await loadSingaporeSourcesFromOpenData({
    env: {},
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        observed = signal;
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  assert.deepEqual(cameras, []);
  assert.equal(observed?.aborted, true);
  assert.ok(Date.now() - startedAt < 2000, 'the injected deadline applies');
});

test('malformed and unavailable lists give an empty pack', async (t) => {
  quiet(t);
  const unavailable = streamingResponse({ status: 503 });
  for (const respond of [
    async () => unavailable.response,
    async () => new Response('<html>busy</html>', { status: 200 }),
    async () => new Response('{"items": [', { status: 200 }),
    async () => Response.json([]),
    async () => Response.json({ items: {} }),
    async () => Response.json({ items: [{ cameras: null }] }),
    async () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    assert.deepEqual(
      await loadSingaporeSourcesFromOpenData({ env: {}, fetchImpl: respond }),
      [],
    );
  }
  assert.equal(unavailable.state.cancelled, true, 'the 503 body is cancelled');
});

test('octet-stream frames are read as JPEG only from data.gov.sg and only with the signature', async () => {
  const live = frameUrl('7b00d0ca-69be-4b48-904f-bbcae219fd76');
  assert.equal(cctvOctetStreamJpegAllowed(live), true);

  // The type data.gov.sg actually serves, with the JPEG signature.
  for (const type of [
    'application/octet-stream',
    'Application/Octet-Stream; charset=binary',
  ]) {
    const { response } = frameResponse(type);
    const image = await fetchCctvImageFromUpstream(live, {
      fetchImpl: async () => response,
    });
    assert.equal(image?.ok, true, type);
    assert.equal(image.contentType, 'image/jpeg');
    assert.deepEqual(image.body, JPEG);
  }

  // The same type without the signature is refused.
  for (const body of [
    Buffer.from('<!doctype html><p>x</p>'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xd8, 0x00, 0xff]),
    Buffer.alloc(0),
  ]) {
    const { response } = frameResponse('application/octet-stream', body);
    assert.equal(
      await fetchCctvImageFromUpstream(live, {
        fetchImpl: async () => response,
      }),
      null,
      body.toString('hex'),
    );
  }

  // Every other origin keeps today's rule, even with a JPEG body.
  for (const url of [
    'https://example.com/frame.jpg',
    'https://images.data.gov.sg.evil.test/api/traffic-images/2026/11/a.jpg',
    'https://images.data.gov.sg/api/other/2026/11/a.jpg',
    'https://api.data.gov.sg/api/traffic-images/2026/11/a.jpg',
    'http://images.data.gov.sg/api/traffic-images/2026/11/a.jpg',
    'https://images.data.gov.sg:8443/api/traffic-images/2026/11/a.jpg',
    'https://trafficcam.calgary.ca/loc142.jpg',
  ]) {
    assert.equal(cctvOctetStreamJpegAllowed(url), false, url);
    const { response, state } = frameResponse('application/octet-stream');
    assert.equal(
      await fetchCctvImageFromUpstream(url, {
        fetchImpl: async () => response,
      }),
      null,
      url,
    );
    assert.equal(state.cancelled, true, `${url}: body cancelled`);
  }

  // The Singapore origin keeps the raster rule for a real image type, and
  // other types stay refused there.
  const jpeg = frameResponse('image/jpeg');
  assert.equal(
    (
      await fetchCctvImageFromUpstream(live, {
        fetchImpl: async () => jpeg.response,
      })
    )?.contentType,
    'image/jpeg',
  );
  for (const type of ['text/html', 'image/svg+xml', 'application/json']) {
    const { response, state } = frameResponse(type);
    assert.equal(
      await fetchCctvImageFromUpstream(live, {
        fetchImpl: async () => response,
      }),
      null,
      type,
    );
    assert.equal(state.cancelled, true, `${type}: body cancelled`);
  }
});

test('a Singapore frame redirect stays inside the pinned directory', async () => {
  const start = frameUrl('start');
  const redirectTo = (location) => async (url) =>
    url === start
      ? new Response(null, { status: 302, headers: { location } })
      : frameResponse('application/octet-stream').response;
  for (const location of [
    'https://evil.example/x.jpg',
    'http://images.data.gov.sg/api/traffic-images/2026/11/x.jpg',
    '/api/other/x.jpg',
    '/api/traffic-images/../other/x.jpg',
    '/api/traffic-images/..%2fother/x.jpg',
  ]) {
    assert.equal(
      await fetchCctvImageFromUpstream(start, {
        fetchImpl: redirectTo(location),
      }),
      null,
      location,
    );
  }
  const followed = await fetchCctvImageFromUpstream(start, {
    fetchImpl: redirectTo('/api/traffic-images/2026/11/next.jpg'),
  });
  assert.equal(followed?.contentType, 'image/jpeg');
});

/** A resolver over a scripted list API, with a clock the test moves. */
function scriptedResolver(answers) {
  const clock = { now: 1_000_000 };
  const calls = [];
  const resolve = createSingaporeFrameResolver({
    now: () => clock.now,
    timeoutMs: 50,
    fetchImpl: async (url, init) => {
      calls.push([String(url), init.redirect]);
      const answer = answers.shift();
      if (!answer) throw new Error('no scripted answer');
      return answer(init);
    },
  });
  return { resolve, calls, clock };
}

test('the frame resolver gives the current link and shares one lookup', async (t) => {
  quiet(t);
  const catalogLink = frameUrl('catalog');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { resolve, calls, clock } = scriptedResolver([
    async () => {
      await gate;
      return Response.json(payload([row({ image: frameUrl('current-1') })]));
    },
    async () => Response.json(payload([row({ image: frameUrl('current-2') })])),
  ]);

  // Three viewers ask at once: one request answers all of them.
  const pending = [
    resolve('singapore-2701', catalogLink),
    resolve('singapore-2701', catalogLink),
    resolve('singapore-4799', frameUrl('catalog-4799')),
  ];
  release();
  assert.deepEqual(await Promise.all(pending), [
    frameUrl('current-1'),
    frameUrl('current-1'),
    // Not in the lookup answer: the catalog link.
    frameUrl('catalog-4799'),
  ]);
  assert.deepEqual(calls, [[SINGAPORE_TRAFFIC_IMAGES_URL, 'manual']]);

  // Inside the refresh floor, no new request.
  clock.now += SINGAPORE_FRAME_LINK_REFRESH_MS - 1;
  assert.equal(
    await resolve('singapore-2701', catalogLink),
    frameUrl('current-1'),
  );
  assert.equal(calls.length, 1);

  // Past the floor, one more request and the newer link.
  clock.now += 1;
  assert.equal(
    await resolve('singapore-2701', catalogLink),
    frameUrl('current-2'),
  );
  assert.equal(calls.length, 2);
});

test('a failed lookup falls back to the catalog link and waits out the floor', async (t) => {
  quiet(t);
  const catalogLink = frameUrl('catalog');
  const unavailable = streamingResponse({ status: 503 });
  const redirected = streamingResponse({
    status: 301,
    headers: { location: 'https://evil.example/' },
  });
  const failures = [
    async () => unavailable.response,
    async () => redirected.response,
    async () => new Response('not json', { status: 200 }),
    async () => Response.json({ unexpected: true }),
    async () =>
      new Response('{}', {
        headers: { 'Content-Length': String(SINGAPORE_MAX_CATALOG_BYTES + 1) },
      }),
    async () => {
      throw new TypeError('fetch failed');
    },
    // Never answers: the lookup deadline applies.
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  ];
  for (const failure of failures) {
    const { resolve, calls, clock } = scriptedResolver([
      failure,
      async () =>
        Response.json(payload([row({ image: frameUrl('recovered') })])),
    ]);
    assert.equal(await resolve('singapore-2701', catalogLink), catalogLink);
    // Inside the floor the failed lookup is not retried.
    clock.now += SINGAPORE_FRAME_LINK_REFRESH_MS - 1;
    assert.equal(await resolve('singapore-2701', catalogLink), catalogLink);
    assert.equal(calls.length, 1);
    // After it, the next lookup runs and recovers.
    clock.now += 1;
    assert.equal(
      await resolve('singapore-2701', catalogLink),
      frameUrl('recovered'),
    );
    assert.equal(calls.length, 2);
  }
  assert.equal(unavailable.state.cancelled, true);
  assert.equal(redirected.state.cancelled, true);
});

test('the frame resolver never returns a link outside the pinned directory', async (t) => {
  quiet(t);
  const { resolve } = scriptedResolver([
    async () =>
      Response.json(
        payload([
          row({ image: 'https://evil.example/x.jpg' }),
          row({ camera_id: '4799', image: frameUrl('ok-4799') }),
        ]),
      ),
  ]);
  // The lookup's off-pin link is refused, so the catalog link is used.
  assert.equal(
    await resolve('singapore-2701', frameUrl('catalog')),
    frameUrl('catalog'),
  );
  assert.equal(await resolve('singapore-4799', ''), frameUrl('ok-4799'));
  // An off-pin catalog link is not a fallback either.
  assert.equal(
    await resolve('singapore-2701', 'https://evil.example/x.jpg'),
    '',
  );
});

/** Build a source root with no curated catalogs, so only live lanes load. */
function emptySourceRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cctv-singapore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Environment for a catalog refresh that only reaches the live lanes. */
const CATALOG_ENV = {
  CCTV_SOURCES_FILE: undefined,
  CCTV_SOURCES_JSON: undefined,
  CCTV_FORCE_AUSTIN: undefined,
  CCTV_PREFER_AUSTIN: undefined,
  CCTV_MAX_SOURCES: undefined,
  CCTV_SINGAPORE_ENABLED: undefined,
  CCTV_SINGAPORE_MAX_SOURCES: undefined,
  CCTV_QUEBEC_ENABLED: '0',
  CCTV_WORLD_CAMERAS_ENABLED: '0',
};

test('the Singapore lane is on by default and CCTV_SINGAPORE_ENABLED=0 skips the request', async (t) => {
  quiet(t);
  const root = emptySourceRoot(t);
  withEnv(t, CATALOG_ENV);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    // Every other live pack is down; only Singapore answers.
    return String(url) === SINGAPORE_TRAFFIC_IMAGES_URL
      ? Response.json(payload(LIVE_ROWS))
      : new Response('unavailable', { status: 503 });
  });

  const sources = await createCctvCatalog({ sourceRoot: root })();
  assert.deepEqual(
    sources.map((source) => source.id).sort(),
    LIVE_ROWS.map((r) => `singapore-${r.camera_id}`).sort(),
  );
  assert.ok(sources.every((source) => source.pack === 'singapore'));
  assert.equal(
    requested.filter((url) => url === SINGAPORE_TRAFFIC_IMAGES_URL).length,
    1,
    'one request per catalog refresh',
  );

  process.env.CCTV_SINGAPORE_ENABLED = '0';
  requested.length = 0;
  assert.deepEqual(await createCctvCatalog({ sourceRoot: root })(), []);
  assert.ok(requested.length > 0, 'the other live packs still load');
  assert.equal(
    requested.includes(SINGAPORE_TRAFFIC_IMAGES_URL),
    false,
    'a disabled pack makes no request',
  );
});

test('a reduced catalog cap thins every pack instead of dropping Singapore', () => {
  const lane = (name, count) => ({
    name,
    sources: Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}` })),
  });
  const { sources, packs } = allocateSourceCap(
    [lane('austin', 250), lane('calgary', 215), lane('singapore', 8)],
    12,
  );
  assert.equal(sources.length, 12);
  assert.deepEqual(
    packs.map((p) => [p.name, p.kept]),
    [
      ['austin', 4],
      ['calgary', 4],
      ['singapore', 4],
    ],
  );
  assert.equal(
    CCTV_SHARED_SOURCE_SLOTS,
    4000,
    'the shared slots are not raised',
  );
});

/** Mount the real proxy with a fixed fetch, and drive requests through it. */
function mount(t, root, respond) {
  withEnv(t, {
    ...CATALOG_ENV,
    // A configured key makes any Street View fallback observable.
    GOOGLE_MAPS_SERVER_API_KEY: 'test-google-key',
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    requests.push(String(url));
    return respond(String(url), init) || new Response('down', { status: 503 });
  });
  let handler;
  cctvProxy({ sourceRoot: root }).configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  const call = async (url) => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(body) {
        this.body = body;
      },
      on() {},
      once() {},
    };
    await handler({ url, method: 'GET', headers: {}, on() {} }, res);
    return res;
  };
  return { call, requests };
}

test('the frame route serves the current Singapore frame from upstream as JPEG', async (t) => {
  quiet(t);
  const root = emptySourceRoot(t);
  // The list answers the catalog first, then the frame-time lookup with a
  // newer link for the same camera.
  const lists = [
    payload([row({ image: frameUrl('catalog') })]),
    payload([row({ image: frameUrl('current') })]),
  ];
  const currentFrame = Buffer.concat([JPEG, Buffer.from('current')]);
  const app = mount(t, root, (url) => {
    if (url === SINGAPORE_TRAFFIC_IMAGES_URL)
      return Response.json(lists.shift() || payload([]));
    if (url === frameUrl('current'))
      return new Response(currentFrame, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    if (url === frameUrl('catalog'))
      return new Response(JPEG, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    return null;
  });

  const listed = JSON.parse((await app.call('/sources')).body).sources;
  const camera = listed.find((s) => s.id === 'singapore-2701');
  assert.equal(camera.name, 'Woodlands Causeway (Towards Johor)');
  assert.equal(camera.sourceKind, SINGAPORE_SOURCE_KIND);
  assert.equal(camera.frameRefreshMs, SINGAPORE_FRAME_LINK_REFRESH_MS);
  assert.match(
    camera.license,
    /^Contains information from Traffic Images accessed on /,
  );

  const frame = await app.call('/frame/singapore-2701');
  assert.equal(frame.status, 200);
  assert.equal(frame.headers['Content-Type'], 'image/jpeg');
  assert.equal(frame.headers['X-CCTV-Source'], 'upstream-image');
  assert.deepEqual(
    frame.body,
    currentFrame,
    'the current link, not the catalog one',
  );

  const again = await app.call('/frame/singapore-2701');
  assert.equal(again.headers['X-CCTV-Source'], 'upstream-image');
  assert.equal(
    app.requests.filter((url) => url === SINGAPORE_TRAFFIC_IMAGES_URL).length,
    2,
    'one catalog request and one lookup; the second frame reuses the lookup',
  );
  assert.equal(
    app.requests.some((url) => url.includes('maps.googleapis.com')),
    false,
    'a working camera never spends the Street View key',
  );

  const health = JSON.parse((await app.call('/health')).body).cameras;
  const entry = health.find((h) => h.id === 'singapore-2701');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.label, 'Land Transport Authority');
});
