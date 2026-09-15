// Unit tests for src/data/cctvSources.js — the CCTV catalog + frame-serving
// module shared by the dev middleware and the Pages Function. The pure helpers
// are asserted directly; the three live open-data loaders are driven through
// getCctvSources() with globalThis.fetch stubbed per host, which also pins the
// cache TTL, the single-flight refresh, the pack gates, the caps and the
// serve-stale backstop.
//
// Run with: node --test src/data/cctvSources.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIA_DECLARED_CAP_BYTES,
  CCTV_IMAGE_MAX_BYTES,
  CCTV_SOURCE_CACHE_MS,
  buildMediaPassthrough,
  buildStreamPayload,
  buildSyntheticCctvSvg,
  coerceLatLon,
  createCctvHealthTracker,
  escapeXml,
  getCctvSources,
  hashSeed,
  haversineKm,
  isVideoFeedType,
  normalizeFeedType,
  parseConfiguredSourcesFromEnv,
  parsePointString,
  streetViewFallback,
  toFiniteNumber,
} from './cctvSources.js';
import { api } from '../config/apiEndpoints.js';

// ── fixtures ────────────────────────────────────────────────────────────────

/** Socrata rows.json shape: column metadata + positional rows. */
const AUSTIN_PAYLOAD = {
  meta: {
    view: {
      columns: [
        { fieldName: 'camera_id' },
        { fieldName: 'camera_status' },
        { fieldName: 'camera_name' },
        { fieldName: 'location' },
        { fieldName: 'direction' },
        { fieldName: 'latitude' },
        { fieldName: 'longitude' },
        { fieldName: 'camera_device_id' },
      ],
    },
  },
  data: [
    ['42', 'TURNED_ON', 'I-35 @ 6th', 'POINT(-97.74 30.27)', 'West', null, null, null],
    ['43', 'TURNED_ON', '5TH ST / WEST AVE', 'POINT(-97.73 30.28)', '', null, null, null],
    // Finite but outside the Austin bbox → dropped.
    ['44', 'TURNED_ON', 'bad coords', 'POINT(0 0)', '', null, null, null],
    // Planned camera, not live → dropped by the status gate.
    ['45', 'PLANNED', 'not live', 'POINT(-97.71 30.29)', '', null, null, null],
    // No WKT field; scalar lat/lon columns carry the position instead.
    ['46', 'TURNED_ON', 'scalar coords', null, '', '30.25', '-97.76', null],
    // Duplicate of 42 → last-write-wins renames it.
    ['42', 'TURNED_ON', 'DUP PEAK', 'POINT(-97.74 30.27)', 'West', null, null, null],
    // No preferred id column and no name fields: the id-scan finds
    // camera_device_id and the name falls back to the id.
    [null, 'TURNED_ON', null, null, '', '30.24', '-97.77', '90123'],
    // No id anywhere → the row is skipped.
    [null, 'TURNED_ON', 'no id cam', 'POINT(-97.75 30.26)', '', null, null, null],
  ],
};

const CALTRANS_ROW = (overrides) => ({
  cctv: {
    inService: 'true',
    location: {
      latitude: '37.7790',
      longitude: '-122.4190',
      locationName: 'TV102 -- I-580 : MacArthur',
      nearbyPlace: 'Oakland',
      direction: 'South',
      elevation: '1000',
    },
    imageData: { static: { currentImageURL: 'https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102.jpg' } },
    ...overrides,
  },
});

