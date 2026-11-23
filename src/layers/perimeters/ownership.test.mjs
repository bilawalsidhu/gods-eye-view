import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFirePerimetersLayer,
  perimeterAnchorDegrees,
  PERIMETER_AGE_BANDS,
} from './index.js';
import { firePerimeterSnapshot } from './records.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import { clickCard } from '../../data/pickRegistry.js';
import { fakeInput, fakeInputUnderLabel } from '../../input/testDoubles.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

// The fills set of the layer the last harness made: perimeter picks name it.
let fillsSetId = null;
/** A Cesium pick of a perimeter's fill, as the draw port makes it. */
const perimeterPick = (id) => ({ id: { set: fillsSetId, id } });
const liveSet = (draw, suffix) =>
  [...draw.sets.values()].find(
    (record) => !record.disposed && record.spec.id.endsWith(suffix),
  );

function harness(
  source,
  {
    init = true,
    pick = () => null,
    inciwebIndex = null,
    cardHit = () => null,
    publication = async () => ({
      createdMs: 1757000000000,
      changedMs: 1757900000000,
    }),
  } = {},
) {
  const overlay = { entries: new Map(), visible: null };
  const owners = new Map();
  const opened = [];
  const viewer = { scene: { pick } };
  const { draw } = bindFakeDraw(viewer);
  const input = fakeInputUnderLabel(viewer);
  const clicks = {
    handler: (click) => input.click(click.position),
    // Only the label's own overlay handler is left.
    get destroyed() {
      return input.input.subscriberCount() === 1 ? 1 : 0;
    },
  };
  const layer = createFirePerimetersLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        overlay.entries.set(sourceId, entries);
      },
      setVisible(sourceId, visible) {
        overlay.visible = visible;
      },
      clearSource(sourceId) {
        overlay.entries.delete(sourceId);
      },
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    inputFor: () => input.input,
    picking: {
      resolvePickId: (picked) => picked?.id?.id ?? picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickedId) =>
        String(pickedId).startsWith('other-layer:'),
      registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
      unregisterPickOwner: (layerId) => owners.delete(layerId),
      // The card on top at a click, as the registry answers from the host;
      // a mission label painted over everything comes first.
      clickCard: (click) =>
        clickCard(click) ??
        cardHit(click.screenPosition?.x, click.screenPosition?.y, {}),
    },
    inciwebSource: inciwebIndex
      ? { getIndex: async () => inciwebIndex }
      : { getIndex: async () => [] },
    inciwebPublications: { getPublication: publication },
    openExternal: (url) => opened.push(url),
  });
  if (init) {
    layer.init(viewer);
    layer.enable(viewer);
    fillsSetId = liveSet(draw, ':fills').spec.id;
  }
  return {
    layer,
    viewer,
    draw,
    fills: () => liveSet(draw, ':fills'),
    lines: () => liveSet(draw, ':lines'),
    overlay,
    clicks,
    owners,
    opened,
    /** A Space Missions label painted over the map: while `over`, it takes
     *  each click and is the card on top. */
    label: input.label,
  };
}

const ring = [
  [-108.1, 35.2],
  [-108.0, 35.2],
  [-108.0, 35.3],
  [-108.1, 35.2],
];
const HOUR = 3600000;
const fire = {
  id: '2026-NMGNF-000123',
  name: 'Fixture Fire',
  acres: 512.5,
  containedPct: 40,
  state: 'US-NM',
  category: 'WF',
  discoveredTime: 1757900000000,
  updatedTime: 1757950000000,
  cause: 'Natural',
  behavior: 'Active',
  personnel: 380,
  county: 'Sandoval',
  costToDate: 4200000,
  complexity: 'Type 3 Incident',
  complexName: 'ROWE CREEK COMPLEX',
  lastGrowthTime: 1757950000000,
  anchor: perimeterAnchorDegrees([[ring]]),
};
/** One piece of `fireId`'s area: one polygon, outlined by its rings. */
const pieceOf = (fireId, { rings = [ring], born = null, ...rest } = {}) => ({
  fireId,
  born,
  polygons: [rings],
  outline: rings,
  ...rest,
});
/** A source snapshot of `fires`, one piece each unless `pieces` is given. */
function snap(fires, { pieces, ...rest } = {}) {
  return {
    at: null,
    fetchedAt: null,
    stale: false,
    revision: 'r1',
    note: null,
    fires,
    pieces: pieces ?? fires.map(({ id }) => pieceOf(id)),
    ...rest,
  };
}
const tick = () => new Promise((done) => setTimeout(done, 0));
const rgba = (band, alpha) => hexColor(PERIMETER_AGE_BANDS[band].color, alpha);

