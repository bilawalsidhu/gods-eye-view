import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  EARTHQUAKE_CARD_SOURCE_ID,
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  createEarthquakesLayer,
  describeEarthquake,
  earthquakeEventLink,
  earthquakeRippleRings,
  earthquakeContourRings,
  earthquakeContourShape,
  earthquakeContourScale,
  EARTHQUAKE_CONTOUR_WOBBLE,
  EARTHQUAKE_RIPPLE_PERIOD_MS,
  earthquakeSeverityName,
  earthquakeSeverityMeter,
  earthquakeDepthBandName,
} from './index.js';

const quake = (id, extra = {}) => ({
  stableId: id,
  usgsId: id,
  lon: -153.3,
  lat: 60.0,
  depthKm: 112.4,
  mag: 2.5,
  place: '42 km W of Fixture, Alaska',
  time: Date.UTC(2026, 10, 13, 15, 37),
  ...extra,
});

/** A layer whose globe clicks, card hits and context store the test drives. */
function harness(rows, { context = null, ripples = null } = {}) {
  let snapshot = rows;
  const handlers = [];
  const opened = [];
  const cards = [];
  const visible = new Map();
  const labels = [];
  const focused = [];
  // What the overlay hit test finds under the click, per source.
  const overlayHits = new Map();
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const layer = createEarthquakesLayer({
    source: { getSnapshot: async () => snapshot },
    overlayHost: {
      setEntries(sourceId, entries) {
        if (sourceId === EARTHQUAKE_CARD_SOURCE_ID) cards.push(entries);
        if (sourceId === EARTHQUAKE_OVERLAY_SOURCE_ID) labels.push(entries);
      },
      setVisible: (sourceId, show) => visible.set(sourceId, show),
      clearSource() {},
      // As the real host does, only an interactive entry painted now is hit.
      hitTest(_x, _y, { sourceId }) {
        const hit = overlayHits.get(sourceId);
        const painted =
          sourceId === EARTHQUAKE_CARD_SOURCE_ID ? cards.at(-1) : labels.at(-1);
        const entry = painted?.find((e) => e.id === hit?.entryId);
        return hit && entry?.interactive === true ? hit : null;
      },
    },
    input: () => ({
      onClick(callback) {
        const handler = { callback, destroyed: false };
        handlers.push(handler);
        return () => {
          handler.destroyed = true;
        };
      },
    }),
    picking,
    context,
    ripples,
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
    focus: {
      requestWorldFocus: (detail) => {
        focused.push(detail);
        return true;
      },
    },
  });
  layer.init(viewer);
  const discs = () => draw.find('earthquakes:');
  const live = () => handlers.filter((h) => !h.destroyed);
  return {
    layer,
    viewer,
    opened,
    cards,
    visible,
    focused,
    handlers,
    discs,
    setRows(next) {
      snapshot = next;
    },
    /** Click a quake's disc (by stable id), something else, or the map. */
    click(hit) {
      for (const { callback } of live())
        callback({
          screenPosition: { x: 10, y: 10 },
          topHit: hit,
          drawHit: hit && !hit.surface ? hit : null,
        });
    },
    clickDisc(id) {
      this.click({ set: discs().spec.id, id: `earthquake:${id}` });
    },
    clickCard(entryId) {
      this.clickOverlay(EARTHQUAKE_CARD_SOURCE_ID, entryId);
    },
    /** Click a magnitude label, as the overlay host paints it. */
    clickLabel(id) {
      this.clickOverlay(EARTHQUAKE_OVERLAY_SOURCE_ID, id);
    },
    clickOverlay(sourceId, entryId) {
      this.clickOverlayWith(sourceId, entryId, null);
    },
    /** Click an overlay entry with `hit` drawn under the same pixel. */
    clickOverlayWith(sourceId, entryId, hit) {
      overlayHits.set(sourceId, { sourceId, entryId });
      this.click(hit);
      overlayHits.delete(sourceId);
    },
    lastCard: () => cards.at(-1),
    lastLabels: () => labels.at(-1),
  };
}