const CALTRANS_D4 = {
  data: [
    CALTRANS_ROW({}),
    CALTRANS_ROW({ inService: 'false' }),
    CALTRANS_ROW({
      location: { latitude: '37.8', longitude: '-122.5', locationName: 'TV999 -- Bay Bridge', direction: '' },
      imageData: { static: { currentImageURL: 'http://evil.example/x.jpg' } },
    }),
    // Seven more in-service cameras near the SF anchor: with the pack cap at 8
    // and ten total cameras, the anchor-distance sort must drop exactly the
    // farthest one (TV888, out at sea, far from ALL four metro anchors).
    ...Array.from({ length: 7 }, (_, i) => CALTRANS_ROW({
      location: {
        latitude: String(37.78 + i * 0.01),
        longitude: '-122.419',
        locationName: `TV2${i} -- I-280 : stretch ${i}`,
        nearbyPlace: '',
        direction: '',
        elevation: '',
      },
    })),
    CALTRANS_ROW({
      location: {
        latitude: '36.0', longitude: '-123.5',
        locationName: 'TV888 -- Pacific : far', nearbyPlace: '', direction: '', elevation: '',
      },
    }),
  ],
};

const CALTRANS_D7 = {
  data: [
    CALTRANS_ROW({
      location: {
        latitude: '34.05', longitude: '-118.24',
        locationName: 'TV700 -- US101 : Cahuilla', nearbyPlace: '', direction: '', elevation: '',
      },
    }),
  ],
};

const TFL_PLACES = [
  {
    id: 'JamCams_00002.00865',
    commonName: 'Abbey Road',
    lat: 51.5074,
    lon: -0.1278,
    additionalProperties: [
      { key: 'available', value: 'true' },
      { key: 'imageUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg' },
    ],
  },
  { id: 'JamCams_00003.01130', commonName: 'Dark cam', lat: 51.51, lon: -0.12,
    additionalProperties: [{ key: 'available', value: 'false' }] },
  { id: 'JamCams_00004.07160', commonName: 'Off-bucket', lat: 51.52, lon: -0.13,
    additionalProperties: [
      { key: 'available', value: 'true' },
      { key: 'imageUrl', value: 'https://evil.example/00004.jpg' },
    ] },
];

/** Hand-authored catalog entries merged into every loader test. */
const CONFIGURED = [
  { id: '42', name: 'Config override 42', lat: 30.27, lon: -97.74,
    url: 'https://example.com/cam42.jpg', poseSource: 'curated' },
  { id: 'cfg-heading', name: 'heading cam', lat: 30.5, lon: -97.5,
    headingDeg: '270', headingSource: 'high', feedType: 'mjpg' },
  { id: 'cfg-unsafe', name: 'unsafe', lat: 30, lon: -97,
    url: 'http://localhost:8080/frame', snapshotUrl: 'http://127.0.0.1/x' },
  { id: 'cfg-nourl', name: 'no url cam' },
];

// ── harness ─────────────────────────────────────────────────────────────────

const jsonResponse = (payload) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

/** Route stubbed fetches to per-host canned payloads; anything else throws. */
function installFetch(handlers) {
  const saved = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    urls.push(url);
    for (const handler of handlers) {
      if (handler.match(url)) return handler.reply(url);
    }
    throw new Error(`unexpected CCTV upstream fetch: ${url}`);
  };
  return { urls, restore: () => { globalThis.fetch = saved; } };
}

/** Silence (and record) the loader's console chatter for one test. */
function captureConsole(t) {
  const lines = { log: [], warn: [] };
  const saved = { log: console.log, warn: console.warn };
  console.log = (...args) => lines.log.push(args.join(' '));
  console.warn = (...args) => lines.warn.push(args.join(' '));
  t.after(() => { console.log = saved.log; console.warn = saved.warn; });
  return lines;
}

const LIVE_HANDLERS = [
  { match: (u) => u.includes('data.austintexas.gov'), reply: () => jsonResponse(AUSTIN_PAYLOAD) },
  {
    match: (u) => u.includes('cwwp2.dot.ca.gov/data/d'),
    reply: (u) => jsonResponse(u.includes('/d4/') ? CALTRANS_D4 : CALTRANS_D7),
  },
  { match: (u) => u.includes('api.tfl.gov.uk'), reply: () => jsonResponse(TFL_PLACES) },
];

const byId = (catalog) => new Map(catalog.map((source) => [source.id, source]));