test('each piece draws as a clamped fill and its outline as draped lines, coloured by age', async () => {
  const hole = [
    [-108.08, 35.22],
    [-108.02, 35.22],
    [-108.02, 35.25],
    [-108.08, 35.22],
  ];
  const at = Date.UTC(2025, 7, 1, 12);
  const other = { ...fire, id: 'other', containedPct: 100 };
  const h = harness({
    getSnapshot: async () =>
      snap([fire, other], {
        at,
        pieces: [
          pieceOf(fire.id, { rings: [ring, hole], born: at - HOUR }),
          // A piece cut from a larger area: no line along the cut.
          {
            fireId: 'other',
            born: at - 30 * HOUR,
            polygons: [[ring]],
            outline: [ring.slice(0, 3)],
          },
          pieceOf('other', { born: null }),
        ],
      }),
  });
  assert.equal(h.fills().show, true);
  assert.equal(h.lines().show, true);
  assert.equal(await h.layer.update(h.viewer), true);
  assert.deepEqual(
    [...h.fills().items.keys()],
    [
      'fire-perimeter:2026-NMGNF-000123:0',
      'fire-perimeter:other:0',
      'fire-perimeter:other:1',
    ],
  );
  assert.deepEqual(
    [...h.lines().items.keys()],
    [
      'fire-perimeter:2026-NMGNF-000123:line:0',
      'fire-perimeter:2026-NMGNF-000123:line:1',
      'fire-perimeter:other:line:0',
      'fire-perimeter:other:line:1',
    ],
  );
  const fill = h.fills().items.get('fire-perimeter:2026-NMGNF-000123:0');
  assert.equal(fill.height, 'clampGround');
  assert.deepEqual(fill.fill, rgba(0, 0.35));
  assert.equal(fill.geometry.kind, 'polygon');
  assert.equal(fill.geometry.rings.length, 2, 'the hole stays');
  assert.deepEqual(fill.geometry.rings[0][1], { lon: -108.0, lat: 35.2 });
  const line = h.lines().items.get('fire-perimeter:2026-NMGNF-000123:line:1');
  assert.equal(line.mode, 'draped');
  assert.equal(line.widthPx, 2);
  assert.deepEqual(line.style, { kind: 'solid', color: rgba(0, 0.9) });
  assert.equal(line.positions.length, hole.length, 'the hole is outlined too');
  assert.ok(Number.isFinite(line.positions[0].x), 'lines take ECEF');
  assert.equal(
    h.lines().items.get('fire-perimeter:other:line:0').positions.length,
    3,
    'the outline as given, not the polygon',
  );
  // Aged at the snapshot's moment, not now: 30 h is 1–3 days; unknown is oldest.
  assert.deepEqual(
    h.fills().items.get('fire-perimeter:other:0').fill,
    rgba(2, 0.35),
  );
  assert.deepEqual(
    h.fills().items.get('fire-perimeter:other:1').fill,
    rgba(3, 0.35),
  );
  assert.equal(h.layer.getStats().count, 2);
  h.layer.disable();
  assert.equal(h.fills().show, false);
  assert.equal(h.lines().show, false);
  h.layer.destroy();
  assert.equal(h.fills(), undefined, 'destroy disposes the sets');
  assert.equal(h.lines(), undefined);
});

test('a piece of a fire the snapshot does not list is dropped', async () => {
  const h = harness({
    getSnapshot: async () =>
      snap([fire], { pieces: [pieceOf(fire.id), pieceOf('ghost')] }),
  });
  await h.layer.update();
  assert.deepEqual(
    [...h.fills().items.keys()],
    ['fire-perimeter:2026-NMGNF-000123:0'],
  );
  h.layer.destroy();
});

test("a pick selects only an item of the layer's own sets", async () => {
  let pickResult = null;
  const h = harness(
    { getSnapshot: async () => snap([fire]) },
    { pick: () => pickResult },
  );
  await h.layer.update(h.viewer);
  pickResult = {
    id: { set: 'someone-else', id: 'fire-perimeter:2026-NMGNF-000123:0' },
  };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('fire-perimeters')?.length ?? 0, 0);
  // The fire line picks as its perimeter, as the one entity used to.
  pickResult = {
    id: {
      set: h.lines().spec.id,
      id: 'fire-perimeter:2026-NMGNF-000123:line:0',
    },
  };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('fire-perimeters').length, 1);
});

test('late refresh cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve(snap([fire]));
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    h.layer.destroy(h.viewer);
  }
});

test('clicking a perimeter publishes its incident card; empty space clears it', async () => {
  let pickResult = null;
  const h = harness(
    { getSnapshot: async () => snap([fire]) },
    {
      pick: () => pickResult,
    },
  );
  await h.layer.update(h.viewer);
  assert.equal(typeof h.clicks.handler, 'function', 'click handler missing');
  // Deliberately NOT registered as a pick owner: sibling layers' click
  // handlers yield to owned picks before their own card hit-tests, so
  // claiming these large ground polygons would make FIRMS/vessel/CCTV
  // overlay cards inert anywhere over a perimeter.
  assert.equal(h.owners.size, 0);

  pickResult = perimeterPick('fire-perimeter:2026-NMGNF-000123:0');
  h.clicks.handler({ position: { x: 10, y: 10 } });
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'fire-perimeter-card:2026-NMGNF-000123');
  assert.equal(entries[0].title, 'FIRE · Fixture Fire');
  assert.ok(entries[0].position, 'card must carry a world anchor');

  pickResult = { id: 'other-layer:aircraft-1' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(
    h.overlay.entries.get('fire-perimeters')?.length,
    1,
    'sibling-layer picks must not clear the selection',
  );

  pickResult = null;
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('fire-perimeters')?.length ?? 0, 0);
});

