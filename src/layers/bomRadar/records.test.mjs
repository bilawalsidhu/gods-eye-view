import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOM_FRAME_PATTERN,
  BOM_LOOP_FRAMES,
  bomProductRangeKm,
  groupBomProductsByRadar,
  isBomFrameFile,
  isBomProduct,
  BOM_HEADER_ROWS,
  maskBomFurniture,
  newestBomFrames,
  parseBomFrameName,
  parseBomFrameTime,
  parseBomRadarListing,
  parseBomRadarMap,
} from './records.js';

// The georeferencing file for the Adelaide 128 km product, as published.
const ADELAIDE_MAP = `IDR643.map
64 Adelaide (128 km)
projection = Gnomonic
center_longitude =     138.46899
center_latitude  =     -34.61700
lon0 =     137.05746
lat0 =     -35.75734
lon1 =     137.09607
lat1 =     -33.45551
lon2 =     139.85535
lat2 =     -33.45536
lon3 =     139.89433
lat3 =     -35.75718
`;

test('the published map file parses: name, range, centre, corners and bounds', () => {
  const map = parseBomRadarMap(ADELAIDE_MAP);
  assert.equal(map.name, 'Adelaide');
  assert.equal(map.rangeKm, 128);
  assert.equal(map.projection, 'Gnomonic');
  assert.deepEqual(map.center, { lat: -34.617, lon: 138.46899 });
  assert.deepEqual(map.corners.sw, { lat: -35.75734, lon: 137.05746 });
  assert.deepEqual(map.corners.nw, { lat: -33.45551, lon: 137.09607 });
  assert.deepEqual(map.corners.ne, { lat: -33.45536, lon: 139.85535 });
  assert.deepEqual(map.corners.se, { lat: -35.75718, lon: 139.89433 });
  // The rectangle is the corners' min/max, not any single corner.
  assert.deepEqual(map.bounds, {
    west: 137.05746,
    south: -35.75734,
    east: 139.89433,
    north: -33.45536,
  });
});

test('CRLF files, reordered keys and a missing heading still parse', () => {
  const map = parseBomRadarMap(
    ADELAIDE_MAP.split('\n').slice(2).reverse().join('\r\n'),
  );
  assert.equal(map.name, null);
  assert.equal(map.rangeKm, null);
  assert.equal(map.bounds.west, 137.05746);
});

test('malformed or incomplete maps are rejected, never guessed at', () => {
  const without = (key) =>
    ADELAIDE_MAP.split('\n')
      .filter((line) => !line.startsWith(key))
      .join('\n');
  for (const bad of [
    '',
    '   \n',
    undefined,
    null,
    '<html>File Unavailable</html>',
    without('lat2'),
    without('lon3'),
    without('center_latitude'),
    ADELAIDE_MAP.replace('lat1 =     -33.45551', 'lat1 = north'),
    ADELAIDE_MAP.replace('lat0 =     -35.75734', 'lat0 = -135.75734'),
    ADELAIDE_MAP.replace('lon0 =     137.05746', 'lon0 = 237.05746'),
    // A collapsed box cannot be draped.
    ADELAIDE_MAP.replace('lon2 =     139.85535', 'lon2 = 137.09607').replace(
      'lon3 =     139.89433',
      'lon3 = 137.05746',
    ),
  ])
    assert.throws(() => parseBomRadarMap(bad), /invalid_map/, String(bad));
});

