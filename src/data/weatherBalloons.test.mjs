import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  createWeatherBalloonsLayer,
  BALLOON_SELECTED_OVERLAY_SOURCE_ID,
  createBalloonSelectedOverlayEntry,
} from './weatherBalloons.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

const AMBIENT_SOURCE_ID = 'weather-balloons';

/** A viewer stub exposing only what the layer touches: camera, data sources, and a stubbable scene.pick. */
function fakeViewer(latitudeDeg = 47.2, longitudeDeg = 13.1) {
  return {
    camera: {
      positionCartographic: {
        latitude: Cesium.Math.toRadians(latitudeDeg),
        longitude: Cesium.Math.toRadians(longitudeDeg),
      },
    },
    dataSources: { add() {}, remove() {} },
    scene: { pick: () => null, canvas: {} },
  };
}

/** One already-normalized proxy record (the shape sondehubFallback.js emits). */
function balloon(serial, overrides = {}) {
  return {
    serial,
    lat: 47.2,
    lon: 13.1,
    altitudeM: 18288, // 60,000 ft
    headingDeg: 90,
    speedMps: 12,
    verticalRateMps: 4.5,
    phase: 'ascending',
    manufacturer: 'Vaisala',
    type: 'RS41-SGP',
    frequencyMhz: 403.1,
    tempC: -55.2,
    uploaderCallsign: 'DL1ABC',
    timeMs: Date.now() - 3000,
    ...overrides,
  };
}

/**
 * Stand a layer up, wired to a stub click handler so tests can drive
 * LEFT_CLICK without a real Cesium canvas/scene — mirrors the
 * `screenSpaceEventHandlerFactory` injection gliders.test.mjs uses.
 * @param {Array<object>} balloons Records the stubbed proxy returns on `update()`.
 * @returns {Promise<object>} Test handle — layer, overlay spy, and a `click` driver.
 */
async function harness(balloons) {
  const overlay = { bySource: Object.create(null), clearedSources: [] };
  let clickCallback = null;
  const layer = createWeatherBalloonsLayer({
    overlayHost: {
      setEntries: (sourceId, entries) => { overlay.bySource[sourceId] = entries; },
      setVisible() {},
      clearSource: (sourceId) => { overlay.clearedSources.push(sourceId); },
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(callback) { clickCallback = callback; },
      destroy() { clickCallback = null; },
    }),
  });
  const viewer = fakeViewer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ balloons }) });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    const updated = await layer.update(viewer);
    assert.equal(updated, true, 'update should report success');
  } finally {
    globalThis.fetch = originalFetch;
  }
  return {
    layer,
    overlay,
    /** Simulate a LEFT_CLICK whose `scene.pick()` returns `picked`. */
    click(picked) {
      viewer.scene.pick = () => picked;
      clickCallback({ position: { x: 0, y: 0 } });
    },
  };
}

test('a normal poll ingests every usable balloon', async () => {
  const { layer } = await harness([balloon('S1'), balloon('S2')]);
  assert.equal(layer.getStats().count, 2);
});

test('a balloon missing a serial or position is dropped, not counted', async () => {
  const { layer } = await harness([
    balloon('S1'),
    { ...balloon('S2'), serial: '' },
    { ...balloon('S3'), lat: null },
  ]);
  assert.equal(layer.getStats().count, 1);
});

test('ambient labels are accented by ascent/descent phase', async () => {
  const { overlay } = await harness([balloon('S1', { phase: 'descending' })]);
  const entries = overlay.bySource[AMBIENT_SOURCE_ID];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].accent, Cesium.Color.fromCssColorString('#ff9f45').toCssColorString());
});

// --- Click-for-info (the same "no information when I click on them" fix as gliders.js) ---