/** Jump the module's 15-min catalog TTL (mock Date starts at epoch 0). Each
 * call jumps an hour FURTHER than the last: a refresh stamps the cache with
 * mocked (future) time, so a fixed offset would land back on it. */
let catalogEpochJumps = 0;
function expireCatalogCache(t) {
  catalogEpochJumps += 1;
  const realNow = Date.now();
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(realNow + CCTV_SOURCE_CACHE_MS + catalogEpochJumps * 3_600_000);
}

// ── pure helpers ────────────────────────────────────────────────────────────

test('hashSeed is FNV-1a 32-bit and deterministic', () => {
  assert.equal(hashSeed(''), 2166136261, 'FNV offset basis');
  assert.equal(hashSeed('a'), 3826002220, 'known FNV-1a vector');
  assert.equal(hashSeed('cam-42'), hashSeed('cam-42'));
});

test('escapeXml neutralizes markup characters', () => {
  assert.equal(escapeXml('<a & "b" \'c\'>'), '&lt;a &amp; &quot;b&quot; &#39;c&#39;&gt;');
  assert.equal(escapeXml(''), '');
  assert.equal(escapeXml(null), '');
});

test('normalizeFeedType + isVideoFeedType canonicalize feed kinds', () => {
  assert.equal(normalizeFeedType('JPEG'), 'image');
  assert.equal(normalizeFeedType(' jpg '), 'image');
  assert.equal(normalizeFeedType('mjpg'), 'mjpeg');
  assert.equal(normalizeFeedType('Video'), 'mp4');
  assert.equal(normalizeFeedType('STREAM'), 'hls');
  assert.equal(normalizeFeedType(''), 'image');
  assert.equal(normalizeFeedType('weird'), 'weird', 'unknown kinds pass through');
  assert.ok(isVideoFeedType('mp4') && isVideoFeedType('webm') && isVideoFeedType('hls'));
  assert.equal(isVideoFeedType('image'), false);
});

test('toFiniteNumber coerces with a fallback', () => {
  assert.equal(toFiniteNumber('12.5'), 12.5);
  assert.ok(Number.isNaN(toFiniteNumber('abc')));
  assert.equal(toFiniteNumber('abc', 0), 0);
  assert.equal(toFiniteNumber(Number.POSITIVE_INFINITY, -1), -1);
});

test('parsePointString reads WKT (lon lat) order', () => {
  assert.deepEqual(parsePointString('POINT(-97.74 30.27)'), { lon: -97.74, lat: 30.27 });
  assert.ok(Number.isNaN(parsePointString('POLYGON x').lat));
  assert.ok(Number.isNaN(parsePointString('').lat));
});

test('coerceLatLon reads the usual coordinate vocabularies', () => {
  assert.deepEqual(coerceLatLon({ latitude: 1, longitude: 2 }), { lat: 1, lon: 2 });
  assert.deepEqual(coerceLatLon({ lat: 3, lng: 4 }), { lat: 3, lon: 4 });
  assert.deepEqual(coerceLatLon({ y: 5, x: 6 }), { lat: 5, lon: 6 });
  assert.deepEqual(coerceLatLon({ Latitude: '7', Longitude: '8' }), { lat: 7, lon: 8 });
  assert.deepEqual(coerceLatLon('POINT(9 10)'), { lon: 9, lat: 10 });
  assert.ok(Number.isNaN(coerceLatLon(42).lat), 'scalars have no coordinates');
  assert.ok(Number.isNaN(coerceLatLon(null).lat));
});

test('haversineKm measures great-circle kilometres', () => {
  assert.equal(haversineKm(30, -97, 30, -97), 0);
  assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - 111.19) < 0.05, '1° of equatorial longitude');
});

test('CCTV_SOURCES_JSON decodes arrays and degrades everything else to []', () => {
  assert.deepEqual(parseConfiguredSourcesFromEnv('[{"id":"a"}]'), [{ id: 'a' }]);
  assert.deepEqual(parseConfiguredSourcesFromEnv('{"id":"not-an-array"}'), []);
  assert.deepEqual(parseConfiguredSourcesFromEnv('not json'), []);
  assert.deepEqual(parseConfiguredSourcesFromEnv(''), []);
  assert.deepEqual(parseConfiguredSourcesFromEnv(undefined), []);
});