test('frame names are validated strictly, including the calendar', () => {
  assert.deepEqual(parseBomFrameName('IDR643.T.202610121609.png'), {
    file: 'IDR643.T.202610121609.png',
    product: 'IDR643',
    radar: '64',
    rangeKm: 128,
    timeMs: Date.UTC(2026, 9, 12, 16, 9),
  });
  assert.equal(parseBomFrameName('IDR0231.T.202610121609.png').radar, '023');
  assert.equal(parseBomFrameName('IDR0231.T.202610121609.png').rangeKm, 512);
  for (const bad of [
    'IDR64I.T.202610121609.png',
    'IDR645.T.202610121609.png',
    'IDR640.T.202610121609.png',
    'IDR6.T.202610121609.png',
    'IDR64.T.202610121609.png',
    'IDR6433.T.2026101216.png',
    'IDR643.T.20261012160.png',
    'IDR643.T.202610121609.png.exe',
    'idr643.T.202610121609.png',
    'IDR643.t.202610121609.png',
    'IDR643.T.202613121609.png',
    'IDR643.T.202602301609.png',
    'IDR643.T.202610122509.png',
    '../IDR643.T.202610121609.png',
    'IDR643.T.202610121609.png/../../etc/passwd',
    '/IDR643.T.202610121609.png',
    'IDR643.T.202610121609.png\n',
    '',
    null,
    {},
  ]) {
    assert.equal(parseBomFrameName(bad), null, String(bad));
    assert.equal(isBomFrameFile(bad) && parseBomFrameName(bad) !== null, false);
  }
  assert.equal(parseBomFrameTime('202402291200'), Date.UTC(2024, 1, 29, 12));
  assert.equal(parseBomFrameTime('202302291200'), null);
  assert.ok(BOM_FRAME_PATTERN.test('IDR643.T.202610121609.png'));
});

test('product ids accept only IDR, a 2-3 digit radar and a range digit 1-4', () => {
  for (const ok of ['IDR643', 'IDR641', 'IDR0234', 'IDR713'])
    assert.equal(isBomProduct(ok), true, ok);
  for (const bad of [
    'IDR64',
    'IDR645',
    'IDR64I',
    'IDR6433a',
    'idr643',
    'IDR643.map',
    '../IDR643',
    'IDR643 ',
    '',
    null,
  ])
    assert.equal(isBomProduct(bad), false, String(bad));
  assert.equal(bomProductRangeKm('IDR641'), 512);
  assert.equal(bomProductRangeKm('IDR642'), 256);
  assert.equal(bomProductRangeKm('IDR643'), 128);
  assert.equal(bomProductRangeKm('IDR644'), 64);
  assert.equal(bomProductRangeKm('IDR64I'), null);
});

test('the listing keeps radar frames, ignores junk and orders irregular times', () => {
  const listing = parseBomRadarListing([
    // Irregular spacing (5-6 minutes), listed out of order, with a duplicate.
    'IDR643.T.202610121620.png',
    'IDR643.T.202610121609.png',
    'IDR643.T.202610121614.png',
    'IDR643.T.202610121614.png',
    'IDR643.T.202610121625.png',
    'IDR644.T.202610121611.png',
    // Not radar frames.
    'IDR64I.T.202610121609.png',
    'IDR643.T.202610121609.gif',
    'IDR643.background.png',
    'IDR64.T.202610121609.png',
    'README.txt',
    '.',
    '..',
    '',
    null,
  ]);
  assert.deepEqual([...listing.keys()].sort(), ['IDR643', 'IDR644']);
  assert.deepEqual(
    listing.get('IDR643').map(({ file }) => file),
    [
      'IDR643.T.202610121609.png',
      'IDR643.T.202610121614.png',
      'IDR643.T.202610121620.png',
      'IDR643.T.202610121625.png',
    ],
  );
  assert.equal(parseBomRadarListing('not a list').size, 0);
});

test('only the newest frames are kept, newest last', () => {
  const names = Array.from(
    { length: 40 },
    (_, i) =>
      `IDR643.T.20261012${String(Math.floor(i / 6) + 10).padStart(2, '0')}${String((i % 6) * 10).padStart(2, '0')}.png`,
  );
  const kept = parseBomRadarListing(names, { keep: 30 }).get('IDR643');
  assert.equal(kept.length, 30);
  assert.equal(kept.at(-1).file, names.at(-1));
  assert.equal(kept[0].file, names[10]);
  const loop = newestBomFrames(kept);
  assert.equal(loop.length, BOM_LOOP_FRAMES);
  assert.equal(loop.at(-1).file, names.at(-1));
  assert.deepEqual(newestBomFrames(kept.slice(0, 3)), kept.slice(0, 3));
});

