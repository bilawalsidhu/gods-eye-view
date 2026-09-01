import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGlidersLayer, GLIDER_SELECTED_OVERLAY_SOURCE_ID, createGliderSelectedOverlayEntry } from './gliders.js';
import { GLIDER_CLASSES } from './gliderClass.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

const AMBIENT_SOURCE_ID = 'gliders';

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

/** One already-normalized proxy contact (the shape ognFallback.js emits). */
function contact(id, typeLabel, overrides = {}) {
  return {
    id,
    lat: 47.2,
    lon: 13.1,
    callsign: id,
    registration: id,
    altitudeM: 1200,
    ageSeconds: 3,
    headingDeg: 90,
    speedMps: 25,
    climbMps: 1.5,
    typeCode: 1,
    typeLabel,
    receiver: 'TESTRX',
    flarmId: id,
    ...overrides,
  };
}

/**
 * Stand a layer up, wired to a stub click handler so tests can drive
 * LEFT_CLICK without a real Cesium canvas/scene — mirrors the
 * `screenSpaceEventHandlerFactory` injection firmsInteraction.test.mjs uses.
 * @param {Array<object>} aircraft Contacts the stubbed proxy returns on `update()`.
 * @returns {Promise<object>} Test handle — layer, overlay spy, and a `click` driver.
 */
async function harness(aircraft) {
  const overlay = { bySource: Object.create(null), clearedSources: [] };
  let clickCallback = null;
  const layer = createGlidersLayer({
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
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ aircraft }) });
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

test('ADS-B relay traffic is neither counted nor drawn — the over-count regression', async () => {
  // OGN ground stations relay the Mode-S/ADS-B targets they also receive, filed
  // under the generic 'plane'/'jet' codes. Before the taxonomy was enforced as a
  // filter, a busy bounding box counted every one of them as an active glider.
  const { layer } = await harness([
    contact('G1', 'glider'),
    contact('G2', 'glider'),
    contact('AIRLINER1', 'jet'),
    contact('AIRLINER2', 'plane'),
    contact('AIRLINER3', 'plane'),
    contact('SKYDIVE', 'parachute'),
  ]);

  assert.equal(layer.getStats().count, 2, 'only the two gliders are active contacts');
  const legend = layer.getRowControls().legend;
  assert.deepEqual(legend.map((item) => item.label), ['GLIDER']);
  assert.equal(legend[0].count, 2);
});

test('the layer is scoped to just gliders and balloons — everything else is dropped', async () => {
  const { layer } = await harness([
    contact('G1', 'glider'),
    contact('B1', 'balloon'),
    contact('P1', 'paraglider'),
    contact('H1', 'hang-glider'),
    contact('T1', 'tow-plane'),
    contact('C1', 'helicopter'),
    contact('D1', 'drone'),
    contact('U1', 'unknown'),
  ]);

  assert.equal(layer.getStats().count, 2, 'only the glider and the balloon are active contacts');
  const legend = layer.getRowControls().legend;
  assert.deepEqual(
    legend.map((item) => [item.label, item.count]),
    [['GLIDER', 1], ['BALLOON', 1]],
  );
});

test("'unknown' contacts (OGN ftype 0/14/15 — includes static ground beacons) are excluded", async () => {
  const { layer } = await harness([contact('BEACON1', 'unknown'), contact('G1', 'glider')]);
  assert.equal(layer.getStats().count, 1);
  assert.deepEqual(layer.getRowControls().legend.map((item) => item.label), ['GLIDER']);
});

test('this layer offers no mode chips', async () => {
  const { layer } = await harness([contact('G1', 'glider')]);
  assert.deepEqual(layer.getRowControls().chips, []);
});

test('overlay labels are accented from the same palette as the legend', async () => {
  const { overlay } = await harness([contact('B1', 'balloon')]);
  const entries = overlay.bySource[AMBIENT_SOURCE_ID];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].accent, GLIDER_CLASSES.balloon.color);
});

test('disabling the layer drops the tally, so a re-enable cannot flash a stale legend', async () => {
  const { layer } = await harness([contact('G1', 'glider')]);
  assert.equal(layer.getRowControls().legend.length, 1);
  layer.disable();
  assert.deepEqual(layer.getRowControls().legend, []);
});

test('a feed of nothing but out-of-scope traffic leaves the layer empty, not populated', async () => {
  const { layer } = await harness([
    contact('A1', 'jet'),
    contact('A2', 'plane'),
    contact('A3', 'airship'),
    contact('A4', 'paraglider'),
  ]);
  assert.equal(layer.getStats().count, 0);
  assert.deepEqual(layer.getRowControls().legend, []);
});