// Another layer's card or label painted over the area (a quake's card or
// magnitude label) is that layer's click: the area under it stands aside.
test("another layer's overlay on top keeps a click off the area", async () => {
  let pickResult = null;
  let foreignOnTop = false;
  const h = harness(
    { getSnapshot: async () => snap([fire]) },
    {
      pick: () => pickResult,
      // Unfiltered: the topmost entry of any source.
      cardHit: (_x, _y, options) =>
        foreignOnTop && !options?.sourceId
          ? { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' }
          : null,
    },
  );
  await h.layer.update(h.viewer);
  pickResult = perimeterPick('fire-perimeter:2026-NMGNF-000123:0');
  foreignOnTop = true;
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('fire-perimeters')?.length ?? 0, 0);
  // With nothing painted over it, the same click selects the area.
  foreignOnTop = false;
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(
    h.overlay.entries.get('fire-perimeters')[0].id,
    'fire-perimeter-card:2026-NMGNF-000123',
  );
  // An overlay on top never clears an existing selection either.
  foreignOnTop = true;
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(
    h.overlay.entries.get('fire-perimeters')[0].id,
    'fire-perimeter-card:2026-NMGNF-000123',
  );
});

test('disable removes the click handler, pick ownership, and any card', async () => {
  const h = harness(
    { getSnapshot: async () => snap([fire]) },
    { pick: () => perimeterPick('fire-perimeter:2026-NMGNF-000123:0') },
  );
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
  h.layer.disable(h.viewer);
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.owners.has('fire-perimeters'), false);
  assert.equal(h.overlay.entries.has('fire-perimeters'), false);
});

test('a refresh that drops the selected incident also drops its card', async () => {
  let rows = snap([fire]);
  const h = harness(
    { getSnapshot: async () => rows },
    { pick: () => perimeterPick('fire-perimeter:2026-NMGNF-000123:0') },
  );
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('fire-perimeters').length, 1);
  rows = snap([{ ...fire, id: 'different' }], { revision: 'r2' });
  await h.layer.update(h.viewer);
  assert.equal(h.overlay.entries.get('fire-perimeters')?.length ?? 0, 0);
});

test('a selected fire keeps its card while listed, even with no pieces left', async () => {
  let current = snap([fire]);
  const h = harness(
    { getSnapshot: async () => current },
    { pick: () => perimeterPick('fire-perimeter:2026-NMGNF-000123:0') },
  );
  await h.layer.update();
  h.clicks.handler({ position: { x: 10, y: 10 } });
  current = snap([fire], { pieces: [] });
  await h.layer.update();
  assert.equal(h.fills().items.size, 0);
  const [card] = h.overlay.entries.get('fire-perimeters');
  assert.equal(card.id, 'fire-perimeter-card:2026-NMGNF-000123');
  assert.equal(h.layer.getStats().count, 1, 'a fire without pieces counts');
  assert.equal(
    h.layer.getRowControls().legend.reduce((sum, { count }) => sum + count, 0),
    1,
  );
  h.layer.destroy();
});

test('the card ages from the moment the snapshot shows', async () => {
  const at = Date.UTC(2025, 7, 1, 12);
  const h = harness(
    {
      getSnapshot: async () =>
        snap(
          [
            {
              ...fire,
              discoveredTime: at - 50 * HOUR,
              updatedTime: at - 2 * HOUR,
              lastGrowthTime: at - 5 * HOUR,
            },
          ],
          { at },
        ),
    },
    { pick: () => perimeterPick('fire-perimeter:2026-NMGNF-000123:0') },
  );
  await h.layer.update();
  h.clicks.handler({ position: { x: 10, y: 10 } });
  const [card] = h.overlay.entries.get('fire-perimeters');
  assert.deepEqual(card.details.slice(-2), [
    'last growth 5h ago',
    'discovered 2d ago · updated 2h ago',
  ]);
  h.layer.destroy();
});

