import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { createMcpServer } from '../mcp/index.js';

const cameras = [
  {
    id: 'austin-1',
    name: 'Congress at 6th',
    city: 'Austin',
    provider: 'City of Austin',
    lat: 30.2685,
    lon: -97.7425,
    headingDeg: 180,
    feedType: 'image',
    credit: 'City of Austin',
  },
  {
    id: 'austin-2',
    name: 'Lamar at 5th',
    city: 'Austin',
    provider: 'City of Austin',
    lat: 30.2695,
    lon: -97.7535,
    headingDeg: 90,
    feedType: 'image',
    credit: '',
  },
  { id: 'far', name: 'Elsewhere', city: 'Oslo', lat: 59.9, lon: 10.7 },
  { id: 'no-position', name: 'Unplaced' },
];
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cctv = (frame = { contentType: 'image/png', bytes: PNG }) => ({
  frames: [],
  async getCatalog() {
    return { sources: cameras };
  },
  async getFrame(camera) {
    this.frames.push(camera.id);
    return frame;
  },
});
const downtown = { lat: 30.2672, lon: -97.7431, radius_km: 3 };

test('cameras in an area are listed nearest first', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { cctv: cctv() },
  });
  const result = await catalog.call('find_cctv_cameras', { area: downtown });
  assert.equal(
    result.summary,
    '2 public cameras in 3 km around 30.267, -97.743.',
  );
  assert.deepEqual(
    result.data.rows.map((row) => row.id),
    ['austin-1', 'austin-2'],
  );
  assert.deepEqual(result.data.rows[0], {
    id: 'austin-1',
    name: 'Congress at 6th',
    city: 'Austin',
    provider: 'City of Austin',
    lat: 30.2685,
    lon: -97.7425,
    heading_deg: 180,
    feed_type: 'image',
    credit: 'City of Austin',
    distance_km: 0.16,
  });
  assert.equal(result.data.rows[1].credit, null);
});

test('a snapshot returns the frame as an image with its credit', async () => {
  const source = cctv();
  const catalog = composeCatalog({
    tools: coreTools,
    services: { cctv: source },
  });
  const result = await catalog.call('get_cctv_snapshot', {
    camera_id: 'austin-1',
  });
  assert.equal(
    result.summary,
    'Current view from Congress at 6th in Austin, courtesy of City of Austin.',
  );
  assert.deepEqual(result.images, [
    { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ]);
  assert.equal(result.data.bytes, 8);
  assert.deepEqual(source.frames, ['austin-1']);

  const server = createMcpServer({ catalog, name: 'test', version: '1' });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_cctv_snapshot', arguments: { camera_id: 'austin-1' } },
  });
  assert.deepEqual(response.result.content[2], {
    type: 'image',
    data: 'iVBORw0KGgo=',
    mimeType: 'image/png',
  });
});

test('unknown cameras, video-only feeds and oversized frames are reported', async () => {
  const catalog = (frame) =>
    composeCatalog({ tools: coreTools, services: { cctv: cctv(frame) } });
  await assert.rejects(
    catalog().call('get_cctv_snapshot', { camera_id: 'nope' }),
    /No camera has id nope; use find_cctv_cameras first/,
  );
  await assert.rejects(
    catalog({ contentType: 'video/mp2t', bytes: PNG }).call(
      'get_cctv_snapshot',
      { camera_id: 'austin-2' },
    ),
    (error) =>
      error.code === 'unavailable' && /no still image/.test(error.message),
  );
  await assert.rejects(
    catalog({
      contentType: 'image/jpeg',
      bytes: new Uint8Array(3 * 1024 * 1024 + 1),
    }).call('get_cctv_snapshot', { camera_id: 'austin-2' }),
    /too large/,
  );
});

