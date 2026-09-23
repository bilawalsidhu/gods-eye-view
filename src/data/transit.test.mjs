import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import transitLayer, {
  TRANSIT_MODE_COLORS,
  TRANSIT_POLL_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  interpolatedVehiclePosition,
  isStaleVehicleFix,
  transitVehicleKey,
} from './transit.js';
import { TRANSIT_MODES, getTransitFeed } from './transitFeeds.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { SPRITE_LAYER_ORDER } from './spriteOrder.js';

test('layer module declares the manager contract', () => {
  assert.equal(transitLayer.id, 'transit');
  assert.equal(typeof transitLayer.name, 'string');
  assert.equal(typeof transitLayer.icon, 'string');
  assert.equal(transitLayer.updateInterval, TRANSIT_POLL_MS);
  for (const method of [
    'init',
    'enable',
    'disable',
    'update',
    'getStats',
    'destroy',
  ]) {
    assert.equal(
      typeof transitLayer[method],
      'function',
      `${method} is implemented`,
    );
  }
});

test('the layer is registered for share links and sprite stacking', () => {
  const entry = LAYER_STATE_REGISTRY.find((row) => row.id === 'transit');
  assert.ok(entry, 'transit has a share-link token');
  assert.equal(entry.disposition, 'enabled-only');
  assert.equal(
    LAYER_STATE_REGISTRY.filter((row) => row.token === entry.token).length,
    1,
    'token is unique',
  );
  const index = SPRITE_LAYER_ORDER.indexOf('transit');
  assert.ok(
    index > SPRITE_LAYER_ORDER.indexOf('bikeshare'),
    'vehicles draw above bikeshare stations',
  );
  assert.ok(
    index < SPRITE_LAYER_ORDER.indexOf('flights'),
    'aircraft stay on top',
  );
});

test('every transit mode has a colour and the selected card uses it as accent', () => {
  for (const mode of TRANSIT_MODES) {
    assert.match(
      TRANSIT_MODE_COLORS[mode],
      /^#[0-9a-f]{6}$/i,
      `${mode} has a colour`,
    );
  }
  const position = Cesium.Cartesian3.fromDegrees(-71.06, 42.36, 3);
  const card = createTransitSelectedOverlayEntry(
    'mbta:1',
    position,
    { title: 'T', details: ['d'] },
    'subway',
  );
  assert.equal(card.accent, TRANSIT_MODE_COLORS.subway);
  assert.equal(card.selected, true);
  assert.equal(card.protected, true);
  assert.equal(card.position, position);
  assert.equal(
    createTransitSelectedOverlayEntry(
      '',
      position,
      { title: 'T', details: [] },
      'bus',
    ),
    null,
  );
  assert.equal(
    createTransitSelectedOverlayEntry(
      'k',
      null,
      { title: 'T', details: [] },
      'bus',
    ),
    null,
  );
  assert.equal(
    TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS.moving,
    true,
    'the card follows a moving vehicle',
  );
});

test('position queries read the published display sample', () => {
  const entry = { track: {}, sample: { lat: 1, lon: 2, phase: 'playing' } };
  assert.deepEqual(interpolatedVehiclePosition(entry), {
    lat: 1,
    lon: 2,
    settled: false,
  });
  entry.sample.phase = 'held';
  assert.equal(interpolatedVehiclePosition(entry).settled, true);
});
test('fixes older than ten minutes are stale; feeds without timestamps are trusted', () => {
  const now = 1_700_000_000_000;
  assert.equal(isStaleVehicleFix({ timestamp: now / 1000 - 30 }, now), false);
  assert.equal(isStaleVehicleFix({ timestamp: now / 1000 - 601 }, now), true);
  assert.equal(isStaleVehicleFix({ timestamp: null }, now), false);
  assert.equal(isStaleVehicleFix({}, now), false);
});

test('selection copy reads like a transit card and never leaks nulls', () => {
  const feed = getTransitFeed('metrotransit-msp');
  const now = 1_788_936_960_000;
  const full = buildTransitSelectionCopy(
    feed,
    {
      id: '1557',
      label: '1557',
      routeId: '17',
      lat: 44.9,
      lon: -93.4,
      bearing: 248,
      speedMps: 11.2,
      timestamp: 1_788_936_945,
      stopId: '57458',
      status: 'STOPPED_AT',
      occupancy: 'FEW_SEATS_AVAILABLE',
      timestampSource: 'vehicle',
    },
    'bus',
    now,
  );
  assert.equal(full.title, '🚌 Route 17');
  assert.deepEqual(full.details, [
    // The mode is said in words: a glyph and a route number do not tell a
    // reader whether the dot on the street is a bus or a subway train.
    'Bus · Metro Transit · Minneapolis–St Paul, MN',
    'Reported 15 s ago',
    // The operator's speed is labelled as a report: it describes the newest
    // fix, not the older segment the screen is drawing.
    'reported 40 km/h · reported hdg 248°',
    // The operator's claim is kept as a REPORT, not as the live state. It
    // describes the moment of the report, which the display may not have
    // reached yet — presenting it as "now" is what put STOPPED on a metro
    // gliding across the owner's screen.
    'Last report: stopped at stop 57458 · few seats available',
    'Vehicle 1557',
  ]);
  // A time the feed gave for the SNAPSHOT rather than for this vehicle is
  // labelled, so the card never presents a borrowed time as the bus's own.
  const borrowed = buildTransitSelectionCopy(
    feed,
    {
      id: '9',
      lat: 1,
      lon: 1,
      timestamp: 1_788_936_900,
      timestampSource: 'header',
    },
    'bus',
    now,
  );
  assert.equal(borrowed.details[1], 'Reported 60 s ago (feed time)');

  // A subway says where it is drawn, because a train on a road is otherwise
  // read as a bug rather than as a deliberate surface projection.
  const underground = buildTransitSelectionCopy(
    feed,
    {
      id: 'T1',
      routeId: 'Blue',
      lat: 44.9,
      lon: -93.4,
      timestamp: 1_788_936_945,
    },
    'subway',
    now,
  );
  assert.deepEqual(underground.details, [
    'Subway · Metro Transit · Minneapolis–St Paul, MN',
    'Reported 15 s ago',
    'Shown at street level · depth not in the feed',
    'Vehicle T1',
  ]);
  // No timestamp at all is aged from the fetch, never from "now".
  const sparse = buildTransitSelectionCopy(
    feed,
    { id: 'abc', lat: 1, lon: 1 },
    'rail',
    now,
    now - 120_000,
  );
  assert.equal(sparse.title, '🚆 Vehicle abc');
  assert.deepEqual(sparse.details, [
    'Train · Metro Transit · Minneapolis–St Paul, MN',
    'Reported 2 min ago (feed time)',
    'Vehicle abc',
  ]);
  for (const line of [...full.details, ...sparse.details])
    assert.doesNotMatch(line, /null|undefined|NaN/);
  assert.equal(transitVehicleKey('mbta', '17'), 'mbta:17');
});

test('the layer accepts a manager handle for out-of-tick panel repaints', () => {
  assert.equal(typeof transitLayer.attachDataManager, 'function');
  transitLayer.attachDataManager({ refreshLayerStats() {} });
  transitLayer.attachDataManager(null);
});

test('stats before enable are an honest zero, not a fake feed state', () => {
  const stats = transitLayer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.source, 'GTFS-RT');
  assert.equal(stats.error, null);
});
