import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
// Registers the shared `gev-trail:` owner as passive, as the app does.
import '../../data/trailRenderer.js';
import { createSelection as createFireSelection } from '../firms/selection.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { createDroneAirspaceLayer } from '../droneAirspace/index.js';
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
function harness(
  rows,
  {
    context = null,
    ripples = null,
    groundHeight = null,
    input: inputFactory = null,
  } = {},
) {
  let snapshot = rows;
  const handlers = [];
  const opened = [];
  const cards = [];
  const visible = new Map();
  const labels = [];
  const focused = [];
  // What the overlay hit test finds under the click, per source.
  const overlayHits = new Map();
  // Another layer's interactive entry painted on top, if any.
  let foreignTop = null;
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const overlayHost = {
    setEntries(sourceId, entries) {
      if (sourceId === EARTHQUAKE_CARD_SOURCE_ID) cards.push(entries);
      if (sourceId === EARTHQUAKE_OVERLAY_SOURCE_ID) labels.push(entries);
    },
    setVisible: (sourceId, show) => visible.set(sourceId, show),
    clearSource() {},
    // As the real host does, only an interactive entry painted now is hit.
    hitTest(_x, _y, { sourceId } = {}) {
      // Unfiltered, as the host answers: another layer's entry on top
      // first, else this layer's own.
      if (!sourceId)
        return (
          foreignTop ??
          this.hitTest(_x, _y, { sourceId: EARTHQUAKE_CARD_SOURCE_ID }) ??
          this.hitTest(_x, _y, { sourceId: EARTHQUAKE_OVERLAY_SOURCE_ID })
        );
      const hit = overlayHits.get(sourceId);
      const painted =
        sourceId === EARTHQUAKE_CARD_SOURCE_ID ? cards.at(-1) : labels.at(-1);
      const entry = painted?.find((e) => e.id === hit?.entryId);
      return hit && entry?.interactive === true ? hit : null;
    },
  };
  // The card on top at a click, as the host answers the pick registry.
  picking.setClickCardHitTest((x, y) => overlayHost.hitTest(x, y));
  const layer = createEarthquakesLayer({
    source: { getSnapshot: async () => snapshot },
    overlayHost,
    input:
      inputFactory ??
      (() => ({
        onClick(callback) {
          const handler = { callback, destroyed: false };
          handlers.push(handler);
          return () => {
            handler.destroyed = true;
          };
        },
      })),
    picking,
    context,
    ripples,
    groundHeight,
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
    overlayHost,
    overlayHits,
    discs,
    setRows(next) {
      snapshot = next;
    },
    /** Click a quake's disc (by stable id), something else, or the map. */
    click(hit, resolvedHit = hit, gesture = { travelPx: 0, durationMs: 0 }) {
      for (const { callback } of live())
        callback({
          screenPosition: { x: 10, y: 10 },
          topHit: hit,
          hit: resolvedHit,
          drawHit: hit && !hit.surface ? hit : null,
          gesture,
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
    /** Click another layer's card painted on top, with `hit` under it. */
    clickForeignCard(sourceId, entryId, hit) {
      foreignTop = { sourceId, entryId };
      this.click(hit);
      foreignTop = null;
    },
    /** Click an overlay entry with `hit` drawn under the same pixel. */
    clickOverlayWith(sourceId, entryId, hit, resolvedHit = hit) {
      overlayHits.set(sourceId, { sourceId, entryId });
      this.click(hit, resolvedHit);
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
  assert.equal(
    card.accessibilityLabel,
    'Open the source for M4.1 · Light, Intermediate · 112.4 km deep, 42 km W of Fixture, Alaska, 2026-11-13 15:37 UTC, Source: USGS',
  );
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
  assert.ok(!card.details.some((line) => line.includes('Click the card')));
  // No source to open: a click on the card flies to the quake instead.
  h.clickCard(card.id);
  assert.deepEqual(h.opened, []);
  assert.equal(h.focused.length, 1);
  // Its keyboard action does the same, so it still has a place in the
  // action list.
  assert.match(card.accessibilityLabel, /^Focus earthquake M2\.5 · Minor, /);
  assert.equal(card.activate(), true);
  assert.equal(h.focused.length, 2);
  assert.deepEqual(h.opened, []);
  assert.equal(h.lastCard()[0].id, card.id, 'the card stays');
  h.layer.destroy();
});

test("another layer's pick leaves the card; discs stay unowned, as area layers do", async () => {
  const h = harness([quake('ak1')]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  // Like drone airspace and fire perimeters, the discs are not registered:
  // siblings read a disc as empty space, so their cards and deselection
  // work over a quake (a fire card, a radio near-miss, a followed plane).
  assert.equal(picking.findPickOwner('earthquake:ak1'), null);
  assert.equal(picking.isOwnedByOtherLayer('firms', 'earthquake:ak1'), false);
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
  assert.equal(
    bare.accessibilityLabel,
    'Focus earthquake M3.0 · Minor, Source: USGS',
  );
  // A place cut short never splits a character made of a surrogate pair.
  const emoji = describeEarthquake(quake('ak9', { place: '🌋'.repeat(60) }));
  assert.equal(Array.from(emoji.details[1]).length, 48);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(emoji.details[1]));
  // A long place is cut short on the card; the accessible name keeps it all.
  const long = 'A very long place name '.repeat(4).trim();
  const wide = describeEarthquake(quake('ak9', { place: long }));
  assert.equal(Array.from(wide.details[1]).length, 48);
  assert.ok(wide.details[1].endsWith('…'));
  assert.ok(wide.accessibilityLabel.includes(long));
  // With no opener to follow a link, the card does not offer one.
  const closed = describeEarthquake(quake('ak9'), { canOpen: false });
  assert.ok(!closed.details.some((line) => line.includes('Click the card')));
  assert.match(closed.accessibilityLabel, /^Focus earthquake /);
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
  // The whole disc in view: the radius scales with the magnitude; up to M6
  // the framing's own range fits the disc.
  assert.equal(detail.radiusM, 32000);
  assert.equal(detail.rangeM, undefined);

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
  // The ground the disc is draped on: the rings are drawn at its height.
  const heights = [];
  const h = harness(
    [quake('ak1', { mag: 5, depthKm: 10 }), quake('ak2', { mag: 3 })],
    {
      ripples,
      groundHeight: (viewer, lon, lat) => {
        heights.push([lon, lat]);
        return lon === -153.3 ? 1840 : null;
      },
    },
  );
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('ak1');
  const shown = calls.findLast(([kind]) => kind === 'show')[1];
  const { heightAt, ...rest } = shown;
  assert.deepEqual(rest, {
    id: 'ak1',
    lon: -153.3,
    lat: 60,
    heightM: 1840,
    radiusM: 32000,
    color: 'rgb(255,0,0)',
  });
  assert.deepEqual(heights.at(-1), [-153.3, 60]);
  // The painter can read the ground again as it loads (a label's fly-to).
  assert.equal(heightAt(), 1840);
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

// The label painted on top takes the click: the object drawn under it does not.
test("a magnitude label takes the click over another layer's object", async () => {
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
    assert.equal(h.lastCard()[0].id, 'earthquake-card:ak1', 'selected');
    assert.equal(h.focused.length, 1, 'and the camera flies');
    // The plane alone, with no label over it, is not empty space.
    h.click({ set: 'flights:1', id: 'plane-9' });
    assert.equal(h.lastCard()[0].id, 'earthquake-card:ak1', 'kept');
  } finally {
    picking.unregisterPickOwner('test-plane');
    h.layer.destroy();
  }
});

test('a touch-expanded quake hit selects its disc without flying', async () => {
  const h = harness([quake('ak1')]);
  try {
    h.layer.enable(h.viewer);
    await h.layer.update(h.viewer);
    h.click(null, { set: h.discs().spec.id, id: 'earthquake:ak1' });
    assert.equal(h.lastCard()?.[0]?.id, 'earthquake-card:ak1');
    assert.equal(h.focused.length, 0);
  } finally {
    h.layer.destroy();
  }
});

test('a quake label takes the click over a touch-expanded sibling hit', async () => {
  const h = harness([quake('ak1'), quake('ak2')]);
  try {
    h.layer.enable(h.viewer);
    await h.layer.update(h.viewer);
    h.clickDisc('ak1');
    picking.registerPickOwner('test-plane', (id) => id === 'plane-9');
    h.clickOverlayWith(EARTHQUAKE_OVERLAY_SOURCE_ID, 'ak2', null, {
      set: 'flights:1',
      id: 'plane-9',
    });
    assert.equal(h.lastCard()[0].id, 'earthquake-card:ak2');
    assert.equal(h.focused.length, 1);
  } finally {
    picking.unregisterPickOwner('test-plane');
    h.layer.destroy();
  }
});

test("another layer's card over a quake disc takes the click, and the disc yields", async () => {
  const h = harness([quake('ak1', { mag: 6 })]);
  try {
    h.layer.enable(h.viewer);
    await h.layer.update(h.viewer);
    // A fire's card painted over the disc: the disc is what the scene picks.
    h.clickForeignCard('firms', 'fire:x', {
      set: h.discs().spec.id,
      id: 'earthquake:ak1',
    });
    assert.equal(h.cards.length, 0, 'the quake is not selected');
    assert.equal(h.focused.length, 0);
    // The same disc with nothing painted over it selects the quake.
    h.clickDisc('ak1');
    assert.equal(h.lastCard()[0].id, 'earthquake-card:ak1');
  } finally {
    h.layer.destroy();
  }
});

for (const coarse of [false, true]) {
  test(`a quake card takes the click over an aircraft, which does not track (${coarse ? 'coarse' : 'exact'} hit)`, async (t) => {
    const previous = globalThis.matchMedia;
    globalThis.matchMedia = () => ({ matches: coarse });
    t.after(() => {
      if (previous) globalThis.matchMedia = previous;
      else delete globalThis.matchMedia;
    });
    const plane = { set: 'flights:1', id: 'plane-9' };
    let sceneHit = null;
    let nearby = null;
    let tracked = null;
    let tracks = 0;
    let input;
    const h = harness([quake('ak1')], {
      input(viewer) {
        viewer.scene = {
          pick: () => (sceneHit ? { id: sceneHit } : null),
          drillPick: () => (nearby ? [{ id: nearby }] : []),
        };
        input = fakeInput(viewer);
        // The aircraft layer runs first; like every layer, it leaves a
        // click under another layer's card to that card.
        input.input.onClick((event) => {
          if (picking.isUnderOtherCard(event)) return;
          const id = event.hit?.id;
          if (id !== plane.id || tracked === id) return;
          tracked = id;
          tracks++;
        });
        return input.input;
      },
    });
    picking.registerPickOwner('test-plane', (id) => id === plane.id);
    t.after(() => {
      picking.unregisterPickOwner('test-plane');
      h.layer.destroy();
      input?.destroy();
    });
    h.layer.enable(h.viewer);
    await h.layer.update(h.viewer);
    sceneHit = { set: h.discs().spec.id, id: 'earthquake:ak1' };
    input.click();
    const card = h.lastCard()[0];
    h.overlayHits.set(EARTHQUAKE_CARD_SOURCE_ID, {
      sourceId: EARTHQUAKE_CARD_SOURCE_ID,
      entryId: card.id,
    });
    sceneHit = coarse ? null : plane;
    nearby = coarse ? plane : null;

    input.click();
    assert.equal(tracks, 0, 'the aircraft under the card does not track');
    assert.deepEqual(h.opened, [
      'https://earthquake.usgs.gov/earthquakes/eventpage/ak1',
    ]);
    assert.equal(h.lastCard()[0].id, card.id, 'the card stays');

    // Without the card the aircraft takes it, and the quake stays selected.
    h.overlayHits.clear();
    input.click();
    assert.equal(tracks, 1, 'the bare aircraft tracks');
    assert.equal(h.opened.length, 1);
    assert.equal(h.lastCard()[0].id, card.id);
  });
}

for (const kind of ['card', 'label']) {
  for (const areaFirst of [false, true]) {
    test(`quake ${kind} over an unowned area takes the click once (${areaFirst ? 'area' : 'quake'} handler first)`, async () => {
      let sceneHit = null;
      let painted = null;
      const viewer = {
        scene: { pick: () => (sceneHit ? { id: sceneHit } : null) },
      };
      const { draw, unbind } = bindFakeDraw(viewer);
      const input = fakeInput(viewer);
      const entries = new Map();
      const opened = [];
      const focused = [];
      // As the real host does, hits are what was last painted: a card a
      // subscriber publishes during a click changes nothing for the others
      // until the next paint, so the outcome cannot depend on their order.
      let screen = new Map();
      const paint = () => {
        screen = new Map(entries);
      };
      const host = {
        setEntries: (source, rows) => entries.set(source, rows),
        setVisible() {},
        clearSource: (source) => entries.delete(source),
        hitTest(_x, _y, { sourceId } = {}) {
          if (!painted || (sourceId && sourceId !== painted.sourceId))
            return null;
          const entry = screen
            .get(painted.sourceId)
            ?.find((e) => e.id === painted.entryId);
          return entry?.interactive ? { ...painted, entry } : null;
        },
      };
      const click = () => {
        paint();
        input.click();
      };
      picking.setClickCardHitTest((x, y) => host.hitTest(x, y));
      const q = createEarthquakesLayer({
        source: { getSnapshot: async () => [quake('ak1')] },
        overlayHost: host,
        input: () => input.input,
        picking,
        openExternal: (url) => opened.push(url),
        focus: { requestWorldFocus: (detail) => focused.push(detail) },
      });
      const area = createDroneAirspaceLayer({
        source: {
          getSnapshot: async () => [
            {
              stableId: '310',
              name: 'Fixture area',
              typeCode: 'P',
              type: 'Prohibited',
              lowerAltitude: 'SFC',
              upperAltitude: '18000',
              polygons: [
                [
                  [
                    [-153.4, 59.9],
                    [-153.2, 59.9],
                    [-153.2, 60.1],
                    [-153.4, 59.9],
                  ],
                ],
              ],
            },
          ],
        },
        overlayHost: host,
        inputFor: () => input.input,
        picking,
      });
      const layers = areaFirst ? [area, q] : [q, area];
      try {
        for (const layer of layers) {
          layer.init(viewer);
          layer.enable(viewer);
          await layer.update(viewer);
        }
        const ownHit = {
          set: draw.find('earthquakes:').spec.id,
          id: 'earthquake:ak1',
        };
        const areaSet = [...draw.sets.values()].find(
          (set) =>
            set.spec.id.startsWith('drone-airspace:') &&
            set.spec.id.endsWith(':fills'),
        );
        const areaHit = { set: areaSet.spec.id, id: 'drone-airspace:310:0' };
        assert.equal(picking.findPickOwner(areaHit.id), null);
        sceneHit = ownHit;
        click();
        assert.equal(
          entries.get('earthquake-card')[0].id,
          'earthquake-card:ak1',
        );
        assert.equal(entries.get('drone-airspace')?.length ?? 0, 0);
        painted = {
          sourceId:
            kind === 'card'
              ? EARTHQUAKE_CARD_SOURCE_ID
              : EARTHQUAKE_OVERLAY_SOURCE_ID,
          entryId: kind === 'card' ? 'earthquake-card:ak1' : 'ak1',
        };
        sceneHit = areaHit;
        click();
        // The quake's card or label painted on top takes the click; the
        // zone under it is background and stands aside: one action.
        assert.equal(
          entries.get('drone-airspace')?.length ?? 0,
          0,
          'the area under the overlay is not selected',
        );
        assert.equal(
          entries.get('earthquake-card')[0].id,
          'earthquake-card:ak1',
          'the quake card stays',
        );
        assert.equal(opened.length, kind === 'card' ? 1 : 0);
        assert.equal(focused.length, kind === 'label' ? 1 : 0);
        // The same painted action works over its own disc and over open ground.
        for (const hit of [ownHit, null]) {
          sceneHit = hit;
          click();
        }
        assert.equal(opened.length, kind === 'card' ? 3 : 0);
        assert.equal(focused.length, kind === 'label' ? 3 : 0);
        // With no overlay the area is selected and the quake deselects.
        painted = null;
        sceneHit = areaHit;
        click();
        assert.equal(entries.get('drone-airspace')?.length, 1);
        assert.equal(entries.get('earthquake-card')?.length ?? 0, 0);
      } finally {
        for (const layer of layers) layer.destroy();
        input.destroy();
        unbind();
      }
    });
  }
}

// Layers that never act on clicks still draw pickable items (air quality
// stations, traffic heat lines, OSM places). They are not a click target, so
// the quake card and labels painted over them keep working.
test('quake card and label work over pickable items no layer acts on', async () => {
  const h = harness([quake('ak1'), quake('ak2', { mag: 4 })]);
  try {
    h.layer.enable(h.viewer);
    await h.layer.update(h.viewer);
    h.clickDisc('ak1');
    const decorative = [
      { set: 'air-quality-markers:1', id: 'aq:station-1' },
      { set: 'traffic:1:heat', id: 'traffic:segment-9' },
      { set: 'osm-places:1:points', id: 'osm:node-3' },
    ];
    for (const hit of decorative) {
      h.clickOverlayWith(EARTHQUAKE_CARD_SOURCE_ID, 'earthquake-card:ak1', hit);
    }
    assert.equal(h.opened.length, decorative.length, 'the card opens USGS');
    h.clickOverlayWith(EARTHQUAKE_OVERLAY_SOURCE_ID, 'ak2', decorative[1]);
    assert.equal(h.focused.at(-1)?.id, 'earthquake:ak2', 'the label flies');
  } finally {
    h.layer.destroy();
  }
});

// The quake card or a magnitude label on top takes the click over whatever is
// drawn under it: a flight trail, a route, a route step or an aircraft.
test('quake card and label act over trails, routes, steps and aircraft', async () => {
  const h = harness([quake('ak1'), quake('ak2', { mag: 4 })]);
  picking.registerPickOwner('test-directions', (id) =>
    String(id).startsWith('directions:'),
  );
  picking.registerPickOwner('test-plane', (id) => id === 'plane-9');
  try {
    h.layer.enable(h.viewer);
    await h.layer.update(h.viewer);
    h.clickDisc('ak1');
    const trail = { set: 'trail:1:lines', id: 'gev-trail:fl-a1b2c3:head' };
    const route = { set: 'directions:1:route', id: 'directions:route' };
    assert.equal(picking.findPickOwner(trail.id), 'trails');
    h.clickOverlayWith(EARTHQUAKE_CARD_SOURCE_ID, 'earthquake-card:ak1', trail);
    h.clickOverlayWith(EARTHQUAKE_CARD_SOURCE_ID, 'earthquake-card:ak1', route);
    assert.equal(h.opened.length, 2, 'the card opens USGS over both');
    h.clickOverlayWith(EARTHQUAKE_OVERLAY_SOURCE_ID, 'ak2', trail);
    assert.equal(h.focused.at(-1)?.id, 'earthquake:ak2', 'the label flies');
    // A route step under the label: the label still takes it.
    h.clickOverlayWith(EARTHQUAKE_OVERLAY_SOURCE_ID, 'ak1', {
      set: 'directions:1:steps',
      id: 'directions:step:2',
    });
    assert.equal(h.focused.at(-1)?.id, 'earthquake:ak1', 'over a step');
    // So does the card over an aircraft.
    h.clickOverlayWith(EARTHQUAKE_OVERLAY_SOURCE_ID, 'ak2', null);
    h.clickOverlayWith(EARTHQUAKE_CARD_SOURCE_ID, 'earthquake-card:ak2', {
      set: 'flights:1',
      id: 'plane-9',
    });
    assert.equal(h.opened.length, 3, 'over an aircraft');
    // A plain click on a trail is still not empty space: the card stays.
    h.click(trail);
    assert.equal(h.lastCard()[0].id, 'earthquake-card:ak2');
  } finally {
    picking.unregisterPickOwner('test-directions');
    picking.unregisterPickOwner('test-plane');
    h.layer.destroy();
  }
});

test('quake overlays take the click over a nearby or exact fire; a bare fire acts once', async (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  let sceneHit = null;
  const fireHit = { set: 'firms:test', id: 'fire:test' };
  let input;
  const h = harness([quake('ak1')], {
    input(viewer) {
      viewer.scene = {
        pick: () => (sceneHit ? { id: sceneHit } : null),
        drillPick: () => [{ id: fireHit }],
      };
      input ??= fakeInput(viewer);
      return input.input;
    },
  });
  const fire = { lat: 60, lon: -153, frp: 5, acqMs: 1, sensor: 'test' };
  const fireFocus = [];
  const state = {
    _viewer: h.viewer,
    _icons: { id: fireHit.set },
    _pickIndexById: new Map([[fireHit.id, fire]]),
    _fireByCardId: new Map(),
    _contextIds: new Set(),
  };
  const selection = createFireSelection({
    layerState: state,
    services: {
      picking,
      context: {},
      focus: { requestWorldFocus: (x) => fireFocus.push(x) },
    },
    components: {
      cards: { rebuildAmbientLabels() {} },
      model: { firePosition: () => ({ x: 1, y: 2, z: 3 }) },
    },
    config: { id: 'firms', name: 'FIRMS', overlayHost: h.overlayHost },
    feed: {},
  });
  try {
    h.layer.enable(h.viewer);
    await h.layer.update(h.viewer);
    selection.installClickHandler();
    picking.registerPickOwner('firms', (id) => state._pickIndexById.has(id));
    h.overlayHits.set(EARTHQUAKE_OVERLAY_SOURCE_ID, {
      sourceId: EARTHQUAKE_OVERLAY_SOURCE_ID,
      entryId: 'ak1',
    });
    input.click();
    assert.equal(h.focused.length, 1, 'label acts on the exact miss');
    assert.equal(fireFocus.length, 0, 'nearby fire does not act');
    h.overlayHits.clear();
    h.overlayHits.set(EARTHQUAKE_CARD_SOURCE_ID, {
      sourceId: EARTHQUAKE_CARD_SOURCE_ID,
      entryId: 'earthquake-card:ak1',
    });
    input.click();
    assert.equal(h.opened.length, 1, 'selected card opens once');
    assert.equal(fireFocus.length, 0);
    sceneHit = fireHit;
    input.click();
    assert.equal(fireFocus.length, 0, 'an exact fire under the card does not');
    assert.equal(h.opened.length, 2, 'the card on top acts');
    h.overlayHits.clear();
    input.click();
    assert.equal(fireFocus.length, 1, 'the bare fire acts');
    assert.equal(h.opened.length, 2);
  } finally {
    selection.removeClickHandler();
    picking.unregisterPickOwner('firms');
    h.layer.destroy();
    input?.destroy();
  }
});

// A tap that drifts more than the tracking click travel is a drag: the quake
// card ignores it, as the aircraft layers do.
test('a quake card takes a still tap beside an aircraft but not a dragged one', async (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const plane = { set: 'flights:1', id: 'plane-9' };
  let sceneHit = null;
  let nearby = null;
  let input;
  const h = harness([quake('ak1')], {
    input(viewer) {
      viewer.scene = {
        pick: () => (sceneHit ? { id: sceneHit } : null),
        drillPick: () => (nearby ? [{ id: nearby }] : []),
      };
      input = fakeInput(viewer);
      return input.input;
    },
  });
  picking.registerPickOwner('test-plane', (id) => id === plane.id);
  t.after(() => {
    picking.unregisterPickOwner('test-plane');
    h.layer.destroy();
    input?.destroy();
  });
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  sceneHit = { set: h.discs().spec.id, id: 'earthquake:ak1' };
  input.click();
  const card = h.lastCard()[0];
  h.overlayHits.set(EARTHQUAKE_CARD_SOURCE_ID, {
    sourceId: EARTHQUAKE_CARD_SOURCE_ID,
    entryId: card.id,
  });
  sceneHit = null;
  nearby = plane;
  // A still tap: the card on top takes it over the aircraft's contact.
  input.tap({ x: 10, y: 10 });
  assert.equal(h.opened.length, 1);
  // A tap that drifts 10 px: the aircraft ignores it, so the card opens.
  input.down({ x: 10, y: 10 });
  input.move({ x: 20, y: 10 }, { x: 10, y: 10 });
  input.up({ x: 20, y: 10 });
  input.click({ x: 20, y: 10 });
  assert.equal(h.opened.length, 1, 'a drag opens nothing');
});

// A pan that ends near where it began still raises a click: it must not
// select a quake, fly to one, open its source or clear the selection.
test('a drag that ends on a quake does nothing; a long press selects but neither opens nor clears', async () => {
  const drag = { travelPx: 12, durationMs: 120 };
  const hold = { travelPx: 0, durationMs: 900 };
  const h = harness([quake('ak1'), quake('ak2')]);
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  const disc = (id) => ({ set: h.discs().spec.id, id: `earthquake:${id}` });
  h.click(disc('ak1'), disc('ak1'), drag);
  assert.equal(h.cards.length, 0, 'a drag over a disc selects nothing');
  h.overlayHits.set(EARTHQUAKE_OVERLAY_SOURCE_ID, {
    sourceId: EARTHQUAKE_OVERLAY_SOURCE_ID,
    entryId: 'ak2',
  });
  h.click(null, null, drag);
  h.overlayHits.clear();
  assert.equal(h.focused.length, 0, 'a drag over a label does not fly');
  h.click(disc('ak1'), disc('ak1'), hold);
  const card = h.lastCard()[0];
  assert.ok(card, 'a long press on a disc selects it');
  h.overlayHits.set(EARTHQUAKE_CARD_SOURCE_ID, {
    sourceId: EARTHQUAKE_CARD_SOURCE_ID,
    entryId: card.id,
  });
  h.click(null, null, hold);
  h.overlayHits.clear();
  assert.deepEqual(h.opened, [], 'a long press does not open the source');
  const cardsBefore = h.cards.length;
  h.click(null, null, drag);
  h.click(null, null, hold);
  assert.equal(
    h.cards.length,
    cardsBefore,
    'a drag or hold on the map keeps it',
  );
  assert.ok(h.lastCard().length, 'still selected');
  h.click(null);
  assert.deepEqual(h.lastCard(), [], 'a clean click on the map clears it');
  h.layer.destroy();
});

// A refresh that no longer carries the selected quake evicts it, as other
// feeds report; a click on empty map is a deliberate clear.
test('a quake that ages out of the feed is cleared as evicted', async () => {
  const clears = [];
  const context = {
    registerEntityContext: (record) => ({ ...record, id: record.id }),
    selectEntityContext() {},
    clearSelectedEntityContextForLayer: (layerId, options) =>
      clears.push([layerId, options?.evicted === true]),
    getContextStore: () => ({ entities: new Map() }),
  };
  const h = harness([quake('ak1'), quake('ak2')], { context });
  h.layer.enable(h.viewer);
  await h.layer.update(h.viewer);
  h.clickDisc('ak1');
  h.setRows([quake('ak2')]);
  await h.layer.update(h.viewer);
  assert.deepEqual(clears.at(-1), ['earthquakes', true], 'aged out: evicted');
  h.clickDisc('ak2');
  h.click(null);
  assert.deepEqual(clears.at(-1), ['earthquakes', false], 'empty map');
  h.layer.destroy();
});