test('radars group their products and sort numerically', () => {
  assert.deepEqual(
    groupBomProductsByRadar([
      'IDR644',
      'IDR021',
      'IDR641',
      'IDR1013',
      'IDR643',
      'IDR02I',
    ]),
    [
      { id: '02', products: ['IDR021'] },
      { id: '64', products: ['IDR641', 'IDR643', 'IDR644'] },
      { id: '101', products: ['IDR1013'] },
    ],
  );
});

test('the radar title bar and caption are made transparent; rain is untouched', () => {
  const width = 512;
  const height = 512;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const set = (x, y, color) => rgba.set(color, (y * width + x) * 4);
  const RAIN = [
    [245, 245, 255, 255],
    [181, 181, 255, 255],
    [12, 12, 255, 255],
    [0, 151, 145, 255],
    [0, 102, 102, 255],
  ];
  // Header: opaque grey bar with black text, plus rain-coloured pixels in it.
  for (let y = 0; y < BOM_HEADER_ROWS; y++)
    for (let x = 0; x < width; x++)
      set(x, y, (x + y) % 7 === 0 ? [0, 0, 0, 255] : [193, 193, 193, 255]);
  set(100, 3, RAIN[0]);
  // Caption in rows 496-511: black text next to genuine rain pixels.
  for (let x = 52; x < 489; x += 3) set(x, 500, [0, 0, 0, 255]);
  set(300, 498, RAIN[0]);
  set(301, 506, RAIN[1]);
  // Rain, a translucent black shadow and a stray grey inside the picture.
  RAIN.forEach((color, i) => set(200 + i, 250, color));
  set(210, 250, [0, 0, 0, 128]);
  set(211, 250, [193, 193, 193, 200]);
  set(212, 250, [0, 0, 0, 255]);
  set(213, 250, [193, 193, 193, 255]);
  const before = rgba.slice();

  assert.equal(maskBomFurniture(rgba, width, height), rgba, 'in place');
  const at = (x, y) => [
    ...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4),
  ];
  const was = (x, y) => [
    ...before.slice((y * width + x) * 4, (y * width + x) * 4 + 4),
  ];

  for (let y = 0; y < BOM_HEADER_ROWS; y++)
    for (let x = 0; x < width; x++)
      assert.deepEqual(at(x, y), [0, 0, 0, 0], `header ${x},${y}`);
  for (let x = 52; x < 489; x += 3) assert.deepEqual(at(x, 500), [0, 0, 0, 0]);
  assert.deepEqual(at(212, 250), [0, 0, 0, 0]);
  assert.deepEqual(at(213, 250), [0, 0, 0, 0]);
  // Everything else is preserved byte for byte.
  for (const [x, y] of [
    [300, 498],
    [301, 506],
    [200, 250],
    [201, 250],
    [202, 250],
    [203, 250],
    [204, 250],
    [210, 250],
    [211, 250],
    [0, 16],
    [511, 511],
  ])
    assert.deepEqual(at(x, y), was(x, y), `kept ${x},${y}`);
  const changed = [];
  for (let i = BOM_HEADER_ROWS * width * 4; i < rgba.length; i++)
    if (rgba[i] !== before[i]) changed.push(i);
  assert.equal(changed.length > 0, true);
  assert.deepEqual(at(300, 498), RAIN[0]);
});

test('masking rejects a buffer that does not match its dimensions', () => {
  assert.throws(
    () => maskBomFurniture(new Uint8ClampedArray(12), 2, 2),
    /Invalid/,
  );
  assert.throws(() => maskBomFurniture(null, 2, 2), /Invalid/);
  assert.throws(
    () => maskBomFurniture(new Uint8ClampedArray(4), 0, 1),
    /Invalid/,
  );
  const short = new Uint8ClampedArray(4 * 4 * 4).fill(255);
  maskBomFurniture(short, 4, 4);
  assert.ok(
    short.every((v) => v === 0),
    'an image shorter than the header is all header',
  );
});