test('radio stations match area and every search term', async () => {
  const radio = {
    async getDirectory() {
      return {
        stations: [
          {
            id: 'a',
            name: 'KUTX',
            lat: 30.28,
            lon: -97.74,
            country: 'United States',
            state: 'Texas',
            tags: ['music', 'indie'],
            languages: ['english'],
            codec: 'MP3',
            bitrate: 128,
            streamUrl: 'https://example.org/kutx.mp3',
            homepage: 'https://kutx.org',
          },
          {
            id: 'b',
            name: 'KMFA Classical',
            lat: 30.3,
            lon: -97.7,
            country: 'United States',
            state: 'Texas',
            tags: ['classical'],
            languages: ['english'],
            codec: 'AAC',
            bitrate: null,
            streamUrl: 'https://example.org/kmfa.aac',
          },
          {
            id: 'c',
            name: 'Jazz Oslo',
            lat: 59.9,
            lon: 10.7,
            country: 'Norway',
            tags: ['jazz'],
            languages: ['norwegian'],
          },
        ],
      };
    },
  };
  const catalog = composeCatalog({ tools: coreTools, services: { radio } });
  const nearby = await catalog.call('find_radio_stations', {
    area: { lat: 30.27, lon: -97.74, radius_km: 20 },
  });
  assert.deepEqual(
    nearby.data.rows.map((row) => row.id),
    ['a', 'b'],
  );
  assert.equal(nearby.data.rows[0].stream_url, 'https://example.org/kutx.mp3');
  const jazz = await catalog.call('find_radio_stations', {
    query: 'jazz norwegian',
  });
  assert.equal(
    jazz.summary,
    '1 radio station matching "jazz norwegian" (from a directory of 3 popular stations).',
  );
  assert.equal(jazz.data.directory_size, 3);
  assert.equal(jazz.data.stale, false);
  assert.equal(jazz.data.rows[0].distance_km, undefined);
  const classicalTexas = await catalog.call('find_radio_stations', {
    query: 'classical texas',
    area: { lat: 30.27, lon: -97.74, radius_km: 20 },
  });
  assert.deepEqual(
    classicalTexas.data.rows.map((row) => row.id),
    ['b'],
  );
  assert.equal(classicalTexas.data.rows[0].bitrate_kbps, null);
  await assert.rejects(
    catalog.call('find_radio_stations', {}),
    /area, a query or both/,
  );
});

test('malformed image results are a programming error', async () => {
  const { defineTool } = await import('../catalog.js');
  const bad = defineTool({
    name: 'bad_image',
    title: 'Bad',
    description: 'Returns a malformed image.',
    inputSchema: { type: 'object' },
    run: async () => ({
      summary: 'x',
      data: {},
      images: [{ mimeType: 'image/png' }],
    }),
  });
  await assert.rejects(
    composeCatalog({ tools: [bad] }).call('bad_image'),
    /malformed images/,
  );
});

test('a stale or degraded radio directory is reported', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      radio: {
        getDirectory: async () => ({
          stations: [],
          stale: true,
          degraded: true,
        }),
      },
    },
  });
  const result = await catalog.call('find_radio_stations', { query: 'jazz' });
  assert.match(
    result.summary,
    /the directory may be stale; the directory is incomplete right now\)\.$/,
  );
  assert.equal(result.data.degraded, true);
});

test('cameras from a trimmed catalog pack are reported as partial', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      cctv: {
        getCatalog: async () => ({
          trimmedPacks: [
            { pack: 'tfl', available: 900, served: 250 },
            { pack: 'other', available: 10, served: 5 },
          ],
          sources: [
            {
              id: 'jam-1',
              name: 'Strand',
              lat: 51.51,
              lon: -0.12,
              pack: 'tfl',
            },
          ],
        }),
      },
    },
  });
  const result = await catalog.call('find_cctv_cameras', {
    area: { lat: 51.51, lon: -0.12, radius_km: 5 },
  });
  assert.equal(result.data.complete, false);
  assert.deepEqual(result.data.catalog_trimmed, [
    { pack: 'tfl', available: 900, served: 250 },
  ]);
  assert.match(
    result.summary,
    /\(the catalog serves only some cameras here: 250 of 900 from tfl\)\.$/,
  );
});

test('an area the catalog trimmed away entirely is not reported complete', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      cctv: {
        getCatalog: async () => ({
          trimmedPacks: [
            {
              pack: 'tfl',
              available: 900,
              served: 250,
              region: { west: -0.6, south: 51.3, east: 0.3, north: 51.7 },
            },
          ],
          // Every served camera is in central London, none in the suburb.
          sources: [
            {
              id: 'jam-1',
              name: 'Strand',
              lat: 51.51,
              lon: -0.12,
              pack: 'tfl',
            },
          ],
        }),
      },
    },
  });
  const suburb = await catalog.call('find_cctv_cameras', {
    area: { lat: 51.4, lon: -0.5, radius_km: 3 },
  });
  assert.equal(suburb.data.rows.length, 0);
  assert.equal(suburb.data.complete, false);
  assert.match(suburb.summary, /250 of 900 from tfl/);
  const elsewhere = await catalog.call('find_cctv_cameras', {
    area: { lat: 40.7, lon: -74, radius_km: 3 },
  });
  assert.equal(elsewhere.data.complete, true);
  assert.equal(
    elsewhere.summary,
    'The camera catalog has no cameras in 3 km around 40.700, -74.000.',
  );
});
