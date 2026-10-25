import test from 'node:test';
import assert from 'node:assert/strict';
import { tileToBBox } from '../../data/tomtomTiles.js';
import { encodePoiTile } from './poiTileFixture.mjs';
import {
  CHARGING_MAX_TILES,
  CHARGING_STATION_LIMIT,
  chargingViewFits,
  createChargingSource,
} from './source.js';

const TEMPLATE =
  'https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf';
const BUILD_TIME = Date.UTC(2026, 9, 18, 8, 0, 1);
/** Central Oslo: a few z14 tiles. */
const OSLO = { south: 59.905, west: 10.73, north: 59.92, east: 10.77 };

/** One unnamed station in the middle of whichever tile is asked for. */
function stationTile(url) {
  const [z, x, y] = url
    .match(/(\d+)\/(\d+)\/(\d+)\.pbf$/)
    .slice(1)
    .map(Number);
  const box = tileToBBox(z, x, y);
  return encodePoiTile({ z, x, y }, [
    {
      lon: (box.west + box.east) / 2,
      lat: (box.south + box.north) / 2,
      class: 'fuel',
      subclass: 'charging_station',
    },
  ]);
}

/** A source over an injected fetch; `tile(url)` answers each tile request. */
function harness(tile = (url) => new Response(stationTile(url))) {
  const calls = [];
  const source = createChargingSource({
    tileFetchImpl: async (url) => {
      calls.push(url);
      if (url === 'https://tiles.openfreemap.org/planet')
        return Response.json({ tiles: [TEMPLATE] });
      return tile(url);
    },
  });
  const tiles = () => calls.filter((url) => url.endsWith('.pbf'));
  return { source, calls, tiles };
}

test('an invalid view is refused before any request', async () => {
  const { source, calls } = harness();
  for (const bad of [
    null,
    { ...OSLO, north: NaN },
    { ...OSLO, east: OSLO.west - 1 },
    { ...OSLO, north: 91 },
  ])
    await assert.rejects(
      source.getStations(bad),
      /EV charging requires a bounded viewport/,
    );
  assert.equal(calls.length, 0);
});

test('a view wider than the tile cap asks to zoom in without a request', async () => {
  const { source, calls } = harness();
  const wide = { south: 59.8, west: 10.5, north: 60.0, east: 11.0 };
  assert.equal(chargingViewFits(wide), false);
  assert.deepEqual(await source.getStations(wide), {
    records: [],
    zoomIn: true,
    partial: false,
    saturated: false,
    observedAt: null,
  });
  assert.equal(calls.length, 0);
});

test('a view at the tile cap reads every tile once and stations from each', async () => {
  const { source, tiles } = harness();
  // Sixteen z14 tiles, four by four, inside Oslo.
  const first = tileToBBox(14, 8681, 4763);
  const last = tileToBBox(14, 8684, 4766);
  const box = {
    south: last.south + 1e-6,
    west: first.west + 1e-6,
    north: first.north - 1e-6,
    east: last.east - 1e-6,
  };
  assert.equal(chargingViewFits(box), true);
  const snapshot = await source.getStations(box);
  assert.equal(tiles().length, CHARGING_MAX_TILES);
  assert.equal(snapshot.records.length, CHARGING_MAX_TILES);
  assert.equal(new Set(snapshot.records.map((r) => r.id)).size, 16);
  assert.equal(snapshot.zoomIn, false);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.saturated, false);
  // Freshness is the planet build the tiles came from.
  assert.equal(snapshot.observedAt, BUILD_TIME);
  for (const url of tiles())
    assert.match(url, /\/planet\/20261018_080001_pt\/14\//);
  // One more tile row is past the cap.
  assert.equal(
    chargingViewFits({
      ...box,
      south: tileToBBox(14, 8684, 4767).south + 1e-6,
    }),
    false,
  );
});

test('repeated reads of one view reuse the decoded tiles', async () => {
  const { source, tiles } = harness();
  await source.getStations(OSLO);
  const read = tiles().length;
  assert.ok(read > 0);
  await source.getStations(OSLO);
  assert.equal(tiles().length, read);
  source.destroy();
  await source.getStations(OSLO);
  assert.equal(tiles().length, read * 2, 'destroy drops the cache');
});

test('one failed tile makes the read partial, not empty', async () => {
  let failed = false;
  const { source } = harness((url) => {
    if (!failed) {
      failed = true;
      return new Response('', { status: 503 });
    }
    return new Response(stationTile(url));
  });
  const snapshot = await source.getStations(OSLO);
  assert.equal(snapshot.partial, true);
  assert.ok(snapshot.records.length > 0);
});

test('upstream failures arrive in the fixed English forms the row translates', async () => {
  const failing = async (tile) => {
    const { source } = harness(tile);
    return source.getStations(OSLO).then(
      () => null,
      (error) => error.message,
    );
  };
  assert.equal(
    await failing(() => new Response('', { status: 503 })),
    'OpenFreeMap HTTP 503',
  );
  assert.equal(
    await failing(() => new Response('', { status: 429 })),
    'OpenFreeMap rate limited',
  );
  assert.equal(
    await failing(() => {
      throw new TypeError('fetch failed');
    }),
    'OpenFreeMap network error',
  );
  assert.equal(
    await failing(() => new Response(new Uint8Array([0xff, 0xff, 0xff]))),
    'Malformed OpenFreeMap response',
  );
  // A TileJSON failure is named the same way.
  const metadataDown = createChargingSource({
    tileFetchImpl: async () => new Response('', { status: 500 }),
  });
  await assert.rejects(metadataDown.getStations(OSLO), {
    message: 'OpenFreeMap HTTP 500',
  });
});

test('cancellation stays an abort, never a feed error', async () => {
  const abort = new AbortController();
  const { source } = harness((url) => {
    abort.abort();
    return new Response(stationTile(url));
  });
  await assert.rejects(source.getStations(OSLO, { signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('past the station limit the stations nearest the view centre are kept', async () => {
  const count = CHARGING_STATION_LIMIT + 50;
  const { source } = harness((url) => {
    const [z, x, y] = url
      .match(/(\d+)\/(\d+)\/(\d+)\.pbf$/)
      .slice(1)
      .map(Number);
    const box = tileToBBox(z, x, y);
    return new Response(
      encodePoiTile(
        { z, x, y },
        Array.from({ length: count }, (_, i) => ({
          lon: box.west + ((box.east - box.west) * (i + 0.5)) / count,
          lat: (box.south + box.north) / 2,
          class: 'fuel',
          subclass: 'charging_station',
        })),
      ),
    );
  });
  // One tile, so the centre is known.
  const tile = tileToBBox(14, 8682, 4764);
  const box = {
    south: tile.south + 1e-4,
    west: tile.west + 1e-4,
    north: tile.north - 1e-4,
    east: tile.east - 1e-4,
  };
  const snapshot = await source.getStations(box);
  assert.equal(snapshot.saturated, true);
  assert.equal(snapshot.records.length, CHARGING_STATION_LIMIT);
  // The row runs edge to edge; the 25 at each end are the ones dropped.
  const centre = (box.west + box.east) / 2;
  const spread = Math.max(
    ...snapshot.records.map((r) => Math.abs(r.longitude - centre)),
  );
  const width = tile.east - tile.west;
  assert.ok(spread < width * 0.49, `kept spread ${spread / width}`);
});