// --- Click-for-info (the "no information when I click on them" fix) ---

test('clicking a contact publishes a detail card carrying its real data', async () => {
  const { overlay, click } = await harness([
    contact('G1', 'glider', { registration: 'D-1234', altitudeM: 1219, speedMps: 27.8, climbMps: 1.5 }),
  ]);
  click({ id: 'glider:G1' });

  const cards = overlay.bySource[GLIDER_SELECTED_OVERLAY_SOURCE_ID];
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.title, 'D-1234');
  assert.equal(card.accent, GLIDER_CLASSES.glider.color);
  assert.ok(card.details.some((line) => line.includes('3,999 ft')), `expected a feet line, got: ${card.details}`);
  assert.ok(card.details.some((line) => line.includes('kt')), `expected a knots line, got: ${card.details}`);
  assert.ok(card.details.some((line) => line.includes('+1.5 m/s')), `expected a vario line, got: ${card.details}`);
});

test('clicking empty space clears any open detail card', async () => {
  const { overlay, click } = await harness([contact('G1', 'glider')]);
  click({ id: 'glider:G1' });
  assert.ok(overlay.bySource[GLIDER_SELECTED_OVERLAY_SOURCE_ID].length > 0);

  click(null);
  assert.deepEqual(overlay.clearedSources.at(-1), GLIDER_SELECTED_OVERLAY_SOURCE_ID);
});

test('a pick owned by a sibling layer is left alone, not treated as empty space', async () => {
  const { overlay, click } = await harness([contact('G1', 'glider')]);
  click({ id: 'glider:G1' });
  const clearedBefore = overlay.clearedSources.length;

  registerPickOwner('some-other-layer', (pickedId) => pickedId === 'other:thing');
  try {
    click({ id: 'other:thing' });
  } finally {
    unregisterPickOwner('some-other-layer');
  }
  assert.equal(overlay.clearedSources.length, clearedBefore, 'selection must survive a sibling-owned pick');
});

test('the detail card re-anchors to the contact\'s fresh position on the next poll', async () => {
  const { overlay, click, layer } = await harness([contact('G1', 'glider', { lat: 47.2, lon: 13.1 })]);
  click({ id: 'glider:G1' });
  const firstCard = overlay.bySource[GLIDER_SELECTED_OVERLAY_SOURCE_ID][0];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ aircraft: [contact('G1', 'glider', { lat: 47.25, lon: 13.15 })] }),
  });
  try {
    await layer.update({ camera: { positionCartographic: { latitude: Cesium.Math.toRadians(47.2), longitude: Cesium.Math.toRadians(13.1) } } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const secondCard = overlay.bySource[GLIDER_SELECTED_OVERLAY_SOURCE_ID][0];
  assert.notDeepEqual(secondCard.position, firstCard.position, 'the card should track the contact, not freeze at click time');
});

test('the detail card is dropped once the selected contact ages out of the feed', async () => {
  const { overlay, click, layer } = await harness([contact('G1', 'glider')]);
  click({ id: 'glider:G1' });
  assert.ok(overlay.bySource[GLIDER_SELECTED_OVERLAY_SOURCE_ID].length > 0);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ aircraft: [] }) });
  try {
    await layer.update({ camera: { positionCartographic: { latitude: Cesium.Math.toRadians(47.2), longitude: Cesium.Math.toRadians(13.1) } } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(overlay.clearedSources.at(-1), GLIDER_SELECTED_OVERLAY_SOURCE_ID);
});

test('createGliderSelectedOverlayEntry falls back through registration, callsign, then class label', () => {
  const position = Cesium.Cartesian3.fromDegrees(13.1, 47.2, 1000);
  assert.equal(
    createGliderSelectedOverlayEntry(contact('G1', 'glider', { registration: 'D-1234', callsign: 'CS1' }), position).title,
    'D-1234',
  );
  assert.equal(
    createGliderSelectedOverlayEntry(contact('G1', 'glider', { registration: null, callsign: 'CS1' }), position).title,
    'CS1',
  );
  assert.equal(
    createGliderSelectedOverlayEntry(contact('G1', 'glider', { registration: null, callsign: null }), position).title,
    'GLIDER',
  );
});

test('createGliderSelectedOverlayEntry is null-safe against a missing contact or position', () => {
  const position = Cesium.Cartesian3.fromDegrees(13.1, 47.2, 1000);
  assert.equal(createGliderSelectedOverlayEntry(null, position), null);
  assert.equal(createGliderSelectedOverlayEntry(contact('G1', 'glider'), null), null);
});