test('a matched incident card carries the InciWeb line and click-through', async () => {
  const inciwebIndex = [
    {
      incident_id: '329300',
      tau: 'NMGNF Fixture Fire',
      incident_title: 'Fixture Fire',
    },
  ];
  let cardHitResult = null;
  let foreignOnTop = false;
  const h = harness(
    { getSnapshot: async () => snap([{ ...fire, name: 'Fixture' }]) },
    {
      pick: () => null,
      inciwebIndex,
      cardHit: (_x, _y, options) =>
        foreignOnTop && !options?.sourceId
          ? { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' }
          : cardHitResult,
    },
  );
  await h.layer.update(h.viewer);
  // Select via a perimeter pick.
  h.viewer.scene.pick = () =>
    perimeterPick('fire-perimeter:2026-NMGNF-000123:0');
  h.clicks.handler({ position: { x: 10, y: 10 } });
  // The card publishes immediately; the link line lands once the
  // publication's currency is validated.
  assert.equal(h.overlay.entries.get('fire-perimeters').length, 1);
  await new Promise((done) => setTimeout(done, 0));
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(entries[0].details.at(-1), 'InciWeb ↗ · click card to open');

  // A selected card covered by a quake card cannot open its hidden link.
  cardHitResult = { sourceId: 'fire-perimeters', entryId: entries[0].id };
  h.viewer.scene.pick = () => null;
  foreignOnTop = true;
  h.clicks.handler({ position: { x: 12, y: 12 } });
  assert.deepEqual(h.opened, []);
  assert.equal(h.overlay.entries.get('fire-perimeters')[0].id, entries[0].id);
  // Removing the foreground card makes the incident card actionable again.
  foreignOnTop = false;
  h.clicks.handler({ position: { x: 12, y: 12 } });
  assert.deepEqual(h.opened, ['https://inciweb.wildfire.gov/node/329300']);
  assert.equal(
    h.overlay.entries.get('fire-perimeters').length,
    1,
    'opening the link must not clear the selection',
  );
});

test('a click on a mission label over the incident card never opens its InciWeb page, and keeps the card open', async () => {
  let cardHitResult = null;
  const h = harness(
    { getSnapshot: async () => snap([fire]) },
    {
      pick: () => perimeterPick('fire-perimeter:2026-NMGNF-000123:0'),
      inciwebIndex: [
        {
          incident_id: '329300',
          tau: 'NMGNF Fixture Fire',
          incident_title: 'Fixture Fire',
        },
      ],
      cardHit: () => cardHitResult,
    },
  );
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
  await new Promise((done) => setTimeout(done, 0));
  const [card] = h.overlay.entries.get('fire-perimeters');
  assert.equal(card.details.at(-1), 'InciWeb ↗ · click card to open');

  // The open card lies under the label: the click opens nothing, and the
  // label on top is its own click, so the card stays open.
  cardHitResult = { sourceId: 'fire-perimeters', entryId: card.id };
  h.viewer.scene.pick = () => null;
  h.label.over = true;
  h.clicks.handler({ position: { x: 12, y: 12 } });
  assert.deepEqual(h.opened, [], 'the page beneath the label is not opened');
  assert.equal(h.overlay.entries.get('fire-perimeters')?.[0]?.id, card.id);

  // Off the label, a click on the open card opens its page.
  h.label.over = false;
  h.clicks.handler({ position: { x: 12, y: 12 } });
  assert.deepEqual(h.opened, ['https://inciweb.wildfire.gov/node/329300']);
  h.layer.destroy();
});

test('an unmatched incident renders no InciWeb line and card clicks stay inert', async () => {
  let cardHitResult = null;
  const h = harness(
    { getSnapshot: async () => snap([fire]) },
    {
      pick: () => perimeterPick('fire-perimeter:2026-NMGNF-000123:0'),
      inciwebIndex: [],
      cardHit: () => cardHitResult,
    },
  );
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(
    entries[0].details.some((line) => line.includes('InciWeb')),
    false,
  );
  cardHitResult = { sourceId: 'fire-perimeters', entryId: entries[0].id };
  h.viewer.scene.pick = () => null;
  h.clicks.handler({ position: { x: 12, y: 12 } });
  assert.deepEqual(h.opened, []);
  assert.equal(h.overlay.entries.get('fire-perimeters').length, 1);
});

test('a complex member resolves to its complex page from the catalog', async () => {
  const h = harness(
    { getSnapshot: async () => snap([fire]) },
    {
      pick: () => perimeterPick('fire-perimeter:2026-NMGNF-000123:0'),
      inciwebIndex: [
        {
          // Same state as the member fire: the state filter applies to
          // complex fallbacks too.
          incident_id: '328923',
          tau: 'NMPRD Rowe Creek Complex',
          incident_title: 'Rowe Creek Complex',
        },
      ],
    },
  );
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
  await new Promise((done) => setTimeout(done, 0));
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(entries[0].details.at(-1), 'InciWeb ↗ · click card to open');
});

test('a stale or unverifiable publication yields no link', async () => {
  const inciwebIndex = [
    {
      incident_id: '100',
      tau: 'NMGNF Fixture Fire',
      incident_title: 'Fixture Fire',
    },
  ];
  for (const publication of [
    // Created two years before this fire's discovery: an archived page.
    async () => ({
      createdMs: 1757900000000 - 700 * 86400000,
      changedMs: null,
    }),
    // Validation endpoint down: fail closed, no link.
    async () => {
      throw new Error('InciWeb HTTP 503');
    },
  ]) {
    const h = harness(
      { getSnapshot: async () => snap([fire]) },
      {
        pick: () => perimeterPick('fire-perimeter:2026-NMGNF-000123:0'),
        inciwebIndex,
        publication,
      },
    );
    await h.layer.update(h.viewer);
    h.clicks.handler({ position: { x: 10, y: 10 } });
    await new Promise((done) => setTimeout(done, 0));
    const entries = h.overlay.entries.get('fire-perimeters');
    assert.equal(entries.length, 1);
    assert.equal(
      entries[0].details.some((line) => line.includes('InciWeb')),
      false,
    );
    assert.equal(entries[0].interactive, false);
    h.layer.destroy(h.viewer);
  }
});

test('a hanging InciWeb index fetch never blocks the perimeter refresh', async (t) => {
  const h = harness(
    { getSnapshot: async () => snap([fire]) },
    { inciwebIndex: null },
  );
  // Replace the index source with one that never resolves.
  h.layer.destroy(h.viewer);
  const hanging = harness({ getSnapshot: async () => snap([fire]) });
  hanging.layer.destroy(hanging.viewer);
  const viewer = { scene: { pick: () => null } };
  bindFakeDraw(viewer);
  const input = fakeInput(viewer);
  t.after(() => input.destroy());
  const layer = createFirePerimetersLayer({
    source: { getSnapshot: async () => snap([fire]) },
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
    picking: {
      resolvePickId: () => null,
      isOwnedByOtherLayer: () => false,
      registerPickOwner() {},
      unregisterPickOwner() {},
    },
    pointer: { isPointerFree: () => true },
    inciwebSource: { getIndex: () => new Promise(() => {}) },
    inciwebPublications: {
      getPublication: async () => ({ createdMs: 1, changedMs: 1 }),
    },
    openExternal: () => {},
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getStats().count, 1);
  layer.destroy(viewer);
});

test('an InciWeb outage never breaks the perimeter refresh', async (t) => {
  const h = harness({ getSnapshot: async () => snap([fire]) });
  const failing = createFirePerimetersLayer({
    source: { getSnapshot: async () => snap([fire]) },
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
    picking: {
      resolvePickId: () => null,
      isOwnedByOtherLayer: () => false,
      registerPickOwner() {},
      unregisterPickOwner() {},
    },
    pointer: { isPointerFree: () => true },
    inciwebSource: {
      getIndex: async () => {
        throw new Error('InciWeb HTTP 503');
      },
    },
    openExternal: () => {},
  });
  const viewer = { scene: { pick: () => null } };
  bindFakeDraw(viewer);
  const failingInput = fakeInput(viewer);
  t.after(() => failingInput.destroy());
  failing.init(viewer);
  failing.enable(viewer);
  assert.equal(await failing.update(viewer), true);
  assert.equal(failing.getStats().count, 1);
  failing.destroy(viewer);
  h.layer.destroy(h.viewer);
});

test('analyst records expose incident facts without geometry payloads', async () => {
  const h = harness({ getSnapshot: async () => snap([fire]) });
  await h.layer.update(h.viewer);
  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'Fixture Fire');
  assert.equal(records[0].acres, 512.5);
  assert.equal(records[0].containedPct, 40);
  assert.equal(records[0].state, 'US-NM');
  assert.equal(records[0].cause, 'Natural');
  assert.equal(records[0].behavior, 'Active');
  assert.equal(records[0].personnel, 380);
  assert.equal(records[0].county, 'Sandoval');
  assert.equal(records[0].costToDate, 4200000);
  assert.equal(records[0].complexity, 'Type 3 Incident');
  assert.equal(records[0].lastGrowthTime, fire.lastGrowthTime);
  assert.equal(records[0].id, fire.id);
  // Spatial scoping in the analyst engine requires coordinates.
  assert.ok(Math.abs(records[0].lat - 35.2333) < 0.01);
  assert.ok(Math.abs(records[0].lon - -108.0333) < 0.01);
  assert.equal('polygons' in records[0] || 'anchor' in records[0], false);
});

test('historical analyst records hold no time after the moment shown', async () => {
  const at = Date.UTC(2024, 6, 3);
  const later = Date.UTC(2024, 6, 4);
  const earlier = Date.UTC(2024, 6, 2);
  const h = harness({
    getSnapshot: async () =>
      snap(
        [
          {
            ...fire,
            id: 'A',
            discoveredTime: later,
            updatedTime: later,
            lastGrowthTime: later,
          },
          {
            ...fire,
            id: 'B',
            discoveredTime: earlier,
            updatedTime: earlier,
            lastGrowthTime: at,
          },
        ],
        { at },
      ),
  });
  await h.layer.update(h.viewer);
  const [a, b] = h.layer.getAnalystRecords();
  assert.deepEqual(
    [a.discoveredTime, a.updatedTime, a.lastGrowthTime],
    [null, null, null],
  );
  assert.deepEqual(
    [b.discoveredTime, b.updatedTime, b.lastGrowthTime],
    [earlier, earlier, at],
  );
  h.layer.destroy();
});

test('the layer redraws on a new revision or a change of age band, and only then', async () => {
  const at = Date.UTC(2025, 7, 1, 12);
  const other = { ...fire, id: 'other' };
  let current = snap([fire, other], {
    at,
    pieces: [pieceOf(fire.id, { born: at - HOUR }), pieceOf('other')],
  });
  const h = harness({ getSnapshot: async () => current });
  const writes = () => [h.fills().writes, h.lines().writes];
  await h.layer.update();
  assert.deepEqual(writes(), [1, 1]);
  // Same revision, feed reordered, facts changed, still in the same band.
  current = {
    ...current,
    at: at + 4 * HOUR,
    fires: [{ ...other, containedPct: 100 }, fire],
  };
  await h.layer.update();
  assert.deepEqual(writes(), [1, 1]);
  // The new piece turns 6 h old.
  current = { ...current, at: at + 6 * HOUR };
  await h.layer.update();
  assert.deepEqual(writes(), [2, 2]);
  assert.deepEqual(
    h.fills().items.get('fire-perimeter:2026-NMGNF-000123:0').fill,
    rgba(1, 0.35),
  );
  current = { ...current, revision: 'changed' };
  await h.layer.update();
  assert.deepEqual(writes(), [3, 3]);
  // A source without a revision is drawn every time.
  current = { ...current, revision: undefined };
  await h.layer.update();
  await h.layer.update();
  assert.deepEqual(writes(), [5, 5]);
  current = snap([]);
  await h.layer.update();
  assert.equal(h.fills().items.size, 0);
  assert.equal(h.lines().items.size, 0);
  h.layer.destroy();
});

test('a failed read keeps the picture and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('WFIGS HTTP 502');
      return snap([fire]);
    },
  });
  await h.layer.update();
  fail = true;
  assert.equal(await h.layer.update(), false);
  assert.equal(h.fills().items.size, 1);
  assert.equal(h.layer.getStats().error, 'WFIGS HTTP 502');
  assert.equal(h.layer.getStats().count, 1);
  h.layer.destroy();
});