test('buildSyntheticCctvSvg renders deterministic, escaped placeholder art', () => {
  const svg = buildSyntheticCctvSvg({ cameraId: 'cam<1>', label: 'I-35 & 6th', city: 'Austin', status: 'UPSTREAM' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('I-35 &amp; 6th'), 'label escaped');
  assert.ok(svg.includes('cam&lt;1&gt;'), 'id escaped');
  assert.ok(svg.includes('Austin'));
  assert.ok(svg.includes('UPSTREAM'));
  const again = buildSyntheticCctvSvg({ cameraId: 'cam<1>', label: 'I-35 & 6th', city: 'Austin', status: 'UPSTREAM' });
  const hues = (s) => [...s.matchAll(/hsla?\((\d+)/g)].map((m) => m[1]).join(',');
  assert.equal(hues(svg), hues(again), 'palette derived from the camera identity, not the clock');
  const fallback = buildSyntheticCctvSvg({ cameraId: 'x', label: 'y' });
  assert.ok(fallback.includes('GLOBAL GRID'), 'city defaults');
  assert.ok(fallback.includes('SYNTHETIC'), 'status defaults');
});

test('buildMediaPassthrough forwards stream headers and stamps the source', () => {
  const upstream = new Response(null, {
    status: 206,
    headers: {
      'content-type': 'video/mp4',
      'content-length': '1234',
      'content-range': 'bytes 0-1233/9999',
      'accept-ranges': 'bytes',
      'cache-control': 'max-age=4',
    },
  });
  assert.deepEqual(buildMediaPassthrough(upstream, { sourceHeader: 'caltrans' }), {
    ok: true,
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'max-age=4',
      'X-CCTV-Source': 'caltrans',
      'Content-Length': '1234',
      'Content-Range': 'bytes 0-1233/9999',
      'Accept-Ranges': 'bytes',
    },
  });
});

test('buildMediaPassthrough defaults sparse upstreams and refuses oversized declared bodies', () => {
  const sparse = buildMediaPassthrough(new Response(null, { headers: {} }));
  assert.equal(sparse.ok, true);
  assert.equal(sparse.headers['Content-Type'], 'application/octet-stream');
  assert.equal(sparse.headers['Cache-Control'], 'no-store');
  assert.equal(sparse.headers['X-CCTV-Source'], 'upstream');
  assert.equal('Content-Length' in sparse.headers, false, 'live streams declare no length');

  const huge = buildMediaPassthrough(new Response(null, {
    headers: { 'content-length': String(MEDIA_DECLARED_CAP_BYTES + 1) },
  }));
  assert.deepEqual(huge, { ok: false, status: 502, error: 'Upstream media exceeds size cap' });
});

test('buildStreamPayload routes video feeds to the media proxy and stills to frames', () => {
  const video = buildStreamPayload(
    { feedType: 'mp4', provider: 'Caltrans', sourceKind: 'caltrans-open-data', url: 'https://x/y' },
    'ca-1',
  );
  assert.equal(video.feedType, 'mp4');
  assert.equal(video.mediaUrl, api.cctvMedia('ca-1'));
  assert.equal(video.frameUrl, api.cctvFrame('ca-1'));
  assert.equal(video.provider, 'Caltrans');

  // 'mjpeg' is deliberately NOT a <video> feed (client cctv.js mirrors this):
  // stills-first means even an mjpg source routes through the frame endpoint.
  const stills = buildStreamPayload({ feedType: 'mjpg', url: 'https://x/y' }, 'ca-2');
  assert.equal(stills.feedType, 'mjpeg');
  assert.equal(stills.mediaUrl, null);
  assert.equal(stills.frameUrl, api.cctvFrame('ca-2'));

  const unknown = buildStreamPayload(undefined, 'ghost');
  assert.equal(unknown.feedType, 'image');
  assert.equal(unknown.mediaUrl, null);
  assert.equal(unknown.sourceKind, 'fallback');

  const bare = buildStreamPayload({ id: 'bare' }, 'bare');
  assert.equal(bare.sourceKind, 'fallback', 'a source with no URL is not configurable');
});

test('the health tracker patches, merges and evicts', () => {
  const tracker = createCctvHealthTracker();
  tracker.setHealth('cam-1', { status: 'upstream', sourceKind: 'austin-open-data', label: 'I-35' });
  tracker.setHealth('cam-1', { status: 'streetview', message: 'snap missed' });
  const entry = tracker.listHealth().find((e) => e.id === 'cam-1');
  assert.equal(entry.status, 'streetview');
  assert.equal(entry.sourceKind, 'austin-open-data', 'unspecified fields persist');
  assert.equal(entry.label, 'I-35');
  assert.equal(entry.message, 'snap missed');
  assert.ok(Number.isFinite(entry.updatedAt));

  for (let i = 0; i < 1300; i++) tracker.setHealth(`bulk-${i}`, { status: 'upstream' });
  const all = tracker.listHealth();
  assert.equal(all.length, 1200, 'bounded at the catalog ceiling');
  assert.ok(!all.some((e) => e.id === 'cam-1'), 'oldest entries evicted first');
});

// ── Street View fallback ────────────────────────────────────────────────────

test('streetViewFallback refuses to spend quota it cannot justify', async () => {
  const f = installFetch([]);
  try {
    assert.equal(await streetViewFallback({ lat: 30, lon: -97, apiKey: '' }), null, 'no key');
    assert.equal(
      await streetViewFallback({ lat: 30, lon: -97, apiKey: 'your_google_maps_api_key_here' }),
      null,
      'the scaffolded placeholder counts as absent',
    );
    assert.equal(await streetViewFallback({ lat: 95, lon: -97, apiKey: 'k' }), null, 'lat off-planet');
    assert.equal(await streetViewFallback({ lat: 30, lon: Number.NaN, apiKey: 'k' }), null, 'lon not finite');
    assert.equal(f.urls.length, 0, 'none of these reached the network');
  } finally {
    f.restore();
  }
});

test('streetViewFallback builds the bounded static-view request and passes the frame through', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const saved = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(new URL(String(url)));
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    const frame = await streetViewFallback({ lat: 30.27, lon: -97.74, heading: 450, fov: 150, pitch: -90, apiKey: 'sv-key' });
    assert.ok(frame?.ok);
    assert.equal(frame.contentType, 'image/jpeg');
    assert.deepEqual([...frame.body], [1, 2, 3]);
    const q = seen[0].searchParams;
    assert.equal(seen[0].pathname, '/maps/api/streetview');
    assert.equal(q.get('size'), '960x540');
    assert.equal(q.get('location'), '30.27,-97.74');
    assert.equal(q.get('heading'), '90', 'heading normalized into [0,360)');
    assert.equal(q.get('fov'), '120', 'fov clamped to the API max');
    assert.equal(q.get('pitch'), '-40', 'pitch clamped to the API min');
    assert.equal(q.get('source'), 'outdoor');
    assert.equal(q.get('return_error_code'), 'true');
    assert.equal(q.get('key'), 'sv-key');

    await streetViewFallback({ lat: 30.27, lon: -97.74, heading: -10, fov: 5, pitch: 50, apiKey: 'sv-key' });
    assert.equal(seen[1].searchParams.get('heading'), '350', 'negative heading wraps');
    assert.equal(seen[1].searchParams.get('fov'), '20', 'fov clamped to the API min');
    assert.equal(seen[1].searchParams.get('pitch'), '20', 'pitch clamped to the API max');
  } finally {
    globalThis.fetch = saved;
  }
});