test('clicking a quake disc shows its detail card; empty map clears it', async () => {
  const h = harness([quake('ak1'), quake('ak2', { mag: 4.1 })]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  assert.equal(h.cards.length, 0, 'no card before a click');

  h.clickDisc('ak2');
  const [card] = h.lastCard();
  assert.equal(card.id, 'earthquake-card:ak2');
  assert.equal(card.title, 'M4.1 · Light');
  assert.deepEqual(card.details, [
    '■■□□□□  Intermediate · 112.4 km deep',
    '42 km W of Fixture, Alaska',
    '2026-11-13 15:37 UTC',
    'Source: USGS',
    'Click the card to open the source ↗',
  ]);
  assert.equal(card.interactive, true);
  assert.equal(card.accessibilityLabel, 'Open the source for M4.1 · Light');
  assert.equal(h.visible.get(EARTHQUAKE_CARD_SOURCE_ID), true);

  h.click(null);
  assert.deepEqual(h.lastCard(), [], 'a click on the map clears the card');
  h.layer.destroy();
});

test('the card opens the USGS event page, from a click or the keyboard', async () => {
  const h = harness([quake('ak1')]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('ak1');
  h.clickCard('earthquake-card:ak1');
  assert.deepEqual(h.opened, [
    'https://earthquake.usgs.gov/earthquakes/eventpage/ak1',
  ]);
  assert.equal(h.lastCard()[0].activate(), true);
  assert.equal(h.opened.length, 2);
  assert.equal(h.lastCard().length, 1, 'opening the source keeps the card');
  h.layer.destroy();
});

test('a quake with no USGS id gets a card with no link', async () => {
  const h = harness([quake('event-1', { usgsId: null })]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('event-1');
  const [card] = h.lastCard();
  assert.equal(card.interactive, true, 'hit-testable, so a click keeps it');
  assert.equal(card.activate, undefined);
  assert.equal(card.accessibilityLabel, undefined, 'no action to offer');
  assert.ok(!card.details.some((line) => line.includes('Click the card')));
  h.clickCard(card.id);
  assert.deepEqual(h.opened, []);
  assert.equal(h.lastCard()[0].id, card.id, 'the card stays');
  h.layer.destroy();
});

test("another layer's pick leaves the card; its own pick ids are claimed", async () => {
  const h = harness([quake('ak1')]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  assert.equal(picking.findPickOwner('earthquake:ak1'), 'earthquakes');
  assert.equal(picking.findPickOwner('earthquake:gone'), null);
  picking.registerPickOwner('test-other', (id) => id === 'plane-1');
  try {
    h.clickDisc('ak1');
    const before = h.cards.length;
    h.click({ set: 'flights:1', id: 'plane-1' });
    assert.equal(h.cards.length, before, 'the card stays');
    // A pick of the same id from another set is not a quake.
    h.click({ set: 'other:1', id: 'earthquake:ak1' });
    assert.deepEqual(h.lastCard(), []);
  } finally {
    picking.unregisterPickOwner('test-other');
    h.layer.destroy();
  }
  assert.equal(picking.findPickOwner('earthquake:ak1'), null);
});

test('a refresh keeps the selected quake while it is in the feed', async () => {
  const h = harness([quake('ak1'), quake('ak2')]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('ak1');
  h.setRows([quake('ak1', { mag: 2.7 }), quake('ak2')]);
  await h.layer.update(h.viewer);
  assert.equal(
    h.lastCard()[0].title,
    'M2.7 · Minor',
    'the card follows the feed',
  );
  h.setRows([quake('ak2')]);
  await h.layer.update(h.viewer);
  assert.deepEqual(h.lastCard(), [], 'a quake that left the feed loses it');
  h.layer.destroy();
});

test('disable removes the click handler and the card', async () => {
  const h = harness([quake('ak1')]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('ak1');
  h.layer.disable(h.viewer);
  assert.deepEqual(h.lastCard(), []);
  assert.equal(
    h.handlers.every((handler) => handler.destroyed),
    true,
  );
  assert.equal(picking.findPickOwner('earthquake:ak1'), null);
  h.layer.enable(h.viewer);
  assert.equal(
    h.handlers.filter((handler) => !handler.destroyed).length,
    1,
    'one handler again, not two',
  );
  h.layer.destroy();
});

test('a small quake inside a big one is drawn on top of it', async () => {
  const h = harness([quake('small', { mag: 2.6 }), quake('big', { mag: 6 })]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  assert.deepEqual(
    [...h.discs().items.keys()],
    ['earthquake:big', 'earthquake:small'],
  );
  h.layer.destroy();
});

test('the clicked quake is the selected context, cleared with the card', async () => {
  const entities = new Map();
  const calls = [];
  const context = {
    getContextStore: () => ({ entities }),
    registerEntityContext(carrier, metadata) {
      entities.set(metadata.id, { ...metadata, entity: carrier });
    },
    selectEntityContext: (carrier) => calls.push(['select', carrier]),
    clearSelectedEntityContextForLayer: (layerId) =>
      calls.push(['clear', layerId]),
  };
  const h = harness([quake('ak1'), quake('ak2')], { context });
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('ak1');
  const record = entities.get('earthquake:ak1');
  assert.equal(record.layerId, 'earthquakes');
  assert.equal(record.label, 'Earthquake · M2.5 · 42 km W of Fixture, Alaska');
  assert.equal(record.properties.usgsId, 'ak1');
  assert.equal(record.dataSource.show, true, 'hidden with the discs');
  assert.equal(calls.at(-1)[0], 'select');
  h.clickDisc('ak2');
  assert.deepEqual([...entities.keys()], ['earthquake:ak2'], 'one record');
  h.click(null);
  assert.equal(entities.size, 0);
  assert.deepEqual(calls.at(-1), ['clear', 'earthquakes']);
  h.layer.destroy();
});

test('without click services the layer draws and takes no clicks', async () => {
  const viewer = {};
  bindFakeDraw(viewer);
  const layer = createEarthquakesLayer({
    source: { getSnapshot: async () => [quake('ak1')] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(picking.findPickOwner('earthquake:ak1'), null);
  layer.destroy();
});

test('describeEarthquake translates through the given formatters', () => {
  const card = describeEarthquake(quake('ak1', { place: '  far   away ' }), {
    t: (text, values) => `<${text}>${JSON.stringify(values ?? {})}`,
    formatTime: () => 'TIME',
    formatDepth: (km) => `~${km}`,
  });
  assert.equal(card.title, 'M2.5 · <Minor>{"context":"earthquake"}');
  assert.deepEqual(card.details, [
    '■□□□□□  <Intermediate>{"context":"earthquake"} · <{km} km deep>{"km":"~112.4"}',
    'far away',
    'TIME',
    '<Source: {value}>{"value":"USGS"}',
    '<Click the card to open the source ↗>{}',
  ]);
  const bare = describeEarthquake({ mag: 3, place: null, time: null });
  assert.equal(bare.title, 'M3.0 · Minor');
  assert.deepEqual(bare.details, ['■□□□□□', 'Source: USGS']);
  assert.equal(bare.link, null);
});

test('severity follows the USGS magnitude classes; depth bands the disc colours', () => {
  const cases = [
    [2.5, 'Minor', '■□□□□□'],
    [3.99, 'Minor', '■□□□□□'],
    [4, 'Light', '■■□□□□'],
    [5.4, 'Moderate', '■■■□□□'],
    [6.1, 'Strong', '■■■■□□'],
    [7.8, 'Major', '■■■■■□'],
    [8.2, 'Great', '■■■■■■'],
    [9.5, 'Great', '■■■■■■'],
    [Number.NaN, 'Minor', '■□□□□□'],
  ];
  for (const [mag, name, meter] of cases) {
    assert.equal(earthquakeSeverityName(mag), name, String(mag));
    assert.equal(earthquakeSeverityMeter(mag), meter, String(mag));
  }
  assert.equal(earthquakeDepthBandName(10), 'Shallow');
  assert.equal(earthquakeDepthBandName(69.9), 'Shallow');
  assert.equal(earthquakeDepthBandName(70), 'Intermediate');
  assert.equal(earthquakeDepthBandName(299), 'Intermediate');
  assert.equal(earthquakeDepthBandName(300), 'Deep');
});

test('earthquakeEventLink accepts only plain USGS ids', () => {
  assert.equal(
    earthquakeEventLink('us7000abcd'),
    'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd',
  );
  for (const bad of [null, '', '  ', '../x', 'a/b', 'a?b=1', 'x'.repeat(65)])
    assert.equal(earthquakeEventLink(bad), null, String(bad));
});

test('clicking a magnitude label selects the quake and flies to it', async () => {
  const h = harness([
    quake('ak1'),
    quake('jp1', { mag: 5, lon: 142, lat: 38 }),
  ]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  const label = h.lastLabels().find((entry) => entry.id === 'jp1');
  assert.equal(label.interactive, true, 'labels take clicks');
  assert.equal(
    label.accessibilityLabel,
    'Zoom to M5.0 · 42 km W of Fixture, Alaska',
  );

  h.clickLabel('jp1');
  assert.equal(h.lastCard()[0].id, 'earthquake-card:jp1');
  assert.equal(h.focused.length, 1);
  const [detail] = h.focused;
  assert.equal(detail.kind, 'earthquake');
  assert.equal(detail.id, 'earthquake:jp1');
  assert.equal(detail.label, 'M5.0');
  assert.ok(
    Math.hypot(detail.position.x, detail.position.y, detail.position.z) > 6e6,
  );

  // The keyboard path does the same.
  assert.equal(
    h
      .lastLabels()
      .find((e) => e.id === 'ak1')
      .activate(),
    true,
  );
  assert.equal(h.lastCard()[0].id, 'earthquake-card:ak1');
  assert.equal(h.focused.at(-1).id, 'earthquake:ak1');

  // A disc click only selects: the camera stays where it is.
  h.clickDisc('jp1');
  assert.equal(h.focused.length, 2);
  assert.equal(h.lastCard()[0].id, 'earthquake-card:jp1');

  // A label id the layer no longer draws is not a quake.
  h.clickLabel('gone');
  assert.deepEqual(h.lastCard(), []);
  assert.equal(h.focused.length, 2);
  h.layer.destroy();
});

test('without click services the labels stay non-interactive', async () => {
  const viewer = {};
  bindFakeDraw(viewer);
  const published = [];
  const layer = createEarthquakesLayer({
    source: { getSnapshot: async () => [quake('ak1')] },
    overlayHost: {
      setEntries: (_source, entries) => published.push(entries),
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update(viewer);
  const [label] = published.at(-1);
  assert.equal(label.interactive, false);
  assert.equal(label.activate, undefined);
  layer.destroy();
});

test('the selected quake runs contour rings to its disc edge; clearing stops them', async () => {
  const calls = [];
  const ripples = {
    show: (target) => calls.push(['show', target]),
    hide: () => calls.push(['hide']),
    dispose: () => calls.push(['dispose']),
  };
  const h = harness(
    [quake('ak1', { mag: 5, depthKm: 10 }), quake('ak2', { mag: 3 })],
    { ripples },
  );
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('ak1');
  const shown = calls.findLast(([kind]) => kind === 'show')[1];
  assert.deepEqual(shown, {
    id: 'ak1',
    lon: -153.3,
    lat: 60,
    radiusM: 32000,
    color: 'rgb(255,0,0)',
  });
  assert.equal(
    h.discs().items.get('earthquake:ak1').geometry.semiMajor,
    shown.radiusM,
    'the rings end at the disc edge',
  );
  h.clickDisc('ak2');
  assert.equal(calls.findLast(([kind]) => kind === 'show')[1].radiusM, 8000);
  h.click(null);
  assert.deepEqual(calls.at(-1), ['hide']);
  h.clickDisc('ak1');
  h.layer.disable(h.viewer);
  assert.deepEqual(calls.at(-1), ['hide']);
  h.layer.destroy();
  assert.deepEqual(calls.at(-1), ['dispose']);
});

test('ripple rings run from the marker to the edge, staggered, fading at both ends', () => {
  const rings = earthquakeRippleRings(0, { count: 3, periodMs: 3000 });
  assert.deepEqual(
    rings.map(({ fraction }) => Number(fraction.toFixed(4))),
    [0, 0.3333, 0.6667],
  );
  assert.equal(rings[0].alpha, 0, 'a ring at the marker is not yet seen');
  // Each ring moves outward with time and wraps back to the marker.
  const later = earthquakeRippleRings(1000, { count: 3, periodMs: 3000 });
  assert.ok(later[1].fraction > rings[1].fraction);
  assert.ok(later[2].fraction < rings[2].fraction, 'the outer ring wrapped');
  for (let t = 0; t < 6000; t += 37)
    for (const { fraction, alpha } of earthquakeRippleRings(t)) {
      assert.ok(fraction >= 0 && fraction < 1);
      assert.ok(alpha >= 0 && alpha <= 1);
    }
  const near = (f) =>
    earthquakeRippleRings(f * EARTHQUAKE_RIPPLE_PERIOD_MS, { count: 1 })[0]
      .alpha;
  assert.ok(near(0.99) < 0.02, 'fades out at the edge');
  assert.ok(near(0.12) > 0.999, 'fully in just after the start');
  assert.deepEqual(
    earthquakeContourRings(3).map(({ fraction }) => fraction),
    [1 / 3, 2 / 3, 1],
  );
});

test('a quake keeps its own contour shape; nested lines never cross', () => {
  const a = earthquakeContourShape('us7000abcd');
  assert.deepEqual(
    earthquakeContourShape('us7000abcd'),
    a,
    'same id, same shape',
  );
  assert.notDeepEqual(earthquakeContourShape('ak2026xyz'), a);
  for (const id of ['us7000abcd', 'ak2026xyz', 'event-1', '']) {
    const shape = earthquakeContourShape(id);
    for (let i = 0; i < 180; i++) {
      const angle = (2 * Math.PI * i) / 180;
      let previous = 0;
      for (let step = 1; step <= 200; step++) {
        const fraction = step / 200;
        const scale = earthquakeContourScale(shape, angle, fraction);
        assert.ok(scale <= 1 + 1e-12, 'never past the disc edge');
        assert.ok(scale >= 1 - EARTHQUAKE_CONTOUR_WOBBLE - 1e-12);
        const reach = fraction * scale;
        assert.ok(reach > previous, `${id}: lines cross at ${angle}`);
        previous = reach;
      }
    }
  }
});

test("the selected quake's flat disc fades under its gradient and comes back", async () => {
  const ripples = { show() {}, hide() {}, dispose() {} };
  const h = harness([quake('ak1', { mag: 5 }), quake('ak2')], { ripples });
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  const alpha = (id) => h.discs().items.get(`earthquake:${id}`).fill[3];
  assert.equal(alpha('ak1'), 0.4);
  h.clickDisc('ak1');
  assert.equal(alpha('ak1'), 0.04, 'faint, still pickable');
  h.clickDisc('ak2');
  assert.equal(alpha('ak1'), 0.4, 'restored');
  assert.equal(alpha('ak2'), 0.04);
  // A refresh keeps the selected disc faded.
  await h.layer.update(h.viewer);
  assert.equal(alpha('ak2'), 0.04);
  assert.equal(alpha('ak1'), 0.4);
  h.click(null);
  assert.equal(alpha('ak2'), 0.3);
  h.layer.destroy();
});

test('without the ripples painter the selected disc keeps its fill', async () => {
  const h = harness([quake('ak1')]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('ak1');
  assert.equal(h.discs().items.get('earthquake:ak1').fill[3], 0.3);
  h.layer.destroy();
});

test('a feed refresh neither retakes the selection nor restarts the contours', async () => {
  const calls = [];
  const shows = [];
  const entities = new Map();
  const context = {
    getContextStore: () => ({ entities }),
    registerEntityContext(carrier, metadata) {
      entities.set(metadata.id, { ...metadata, entity: carrier });
    },
    selectEntityContext: () => calls.push('select'),
    clearSelectedEntityContextForLayer: () => calls.push('clear'),
  };
  const ripples = {
    show: (target, options) => shows.push(options),
    hide() {},
    dispose() {},
  };
  const h = harness([quake('ak1', { mag: 4 })], { context, ripples });
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('ak1');
  assert.deepEqual(calls, ['select']);
  assert.deepEqual(shows, [{ restart: true }]);
  // Another layer's selection happens here; then the feed refreshes.
  h.setRows([quake('ak1', { mag: 4.3 })]);
  await h.layer.update(h.viewer);
  assert.deepEqual(calls, ['select'], 'not selected again by a refresh');
  assert.deepEqual(shows.at(-1), { restart: false });
  assert.equal(
    entities.get('earthquake:ak1').label,
    'Earthquake · M4.3 · 42 km W of Fixture, Alaska',
    'the record is kept up to date',
  );
  // Clicking it again is the user's: it selects and runs again.
  h.clickDisc('ak1');
  assert.deepEqual(calls, ['select', 'select']);
  assert.deepEqual(shows.at(-1), { restart: true });
  h.layer.destroy();
});

test("another layer's object over a magnitude label takes the click", async () => {
  const h = harness([quake('ak1')]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  picking.registerPickOwner('test-plane', (id) => id === 'plane-9');
  try {
    // The click lands on the label and on a plane drawn there.
    h.clickOverlayWith(EARTHQUAKE_OVERLAY_SOURCE_ID, 'ak1', {
      set: 'flights:1',
      id: 'plane-9',
    });
    assert.equal(h.cards.length, 0, 'the quake is not selected');
    assert.equal(h.focused.length, 0, 'and the camera stays');
    // The label alone still selects and flies.
    h.clickLabel('ak1');
    assert.equal(h.lastCard()[0].id, 'earthquake-card:ak1');
    assert.equal(h.focused.length, 1);
  } finally {
    picking.unregisterPickOwner('test-plane');
    h.layer.destroy();
  }
});