test('a malformed snapshot is an error, not an empty map', async () => {
  const h = harness({ getSnapshot: async () => [fire] });
  assert.equal(await h.layer.update(), false);
  assert.equal(h.layer.getStats().error, 'Malformed perimeter snapshot');
  h.layer.destroy();
});

test('the legend counts fires by their last growth at the moment shown, with the source note', async () => {
  const at = Date.UTC(2025, 7, 1, 12);
  const ages = [0, 5.9, 6, 23.9, 24, 71.9, 72, null, -1];
  const h = harness({
    getSnapshot: async () =>
      snap(
        ages.map((hours, index) => ({
          ...fire,
          id: String(index),
          lastGrowthTime: hours === null ? null : at - hours * HOUR,
        })),
        { at, note: 'Perimeters are simplified to about 100 m.' },
      ),
  });
  await h.layer.update();
  const controls = h.layer.getRowControls();
  assert.deepEqual(controls.chips, []);
  assert.deepEqual(
    controls.legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['Last 6 hours', '#ffc72e', 2],
      ['6–24 hours', '#ff730d', 2],
      ['1–3 days', '#d9290d', 2],
      ['Older or unknown', '#730f0a', 3],
    ],
  );
  assert.equal(controls.legend[0].blurb, 'Colour shows the age of each area.');
  assert.equal(controls.info, 'Perimeters are simplified to about 100 m.');
  h.layer.destroy();
  assert.deepEqual(
    h.layer.getRowControls().legend.map(({ count }) => count),
    [0, 0, 0, 0],
  );
  assert.equal(h.layer.getRowControls().info, undefined);
});

