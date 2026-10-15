import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import { acquireImageryComparison } from '../../maps/imageryComparison.js';
import { MapSourceController } from '../../maps/controller.js';
import { createDefaultMapSources } from '../../maps/defaultSources.js';
import { resetPointerOwnership } from '../../data/inputOwnership.js';
import { initImageryBoxTool } from '../../ui/imageryBoxTool.js';
import {
  FOCUS_DEBOUNCE_MS,
  MODES,
  SPLIT_PUBLISH_MS,
  createRecentImageryLayer,
} from './index.js';
import {
  BOX,
  CANDIDATES,
  boxToolFakes,
  candidate,
  fakeCatalog,
  fakeController,
  fakeRenderer,
  fakeThumbnails,
  manualTimers,
  settle,
} from './testDoubles.mjs';

const NOW = new Date('2026-09-21T15:00:00Z');
const LINK_BOX = {
  west: -9780000,
  south: 3020000,
  east: -9770000,
  north: 3030000,
};
const S18 = 'S30:2026-09-18';
const L16 = 'L30:2026-09-16';
const V21 = 'VIIRS:2026-09-21';
const V15 = 'VIIRS:2026-09-15';

/**
 * A photoreal map controller with the real lease (`acquireImageryComparison`):
 * one owner, an asynchronous stack switch and a restore on release. `stuck`
 * never leaves photoreal, so the lease fails. With `subscribable`, every
 * settled switch notifies its subscribers, as `MapSourceController` does,
 * after `onSettled(id)` has moved the host.
 */
function leasingController({ stuck = false, subscribable = false } = {}) {
  const subscribers = new Set();
  const controller = {
    calls: [],
    acquisitions: 0,
    _activeId: 'photoreal',
    _generation: 0,
    onSettled: null,
    getActiveId() {
      return this._activeId;
    },
    getSwitchGeneration() {
      return this._generation;
    },
    async setStack(id) {
      this.calls.push(['setStack', id]);
      const generation = ++this._generation;
      await settle();
      if (generation !== this._generation) return { status: 'superseded' };
      if (!stuck) this._activeId = id;
      this.onSettled?.(this._activeId);
      for (const listener of [...subscribers]) listener();
      return { status: 'ready', activeId: this._activeId };
    },
    acquireImageryComparison(options) {
      this.acquisitions += 1;
      return acquireImageryComparison(this, options);
    },
  };
  /** Tell every subscriber the (unchanged) switch settled again. */
  controller.notify = () => {
    for (const listener of [...subscribers]) listener();
  };
  if (subscribable)
    controller.subscribe = (listener) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    };
  return controller;
}

/** The layer manager's publish hook, recording what the layer adopts. */
function fakeDataManager(layerRef) {
  const adopted = [];
  return {
    adopted,
    adoptLayerParams(id, params, options) {
      const live = layerRef.layer.getParams();
      assert.ok(
        Object.entries(params).every(([key, value]) =>
          Object.is(live[key], value),
        ),
        'adopted params match the live params',
      );
      adopted.push([id, params, options.origin]);
      return true;
    },
  };
}

/**
 * The daily overview is off on a first run; the fixture turns it on so the
 * strip holds all four candidates unless told otherwise.
 */