test('streetViewFallback treats every upstream miss as a null frame', async () => {
  const saved = globalThis.fetch;
  const responders = [
    () => new Response('nope', { status: 404 }),
    () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => { throw new Error('offline'); },
    // Declared oversized body → the byte cap refuses it before buffering.
    () => new Response(new Uint8Array(4), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(CCTV_IMAGE_MAX_BYTES + 1) },
    }),
  ];
  for (const respond of responders) {
    globalThis.fetch = async () => respond();
    try {
      assert.equal(await streetViewFallback({ lat: 30, lon: -97, apiKey: 'k' }), null);
    } finally {
      globalThis.fetch = saved;
    }
  }
});

// ── the catalog pipeline (loaders → merge → cache), in cache-state order ────

test('cold refresh loads, normalizes, dedupes and caps all three live packs', async (t) => {
  captureConsole(t);
  const f = installFetch(LIVE_HANDLERS);
  try {
    const catalog = await getCctvSources({
      configuredSources: CONFIGURED,
      env: {
        // Forced: a configured catalog alone would suppress the live packs.
        CCTV_FORCE_AUSTIN: '1',
        TFL_APP_KEY: 'tfl-key-1',
        CCTV_CALTRANS_DISTRICTS: '4,7',
        // 10 Caltrans cameras, cap 8 → the distance sort decides who survives.
        CCTV_CALTRANS_MAX_SOURCES: '8',
      },
    });
    assert.equal(f.urls.filter((u) => u.includes('data.austintexas.gov')).length, 1);
    assert.equal(f.urls.filter((u) => u.includes('cwwp2.dot.ca.gov')).length, 2, 'one fetch per configured district');
    assert.ok(f.urls.some((u) => u.includes('app_key=tfl-key-1')), 'the TfL key rides on the list request');

    const cams = byId(catalog);

    // Austin: WKT coords, the dedicated-direction heading, the bbox + status
    // gates, scalar-coordinate fallback, and dedupe (last write wins) — with
    // the configured override taking the '42' slot in the merge.
    assert.equal(cams.get('42').name, 'Config override 42', 'configured entries override live packs');
    assert.equal(cams.get('42').poseSource, 'curated', 'hand-authored pose badge passes through');
    const a43 = cams.get('43');
    assert.equal(a43.city, 'Austin');
    assert.equal(a43.cityId, 'austin');
    assert.equal(a43.headingConfidence, 'low', 'a bare WEST in street text is not a facing');
    assert.equal(a43.headingDeg % 22.5, 0, 'fallback heading is one of 16 compass stops');
    assert.equal(a43.url, 'https://cctv.austinmobility.io/image/43.jpg');
    assert.equal(a43.feedType, 'image');
    const a46 = cams.get('46');
    assert.equal(a46.lat, 30.25, 'scalar lat/lon columns parsed');
    assert.equal(a46.lon, -97.76);
    const a90123 = cams.get('90123');
    assert.equal(a90123.name, 'Austin Camera 90123', 'id-scan found the device column; name defaulted');
    assert.equal(a90123.headingConfidence, 'low');
    assert.ok(!cams.has('44'), 'outside the Austin bbox');
    assert.ok(!cams.has('45'), 'planned cameras are not live');

    // Configured normalization: headings coerce, feed kinds canonicalize,
    // unsafe media URLs drop to '' while the camera still lists.
    const ch = cams.get('cfg-heading');
    assert.equal(ch.headingDeg, 270);
    assert.equal(ch.headingConfidence, 'high', 'headingSource aliases headingConfidence');
    assert.equal(ch.feedType, 'mjpeg');
    assert.equal(cams.get('cfg-unsafe').url, '', 'loopback media URL refused');
    assert.equal(cams.get('cfg-unsafe').snapshotUrl, '');
    assert.ok(cams.has('cfg-unsafe'), 'the camera itself still lists');
    const noUrl = cams.get('cfg-nourl');
    assert.equal(noUrl.provider, 'Configured CCTV Source');
    assert.equal(noUrl.sourceKind, 'configured');
    assert.equal(noUrl.poseSource, undefined);

    // Caltrans: service gate, official-host image pin, code extraction,
    // feet→metres elevation, and the anchor-distance cap (1 slot, 2 metros →
    // the camera nearest ANY anchor wins).
    const ca = cams.get('ca-d4-tv102');
    assert.equal(ca.headingDeg, 180, 'loc.direction is a dedicated field — bare cardinals count');
    assert.equal(ca.headingConfidence, 'high');
    assert.ok(Math.abs(ca.groundElevationM - 304.8) < 0.01, '1000 ft converted to metres');
    assert.equal(ca.name, 'I-580 : MacArthur (Oakland)');
    assert.equal(ca.city, 'Oakland');
    assert.equal(ca.cityId, 'ca-d4');
    assert.ok(ca.url.startsWith('https://cwwp2.dot.ca.gov/'));
    assert.ok(!cams.has('ca-d4-tv888'), 'the anchor-distance sort drops the camera farthest from every metro');
    assert.ok(cams.has('ca-d4-tv20') && cams.has('ca-d7-tv700'), 'near-anchor cameras from both districts survive the cap');

    // TfL: availability gate, official-bucket pin, provider-stable ids.
    const tfl = cams.get('tfl-00002.00865');
    assert.equal(tfl.name, 'Abbey Road');
    assert.equal(tfl.city, 'London');
    assert.equal(tfl.headingConfidence, 'low', 'JamCams carry no heading signal');
    assert.equal(tfl.groundElevationM, 15);
    assert.equal(tfl.feedType, 'image', 'stills-first even when video exists');
    assert.ok(!cams.has('tfl-00003.01130'), 'unavailable cameras dropped');
    assert.ok(!cams.has('tfl-00004.07160'), 'off-bucket image URLs dropped');
  } finally {
    f.restore();
  }
});