for (const action of ['disable', 'destroy', 'selection']) {
  test(`incident-link verification aborts on ${action} and ignores late completion`, async () => {
    let finish, signal;
    let pickId = `fire-perimeter:${fire.id}:0`;
    const h = harness(
      {
        getSnapshot: async () =>
          snap([fire, { ...fire, id: 'other', name: 'Other Fire' }]),
      },
      {
        pick: () => perimeterPick(pickId),
        inciwebIndex: [
          { incident_id: '123', incident_title: fire.name, tau: 'nm' },
        ],
        publication: (_id, options) => {
          signal = options.signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    );
    await h.layer.update();
    h.clicks.handler({ position: { x: 1, y: 1 } });
    assert.equal(signal.aborted, false);
    if (action === 'selection') {
      pickId = 'fire-perimeter:other:0';
      h.clicks.handler({ position: { x: 1, y: 1 } });
    } else h.layer[action]();
    assert.equal(signal.aborted, true);
    const entries = h.overlay.entries.get('fire-perimeters');
    finish({ createdMs: fire.discoveredTime, changedMs: fire.updatedTime });
    await new Promise(setImmediate);
    assert.equal(h.overlay.entries.get('fire-perimeters'), entries);
    if (action !== 'destroy') h.layer.destroy();
  });
}

test('a stale snapshot reads stale, dated by its own fetch, and a fresh one clears it', async () => {
  const fetchedAt = Date.now() - 3 * 60 * 60 * 1000;
  let snapshot = snap([fire], { stale: true, fetchedAt });
  const h = harness({ getSnapshot: async () => snapshot });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().lastUpdate, fetchedAt);
  snapshot = snap([fire], { fetchedAt: Date.now() });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().stale, false);
  assert.ok(h.layer.getStats().lastUpdate > fetchedAt);
});

test('a failed refresh after a stale snapshot reads as the failure, not stale', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('WFIGS HTTP 502');
      return snap([fire], { stale: true, fetchedAt: Date.now() - 60_000 });
    },
  });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().stale, true);
  fail = true;
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().error, 'WFIGS HTTP 502');
});

test('a WFIGS fire without poly_DateCurrent redraws when its outline moves', async () => {
  const T = Date.UTC(2026, 10, 20, 12);
  const sq = (dx) => [
    [-108 + dx, 35],
    [-107.9 + dx, 35],
    [-107.9 + dx, 35.1],
    [-108 + dx, 35.1],
    [-108 + dx, 35],
  ];
  const rowOf = (dx, polygonTime, acres) => ({
    stableId: 'X',
    name: 'X Fire',
    acres,
    containedPct: 0,
    discoveredTime: T - 10 * 3600000,
    updatedTime: null,
    polygonTime,
    polygons: [[sq(dx)]],
  });
  for (const [a, b] of [
    [rowOf(0, T - 2 * 3600000, 10), rowOf(1, T - 3600000, 20)],
    [rowOf(0, null, 10), rowOf(1, null, 20)],
  ]) {
    const realNow = Date.now;
    Date.now = () => T;
    try {
      let cur = a;
      const h = harness({
        getSnapshot: async () => firePerimeterSnapshot([cur], { now: T }),
      });
      assert.equal(await h.layer.update(h.viewer), true);
      cur = b;
      assert.equal(await h.layer.update(h.viewer), true);
      const record = h.layer.getAnalystRecords()[0];
      const fillLon = [...h.fills().items.values()][0].geometry.rings[0][0].lon;
      const lineLon = [...h.lines().items.values()][0].positions[0];
      assert.ok(Math.abs(record.lon - -106.95) < 1e-6, 'record follows B');
      assert.equal(
        fillLon,
        -107,
        'the fill must follow B like the card anchor',
      );
      assert.deepEqual(lineLon, fromDegrees(-107, 35), 'the outline follows B');
      h.layer.destroy();
    } finally {
      Date.now = realNow;
    }
  }
});

const legendCounts = (layer) =>
  layer.getRowControls().legend.map((entry) => entry.count);
const fillBands = (h) =>
  [...h.fills().items.values()].map((item) =>
    PERIMETER_AGE_BANDS.findIndex((_, band) =>
      rgba(band, 0.35).every((v, i) => v === item.fill[i]),
    ),
  );