function fixture({
  hostKind = 'globe',
  controller = fakeController(),
  viirs = true,
} = {}) {
  const renderer = fakeRenderer();
  const thumbnails = fakeThumbnails();
  const catalog = fakeCatalog();
  const timers = manualTimers();
  const hostState = { kind: hostKind };
  const collections = { none: null, globe: {}, tileset: {} };
  const layer = createRecentImageryLayer({
    catalog,
    renderer,
    thumbnails,
    host: () => ({
      collection: collections[hostState.kind],
      kind: hostState.kind,
    }),
    now: () => NOW,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  if (viirs) layer.setSources({ viirs: true });
  const viewer = { camera: {} };
  const reasons = [];
  layer.subscribe((snapshot, reason) => reasons.push(reason));
  layer.init(viewer);
  if (controller) layer.attachMapStackController(controller);
  const dataManager = fakeDataManager({ layer });
  layer.attachDataManager(dataManager);
  const toolCalls = [];
  layer.setToolHandler(() => toolCalls.push('cancel'));
  /** Enable, select BOX and land the catalog. */
  const ready = async (candidates) => {
    layer.enable();
    layer.setBox(BOX);
    catalog.resolveLast(candidates);
    await settle();
  };
  const owned = () => renderer.getOwned();
  /** Slot keys and split directions, compactly. */
  const drapes = () => {
    const o = renderer.getOwned();
    return {
      a: o.a && `${o.a.key}|${o.a.splitDirection}`,
      b: o.b && `${o.b.key}|${o.b.splitDirection}`,
    };
  };
  return {
    layer,
    renderer,
    thumbnails,
    catalog,
    controller,
    dataManager,
    hostState,
    viewer,
    reasons,
    timers,
    toolCalls,
    ready,
    owned,
    drapes,
    snap: () => layer.getSnapshot(),
    diag: () => layer.diagnostics(),
  };
}

const settleTimes = async (count = 4) => {
  for (let i = 0; i < count; i += 1) await settle();
};

test('a refused box is loud, says its size and persists until a box succeeds; so does a tool refusal', async () => {
  const f = fixture();
  f.layer.enable();
  assert.equal(
    f.layer.setBox({ west: 0, south: 0, east: 20, north: 20 }),
    false,
  );
  assert.match(f.snap().boxError, /^Box is 2,226 km wide · limit 1,000 km$/);
  assert.equal(f.snap().error, null, 'a box refusal is not a layer error');
  assert.equal(f.catalog.searches.length, 0);
  assert.equal(
    f.layer.reportBoxRefusal('Select one side of the dateline'),
    true,
  );
  assert.equal(f.layer.reportBoxRefusal(''), false);
  f.layer.setSources({ viirs: false });
  assert.equal(f.snap().boxError, 'Select one side of the dateline');
  // A share-link box spanning the world is refused too, not read as a sliver.
  f.layer.setParams({
    west: -18000000,
    south: -8000000,
    east: 18000000,
    north: 8000000,
  });
  assert.match(f.snap().boxError, /^Box is [\d,]+ km wide/);
  assert.equal(f.snap().box, null);
  assert.equal(f.layer.setBox(BOX), true);
  assert.equal(f.snap().boxError, null);
});

test('a valid box searches and previews the START HERE day alone in IMAGE mode', async () => {
  const f = fixture();
  f.layer.enable();
  f.layer.setBox(BOX);
  assert.equal(f.snap().searching, true);
  assert.equal(f.catalog.searches[0].request.days, 30);
  f.catalog.resolveLast();
  await settle();
  const snapshot = f.snap();
  assert.equal(snapshot.searching, false);
  assert.equal(snapshot.mode, 'image');
  assert.equal(snapshot.candidates.length, 4);
  assert.deepEqual(snapshot.auto, { key: S18, reason: 'clear', certain: true });
  assert.deepEqual(snapshot.recommended, { key: S18, reason: 'clear' });
  assert.equal(snapshot.focus.key, S18, 'focus starts on it');
  assert.equal(snapshot.preview.key, S18);
  assert.equal(snapshot.preview.slot, 'a');
  assert.equal(snapshot.preview.label, 'Sep 18 · Sentinel-2 · 30 m');
  assert.equal(snapshot.candidates[1].preview, true);
  const none = {
    key: null,
    candidate: null,
    label: null,
    sourceOff: false,
    drapable: false,
  };
  assert.deepEqual(snapshot.pins, { a: none, b: none });
  assert.deepEqual(snapshot.shown, { a: S18, b: null, swipe: 'none' });
  assert.deepEqual(f.drapes(), { a: `${S18}|none`, b: null });
  assert.equal(f.layer.getStats().count, 4);
  assert.ok(
    f.thumbnails.calls.some((c) => c[0] === 'ordered' && c[1].length === 4),
  );
  assert.deepEqual(
    f.dataManager.adopted.map(([, params]) => Object.keys(params)),
    [['west', 'south', 'east', 'north']],
    'the chosen box is published',
  );
  // The same box again is a no-op; a new box aborts the running search.
  f.layer.setBox(BOX);
  assert.equal(f.catalog.searches.length, 1);
  f.layer.setBox({ ...BOX, east: -97.6 });
  f.layer.setBox({ ...BOX, east: -97.5 });
  assert.equal(f.catalog.searches[1].request.signal.aborted, true);
  f.catalog.resolveLast();
  await settle();
  assert.equal(f.snap().preview.key, S18);
});

test('the focused day is the enriched strip entry, never the raw catalog candidate', async () => {
  const f = fixture();
  await f.ready();
  f.thumbnails.setStatus(S18, 'present');
  let { focus, candidates, focusIndex } = f.snap();
  assert.equal(focus.preview, true);
  assert.equal(focus.pinned, null);
  assert.equal(focus.drapable, true);
  assert.equal(focus.thumbnail.status, 'present');
  assert.deepEqual(focus, candidates[focusIndex]);
  f.layer.setMode('ab');
  f.layer.setAssignment('a', S18);
  f.layer.setAssignment('b', L16);
  f.layer.focus(1);
  ({ focus } = f.snap());
  assert.equal(focus.key, S18);
  assert.equal(focus.pinned, 'a');
  assert.equal(f.snap().candidates[2].pinned, 'b');
});

test('a catalog of partial-coverage days still yields a START HERE day, labelled partial', async () => {
  const f = fixture();
  await f.ready(
    CANDIDATES.map((c) =>
      c.product === 'VIIRS' ? c : { ...c, coverage: 'partial' },
    ),
  );
  assert.equal(f.snap().auto.reason, 'partial');
  assert.deepEqual(f.snap().recommended, { key: S18, reason: 'partial' });
});

test('IMAGE: SHOW pins a day, focus stops moving the map, a second SHOW moves the pin and unpinning drops the layer at once', async () => {
  const f = fixture();
  await f.ready();
  assert.equal(f.layer.toggleAssignment('a', L16), true);
  assert.equal(f.snap().pins.a.key, L16);
  assert.equal(f.snap().preview.key, null, 'the preview gives way');
  assert.deepEqual(f.drapes(), { a: `${L16}|none`, b: null });
  assert.equal(f.snap().focus.key, L16, 'focus follows the pin');
  // Focus no longer changes the map.
  f.thumbnails.setStatus(V15, 'present');
  f.layer.focus(3);
  assert.equal(f.timers.armed(), 0);
  assert.equal(f.layer.preview(V15), false, 'a click only focuses');
  assert.equal(f.snap().focus.key, V15);
  assert.deepEqual(f.drapes(), { a: `${L16}|none`, b: null });
  // SHOW on another day moves the pin.
  f.layer.toggleAssignment('a', S18);
  assert.deepEqual(f.drapes(), { a: `${S18}|none`, b: null });
  // SHOW again unpins; nothing replaces it until focus moves.
  assert.equal(f.layer.toggleAssignment('a', S18), true);
  assert.equal(f.snap().pins.a.key, null);
  assert.equal(f.renderer.ownedCount(), 0);
  f.layer.focus(2);
  f.timers.flush();
  assert.deepEqual(f.drapes(), { a: `${L16}|none`, b: null });
  assert.equal(f.snap().preview.key, L16);
  assert.deepEqual(
    f.dataManager.adopted.slice(1).map(([, params]) => params),
    [
      { a: L16, b: null },
      { a: S18, b: null },
      { a: null, b: null },
    ],
  );
  // Unknown, empty or off-source days cannot be pinned.
  assert.equal(f.layer.setAssignment('a', 'nope'), false);
  f.thumbnails.probe(V21, 'empty');
  assert.equal(f.layer.setAssignment('a', V21), false);
  assert.equal(f.layer.setAssignment('c', S18), false);
});

test('VS BASEMAP: the day swipes on the left with no second layer; the preview swipes too; the lease borrows Esri', async () => {
  const controller = leasingController();
  const f = fixture({ controller });
  await f.ready();
  await settleTimes();
  assert.equal(controller.getActiveId(), 'esri-imagery', 'a preview borrows');
  assert.equal(f.snap().borrowedEsri, true);
  assert.equal(f.layer.setMode('basemap'), true);
  assert.equal(f.layer.setMode('basemap'), false);
  assert.equal(f.snap().mode, 'basemap');
  assert.deepEqual(f.snap().shown, { a: S18, b: null, swipe: 'basemap' });
  assert.equal(f.snap().comparison.active, true);
  assert.deepEqual(f.drapes(), { a: `${S18}|left`, b: null });
  f.layer.setAssignment('a', L16);
  assert.deepEqual(f.drapes(), { a: `${L16}|left`, b: null });
  assert.equal(f.renderer.ownedCount(), 1);
  assert.deepEqual(f.dataManager.adopted.at(-2)[1], { mode: 1 });
  // Back to IMAGE: the same pin, no divider.
  f.layer.setMode('image');
  assert.deepEqual(f.drapes(), { a: `${L16}|none`, b: null });
  assert.equal(f.snap().comparison.active, false);
  assert.deepEqual(MODES, ['image', 'basemap', 'ab']);
});

test('A / B: A pins, the focused day previews as B against it, B pins, and a day is in one slot only', async () => {
  const f = fixture();
  await f.ready();
  f.controller.lease.settle();
  await settle();
  f.layer.setMode('ab');
  assert.deepEqual(
    f.drapes(),
    { a: `${S18}|none`, b: null },
    'the preview fills A',
  );
  f.layer.setAssignment('a', S18);
  assert.deepEqual(f.drapes(), { a: `${S18}|none`, b: null });
  assert.equal(f.snap().preview.key, null);
  // The next focus previews in B, behind the swipe.
  f.layer.focus(2);
  f.timers.flush();
  assert.equal(f.snap().preview.slot, 'b');
  assert.deepEqual(f.drapes(), { a: `${S18}|left`, b: `${L16}|right` });
  assert.equal(f.snap().comparison.active, true);
  // Focus back on A's own card takes the B preview off.
  f.layer.focus(1);
  f.timers.flush();
  assert.deepEqual(f.drapes(), { a: `${S18}|none`, b: null });
  f.layer.setAssignment('b', L16);
  assert.deepEqual(f.drapes(), { a: `${S18}|left`, b: `${L16}|right` });
  // Pinning B's day as A moves it: A is L16, B is empty again.
  f.layer.setAssignment('a', L16);
  assert.deepEqual([f.snap().pins.a.key, f.snap().pins.b.key], [L16, null]);
  assert.deepEqual(f.drapes(), { a: `${L16}|none`, b: null });
  f.layer.setAssignment('b', S18);
  // B alone is a single image.
  f.layer.setAssignment('a', null);
  assert.deepEqual(f.drapes(), { a: null, b: `${S18}|none` });
  // Pins survive a mode switch; B only drapes in A / B.
  f.layer.setAssignment('a', L16);
  f.layer.setMode('image');
  assert.deepEqual(f.drapes(), { a: `${L16}|none`, b: null });
  f.layer.setMode('ab');
  assert.deepEqual(f.drapes(), { a: `${L16}|left`, b: `${S18}|right` });
  assert.ok(f.renderer.peak() <= 2, 'never more than two layers');
});

test('the divider recentres on every new comparison but not while scrubbing the second day', async () => {
  const f = fixture();
  await f.ready();
  f.controller.lease.settle();
  await settle();
  f.layer.setMode('ab');
  f.layer.setAssignment('a', S18);
  f.layer.setAssignment('b', L16);
  f.layer.setSplit(0.8);
  assert.equal(f.timers.armed(), 1, 'split publish is debounced');
  assert.equal([...f.timers.pending.values()][0].ms, SPLIT_PUBLISH_MS);
  f.timers.flush();
  assert.deepEqual(f.dataManager.adopted.at(-1)[1], { split: 80 });
  f.layer.setAssignment('b', null);
  assert.equal(f.snap().split, 0.8, 'one image keeps the last framing');
  f.layer.preview(L16);
  assert.equal(f.snap().shown.swipe, 'ab');
  assert.equal(f.snap().split, 0.5, 'a new comparison starts centred');
  f.layer.setSplit(0.3);
  f.thumbnails.setStatus(V15, 'present');
  f.layer.focus(3);
  f.timers.flush();
  assert.equal(f.snap().shown.b, V15);
  assert.equal(f.snap().split, 0.3, 'scrubbing B keeps the divider');
  f.layer.setMode('basemap');
  assert.equal(f.snap().split, 0.5, 'a new kind of comparison recentres');
});

test('SWAP trades the sides of a live divider, again restores, never publishes and resets on a new comparison or CLEAR', async () => {
  const f = fixture();
  await f.ready();
  f.controller.lease.settle();
  await settle();
  const directions = () => [
    f.owned().a?.splitDirection,
    f.owned().b?.splitDirection,
  ];
  // IMAGE mode: no swipe, nothing to swap.
  assert.equal(f.layer.swapSides(), false);
  assert.equal(f.snap().swapped, false);
  // VS BASEMAP: the image moves to the right half, the basemap shows left.
  f.layer.setMode('basemap');
  assert.deepEqual(directions(), ['left', undefined]);
  assert.equal(f.layer.swapSides(), true);
  assert.equal(f.snap().swapped, true);
  assert.deepEqual(directions(), ['right', undefined]);
  assert.equal(f.layer.swapSides(), true);
  assert.deepEqual(directions(), ['left', undefined]);
  // A / B: A moves right and B left; the divider position stays.
  f.layer.setMode('ab');
  f.layer.setAssignment('a', S18);
  f.layer.setAssignment('b', L16);
  f.layer.setSplit(0.3);
  const adopted = f.dataManager.adopted.length;
  f.layer.swapSides();
  assert.deepEqual(directions(), ['right', 'left']);
  assert.equal(f.snap().split, 0.3);
  assert.equal(f.dataManager.adopted.length, adopted, 'nothing published');
  assert.equal('swapped' in f.layer.getParams(), false, 'not in the link');
  // Unpinning B ends the comparison; the next one starts unswapped.
  f.layer.setAssignment('b', null);
  f.layer.preview(L16);
  assert.equal(f.snap().shown.swipe, 'ab');
  assert.equal(f.snap().swapped, false, 'a new comparison is unswapped');
  assert.deepEqual(directions(), ['left', 'right']);
  f.layer.swapSides();
  f.layer.clear();
  assert.equal(f.snap().swapped, false, 'CLEAR resets it');
});

test('any image on the map holds the Esri lease; the last image cleared hands Google 3D back', async () => {
  const controller = leasingController();
  const f = fixture({ controller });
  await f.ready();
  await settleTimes();
  assert.deepEqual(controller.calls, [['setStack', 'esri-imagery']]);
  f.layer.setAssignment('a', S18);
  f.layer.clearPreview();
  await settleTimes();
  assert.equal(controller.getActiveId(), 'esri-imagery', 'still showing A');
  f.layer.setAssignment('a', null);
  assert.equal(f.renderer.ownedCount(), 0);
  await settleTimes();
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(f.snap().borrowedEsri, false);
  // A new image borrows again; disable hands it back.
  f.layer.preview(L16);
  await settleTimes();
  assert.equal(controller.getActiveId(), 'esri-imagery');
  f.layer.disable();
  await settleTimes();
  assert.equal(controller.getActiveId(), 'photoreal');
});

test('a refused lease is guidance and the images still drape without a swipe', async () => {
  const f = fixture({ controller: fakeController({ refuse: true }) });
  await f.ready();
  f.layer.setMode('basemap');
  assert.equal(f.snap().error, 'Comparison in use by another scene');
  assert.deepEqual(f.drapes(), { a: `${S18}|none`, b: null });
  f.layer.clearPreview();
  assert.equal(f.snap().error, null, 'nothing shown, nothing refused');
});

test('a lease that cannot reach the Esri map never shows the divider and says why', async () => {
  const f = fixture({ controller: leasingController({ stuck: true }) });
  await f.ready();
  f.layer.setMode('basemap');
  await settleTimes();
  assert.equal(f.snap().comparison.active, false);
  assert.equal(f.snap().error, 'Esri map unavailable · no swipe');
  assert.equal(f.owned().a.splitDirection, 'none');
});

test('unpin then pin before the release settles recovers the lease', async () => {
  const controller = leasingController();
  const f = fixture({ controller });
  await f.ready();
  f.layer.setMode('basemap');
  f.layer.setAssignment('a', S18);
  await settleTimes();
  assert.equal(controller.getActiveId(), 'esri-imagery');
  f.layer.setAssignment('a', null);
  assert.equal(f.diag().releasing, true);
  f.layer.setAssignment('a', L16);
  assert.equal(f.diag().lease, false, 'no lease while releasing');
  await settleTimes(8);
  assert.equal(f.diag().lease, true);
  assert.equal(f.snap().comparison.active, true);
  assert.equal(controller.getActiveId(), 'esri-imagery');
});

/**
 * A / B on Esri from Google 3D, with the host following the active stack:
 * Google 3D hides the globe (tileset host), every other stack is a globe.
 */
async function comparingOnEsri() {
  const controller = leasingController({ subscribable: true });
  const f = fixture({ controller, hostKind: 'tileset' });
  controller.onSettled = (id) => {
    f.hostState.kind = id === 'photoreal' ? 'tileset' : 'globe';
  };
  await f.ready();
  f.layer.setMode('ab');
  f.layer.setAssignment('a', S18);
  f.layer.setAssignment('b', L16);
  await settleTimes(8);
  assert.equal(controller.getActiveId(), 'esri-imagery');
  assert.equal(f.snap().comparison.active, true);
  assert.deepEqual(controller.calls, [['setStack', 'esri-imagery']]);
  return { controller, f };
}

test('a manual switch to Google 3D while a day is shown takes Esri back once and the divider stays', async () => {
  const { controller, f } = await comparingOnEsri();
  // The operator picks Google 3D by hand: the layer re-leases Esri at once.
  await controller.setStack('photoreal');
  await settleTimes(8);
  assert.deepEqual(controller.calls, [
    ['setStack', 'esri-imagery'],
    ['setStack', 'photoreal'],
    ['setStack', 'esri-imagery'],
  ]);
  assert.equal(controller.getActiveId(), 'esri-imagery');
  assert.equal(f.snap().shown.swipe, 'ab');
  assert.equal(f.snap().comparison.active, true);
  assert.equal(f.snap().comparison.suspended, false);
  assert.deepEqual(f.drapes(), { a: `${S18}|left`, b: `${L16}|right` });
  assert.equal(
    f.snap().notice,
    'Imagery stays on Esri · CLEAR to use Google 3D',
  );
  assert.equal(f.snap().error, null);
  // Once per switch generation: a repeated notification is not a new
  // switch, and the re-lease's own switch landing on Google 3D (a fallback)
  // is not the operator's.
  controller.notify();
  controller._activeId = 'photoreal';
  controller.notify();
  await settleTimes(8);
  assert.equal(controller.calls.length, 3, 'no second re-lease');
  controller._activeId = 'esri-imagery';
  controller.notify();
  // Globe stacks just rebind: Esri → OSM keeps the swipe and switches nothing.
  await controller.setStack('osm');
  await settleTimes(8);
  assert.equal(controller.calls.length, 4);
  assert.equal(controller.getActiveId(), 'osm');
  assert.equal(f.snap().comparison.active, true);
  assert.deepEqual(f.drapes(), { a: `${S18}|left`, b: `${L16}|right` });
});

test('CLEAR after a re-lease hands Google 3D back and does not take Esri again', async () => {
  const { controller, f } = await comparingOnEsri();
  await controller.setStack('photoreal');
  await settleTimes(8);
  assert.equal(controller.getActiveId(), 'esri-imagery');
  const acquisitions = controller.acquisitions;
  f.layer.clear();
  await settleTimes(8);
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.deepEqual(controller.calls.at(-1), ['setStack', 'photoreal']);
  assert.equal(controller.calls.length, 4);
  assert.equal(controller.acquisitions, acquisitions, 'no new lease');
  assert.equal(f.diag().lease, false);
  assert.equal(f.snap().notice, 'Box and images cleared');
});

test('disable after a re-lease hands Google 3D back and does not take Esri again', async () => {
  const { controller, f } = await comparingOnEsri();
  await controller.setStack('photoreal');
  await settleTimes(8);
  const acquisitions = controller.acquisitions;
  f.layer.disable();
  await settleTimes(8);
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(controller.calls.length, 4);
  assert.equal(controller.acquisitions, acquisitions);
  assert.equal(f.diag().lease, false);
});

test('a re-lease refused by another owner says so, drapes without a swipe and does not loop', async () => {
  const { controller, f } = await comparingOnEsri();
  const acquire = controller.acquireImageryComparison;
  controller.acquireImageryComparison = function () {
    this.acquisitions += 1;
    throw new Error('Imagery comparison is already held by nepal');
  };
  await controller.setStack('photoreal');
  await settleTimes(8);
  assert.equal(controller.acquisitions, 2, 'one attempt');
  assert.equal(f.snap().error, 'Comparison in use by another scene');
  assert.notEqual(
    f.snap().notice,
    'Imagery stays on Esri · CLEAR to use Google 3D',
  );
  assert.equal(f.snap().comparison.active, false);
  assert.equal(f.owned().a.kind, 'tileset');
  assert.equal(f.owned().a.splitDirection, 'none');
  // More notifications and renders never try again.
  controller.notify();
  controller.notify();
  f.layer.setAlpha(0.5);
  f.layer.setMode('basemap');
  f.layer.setMode('ab');
  await settleTimes(8);
  assert.equal(controller.acquisitions, 2);
  assert.deepEqual(controller.calls.at(-1), ['setStack', 'photoreal']);
  controller.acquireImageryComparison = acquire;
});

test('without a lease (another owner held it first) a switch to Google 3D takes nothing', async () => {
  const controller = leasingController({ subscribable: true });
  const nepal = acquireImageryComparison(controller, { owner: 'nepal' });
  await nepal.ready;
  controller.calls.length = 0;
  const f = fixture({ controller, hostKind: 'tileset' });
  await f.ready();
  f.layer.setMode('basemap');
  assert.equal(f.snap().error, 'Comparison in use by another scene');
  await controller.setStack('photoreal');
  await settleTimes(8);
  assert.deepEqual(controller.calls, [['setStack', 'photoreal']]);
  assert.equal(f.snap().error, 'Comparison in use by another scene');
});

/**
 * The real `MapSourceController` on Google 3D over the default sources, with
 * Esri tiles that can fail after it activated (`failEsriTiles`) and an OSM
 * map that never activates, so a tile fallback recovers to Google 3D.
 * Every `setStack` (the layer's, the operator's, the fallback's) is
 * recorded in `calls`.
 */
function failingMapController() {
  const listeners = new Set();
  const esriErrors = {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const registry = createDefaultMapSources({ googleTileset: { show: true } });
  for (const source of registry.sources) {
    if (!source.imagery) continue;
    const id = source.descriptor.id;
    source.imagery =
      id === 'osm'
        ? async () => {
            throw new Error('OSM offline');
          }
        : async () => ({
            id,
            errorEvent:
              id === 'esri-imagery' ? esriErrors : { addEventListener() {} },
          });
    source.terrain = {
      id: 'keyless',
      create: async () => ({ provider: { id: 'terrain' } }),
    };
  }
  const viewer = {
    scene: {
      globe: { show: false },
      requestRender() {},
      frameState: {
        creditDisplay: {
          addStaticCredit() {},
          removeStaticCredit() {},
        },
      },
      primitives: { add() {}, remove() {} },
    },
    imageryLayers: { add() {}, remove() {} },
  };
  const controller = new MapSourceController(viewer, {
    registry,
    initialStack: 'photoreal',
    createImageryLayer: (provider) => ({ provider }),
    onError: () => {},
  });
  const calls = [];
  const setStack = controller.setStack.bind(controller);
  controller.setStack = (id, options) => {
    calls.push(id);
    return setStack(id, options);
  };
  const failEsriTiles = () => {
    for (const fn of [...listeners]) fn({});
    for (const fn of [...listeners]) fn({});
  };
  return { controller, calls, failEsriTiles };
}

for (const path of ['subscription', 'stats poll']) {
  test(`an automatic fallback to Google 3D drops the swipe instead of re-leasing Esri; a manual switch re-leases once (${path})`, async () => {
    const { controller, calls, failEsriTiles } = failingMapController();
    // Without `subscribe` the layer watches the map from the stats poll.
    const attached =
      path === 'subscription'
        ? controller
        : {
            getActiveId: () => controller.getActiveId(),
            getSwitchGeneration: () => controller.getSwitchGeneration(),
            getSwitchOrigin: () => controller.getSwitchOrigin(),
            acquireImageryComparison: (options) =>
              controller.acquireImageryComparison(options),
          };
    const f = fixture({ controller: attached, hostKind: 'tileset' });
    Object.defineProperty(f.hostState, 'kind', {
      get: () =>
        controller.getActiveId() === 'photoreal' ? 'tileset' : 'globe',
    });
    const watch = async () => {
      await settleTimes(8);
      if (path === 'stats poll') f.layer.getStats();
      await settleTimes(8);
    };
    await f.ready();
    f.layer.setMode('ab');
    f.layer.setAssignment('a', S18);
    f.layer.setAssignment('b', L16);
    await watch();
    assert.equal(controller.getActiveId(), 'esri-imagery');
    assert.equal(f.snap().comparison.active, true);
    assert.deepEqual(calls, ['esri-imagery']);

    // Esri tiles fail: the controller falls back to OSM, OSM cannot
    // activate, and it recovers to Google 3D. Nobody chose Google 3D, so
    // the layer lets the lease go and shows both days without a swipe.
    failEsriTiles();
    await watch();
    assert.deepEqual(calls, ['esri-imagery', 'osm'], 'no Esri retry');
    assert.equal(controller.getActiveId(), 'photoreal');
    assert.equal(controller.getSwitchOrigin(), 'automatic');
    assert.equal(f.diag().lease, false);
    assert.equal(f.diag().host, 'tileset');
    assert.equal(f.snap().shown.swipe, 'ab');
    assert.equal(f.snap().comparison.active, false);
    assert.deepEqual(f.drapes(), { a: `${S18}|none`, b: `${L16}|none` });
    assert.equal(f.owned().a.kind, 'tileset');
    assert.equal(f.snap().error, 'Esri map unavailable · no swipe');
    assert.notEqual(
      f.snap().notice,
      'Imagery stays on Esri · CLEAR to use Google 3D',
    );
    // More polls, renders and dead Esri listeners never retry.
    failEsriTiles();
    f.layer.setAlpha(0.5);
    f.layer.setMode('basemap');
    f.layer.setMode('ab');
    await watch();
    assert.deepEqual(calls, ['esri-imagery', 'osm']);

    // The operator picks Google 3D by hand: that is answered once.
    await controller.setStack('photoreal');
    await watch();
    await watch();
    assert.deepEqual(calls, [
      'esri-imagery',
      'osm',
      'photoreal',
      'esri-imagery',
    ]);
    assert.equal(controller.getActiveId(), 'esri-imagery');
    assert.equal(f.diag().lease, true);
    assert.equal(f.snap().comparison.active, true);
    assert.deepEqual(f.drapes(), { a: `${S18}|left`, b: `${L16}|right` });
    assert.equal(
      f.snap().notice,
      'Imagery stays on Esri · CLEAR to use Google 3D',
    );
    assert.equal(f.snap().error, null);
    controller.destroy();
  });
}

test('without a host the drapes hide and say so; the stats poll rebinds when no subscription exists', async () => {
  const f = fixture({ hostKind: 'none' });
  await f.ready();
  assert.equal(f.renderer.ownedCount(), 0);
  assert.equal(f.layer.getStats().error, NO_IMAGERY_HOST);
  assert.equal(f.snap().error, NO_IMAGERY_HOST);
  f.hostState.kind = 'tileset';
  assert.equal(f.layer.getStats().error, null);
  assert.equal(f.owned().a.kind, 'tileset');
});

test('a controller subscription moves the drape to the new host on every settled switch', async () => {
  const listeners = new Set();
  const controller = {
    ...fakeController(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const f = fixture({ controller });
  await f.ready();
  f.hostState.kind = 'tileset';
  f.layer.getStats();
  assert.equal(
    f.owned().a.kind,
    'globe',
    'the poll defers to the subscription',
  );
  const before = f.reasons.length;
  for (const listener of listeners) listener();
  assert.equal(f.owned().a.kind, 'tileset');
  assert.equal(f.reasons.length, before + 1, 'the panel re-renders');
  f.hostState.kind = 'globe';
  for (const listener of listeners) listener();
  assert.equal(f.owned().a.kind, 'globe');
  const quiet = f.reasons.length;
  for (const listener of listeners) listener();
  assert.equal(f.reasons.length, quiet, 'a no-op switch is quiet');
  f.layer.destroy();
  assert.equal(listeners.size, 0);
});

test('a catalog failure is exposed and leaves nothing draped', async () => {
  const f = fixture();
  f.layer.enable();
  f.layer.setBox(BOX);
  f.catalog.searches[0].reject(new Error('CMR down'));
  await settle();
  assert.equal(f.snap().error, 'CMR down');
  assert.equal(f.snap().candidates.length, 0);
  assert.equal(f.renderer.ownedCount(), 0);
});

test('share links restore the box, both pins, the mode and a non-default split once, without publishing back', async () => {
  const f = fixture();
  f.layer.setParams({ split: 50 });
  assert.equal(f.diag().splitFromLink, false, 'a stored default is not a link');
  f.layer.setParams({
    ...LINK_BOX,
    a: S18,
    b: L16,
    mode: 2,
    split: 30,
  });
  assert.equal(f.diag().splitFromLink, true);
  f.layer.enable();
  f.catalog.resolveLast();
  await settle();
  f.controller.lease.settle();
  await settle();
  assert.equal(f.snap().mode, 'ab');
  assert.deepEqual(f.drapes(), { a: `${S18}|left`, b: `${L16}|right` });
  assert.equal(f.snap().auto, null, 'a restored pin is never auto');
  assert.equal(f.snap().focus.key, S18);
  assert.equal(f.snap().split, 0.3, 'the link framing is honoured');
  assert.equal(f.diag().splitFromLink, false, 'and consumed');
  assert.deepEqual(f.layer.getParams(), {
    ...LINK_BOX,
    a: S18,
    b: L16,
    mode: 2,
    split: 30,
    viirs: true,
  });
  assert.deepEqual(f.dataManager.adopted, [], 'a restore publishes nothing');
  // String modes and junk.
  f.layer.setParams({ mode: 'basemap' });
  assert.equal(f.snap().mode, 'basemap');
  f.layer.setParams({ mode: 7 });
  assert.equal(f.snap().mode, 'basemap');
  // A pin repeated in both slots keeps A.
  f.layer.setParams({ a: L16, b: L16, mode: 2 });
  assert.deepEqual([f.snap().pins.a.key, f.snap().pins.b.key], [L16, null]);
});

test('restored pins the catalog no longer lists are dropped and START HERE previews', async () => {
  const f = fixture();
  f.layer.setParams({ ...LINK_BOX, a: 'S30:2026-09-01', b: 'S30:2026-09-02' });
  f.layer.enable();
  f.catalog.resolveLast();
  await settle();
  assert.equal(f.snap().pins.a.key, null);
  assert.equal(f.snap().preview.key, S18);
  assert.equal(f.snap().auto.reason, 'clear');
});

test('the data-panel row carries only the two source chips', async () => {
  const f = fixture({ viirs: false });
  await f.ready();
  const { chips } = f.layer.getRowControls();
  assert.deepEqual(
    chips.map(({ id, label, active, params }) => [id, label, active, params]),
    [
      ['hls', 'MORE DETAIL · 30 m', true, { hls: false }],
      ['viirs', 'DAILY OVERVIEW · 250 m', false, { viirs: true }],
    ],
  );
  f.layer.setParams(chips[1].params);
  assert.equal(f.layer.getRowControls().chips[1].active, true);
  assert.equal(f.layer.getParams().viirs, true);
});

test('USE VIEW takes the camera rectangle and refuses a view over the cap instead of shrinking it', () => {
  const f = fixture();
  f.layer.enable();
  assert.equal(f.layer.useCurrentView(), false);
  assert.equal(
    f.snap().boxError,
    'Point the camera at the ground to use the view',
  );
  const rad = (deg) => (deg * Math.PI) / 180;
  const view = (west, south, east, north) => () => ({
    west: rad(west),
    south: rad(south),
    east: rad(east),
    north: rad(north),
  });
  f.viewer.camera.computeViewRectangle = view(-97.8, 30.2, -97.7, 30.3);
  assert.equal(f.layer.useCurrentView(), true);
  assert.ok(Math.abs(f.snap().box.west + 97.8) < 1e-9);
  f.viewer.camera.computeViewRectangle = view(-108, 20, -88, 40);
  assert.equal(f.layer.useCurrentView(), false);
  assert.match(f.snap().boxError, /^View is 2,2\d\d km wide · limit 1,000 km$/);
  assert.equal(f.catalog.searches.length, 1, 'nothing searched');
  assert.ok(Math.abs(f.snap().box.west + 97.8) < 1e-9, 'the box is kept');
});

test('ZOOM IN: an oversized box or view flies top-down to its centre at the height whose view is 400 km wide', () => {
  const f = fixture();
  const flights = [];
  const deg = (rad) => (rad * 180) / Math.PI;
  const rad = (value) => (value * Math.PI) / 180;
  // A 1000 × 500 canvas with a 60° horizontal FOV.
  const fovy = 2 * Math.atan(Math.tan(Math.PI / 6) / 2);
  const expected = 400_000 / (2 * Math.tan(Math.PI / 6));
  let centreHit = null;
  Object.assign(f.viewer, {
    scene: {
      canvas: { clientWidth: 1000, clientHeight: 500 },
      ellipsoid: {
        cartographicToCartesian: (c) => ({ ...c, cartesian: true }),
        cartesianToCartographic: (c) => c && { ...c },
      },
    },
  });
  Object.assign(f.viewer.camera, {
    frustum: { fovy },
    flyTo: (options) => flights.push(options),
    pickEllipsoid: (position) => {
      assert.deepEqual(position, { x: 500, y: 250 }, 'the canvas centre');
      return centreHit;
    },
  });
  f.layer.enable();
  assert.equal(f.snap().zoomToFit, false);
  assert.equal(f.layer.zoomToFit(), null, 'nothing refused, nothing to fit');
  // A box over the cap: its centre.
  f.layer.setBox({ west: 0, south: 0, east: 20, north: 20 });
  assert.equal(f.snap().zoomToFit, true);
  const height = f.layer.zoomToFit();
  assert.ok(Math.abs(height - expected) < 1e-6, String(height));
  assert.equal(flights.length, 1);
  const [flight] = flights;
  assert.ok(Math.abs(deg(flight.destination.longitude) - 10) < 1e-9);
  assert.ok(Math.abs(deg(flight.destination.latitude) - 10) < 1e-9);
  assert.equal(flight.destination.height, height);
  assert.deepEqual(flight.orientation, {
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  assert.equal(flight.duration, 1.2);
  // A view over the cap: the ground under the canvas centre.
  f.viewer.camera.computeViewRectangle = () => ({
    west: rad(-108),
    south: rad(20),
    east: rad(-88),
    north: rad(40),
  });
  centreHit = { longitude: rad(-97), latitude: rad(31), height: 0 };
  assert.equal(f.layer.useCurrentView(), false);
  assert.equal(f.snap().zoomToFit, true);
  f.layer.zoomToFit();
  assert.ok(Math.abs(deg(flights[1].destination.longitude) + 97) < 1e-9);
  assert.ok(Math.abs(deg(flights[1].destination.latitude) - 31) < 1e-9);
  // Sky at the centre: the view rectangle's centre instead.
  centreHit = null;
  f.layer.useCurrentView();
  f.layer.zoomToFit();
  assert.ok(Math.abs(deg(flights[2].destination.longitude) + 98) < 1e-9);
  assert.ok(Math.abs(deg(flights[2].destination.latitude) - 30) < 1e-9);
  // The box tool's own oversized drag carries its box.
  f.layer.reportBoxRefusal('Box is 2,226 km wide · limit 1,000 km', {
    west: 0,
    south: 0,
    east: 20,
    north: 20,
  });
  assert.equal(f.snap().zoomToFit, true);
  // Other refusals and a box that succeeds offer nothing to fit.
  f.layer.reportBoxRefusal('Select one side of the dateline');
  assert.equal(f.snap().zoomToFit, false);
  f.layer.setBox({ west: 179, south: 0, east: -179, north: 1 });
  assert.equal(f.snap().zoomToFit, false);
  assert.equal(f.layer.zoomToFit(), null);
  f.layer.setBox({ west: 0, south: 0, east: 20, north: 20 });
  assert.equal(f.snap().zoomToFit, true);
  f.layer.setBox(BOX);
  assert.equal(f.snap().zoomToFit, false);
  assert.equal(f.layer.zoomToFit(), null);
  assert.equal(flights.length, 3);
});

test('alpha, split and visible range notify without re-rendering the row', async () => {
  const f = fixture();
  let rowRenders = 0;
  f.layer.setRowControlsListener(() => rowRenders++);
  await f.ready();
  const rows = rowRenders;
  f.layer.setAlpha(0.4);
  assert.deepEqual(f.renderer.calls.at(-1), ['alpha', 'b', 0.4]);
  assert.equal(f.owned().a.alpha, 1, 'the fake keeps the look it was given');
  f.layer.setSplit(0.25);
  f.layer.setVisibleRange(1, 3);
  assert.equal(f.thumbnails.calls.at(-1)[2].firstVisible, 1);
  assert.equal(rowRenders, rows);
  assert.deepEqual(f.reasons.slice(-2), ['alpha', 'split']);
  f.layer.setAlpha('bad');
  assert.equal(f.snap().alpha, 0.4);
});

test('disable releases the lease, hides the drapes and cancels the tool; pins come back on enable', async () => {
  const f = fixture();
  await f.ready();
  f.layer.setMode('basemap');
  f.layer.setAssignment('a', S18);
  f.controller.lease.settle();
  await settle();
  f.layer.disable();
  await settle();
  assert.equal(f.renderer.ownedCount(), 0);
  assert.deepEqual(f.controller.calls.at(-1), ['release']);
  assert.deepEqual(f.toolCalls, ['cancel']);
  assert.equal(f.snap().enabled, false);
  f.layer.enable();
  f.catalog.resolveLast();
  await settle();
  assert.equal(f.snap().pins.a.key, S18);
  assert.equal(f.snap().shown.swipe, 'basemap');
  f.layer.destroy();
  assert.ok(f.renderer.calls.some((c) => c[0] === 'destroy'));
  assert.ok(f.thumbnails.calls.some((c) => c[0] === 'destroy'));
  assert.equal(f.layer.enable(), false);
});

test('an empty day never drapes: the automatic preview re-ranks, a pick is refused and an empty pin is unpinned', async () => {
  const f = fixture();
  await f.ready();
  const before = f.reasons.length;
  f.thumbnails.probe(S18, 'empty');
  assert.equal(f.snap().preview.key, L16);
  assert.equal(f.snap().auto.reason, 'cloudy');
  assert.equal(f.owned().a.key, L16);
  assert.deepEqual(f.reasons.slice(before), ['thumbnail', 'state']);
  f.thumbnails.probe(V15, 'empty');
  f.layer.setShowUnavailable(true);
  assert.equal(f.layer.preview(V15), false);
  assert.equal(f.diag().following, null, 'an empty day is not followed');
  assert.equal(f.owned().a.key, L16, 'the previous preview stays');
  // A restored pin that resolves empty is unpinned.
  const g = fixture();
  g.layer.setParams({ ...LINK_BOX, a: S18, b: L16, mode: 2 });
  g.layer.enable();
  g.catalog.resolveLast();
  await settle();
  assert.equal(g.renderer.ownedCount(), 2);
  g.thumbnails.probe(S18, 'empty');
  assert.equal(g.snap().pins.a.key, null);
  assert.deepEqual(g.drapes(), { a: null, b: `${L16}|none` });
});

test('an automatic overview that probes empty hands over to the next ranked day', async () => {
  const f = fixture();
  await f.ready([CANDIDATES[0], CANDIDATES[3]]);
  assert.equal(f.diag().following, V21, 'the newest overview is followed');
  f.thumbnails.probe(V21, 'empty');
  assert.equal(f.diag().following, V15, 'the next overview takes over');
  assert.equal(f.snap().preview.pending, V15);
  f.thumbnails.probe(V15, 'present');
  assert.deepEqual(f.drapes(), { a: `${V15}|none`, b: null });
});

test('a pinned day still being probed drapes once the probe says present', async () => {
  const f = fixture();
  f.layer.setParams({ ...LINK_BOX, a: V21, mode: 0 });
  f.layer.enable();
  f.catalog.resolveLast();
  await settle();
  assert.equal(f.snap().pins.a.key, V21);
  assert.equal(f.renderer.ownedCount(), 0, 'unknown days never drape');
  f.thumbnails.probe(V21, 'present');
  assert.deepEqual(f.drapes(), { a: `${V21}|none`, b: null });
});

/** Thirty daily VIIRS days, newest first, from NOW back. */
const dailyViirs = () =>
  Array.from({ length: 30 }, (_, back) =>
    candidate(
      'VIIRS',
      new Date(Date.UTC(2026, 8, 21 - back)).toISOString().slice(0, 10),
    ),
  );

test('restored pins outside the visible strip window are probed and swipe once present', async () => {
  const f = fixture();
  const days = dailyViirs();
  const newest = days[0].key;
  const older = days[25].key;
  assert.equal(older, 'VIIRS:2026-08-27');
  f.layer.setVisibleRange(0, 5);
  f.layer.setParams({ ...LINK_BOX, a: newest, b: older, mode: 2 });
  f.layer.enable();
  f.catalog.resolveLast(days);
  await settle();
  assert.ok(
    f.thumbnails.requested.includes(older),
    'the offscreen B pin is probed',
  );
  assert.deepEqual(
    f.thumbnails.requests.find(([key]) => key === older),
    [older, 0],
    'at the focused card priority',
  );
  f.thumbnails.probeRequested('present');
  f.controller.lease.settle();
  await settle();
  assert.deepEqual(f.snap().shown, { a: newest, b: older, swipe: 'ab' });
  assert.deepEqual(f.drapes(), { a: `${newest}|left`, b: `${older}|right` });
});

test('pinning an offscreen day probes it at once', async () => {
  const f = fixture();
  const days = dailyViirs();
  const older = days[25].key;
  f.layer.setVisibleRange(0, 5);
  await f.ready(days);
  f.layer.setMode('ab');
  assert.ok(!f.thumbnails.requested.includes(older), 'not probed yet');
  assert.equal(f.layer.setAssignment('b', older), true);
  assert.deepEqual(f.thumbnails.requests.at(-1), [older, 0]);
  f.thumbnails.probe(older, 'present');
  assert.equal(f.snap().shown.b, older);
});

test('turning a source off hides its cards and drapes, disarms its pending preview and labels its pins "Source off"', async () => {
  const f = fixture();
  await f.ready();
  f.layer.setMode('ab');
  f.layer.setAssignment('a', S18);
  f.thumbnails.setStatus(V21, 'present');
  f.layer.setAssignment('b', V21);
  f.layer.setAssignment('b', null);
  f.layer.focus(2);
  assert.equal(f.diag().pending, L16);
  assert.equal(f.layer.setSources({ hls: false }), true);
  assert.equal(f.diag().pending, undefined);
  f.timers.flush();
  const snapshot = f.snap();
  assert.deepEqual(
    snapshot.candidates.map((c) => c.key),
    [V21, V15],
  );
  assert.equal(snapshot.pins.a.sourceOff, true);
  assert.equal(f.owned().a, null);
  assert.equal(f.layer.getParams().a, S18, 'the link keeps it');
  f.layer.setSources({ hls: true });
  assert.equal(f.owned().a.key, S18);
  assert.equal(f.layer.setSources({ hls: true }), false);
});

test('arrow focus previews the focused present day after the 250 ms debounce; only the last of a burst drapes', async () => {
  const f = fixture();
  await f.ready();
  f.thumbnails.setStatus(V15, 'present');
  f.layer.focus(2);
  assert.equal(f.snap().preview.key, S18, 'not yet');
  assert.equal(f.snap().preview.pending, L16);
  assert.equal(f.snap().candidates[2].pending, true);
  assert.equal([...f.timers.pending.values()][0].ms, FOCUS_DEBOUNCE_MS);
  assert.equal(FOCUS_DEBOUNCE_MS, 250);
  f.layer.focus(3);
  assert.equal(f.timers.armed(), 1, 'a single timer');
  f.timers.flush();
  assert.equal(f.snap().preview.key, V15);
  assert.equal(f.snap().auto, null);
  assert.equal(f.renderer.ownedCount(), 1, 'never a second layer');
  // Focus back on the previewed day disarms everything.
  f.layer.focus(2);
  f.layer.focus(3);
  assert.equal(f.timers.armed(), 0);
  assert.equal(f.diag().pending, undefined);
});

test('an unprobed day never drapes; a followed one previews once the probe says present, unless focus moved on', async () => {
  const f = fixture();
  await f.ready();
  f.layer.focus(0);
  assert.equal(f.timers.armed(), 0, 'no debounce for an unconfirmed day');
  assert.equal(f.diag().following, V21);
  f.thumbnails.probe(V21, 'present');
  assert.equal(f.snap().preview.key, V21);
  assert.equal(f.diag().following, null);
  // A click on an unknown day is followed too; moving focus away forgets it.
  assert.equal(f.layer.preview(V15), false);
  assert.equal(f.diag().following, V15);
  f.layer.focus(2);
  f.timers.flush();
  f.thumbnails.probe(V15, 'present');
  assert.equal(f.snap().preview.key, L16, 'not followed');
});

test('a card click previews at once; a repeat click is a no-op and focus follows', async () => {
  const f = fixture();
  await f.ready();
  const shows = () => f.renderer.calls.filter((c) => c[0] === 'show').length;
  const before = shows();
  assert.equal(f.layer.preview(L16), true);
  assert.equal(f.snap().focus.key, L16);
  assert.equal(f.owned().a.key, L16);
  f.layer.preview(L16);
  assert.equal(shows(), before + 1, 'no redraw');
  assert.equal(f.layer.preview('nope'), false);
});

test('Escape order: clearPreview takes the preview off and keeps pins; nothing to clear says so', async () => {
  const f = fixture();
  await f.ready();
  assert.equal(f.layer.clearPreview(), true);
  assert.equal(f.renderer.ownedCount(), 0);
  assert.equal(f.snap().preview.key, null);
  assert.equal(f.layer.clearPreview(), false);
  f.layer.setAssignment('a', S18);
  assert.equal(f.layer.clearPreview(), false, 'a pin is not a preview');
  assert.equal(f.owned().a.key, S18);
  // A preview still on its way counts.
  f.layer.setMode('ab');
  f.layer.focus(2);
  assert.equal(f.layer.clearPreview(), true);
  assert.equal(f.timers.armed(), 0);
});

test('CLEAR forgets the box, pins, preview, pending pick, opacity, split and the tool; mode and sources survive', async () => {
  const f = fixture();
  await f.ready();
  f.layer.setMode('ab');
  f.layer.setAssignment('a', S18);
  f.layer.setAlpha(0.3);
  f.layer.setSplit(0.2);
  f.layer.setSources({ viirs: false });
  f.layer.focus(1);
  f.layer.clear();
  const snapshot = f.snap();
  assert.deepEqual(
    [
      snapshot.box,
      snapshot.pins.a.key,
      snapshot.pins.b.key,
      snapshot.preview.key,
      snapshot.alpha,
      snapshot.split,
      snapshot.mode,
    ],
    [null, null, null, null, 1, 0.5, 'ab'],
  );
  assert.equal(snapshot.notice, 'Box and images cleared');
  assert.equal(snapshot.sources.viirs, false);
  assert.equal(f.renderer.ownedCount(), 0);
  assert.equal(f.timers.armed(), 0);
  assert.deepEqual(f.toolCalls, ['cancel']);
  assert.deepEqual(f.dataManager.adopted.at(-1)[1], {
    west: null,
    south: null,
    east: null,
    north: null,
    a: null,
    b: null,
    split: 50,
  });
});

test('confirmed-empty days hide behind the toggle and focus keeps its key or moves to the nearest older card', async () => {
  const f = fixture();
  await f.ready();
  f.layer.focus(2);
  f.thumbnails.probe(L16, 'empty');
  assert.deepEqual(
    f.snap().candidates.map((c) => c.key),
    [V21, S18, V15],
  );
  assert.equal(f.snap().hiddenCount, 1);
  assert.equal(f.snap().focus.key, V15, 'ties go older');
  f.layer.setShowUnavailable(true);
  assert.equal(f.snap().candidates.length, 4);
  assert.equal(f.snap().hiddenCount, 0);
  assert.equal(f.snap().focus.key, V15, 'same key kept');
  assert.equal(f.snap().candidates[2].drapable, false);
});

test('a new box takes the old drapes down at once; pins the new catalog still lists survive', async () => {
  const f = fixture();
  await f.ready();
  f.layer.setMode('ab');
  f.layer.setAssignment('a', S18);
  f.layer.setAssignment('b', L16);
  f.layer.setBox({ ...BOX, north: 30.4 });
  assert.equal(f.renderer.ownedCount(), 0, 'down before the search lands');
  f.catalog.resolveLast();
  await settle();
  assert.equal(f.snap().shown.swipe, 'ab');
  assert.equal(f.renderer.ownedCount(), 2);
});

test('with SELECT BOX armed, Escape clears the preview first and the next Escape cancels the tool', async () => {
  resetPointerOwnership();
  const f = fixture();
  const fakes = boxToolFakes();
  const cancels = [];
  const tool = initImageryBoxTool({
    viewer: fakes.viewer,
    cesium: fakes.cesium,
    pickWorld: fakes.pickWorld,
    documentRef: fakes.documentRef,
    onBox: (box) => f.layer.setBox(box),
    onCancel: (reason) => cancels.push(reason),
    onActive: (active) => f.layer.setToolActive(active),
    // The wiring in src/app/tools.js.
    onEscape: () => f.layer.clearPreview(),
  });
  await f.ready();
  assert.equal(tool.start(), true);
  fakes.key('Escape');
  assert.equal(f.snap().preview.key, null, 'Escape clears the preview');
  assert.equal(tool.isActive(), true, 'and leaves SELECT BOX armed');
  fakes.key('Escape');
  assert.equal(tool.isActive(), false);
  assert.deepEqual(cancels, ['escape']);
  assert.equal(f.snap().toolActive, false);
  await tool.destroy();
});