test('clicking a balloon publishes a detail card carrying its real data', async () => {
  const { overlay, click } = await harness([
    balloon('S1', { altitudeM: 18288, speedMps: 12, verticalRateMps: 4.5, tempC: -55.2 }),
  ]);
  click({ id: 'balloon:S1' });

  const cards = overlay.bySource[BALLOON_SELECTED_OVERLAY_SOURCE_ID];
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.title, 'S1');
  assert.ok(card.details.some((line) => line.includes('ASCENDING')), `expected a phase line, got: ${card.details}`);
  assert.ok(card.details.some((line) => line.includes('ft')), `expected a feet line, got: ${card.details}`);
  assert.ok(card.details.some((line) => line.includes('-55.2°C')), `expected a temp line, got: ${card.details}`);
  assert.ok(card.details.some((line) => line.includes('+4.5 m/s')), `expected a vertical-rate line, got: ${card.details}`);
  assert.ok(card.details.some((line) => line.includes('kt')), `expected a knots line, got: ${card.details}`);
  assert.ok(card.details.some((line) => line.includes('Vaisala')), `expected a manufacturer line, got: ${card.details}`);
  assert.ok(card.details.some((line) => line.includes('DL1ABC')), `expected an uploader line, got: ${card.details}`);
});

test('clicking empty space clears any open detail card', async () => {
  const { overlay, click } = await harness([balloon('S1')]);
  click({ id: 'balloon:S1' });
  assert.ok(overlay.bySource[BALLOON_SELECTED_OVERLAY_SOURCE_ID].length > 0);

  click(null);
  assert.deepEqual(overlay.clearedSources.at(-1), BALLOON_SELECTED_OVERLAY_SOURCE_ID);
});

test('a pick owned by a sibling layer is left alone, not treated as empty space', async () => {
  const { overlay, click } = await harness([balloon('S1')]);
  click({ id: 'balloon:S1' });
  const clearedBefore = overlay.clearedSources.length;

  registerPickOwner('some-other-layer', (pickedId) => pickedId === 'other:thing');
  try {
    click({ id: 'other:thing' });
  } finally {
    unregisterPickOwner('some-other-layer');
  }
  assert.equal(overlay.clearedSources.length, clearedBefore, 'selection must survive a sibling-owned pick');
});

test('the detail card re-anchors to the balloon\'s fresh position on the next poll', async () => {
  const { overlay, click, layer } = await harness([balloon('S1', { lat: 47.2, lon: 13.1 })]);
  click({ id: 'balloon:S1' });
  const firstCard = overlay.bySource[BALLOON_SELECTED_OVERLAY_SOURCE_ID][0];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ balloons: [balloon('S1', { lat: 47.25, lon: 13.15 })] }),
  });
  try {
    await layer.update({ camera: { positionCartographic: { latitude: Cesium.Math.toRadians(47.2), longitude: Cesium.Math.toRadians(13.1) } } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const secondCard = overlay.bySource[BALLOON_SELECTED_OVERLAY_SOURCE_ID][0];
  assert.notDeepEqual(secondCard.position, firstCard.position, 'the card should track the balloon, not freeze at click time');
});

test('the detail card is dropped once the selected balloon ages out of the feed (e.g. it landed/burst out of range)', async () => {
  const { overlay, click, layer } = await harness([balloon('S1')]);
  click({ id: 'balloon:S1' });
  assert.ok(overlay.bySource[BALLOON_SELECTED_OVERLAY_SOURCE_ID].length > 0);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ balloons: [] }) });
  try {
    await layer.update({ camera: { positionCartographic: { latitude: Cesium.Math.toRadians(47.2), longitude: Cesium.Math.toRadians(13.1) } } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(overlay.clearedSources.at(-1), BALLOON_SELECTED_OVERLAY_SOURCE_ID);
});

test('createBalloonSelectedOverlayEntry is null-safe against a missing balloon or position', () => {
  const position = Cesium.Cartesian3.fromDegrees(13.1, 47.2, 1000);
  assert.equal(createBalloonSelectedOverlayEntry(null, position), null);
  assert.equal(createBalloonSelectedOverlayEntry(balloon('S1'), null), null);
});

test('an unknown-phase balloon (vel_v missing) reads as PHASE UNKNOWN, not a crash', () => {
  const position = Cesium.Cartesian3.fromDegrees(13.1, 47.2, 1000);
  const entry = createBalloonSelectedOverlayEntry(
    balloon('S1', { phase: 'unknown', verticalRateMps: null }),
    position,
  );
  assert.ok(entry.details.some((line) => line.includes('PHASE UNKNOWN')));
});