test('warm cache serves the catalog without refetching upstreams', async (t) => {
  captureConsole(t);
  const f = installFetch(LIVE_HANDLERS);
  try {
    const again = await getCctvSources({ configuredSources: CONFIGURED, env: {} });
    assert.equal(f.urls.length, 0, 'a TTL-fresh cache answers from memory');
    assert.ok(again.length > 0);
  } finally {
    f.restore();
  }
});

test('a post-TTL burst shares one refresh via single-flight', async (t) => {
  captureConsole(t);
  expireCatalogCache(t);
  const f = installFetch(LIVE_HANDLERS);
  try {
    const env = { CCTV_CALTRANS_DISTRICTS: '4,7', CCTV_CALTRANS_MAX_SOURCES: '1', TFL_APP_KEY: 'k' };
    const [ra, rb] = await Promise.all([getCctvSources({ env }), getCctvSources({ env })]);
    assert.equal(ra, rb, 'both callers receive the same in-flight catalog');
    assert.equal(f.urls.length, 4, 'one fetch per pack (austin + d4 + d7 + tfl), not per caller');
  } finally {
    f.restore();
  }
});

test('pack gates: force-austin overrides configured-only mode; disabled packs are never fetched', async (t) => {
  captureConsole(t);
  expireCatalogCache(t);
  const f = installFetch([LIVE_HANDLERS[0]]);
  try {
    const catalog = await getCctvSources({
      configuredSources: [{ id: 'cfg-x', name: 'cfg x', lat: 0, lon: 0 }],
      env: {
        CCTV_FORCE_AUSTIN: '1',
        CCTV_PREFER_AUSTIN: '0',
        CCTV_TFL_ENABLED: '0',
        CCTV_CALTRANS_DISTRICTS: '',
      },
    });
    assert.equal(f.urls.length, 1, 'only the austin pack was fetched');
    const cams = byId(catalog);
    assert.ok(cams.has('43'), 'forced austin pack loaded despite a configured catalog');
    assert.ok(cams.has('cfg-x'), 'configured sources still merged');
    assert.ok(!cams.has('tfl-00002.00865'), 'TfL disabled');
    assert.ok(![...cams.keys()].some((id) => id.startsWith('ca-')), 'empty district list disables Caltrans');
  } finally {
    f.restore();
  }
});