test('the live legend counts a fire in the band its drawn piece shows', async () => {
  const T = Date.UTC(2026, 10, 20, 12);
  const realNow = Date.now;
  let now = T;
  Date.now = () => now;
  try {
    const born = T - (5 * 60 + 59) * 60000;
    const f = { ...fire, lastGrowthTime: born };
    let fail = false;
    const h = harness({
      getSnapshot: async () => {
        if (fail) throw new Error('down');
        return snap([f], { pieces: [pieceOf(f.id, { born })] });
      },
    });
    assert.equal(await h.layer.update(h.viewer), true);
    assert.deepEqual(fillBands(h), [0]);
    assert.deepEqual(legendCounts(h.layer), [1, 0, 0, 0]);
    // Two minutes later the panel repaints (another layer toggled): no refresh.
    now = T + 2 * 60000;
    assert.deepEqual(fillBands(h), [0], 'the piece is still drawn yellow');
    assert.deepEqual(
      legendCounts(h.layer),
      [1, 0, 0, 0],
      'the legend must count the fire where the map shows it',
    );
    // A failed refresh keeps the yellow picture; the legend must agree.
    fail = true;
    assert.equal(await h.layer.update(h.viewer), false);
    assert.deepEqual(fillBands(h), [0]);
    assert.deepEqual(legendCounts(h.layer), [1, 0, 0, 0]);
    // A successful refresh moves both to orange.
    fail = false;
    assert.equal(await h.layer.update(h.viewer), true);
    assert.deepEqual(fillBands(h), [1]);
    assert.deepEqual(legendCounts(h.layer), [0, 1, 0, 0]);
  } finally {
    Date.now = realNow;
  }
});

test('a refresh the host cancelled through refreshLayer publishes nothing', async (t) => {
  const ringAt = (lon) => [
    [lon, 35.2],
    [lon + 0.1, 35.2],
    [lon + 0.1, 35.3],
    [lon, 35.2],
  ];
  const snapshotAt = (revision, lon) =>
    snap([{ ...fire, anchor: { lon: lon + 0.05, lat: 35.25 } }], {
      revision,
      pieces: [pieceOf(fire.id, { rings: [ringAt(lon)] })],
    });
  let next = async () => snapshotAt('S', -108);
  const seen = [];
  const h = harness(
    {
      getSnapshot: (options) => {
        seen.push(options.signal);
        return next(options);
      },
    },
    { init: false },
  );
  const manager = new LayerLifecycle(h.viewer);
  manager.register(h.layer);
  let releaseA;
  t.after(async () => {
    releaseA?.();
    await manager.destroyAll();
  });
  assert.equal(await manager.setEnabled(h.layer.id, true), true);
  const firstLon = () =>
    h.fills().items.get(`fire-perimeter:${fire.id}:0`).geometry.rings[0][0].lon;
  assert.equal(firstLon(), -108);

  next = () =>
    new Promise((resolve) => {
      releaseA = () => resolve(snapshotAt('A', -100));
    });
  const host = new AbortController();
  const refreshA = manager.refreshLayer(h.layer.id, { signal: host.signal });
  await tick();
  host.abort();
  await tick();
  assert.equal(seen.at(-1).aborted, true, 'the source hears the host abort');

  next = async () => {
    throw new Error('B failed');
  };
  const refreshB = manager.refreshLayer(h.layer.id);
  releaseA?.();
  assert.equal(await refreshA, false);
  assert.equal(firstLon(), -108, 'cancelled A is never drawn');
  assert.equal(await refreshB, false);
  assert.equal(firstLon(), -108, 'S stays after B fails');
});

const pine = {
  ...fire,
  name: 'Pine',
  discoveredTime: Date.UTC(2024, 6, 1),
  updatedTime: Date.UTC(2024, 6, 2),
  lastGrowthTime: Date.UTC(2024, 6, 2),
};
const pineIndex = [
  { incident_id: '101', tau: 'NMGNF', incident_title: 'Pine Fire' },
  { incident_id: '202', tau: 'NMGNF', incident_title: '2026 Pine' },
];

// Pine, US-NM, discovered 2024-07-01. The InciWeb catalog holds two Pine
// pages in NM: 101 (began 2024) and 202 (began 2026).
test('a historical card links the same-name page of its own fire, whatever the snapshot time', async () => {
  let at = Date.UTC(2024, 6, 3);
  const asked = [];
  const h = harness(
    { getSnapshot: async () => snap([pine], { at }) },
    {
      pick: () => perimeterPick(`fire-perimeter:${fire.id}:0`),
      inciwebIndex: pineIndex,
      publication: async (id) => {
        asked.push(id);
        return id === '202'
          ? {
              createdMs: Date.UTC(2026, 6, 1),
              changedMs: Date.UTC(2026, 6, 5),
            }
          : {
              createdMs: Date.UTC(2024, 6, 1),
              changedMs: Date.UTC(2024, 7, 1),
            };
      },
    },
  );
  assert.equal(await h.layer.update(), true);
  await tick();
  h.clicks.handler({ position: { x: 10, y: 10 } });
  await tick();
  await tick();
  const [card] = h.overlay.entries.get('fire-perimeters');
  card.activate();
  assert.deepEqual(h.opened, ['https://inciweb.wildfire.gov/node/101']);
  assert.deepEqual(asked, ['202', '101']);
  at = Date.UTC(2026, 6, 6);
  assert.equal(await h.layer.update(), true);
  const [laterCard] = h.overlay.entries.get('fire-perimeters');
  laterCard.activate();
  assert.deepEqual(h.opened, [
    'https://inciweb.wildfire.gov/node/101',
    'https://inciweb.wildfire.gov/node/101',
  ]);
  assert.deepEqual(
    asked,
    ['202', '101'],
    'changing the snapshot time reuses the publications',
  );
  h.layer.destroy();
});

