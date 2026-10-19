import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BomRadarDisabledError,
  BOM_RADAR_OFF_MESSAGE,
  createBomRadarSource,
  frameUrl,
  validateBomFrames,
  validateBomProducts,
} from './source.js';

const FILE = 'IDR643.T.202610121609.png';
const frames = (extra = {}) => ({
  product: 'IDR643',
  name: 'Adelaide',
  rangeKm: 128,
  center: { lat: -34.6, lon: 138.5 },
  bounds: { west: 137, south: -35.8, east: 139.9, north: -33.4 },
  listedAt: 1_700_000_000_000,
  frames: [
    {
      time: '2026-10-12T16:04:00.000Z',
      url: '/api/bom-radar/frame/IDR643.T.202610121604.png',
    },
    { time: '2026-10-12T16:09:00.000Z', url: `/api/bom-radar/frame/${FILE}` },
  ],
  ...extra,
});
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

test('frame lists validate and rebuild their own URLs', () => {
  const valid = validateBomFrames(frames(), 'IDR643');
  assert.equal(valid.frames.length, 2);
  assert.equal(valid.frames[1].url, `/api/bom-radar/frame/${FILE}`);
  assert.equal(valid.frames[1].timeMs, Date.UTC(2026, 9, 12, 16, 9));
  assert.equal(valid.name, 'Adelaide');
  assert.equal(valid.stale, false);
  for (const bad of [
    frames({ product: 'IDR644' }),
    frames({ bounds: { west: 140, south: -35, east: 139, north: -33 } }),
    frames({ bounds: { west: 137, south: -95, east: 139, north: -33 } }),
    frames({ bounds: undefined }),
    frames({ frames: 'none' }),
    frames({
      frames: Array.from({ length: 13 }, (_, i) => ({
        time: `2026-10-12T16:${String(i).padStart(2, '0')}:00.000Z`,
        url: `/api/bom-radar/frame/IDR643.T.2026101216${String(i).padStart(2, '0')}.png`,
      })),
    }),
    // A server-supplied URL is never trusted: wrong host, path or product.
    frames({
      frames: [
        {
          time: '2026-10-12T16:09:00.000Z',
          url: `https://evil.example/${FILE}`,
        },
      ],
    }),
    frames({
      frames: [{ time: '2026-10-12T16:09:00.000Z', url: `/other/${FILE}` }],
    }),
    frames({
      frames: [
        {
          time: '2026-10-12T16:09:00.000Z',
          url: '/api/bom-radar/frame/IDR644.T.202610121609.png',
        },
      ],
    }),
    // The time must agree with the file name, and be strictly increasing.
    frames({
      frames: [
        {
          time: '2026-10-12T16:10:00.000Z',
          url: `/api/bom-radar/frame/${FILE}`,
        },
      ],
    }),
    frames({ frames: [...frames().frames].reverse() }),
    null,
  ])
    assert.throws(() => validateBomFrames(bad, 'IDR643'), /Malformed/);
  assert.throws(() => validateBomFrames(frames(), 'IDR64I'), /Malformed/);
});

test('product lists validate radar ids, product ids and centres', () => {
  const valid = validateBomProducts({
    radars: [
      {
        id: '64',
        products: ['IDR643'],
        center: { lat: -34.6, lon: 138.5 },
        name: 'Adelaide',
      },
      { id: '27', products: ['IDR271', 'IDR273'] },
    ],
    complete: false,
    stale: true,
  });
  assert.equal(valid.radars.length, 2);
  assert.equal(valid.radars[1].center, undefined);
  assert.equal(valid.complete, false);
  assert.equal(valid.stale, true);
  for (const bad of [
    null,
    { radars: 'x' },
    { radars: [{ id: '6', products: ['IDR643'] }] },
    { radars: [{ id: '64', products: [] }] },
    { radars: [{ id: '64', products: ['IDR64I'] }] },
    {
      radars: [{ id: '64', products: ['IDR643'], center: { lat: 99, lon: 0 } }],
    },
    {
      radars: [
        { id: '64', products: ['IDR643'], center: { lat: 'a', lon: 0 } },
      ],
    },
  ])
    assert.throws(() => validateBomProducts(bad), /Malformed/);
});

test('frame URLs are built only from validated file names', () => {
  assert.equal(frameUrl(FILE), `/api/bom-radar/frame/${FILE}`);
  for (const bad of [
    '../x',
    'IDR64I.T.202610121609.png',
    `${FILE}?x=1`,
    '',
    undefined,
  ])
    assert.throws(() => frameUrl(bad), /Invalid BoM radar frame/);
});

test('the source reads status, products and frames through bounded same-origin requests', async () => {
  const seen = [];
  const source = createBomRadarSource({
    fetchImpl: async (url, options) => {
      seen.push([url, options]);
      if (url === '/api/bom-radar/status') return json({ enabled: true });
      if (url === '/api/bom-radar/products')
        return json({
          radars: [{ id: '64', products: ['IDR643'] }],
          complete: true,
        });
      if (url === '/api/bom-radar/frames?product=IDR643') return json(frames());
      if (url === `/api/bom-radar/frame/${FILE}`)
        return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.deepEqual(await source.getStatus(), { enabled: true });
  assert.equal((await source.getProducts()).radars[0].id, '64');
  assert.equal(
    (await source.getFrames({ product: 'IDR643' })).frames.length,
    2,
  );
  assert.deepEqual([...(await source.getFrameImage({ file: FILE }))], [...PNG]);
  assert.ok(seen.every(([url]) => url.startsWith('/api/bom-radar/')));
  assert.ok(seen.every(([, options]) => options.redirect === 'error'));
  await assert.rejects(
    source.getFrames({ product: '../x' }),
    /Invalid BoM radar product/,
  );
  await assert.rejects(
    source.getFrameImage({ file: '../x' }),
    /Invalid BoM radar frame/,
  );
  assert.equal(seen.length, 4, 'invalid arguments never reach the network');
});

test('a 503 from the server is the disabled state; other failures are errors', async () => {
  const source = createBomRadarSource({
    fetchImpl: async () => json({ error: 'bom_radar_disabled' }, 503),
  });
  await assert.rejects(source.getProducts(), (error) => {
    assert.ok(error instanceof BomRadarDisabledError);
    assert.equal(error.code, 'disabled');
    assert.equal(error.message, BOM_RADAR_OFF_MESSAGE);
    return true;
  });
  await assert.rejects(
    source.getFrameImage({ file: FILE }),
    BomRadarDisabledError,
  );
  const broken = createBomRadarSource({
    fetchImpl: async () => json({ error: 'bom_radar_unavailable' }, 502),
  });
  await assert.rejects(broken.getProducts(), /BoM radar HTTP 502/);
});

test('a frame must be a PNG by content type and by signature', async () => {
  const respond = (body, type) =>
    createBomRadarSource({
      fetchImpl: async () =>
        new Response(body, { headers: { 'Content-Type': type } }),
    }).getFrameImage({ file: FILE });
  await assert.rejects(respond(PNG, 'text/html'), /not a PNG/);
  await assert.rejects(
    respond(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), 'image/png'),
    /not a PNG/,
  );
  await assert.rejects(
    respond(new Uint8Array(3 * 1024 * 1024), 'image/png'),
    /too large/,
  );
});