test('the global source cap slices the merged catalog and warns', async (t) => {
  const lines = captureConsole(t);
  expireCatalogCache(t);
  const f = installFetch([LIVE_HANDLERS[0]]);
  try {
    // The cap floors at 8, so merge past that: 4 austin + 6 configured = 10.
    const configured = Array.from({ length: 6 }, (_, i) => ({ id: `cfg-${i + 1}`, lat: 0, lon: 0 }));
    const catalog = await getCctvSources({
      configuredSources: configured,
      env: {
        CCTV_FORCE_AUSTIN: '1',
        CCTV_TFL_ENABLED: '0',
        CCTV_CALTRANS_DISTRICTS: '',
        CCTV_MAX_SOURCES: '8',
      },
    });
    assert.deepEqual(
      catalog.map((s) => s.id),
      ['42', '43', '46', '90123', 'cfg-1', 'cfg-2', 'cfg-3', 'cfg-4'],
      'cap keeps the first (live-first) entries',
    );
    assert.ok(lines.warn.some((line) => line.includes('exceeds cap')), 'an over-cap merge is surfaced');
  } finally {
    f.restore();
  }
});

test('a fully-dark refresh serves the previous catalog stale', async (t) => {
  const lines = captureConsole(t);
  expireCatalogCache(t);
  const f = installFetch([{ match: () => true, reply: () => { throw new Error('dark'); } }]);
  try {
    const catalog = await getCctvSources({
      env: { CCTV_FORCE_AUSTIN: '1', CCTV_TFL_ENABLED: '0', CCTV_CALTRANS_DISTRICTS: '' },
    });
    assert.deepEqual(
      catalog.map((s) => s.id),
      ['42', '43', '46', '90123', 'cfg-1', 'cfg-2', 'cfg-3', 'cfg-4'],
      'the last good catalog is served',
    );
    assert.equal(f.urls.length, 1, 'the refresh was genuinely attempted');
    assert.ok(lines.warn.some((l) => l.includes('serving')), 'the stale-serve fallback is surfaced');
  } finally {
    f.restore();
  }
});