async function selectPerimeter(h) {
  h.clicks.handler({ position: { x: 10, y: 10 } });
  await tick();
  await tick();
  return h.overlay.entries.get('fire-perimeters')[0];
}

const currentPinePage = {
  createdMs: Date.UTC(2024, 6, 1),
  changedMs: Date.UTC(2024, 7, 1),
};

test('a historical card moves past a page that fails to load, and retries it on a new selection', async () => {
  const at = Date.UTC(2024, 6, 3);
  const asked = [];
  const h = harness(
    { getSnapshot: async () => snap([pine], { at }) },
    {
      pick: () => perimeterPick(`fire-perimeter:${pine.id}:0`),
      inciwebIndex: pineIndex,
      publication: async (id) => {
        asked.push(id);
        if (id === '202') throw new Error('InciWeb HTTP 502');
        return currentPinePage;
      },
    },
  );
  await h.layer.update();
  await tick();
  const card = await selectPerimeter(h);
  assert.deepEqual(asked, ['202', '101']);
  card.activate();
  const url = 'https://inciweb.wildfire.gov/node/101';
  assert.deepEqual(h.opened, [url]);

  await h.layer.update();
  assert.deepEqual(asked, ['202', '101']);
  h.overlay.entries.get('fire-perimeters')[0].activate();
  assert.deepEqual(h.opened, [url, url]);

  const reselected = await selectPerimeter(h);
  assert.deepEqual(asked, ['202', '101', '202']);
  reselected.activate();
  assert.deepEqual(h.opened, [url, url, url]);
  h.layer.destroy();
});

test('a verified page keeps its link when another same-name page fails to load', async () => {
  const at = Date.UTC(2024, 6, 3);
  const asked = [];
  const h = harness(
    { getSnapshot: async () => snap([pine], { at }) },
    {
      pick: () => perimeterPick(`fire-perimeter:${pine.id}:0`),
      inciwebIndex: pineIndex,
      publication: async (id) => {
        asked.push(id);
        if (id === '101') throw new Error('InciWeb HTTP 502');
        return currentPinePage;
      },
    },
  );
  await h.layer.update();
  await tick();
  const card = await selectPerimeter(h);
  assert.deepEqual(asked, ['202', '101']);
  card.activate();
  assert.deepEqual(h.opened, ['https://inciweb.wildfire.gov/node/202']);
  h.layer.destroy();
});

test('a live card retries a page that failed to load on the next read', async () => {
  let attempts = 0;
  const h = harness(
    { getSnapshot: async () => snap([fire]) },
    {
      pick: () => perimeterPick(`fire-perimeter:${fire.id}:0`),
      inciwebIndex: [
        {
          incident_id: '100',
          tau: 'NMGNF Fixture Fire',
          incident_title: 'Fixture Fire',
        },
      ],
      publication: async () => {
        if (++attempts === 1) throw new Error('InciWeb HTTP 503');
        return { createdMs: fire.discoveredTime, changedMs: fire.updatedTime };
      },
    },
  );
  await h.layer.update();
  await tick();
  const card = await selectPerimeter(h);
  assert.equal(attempts, 1);
  assert.equal(
    card.details.some((line) => line.includes('InciWeb')),
    false,
  );
  assert.equal(card.interactive, false);

  await h.layer.update();
  await tick();
  const [updated] = h.overlay.entries.get('fire-perimeters');
  assert.equal(attempts, 2);
  assert.equal(updated.details.at(-1), 'InciWeb ↗ · click card to open');
  updated.activate();
  assert.deepEqual(h.opened, ['https://inciweb.wildfire.gov/node/100']);
  h.layer.destroy();
});

test('a historical card checks its complex page when every own-name page is of another season', async () => {
  const at = Date.UTC(2024, 6, 3);
  const member = { ...pine, complexName: 'BIG COMPLEX' };
  const complexPage = {
    createdMs: Date.UTC(2024, 5, 30),
    changedMs: Date.UTC(2024, 7, 1),
  };
  const laterPinePage = {
    createdMs: Date.UTC(2026, 6, 1),
    changedMs: Date.UTC(2026, 6, 5),
  };
  for (const [ownPage, expectedRequests, linkedId] of [
    [laterPinePage, ['202', '303'], '303'],
    [currentPinePage, ['202'], '202'],
  ]) {
    const asked = [];
    const h = harness(
      { getSnapshot: async () => snap([member], { at }) },
      {
        pick: () => perimeterPick(`fire-perimeter:${member.id}:0`),
        inciwebIndex: [
          { incident_id: '202', tau: 'NMGNF', incident_title: '2026 Pine' },
          { incident_id: '303', tau: 'NMGNF', incident_title: 'Big Complex' },
        ],
        publication: async (id) => {
          asked.push(id);
          return id === '202' ? ownPage : complexPage;
        },
      },
    );
    await h.layer.update();
    await tick();
    const card = await selectPerimeter(h);
    assert.deepEqual(asked, expectedRequests);
    card.activate();
    assert.deepEqual(h.opened, [
      `https://inciweb.wildfire.gov/node/${linkedId}`,
    ]);
    h.layer.destroy();
  }
});