test('pack HTTP failures empty their packs independently but never blank the catalog', async (t) => {
  const lines = captureConsole(t);
  expireCatalogCache(t);
  const f = installFetch([
    // Austin: explicit HTTP failure.
    { match: (u) => u.includes('data.austintexas.gov'), reply: () => new Response('nope', { status: 500 }) },
    // Caltrans: the district fetch rejects → Promise.allSettled isolates it.
    { match: (u) => u.includes('cwwp2.dot.ca.gov'), reply: () => new Response('nope', { status: 500 }) },
    // TfL: 200 with garbage JSON → the parse throws into the pack's catch.
    { match: (u) => u.includes('api.tfl.gov.uk'), reply: () => new Response('not json', { status: 200 }) },
  ]);
  try {
    const catalog = await getCctvSources({
      env: { CCTV_FORCE_AUSTIN: '1', CCTV_CALTRANS_DISTRICTS: '4' },
    });
    assert.deepEqual(
      catalog.map((s) => s.id),
      ['42', '43', '46', '90123', 'cfg-1', 'cfg-2', 'cfg-3', 'cfg-4'],
      'the previous catalog is served while every live pack is dark',
    );
    assert.equal(f.urls.length, 3, 'each pack was genuinely attempted');
    assert.ok(lines.warn.some((l) => l.includes('Austin source download failed')), 'austin HTTP failure surfaced');
    assert.ok(lines.warn.some((l) => l.includes('Caltrans district fetch failed')), 'caltrans district failure surfaced');
    assert.ok(lines.warn.some((l) => l.includes('TfL JamCam download error')), 'tfl parse failure surfaced');
  } finally {
    f.restore();
  }
});
