import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../geo/index.js';
import { ENGINE_KINDS } from '../../globe/contract.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createWildlifeSightingsLayer } from './index.js';
import { WILDLIFE_BADGE_SET_ID } from './rendering.js';
import { WILDLIFE_DENSITY_SET_ID } from './density.js';
import { layerFeedState } from '../../data/feedState.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import { ICONIC_LEGEND_ORDER, WILDLIFE_MAX_ROWS } from './policy.js';
import { wildlifeGridCellId } from './gridViewport.js';

const NOW = Date.parse('2026-11-04T18:00:00Z');
const base = {
  stableId: 'inat:1',
  origin: 'inaturalist',
  lat: 47.6,
  lon: -122.4,
  obscured: false,
  cell: null,
  observedAt: NOW - 3_600_000,
  observedOn: '2026-11-04',
  quality: 'research',
  commonName: 'Synthetic bird',
  scientificName: 'Avis synthetica',
  iconic: 'Aves',
  threatened: false,
  provider: null,
  link: 'https://www.inaturalist.org/observations/1',
  photo: null,
};
const photographed = {
  ...base,
  photo: {
    square:
      'https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg',
    medium:
      'https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg',
    attribution: '(c) Synthetic Photographer',
    licence: 'cc-by',
  },
};

const toRadians = geo.math.toRadians;
const toDegrees = geo.math.toDegrees;
const cartographicOf = (position) => geo.cartographic.fromCartesian(position);
const heightOf = (position) => cartographicOf(position).height;
const lonOf = (position) => toDegrees(cartographicOf(position).longitude);
const latOf = (position) => toDegrees(cartographicOf(position).latitude);

/**
 * The layer on a fake globe engine above Seattle. `extra.project(_, position)`
 * and `extra.occluderFactory()` script the engine's projection and horizon
 * test; the rest goes to the layer.
 */
function harness(
  source = { getSnapshot: async () => [base] },
  extra = {},
  { autoEnable = true, width = 2000, height = 1200 } = {},
) {
  const { project, occluderFactory, ...layerExtra } = extra;
  let time = NOW;
  let picked;
  let cardHit = null;
  let pointerFree = true;
  let tilesLoaded = true;
  let rectangle = { south: 47.4, west: -122.7, north: 47.9, east: -122.1 };
  const events = new EventTarget();
  // Camera heights are set exactly; the pose stays above Seattle.
  const camera = { height: 30_000 };
  const projectRow =
    project ??
    ((_scene, position) => ({
      x: 400 + (lonOf(position) - (rectangle.west + rectangle.east) / 2) * 1000,
      y:
        400 +
        ((rectangle.south + rectangle.north) / 2 - latOf(position)) * 1000,
    }));
  // Input registrations the layer holds, on every engine.
  let inputs = 0;
  /** A fake engine of `kind` that sees and projects the fixture view. */
  function globe(kind) {
    const engine = createFakeEngine({ kind, width, height });
    engine.fake.setPose({
      position: geo.cartesian3.fromDegrees(-122, 47, 30_000),
    });
    // Settle the camera so later frames raise no camera events.
    engine.fake.frames(2);
    engine.camera.height = () => camera.height;
    engine.fake.script('viewRectangle', () =>
      Object.fromEntries(
        Object.entries(rectangle).map(([key, value]) => [
          key,
          toRadians(value),
        ]),
      ),
    );
    engine.projector.horizonVisible = (position) =>
      occluderFactory ? occluderFactory().isPointVisible(position) : true;
    engine.fake.script('worldToWindow', (position) =>
      projectRow(null, position),
    );
    engine.fake.script('pick', () => picked ?? undefined);
    engine.fake.script('tilesLoaded', () => tilesLoaded);
    const on = engine.input.on;
    engine.input.on = (type, listener, options) => {
      const off = on(type, listener, options);
      inputs++;
      let removed = false;
      return () => {
        if (!removed) inputs--;
        removed = true;
        off();
      };
    };
    return engine;
  }
  const engine = globe();
  const owners = new Map();
  const overlay = {
    entries: new Map(),
    visible: new Map(),
    options: new Map(),
  };
  const renders = [];
  const focus = [];
  const links = [];
  const store = { entities: new Map(), selectedEntityId: null };
  const timers = new Map();
  const idleTasks = new Map();
  let nextTimer = 0;
  let nextIdle = 0;
  const images = [];
  const ground = { sample: () => 123, resolves: 0 };
  const layer = createWildlifeSightingsLayer({
    source,
    groundFloor: {
      cachedGroundFloor: (lat, lon) => ground.sample(lat, lon),
      resolveGroundFloorCellsBounded: async () => {
        ground.resolves++;
      },
    },
    now: () => time,
    setTimer(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    requestIdleCallback(fn) {
      const id = ++nextIdle;
      idleTasks.set(id, fn);
      return id;
    },
    cancelIdleCallback: (id) => idleTasks.delete(id),
    imageFactory: () => {
      const image = {};
      images.push(image);
      return image;
    },
    eventTarget: events,
    overlayHost: {
      setEntries: (id, entries, options) => {
        assert.equal(options.moving, false);
        overlay.entries.set(id, entries);
        overlay.options.set(id, options);
      },
      setVisible: (id, value) => overlay.visible.set(id, value),
      clearSource: (id) => overlay.entries.delete(id),
      hitTest: (_x, _y, { sourceId }) =>
        cardHit?.sourceId === sourceId ? cardHit : null,
    },
    pointer: { isPointerFree: () => pointerFree },
    picking: {
      registerPickOwner: (id, fn) => owners.set(id, fn),
      unregisterPickOwner: (id) => owners.delete(id),
      resolvePickId: (pick) => pick?.id ?? null,
      isOwnedByOtherLayer: (_layerId, id) => id?.startsWith('other:'),
    },
    render: { governorRequestRender: (reason) => renders.push(reason) },
    focus: { requestWorldFocus: (request) => focus.push(request) },
    openExternal: (url) => links.push(url),
    context: {
      getContextStore: () => store,
      registerEntityContext(entity, metadata) {
        entity.__gevContextId = metadata.id;
        store.entities.set(metadata.id, { ...metadata, entity });
      },
      selectEntityContext(entity) {
        store.selectedEntityId = entity.__gevContextId;
        const selected = new Event('gev:entity-selected');
        selected.detail = store.entities.get(entity.__gevContextId);
        events.dispatchEvent(selected);
      },
      clearSelectedEntityContextForLayer: () => {
        store.selectedEntityId = null;
      },
      removeEntityContextsForLayer: () => store.entities.clear(),
    },
    ...layerExtra,
  });
  const init = () => layer.init(null, { engine });
  if (autoEnable) {
    init();
    layer.enable();
  }
  function flushIdle() {
    for (let steps = 0; idleTasks.size; steps++) {
      assert.ok(steps < 1000, 'idle work finishes without a frame loop');
      const [id, fn] = idleTasks.entries().next().value;
      idleTasks.delete(id);
      fn({ timeRemaining: () => 10 });
    }
  }
  const badgeSet = (target = engine) =>
    target.fake.moverSet(WILDLIFE_BADGE_SET_ID);
  // One badge as the engine draws it, read live from the mover store.
  const badge = (id, target) => {
    const index = () => {
      const set = badgeSet(target);
      if (!set) return -1;
      for (let at = 0; at < set.store.count; at++)
        if (set.store.pickIds[at] === id) return at;
      return -1;
    };
    const read = (fn) => {
      const at = index();
      return at < 0 ? undefined : fn(badgeSet(target).store, at);
    };
    return {
      id,
      get position() {
        return read((store, at) =>
          geo.cartesian3.create(
            store.positions[at * 3],
            store.positions[at * 3 + 1],
            store.positions[at * 3 + 2],
          ),
        );
      },
      get show() {
        return read((store, at) => store.shows[at] === 1);
      },
      get scale() {
        return read((store, at) => store.scales[at]);
      },
      get color() {
        return read((store, at) => [
          ...store.colors.subarray(at * 4, at * 4 + 4),
        ]);
      },
      get cell() {
        return read((store, at) => store.cellKeys[store.cells[at]]);
      },
    };
  };
  return {
    engine,
    ground,
    layer,
    init,
    async update(...args) {
      // Explicit refreshes stand for successive poll batches, not push bursts.
      time += 500;
      const result = await layer.update(...args);
      flushIdle();
      return result;
    },
    flushIdle,
    overlay,
    owners,
    renders,
    focus,
    links,
    images,
    events,
    store,
    timers,
    /** The badges an engine draws, in instance order. */
    badges(target = engine) {
      const set = badgeSet(target);
      return set
        ? Array.from({ length: set.store.count }, (_, at) =>
            badge(set.store.pickIds[at], target),
          )
        : [];
    },
    globe,
    badgeSet,
    glow: () => engine.fake.moverSet(WILDLIFE_DENSITY_SET_ID),
    moveEnd: {
      emit: () => engine.fake.emit('camera.moveEnd'),
      count: () => engine.camera.moveEnd.numberOfListeners,
    },
    /** Listeners that run on every drawn frame. */
    frameWork: () => engine.frames.preRender.numberOfListeners,
    /** The surface-loading watch (one per enabled scene). */
    surfaceWatch: () => engine.frames.postRender.numberOfListeners,
    /** Surface loading as the engine reports it, then one frame. */
    tiles(loaded) {
      tilesLoaded = loaded;
      engine.fake.frame();
    },
    credits: () => engine.fake.credits.length,
    inputs: () => inputs,
    click(event) {
      engine.fake.input('click', event);
    },
    height: (value) => {
      camera.height = value;
    },
    pick: (value) => {
      picked = value;
    },
    hit: (value) => {
      cardHit = value;
    },
    free: (value) => {
      pointerFree = value;
    },
    rectangle: (value) => {
      rectangle = value;
    },
    time: (value) => {
      time = value;
    },
    contextSelect(id) {
      const selected = new Event('gev:entity-selected');
      selected.detail = store.entities.get(id);
      events.dispatchEvent(selected);
    },
  };
}

test('construction validates source and does not acquire; double init throws', () => {
  assert.throws(() => createWildlifeSightingsLayer(), TypeError);
  const h = harness({ getSnapshot: () => assert.fail('enable fetched') });
  assert.throws(() => h.init(), /already initialized/);
  assert.equal(h.badgeSet(), undefined, 'no badge set before any badge');
  assert.deepEqual(h.engine.movers.list(), []);
  h.layer.destroy();
});

test('terrain warming resamples unchanged point, card and context anchors without a frame loop', async () => {
  const h = harness(
    {
      getSnapshot: async () => [
        photographed,
        { ...base, stableId: 'acartia:sea', origin: 'acartia', lon: -122.3 },
      ],
    },
    {},
    { autoEnable: false },
  );
  let height = 0;
  let samples = 0;
  h.ground.sample = () => {
    samples++;
    return height;
  };
  h.init();
  h.layer.enable();
  await h.update();
  h.layer.selectSighting('inat:1');
  const [point, sea] = h.badges();
  const before = samples;
  height = 600;
  await h.update();
  h.moveEnd.emit();
  assert.equal(
    samples,
    before,
    'unchanged snapshots and camera movement do not resample per point',
  );
  h.tiles(false);
  assert.equal(samples, before, 'wait for terrain loading to settle');
  h.tiles(true);
  assert.ok(Math.abs(cartographicOf(point.position).height - 600) < 0.01);
  assert.equal(
    samples,
    before + 1,
    'Acartia sea anchors are never terrain-sampled',
  );
  assert.ok(Math.abs(cartographicOf(sea.position).height) < 0.01);
  assert.equal(
    h.badges()[0].id,
    point.id,
    'resampling preserves the badge instance',
  );
  assert.equal(h.badges().length, 2);
  assert.deepEqual(
    h.overlay.entries.get('wildlife-sightings')[0].position,
    point.position,
  );
  assert.ok(
    h.overlay.entries
      .get('wildlife-sightings-selected')
      .every((entry) => geo.cartesian3.equals(entry.position, point.position)),
  );
  assert.deepEqual(
    h.store.entities.get('inat:1').entity.__localBaseCartesian,
    point.position,
  );
  assert.ok(h.renders.includes('wildlife-sightings-terrain'));
  assert.equal(h.frameWork(), 0);
  h.layer.disable();
  assert.equal(h.surfaceWatch(), 0);
  const disabledSamples = samples;
  h.tiles(false);
  h.tiles(true);
  assert.equal(samples, disabledSamples);
  height = 900;
  h.layer.enable();
  assert.ok(
    Math.abs(cartographicOf(h.badges()[0].position).height - 900) < 0.01,
  );
  assert.equal(h.surfaceWatch(), 1);
  h.layer.destroy();
  assert.equal(h.surfaceWatch(), 0);
});

test('surface loading and map-source changes refresh anchors and release listeners', async () => {
  const h = harness(undefined, {}, { autoEnable: false });
  let height = 20;
  h.ground.sample = () => height;
  h.init();
  h.layer.enable();
  await h.update();
  const point = h.badges()[0];
  const assertHeight = (expected) =>
    assert.ok(Math.abs(heightOf(point.position) - expected) < 0.01);
  height = 200;
  h.tiles(false);
  assertHeight(20);
  h.tiles(true);
  assertHeight(200);
  height = 400;
  h.tiles(true);
  assertHeight(200);
  h.tiles(false);
  h.tiles(true);
  assertHeight(400);
  height = 800;
  h.events.dispatchEvent(new Event('gev:map-stack-changed'));
  assertHeight(800);
  h.layer.disable();
  assert.equal(h.surfaceWatch(), 0);
  height = 1000;
  h.events.dispatchEvent(new Event('gev:map-stack-changed'));
  assert.equal(h.badges().length, 0);
  h.layer.destroy();
  assert.equal(h.frameWork(), 0);
});

test('camera rebuilds expire unselected sightings while a selected observation stays pinned', async () => {
  for (const [taxa, windowHours] of [
    ['all', 48],
    ['whales', 7 * 24],
  ]) {
    let requests = 0;
    const h = harness({
      getSnapshot: async () =>
        ++requests === 1
          ? [photographed]
          : [{ ...base, stableId: 'inat:other-area', lat: 49.1, lon: -124.2 }],
    });
    h.layer.setParams({ taxa });
    await h.update();
    h.rectangle({ south: 48.8, west: -124.5, north: 49.4, east: -124 });
    h.moveEnd.emit();
    await h.update();
    h.rectangle({ south: 47.4, west: -122.7, north: 47.9, east: -122.1 });
    h.moveEnd.emit();
    assert.equal(
      h.badges()[0].id,
      'wildlife:inat:1',
      'the prior area is retained in the LRU',
    );
    assert.equal(h.layer.selectSighting('inat:1'), true);
    assert.ok(h.overlay.entries.get('wildlife-sightings-selected').length > 0);
    h.time(NOW + windowHours * 3_600_000);
    h.moveEnd.emit();
    assert.equal(
      h.badges().length,
      1,
      `${taxa} keeps the explicitly selected observation beyond its window`,
    );
    assert.equal(h.overlay.entries.get('wildlife-sightings').length, 0);
    assert.equal(
      h.overlay.entries.get('wildlife-sightings-selected').length,
      1,
    );
    h.layer.clearSightingSelection();
    h.moveEnd.emit();
    assert.equal(h.badges().length, 0, 'expired rows retire on deselection');
    assert.equal(requests, 2, 'expiry needs no new source success');
    h.layer.destroy();
  }
});

test('pending filter changes retain the accepted recency window until their result validates', async () => {
  const h = harness({
    getSnapshot: async () => [
      { ...photographed, observedAt: NOW - 3 * 86_400_000 },
    ],
  });
  h.layer.setParams({ taxa: 'whales' });
  await h.update();
  h.layer.setParams({ taxa: 'all' });
  assert.equal(h.layer.selectSighting('inat:1'), true);
  assert.equal(
    h.badges().length,
    1,
    'three-day whale remains while ALL is pending',
  );
  assert.ok(h.overlay.entries.get('wildlife-sightings-selected').length > 0);
  h.layer.destroy();
});

test('sampled ground and sea heights keep badges on top and update them in place', async () => {
  let rows = [
    base,
    {
      ...base,
      stableId: 'acartia:2',
      origin: 'acartia',
      lon: -122.5,
      iconic: 'Mammalia',
    },
  ];
  const h = harness({ getSnapshot: async () => rows });
  await h.update();
  const first = h.badges()[0];
  assert.equal(h.badgeSet().options.depthTest, 'always');
  assert.ok(Math.abs(cartographicOf(first.position).height - 123) < 0.01);
  assert.ok(Math.abs(cartographicOf(h.badges()[1].position).height) < 0.01);
  await h.update();
  assert.equal(h.badges()[0].id, first.id);
  for (const change of [
    { lon: -122.3 },
    { iconic: 'Fungi' },
    { quality: 'needs_id' },
  ]) {
    const before = h.badgeSet().store.count;
    rows = [{ ...rows[0], ...change }];
    await h.update();
    assert.equal(
      h.badges()[0].id,
      first.id,
      'changed contacts update in place',
    );
    assert.ok(h.badgeSet().store.count <= before);
  }
  assert.ok(h.renders.length > 0);
  h.layer.destroy();
  const unsupported = harness(undefined);
  unsupported.ground.sample = () => null;
  await unsupported.update();
  assert.ok(
    Math.abs(cartographicOf(unsupported.badges()[0].position).height) < 0.01,
  );
  unsupported.layer.destroy();
});

test('a painted card hides its anchored badge across rebuilds while retaining its context and selection', async (t) => {
  const h = harness({ getSnapshot: async () => [photographed] });
  t.after(() => h.layer.destroy());
  await h.update();
  const point = h.badges()[0];
  assert.equal(point.show, true);
  const visibility =
    h.overlay.options.get('wildlife-sightings').onVisibilityChange;
  visibility(new Set(['sighting:inat:1']));
  assert.equal(point.show, false);
  h.moveEnd.emit();
  assert.equal(
    point.show,
    false,
    'a camera rebuild must not resurrect the represented badge',
  );
  assert.equal(
    h.store.entities.get('inat:1').entity.show,
    true,
    'visual badge suppression must not hide the sighting context',
  );
  assert.equal(h.layer.selectSighting('inat:1'), true);
  assert.equal(
    point.show,
    false,
    'selection must not resurrect the represented badge',
  );
  visibility(new Set());
  assert.equal(point.show, true);
});

test('a painted thumbnail hides the repeat name label, ambient and selected, until it leaves', async (t) => {
  const h = harness({ getSnapshot: async () => [photographed] });
  t.after(() => h.layer.destroy());
  await h.update();
  const labelIds = () =>
    [
      ...(h.overlay.entries.get('wildlife-sightings-labels') || []),
      ...(h.overlay.entries.get('wildlife-sightings-selected') || []),
    ]
      .filter((entry) => entry.variant === 'label')
      .map((entry) => entry.id);
  const visibility =
    h.overlay.options.get('wildlife-sightings').onVisibilityChange;
  assert.ok(h.layer.selectSighting('inat:1'));
  assert.deepEqual(labelIds(), ['wildlife-sightings-label:inat:1']);
  visibility(new Set(['sighting:inat:1']));
  assert.deepEqual(labelIds(), [], 'the thumbnail already names it');
  h.moveEnd.emit();
  assert.deepEqual(labelIds(), [], 'a rebuild keeps the label hidden');
  h.layer.clearSelection?.();
  assert.deepEqual(labelIds(), [], 'ambient labels also yield to the card');
  visibility(new Set());
  assert.ok(labelIds().length <= 1);
});

test('dot, ambient card and context clicks focus the true sighting; cards win over scene picks', async () => {
  const h = harness({ getSnapshot: async () => [photographed] });
  const selections = [];
  h.layer.subscribeSelection((row, metadata) =>
    selections.push({ row, metadata }),
  );
  await h.update();
  h.pick({ id: 'wildlife:inat:1' });
  h.click({ position: { x: 20, y: 30 } });
  assert.equal(h.focus.length, 1);
  assert.equal(h.badges()[0].scale, 1);
  assert.equal(h.store.selectedEntityId, 'inat:1');
  assert.deepEqual(selections.at(-1), {
    row: photographed,
    metadata: { explicitSelection: true },
  });
  const ambient = h.overlay.entries.get('wildlife-sightings')[0];
  assert.equal(ambient.interactive, true);
  // The anchored photo card owns the single iNaturalist link; canvas cards
  // only select and focus.
  assert.match(ambient.accessibilityLabel, /Show Synthetic bird sighting/);
  assert.equal(ambient.activate(), true);
  assert.equal(h.focus.length, 2);
  assert.deepEqual(h.links, []);
  assert.deepEqual(selections.at(-1).metadata, { explicitSelection: true });
  const selected = h.overlay.entries.get('wildlife-sightings-selected');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].variant, 'label');
  assert.equal(selected[0].title, base.commonName.toUpperCase());
  assert.equal(selected[0].placement, 'above');
  assert.equal(selected[0].interactive, false);
  assert.equal(selected[0].selected, true);
  assert.equal(selected[0].image, undefined);
  assert.equal(selected[0].details, undefined);
  assert.equal(selected[0].pinned, undefined);
  assert.ok(
    h.images.every((image) => /square.jpg$/.test(image.src)),
    'selection never starts an overlay medium image',
  );
  h.hit({ sourceId: 'wildlife-sightings', entry: ambient });
  h.pick({ id: 'other:aircraft' });
  h.click({ position: {} });
  assert.deepEqual(h.links, [], 'canvas cards select; they never open links');
  assert.equal(h.focus.length, 3);
  assert.equal(
    h.store.selectedEntityId,
    'inat:1',
    'ambient cards win over scene picks',
  );
  h.hit(null);
  h.click({ position: {} });
  assert.equal(h.store.selectedEntityId, 'inat:1', 'sibling picks yield');
  h.free(false);
  h.pick(null);
  h.click({ position: {} });
  assert.equal(h.store.selectedEntityId, 'inat:1');
  h.contextSelect('inat:1');
  assert.equal(
    h.focus.length,
    4,
    'context selection focuses the same true observation position',
  );
  assert.deepEqual(selections.at(-1).metadata, { explicitSelection: true });
  h.free(true);
  h.click({ position: {} });
  assert.equal(h.store.selectedEntityId, null);
  h.layer.disable();
  assert.equal(ambient.activate(), false);
  h.layer.destroy();
});

test('selection subscriptions publish current rows, accepted refreshes, reselection and real deselection', async () => {
  let rows = [photographed];
  const h = harness({ getSnapshot: async () => rows });
  const seen = [];
  const metadata = [];
  const unsubscribe = h.layer.subscribeSelection((selected, details) => {
    seen.push(selected);
    metadata.push(details);
  });
  assert.deepEqual(
    seen,
    [null],
    'subscription immediately publishes its empty state',
  );
  assert.deepEqual(metadata.at(-1), { explicitSelection: false });
  await h.update();
  assert.deepEqual(metadata.at(-1), { explicitSelection: false });
  assert.equal(h.layer.selectSighting('inat:1'), true);
  assert.equal(seen.at(-1), photographed);
  assert.deepEqual(metadata.at(-1), { explicitSelection: true });
  const immediately = [];
  const removeImmediate = h.layer.subscribeSelection((selected, details) =>
    immediately.push({ selected, details }),
  );
  assert.deepEqual(
    immediately,
    [{ selected: photographed, details: { explicitSelection: false } }],
    'late subscribers immediately receive the selected row without an explicit reselection',
  );
  removeImmediate();
  rows = [{ ...photographed, commonName: 'Updated synthetic bird' }];
  await h.update();
  assert.equal(seen.at(-1), rows[0]);
  assert.deepEqual(
    metadata.at(-1),
    { explicitSelection: false },
    'an accepted snapshot preserves disclosure',
  );
  assert.equal(
    h.overlay.entries.get('wildlife-sightings-selected')[0].title,
    rows[0].commonName.toUpperCase(),
  );
  const beforeReselect = seen.length;
  h.layer.selectSighting('inat:1');
  assert.equal(
    seen.length,
    beforeReselect + 1,
    'reselection notifies the dialog',
  );
  assert.deepEqual(
    metadata.at(-1),
    { explicitSelection: true },
    'explicitly reselecting the same row can reopen it',
  );
  assert.equal(h.layer.clearSightingSelection(), true);
  assert.equal(seen.at(-1), null);
  assert.deepEqual(metadata.at(-1), { explicitSelection: false });
  assert.equal(h.store.selectedEntityId, null);
  assert.equal(h.badges()[0].scale, 1);
  assert.deepEqual(h.badges()[0].color, [1, 1, 1, 1]);
  assert.deepEqual(h.overlay.entries.get('wildlife-sightings-selected'), []);
  assert.equal(h.layer.clearSightingSelection(), false);
  h.layer.selectSighting('inat:1');
  const beforeUnsubscribe = seen.length;
  unsubscribe();
  await h.update();
  h.layer.clearSightingSelection();
  assert.equal(seen.length, beforeUnsubscribe);
  h.layer.destroy();
});

test('selection subscriptions retain omitted rows and clear on disable and destroy, without an overlay host', async () => {
  let rows = [base];
  const eventListeners = new Map();
  const eventTarget = {
    addEventListener(type, listener) {
      if (!eventListeners.has(type)) eventListeners.set(type, new Set());
      eventListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      eventListeners.get(type)?.delete(listener);
    },
  };
  const h = harness(
    { getSnapshot: async () => rows },
    { overlayHost: null, eventTarget },
  );
  assert.equal(eventListeners.get('gev:entity-selected').size, 1);
  const seen = [];
  const unsubscribe = h.layer.subscribeSelection((selected) =>
    seen.push(selected),
  );
  h.layer.subscribeSelection(() => {
    throw new Error('Disconnected dialog');
  });
  await h.update();
  h.layer.selectSighting('inat:1');
  rows = [];
  await h.update();
  assert.equal(
    seen.at(-1),
    base,
    'an accepted result omitting the selected row preserves the dialog',
  );
  rows = [base];
  await h.update();
  h.layer.selectSighting('inat:1');
  h.layer.disable();
  assert.equal(seen.at(-1), null);
  assert.equal(eventListeners.get('gev:entity-selected').size, 0);
  const disabledCount = seen.length;
  h.layer.enable();
  assert.equal(eventListeners.get('gev:entity-selected').size, 1);
  await h.update();
  h.layer.selectSighting('inat:1');
  assert.equal(seen.at(-1), base);
  assert.ok(
    seen.length > disabledCount,
    'disable retains subscriptions for re-enable',
  );
  h.layer.destroy();
  assert.equal(seen.at(-1), null);
  assert.equal(h.inputs(), 0, 'no click listener remains');
  assert.equal(eventListeners.get('gev:entity-selected').size, 0);
  const destroyedCount = seen.length;
  h.layer.clearSightingSelection();
  assert.equal(
    seen.length,
    destroyedCount,
    'destroy removes existing subscribers',
  );
  const afterDestroy = [];
  const removeDestroyed = h.layer.subscribeSelection((selected) =>
    afterDestroy.push(selected),
  );
  assert.deepEqual(afterDestroy, [null]);
  h.layer.clearSightingSelection();
  assert.deepEqual(
    afterDestroy,
    [null],
    'destroyed layers never retain new subscribers',
  );
  removeDestroyed();
  unsubscribe();
});

function watchCells(engine) {
  let current;
  const createSet = engine.ground.createSet.bind(engine.ground);
  engine.ground.createSet = (options) => {
    const set = createSet(options);
    const { replace } = set;
    set.replace = (items) => {
      replace(items);
      current = { set, items };
    };
    return set;
  };
  return () => current;
}

test('privacy cells draw on ground, replace changed batches and release them', async () => {
  let rows = [
    {
      ...base,
      obscured: true,
      cell: { south: 47.6, west: -122.4, north: 47.8, east: -122.2 },
    },
  ];
  const h = harness({ getSnapshot: async () => rows });
  const cells = watchCells(h.engine);
  await h.update();
  const first = cells();
  assert.equal(h.engine.ground.list().length, 1);
  assert.equal(h.frameWork(), 0, 'static cells need no frame work');
  rows = [{ ...rows[0], iconic: 'Fungi' }];
  await h.update();
  const second = cells();
  assert.equal(h.engine.ground.list().length, 1);
  assert.notEqual(second.set, first.set, 'a new accent replaces the geometry');
  assert.notDeepEqual(second.items[0].fill, first.items[0].fill);
  assert.throws(() => first.set.commit(), /destroyed/);
  h.layer.selectSighting(base.stableId);
  assert.equal(h.focus.at(-1).kind, 'sighting-area');
  const selectedRing = h.badges()[0];
  assert.deepEqual(selectedRing.color, [1, 1, 1, 1]);
  assert.equal(selectedRing.scale, 1);
  assert.match(h.badgeSet().options.sprite.atlas.url, /^data:image\/svg/);
  assert.equal(cells(), second, 'selection reuses unchanged privacy geometry');
  h.layer.disable();
  assert.deepEqual(h.engine.ground.list(), []);
  h.layer.destroy();
});

test('disable ignores late successes and failures, unregisters owners and hides both overlay sources and credits', async () => {
  for (const reject of [false, true]) {
    let settle;
    let signal;
    const h = harness({
      getSnapshot: ({ signal: requestSignal }) => {
        signal = requestSignal;
        return new Promise((resolve, fail) => {
          settle = reject ? fail : resolve;
        });
      },
    });
    const pending = h.update();
    assert.equal(h.owners.size, 1);
    h.layer.disable();
    assert.equal(signal.aborted, true);
    settle(reject ? Error('iNaturalist HTTP 502') : [photographed]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().error, null);
    assert.equal(h.badges().length, 0);
    assert.equal(h.owners.size, 0);
    assert.equal(h.credits(), 0);
    assert.deepEqual([...h.overlay.visible.values()], [false, false, false]);
    assert.equal(h.overlay.entries.size, 0);
    assert.equal(h.moveEnd.count(), 0);
    h.layer.destroy();
    assert.deepEqual(h.engine.movers.list(), []);
    assert.equal(h.badgeSet(), undefined);
    assert.equal(h.inputs(), 0);
  }
});

test('first failure stays enabled; stale timestamps and subsequent failure preserve data with honest feed states', async () => {
  let snapshot = null;
  const h = harness({
    getSnapshot: async () => [],
    getSnapshotDetail: async () => {
      if (!snapshot) throw new Error('iNaturalist HTTP 502');
      return snapshot;
    },
  });
  assert.equal(await h.update(), true);
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');
  assert.equal(h.owners.size, 1);
  snapshot = { rows: [base], stale: true, fetchedAt: NOW - 300_000 };
  h.time(NOW + 31_000);
  await h.update();
  assert.equal(h.layer.getStats().lastUpdate, snapshot.fetchedAt);
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');
  snapshot = null;
  await h.update();
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
  h.layer.destroy();
});

test('camera boxes supersede pending fetches through one manager debounce', async () => {
  let signal;
  let settle;
  const h = harness({
    getSnapshot: ({ signal: requestSignal }) => {
      signal = requestSignal;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  });
  let refreshes = 0;
  h.layer.attachDataManager({
    refreshLayer: async (id) => {
      assert.equal(id, 'wildlife-sightings');
      refreshes++;
      return true;
    },
  });
  const pending = h.update();
  h.rectangle({ south: 48, west: -123, north: 48.4, east: -122.6 });
  h.moveEnd.emit();
  assert.equal(signal.aborted, true);
  assert.equal(h.timers.size, 1);
  const timer = [...h.timers.values()][0];
  assert.equal(timer.delay, 600);
  h.time(NOW + 2500);
  timer.fn();
  await Promise.resolve();
  assert.equal(refreshes, 1);
  settle([base]);
  assert.equal(await pending, true);
  h.layer.destroy();
});

test('a deferred A to B to A pan starts a new A request after aborting the first', async () => {
  const requests = [];
  const h = harness({
    getSnapshot: ({ signal, boxes }) =>
      new Promise((resolve) => {
        requests.push({ signal, boxes, resolve });
      }),
  });
  const boxA = { south: 47.4, west: -122.7, north: 47.9, east: -122.1 };
  const pending = h.update();
  h.rectangle({ south: 48, west: -123, north: 48.4, east: -122.6 });
  h.moveEnd.emit();
  assert.equal(requests[0].signal.aborted, true);
  h.rectangle(boxA);
  h.moveEnd.emit();
  assert.equal(
    h.timers.size,
    1,
    'returning to aborted A schedules its replacement',
  );
  requests[0].resolve([base]);
  assert.equal(await pending, true);
  assert.equal(h.layer.getStats().count, 0);
  const [timerId, timer] = [...h.timers][0];
  h.timers.delete(timerId);
  h.time(NOW + timer.delay);
  timer.fn();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].boxes, requests[0].boxes);
  assert.equal(requests[1].signal.aborted, false);
  requests[1].resolve([base]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.timers.size, 0);
  h.layer.destroy();
});

test('a completed A stays reusable when only the B debounce was pending', async () => {
  let calls = 0;
  const h = harness({
    getSnapshot: async () => {
      calls++;
      return [base];
    },
  });
  await h.update();
  h.rectangle({ south: 48, west: -123, north: 48.4, east: -122.6 });
  h.moveEnd.emit();
  assert.equal(h.timers.size, 1);
  h.rectangle({ south: 47.4, west: -122.7, north: 47.9, east: -122.1 });
  h.moveEnd.emit();
  assert.equal(h.timers.size, 0);
  assert.equal(calls, 1);
  assert.equal(h.layer.getStats().count, 1);
  h.layer.destroy();
});

test('an externally aborted attempt does not suppress a camera retry in the same box', async () => {
  const requests = [];
  const h = harness({
    getSnapshot: ({ signal }) =>
      new Promise((resolve) => {
        requests.push({ signal, resolve });
      }),
  });
  const controller = new AbortController();
  const pending = h.update(undefined, { signal: controller.signal });
  controller.abort();
  h.moveEnd.emit();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(h.timers.size, 1);
  requests[0].resolve([base]);
  assert.equal(await pending, false);
  const [timerId, timer] = [...h.timers][0];
  h.timers.delete(timerId);
  h.time(NOW + timer.delay);
  timer.fn();
  assert.equal(requests.length, 2);
  requests[1].resolve([base]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.layer.getStats().count, 1);
  h.layer.destroy();
});

test('the real manager keeps first enable on after a pan supersedes either a success or a failure', async () => {
  for (const reject of [false, true]) {
    for (const debounceBeforeSettlement of [false, true]) {
      const requests = [];
      const h = harness(
        {
          getSnapshot: ({ signal, boxes }) =>
            new Promise((resolve, fail) => {
              requests.push({ signal, boxes, resolve, fail });
            }),
        },
        {},
        { autoEnable: false },
      );
      const manager = new LayerLifecycle(null, { engine: h.engine });
      manager.register(h.layer);
      h.layer.attachDataManager(manager);
      const fireCameraTimer = () => {
        assert.equal(h.timers.size, 1);
        const [timerId, timer] = [...h.timers][0];
        h.timers.delete(timerId);
        h.time(NOW + 2500);
        timer.fn();
      };
      try {
        const enabling = manager.setEnabled(h.layer.id, true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 0, 'startup settles before dispatch');
        fireCameraTimer();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 1);
        h.rectangle({ south: 48, west: -123, north: 48.4, east: -122.6 });
        h.moveEnd.emit();
        assert.equal(requests[0].signal.aborted, true);
        if (debounceBeforeSettlement) {
          fireCameraTimer();
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(
            requests.length,
            1,
            'manager cannot refresh during initial enable',
          );
          assert.equal(h.timers.size, 0);
        }
        if (reject) requests[0].fail(Error('iNaturalist HTTP 502'));
        else requests[0].resolve([base]);
        assert.equal(await enabling, true);
        assert.equal(manager.isEnabled(h.layer.id), true);
        assert.equal(h.owners.size, 1);
        assert.equal(
          h.layer.getStats().count,
          0,
          'superseded rows never publish',
        );
        assert.equal(
          h.layer.getStats().error,
          null,
          'superseded errors never publish',
        );
        assert.equal(h.layer.getStats().lastUpdate, null);
        fireCameraTimer();
        assert.equal(
          requests.length,
          2,
          'settled enable recovers the latest query',
        );
        assert.equal(requests[1].boxes[0].south, 48);
        requests[1].resolve([
          { ...base, stableId: 'inat:2', lat: 48.2, lon: -122.8 },
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(manager.isEnabled(h.layer.id), true);
        assert.equal(h.layer.getStats().count, 1);
        assert.equal(manager.layers.get(h.layer.id).managerRefreshError, null);
        assert.equal(h.owners.get(h.layer.id)('wildlife:inat:2'), true);
      } finally {
        await manager.destroyLayer(h.layer.id);
      }
      assert.equal(h.owners.size, 0);
      assert.equal(h.moveEnd.count(), 0);
      assert.equal(manager._listeners.size, 0);
    }
  }
});

test('first enable settles once and publishes badges within two seconds without restarting its fetch set', async (t) => {
  let finishObservations;
  const requests = [];
  let gridSets = 0;
  const row = { ...base, lat: 48.2, lon: -122.8 };
  const h = harness(
    {
      getSnapshot({ signal, boxes }) {
        requests.push({ signal, boxes });
        return new Promise((resolve) => {
          finishObservations = resolve;
        });
      },
      async getGridSnapshot({ tiles, signal }) {
        gridSets++;
        assert.ok(tiles.length <= 6);
        assert.equal(signal.aborted, false);
        return {
          cells: [
            gridCell(tiles[0].z, {
              id: wildlifeGridCellId(row.lat, row.lon, tiles[0].z),
              lat: row.lat,
              lon: row.lon,
            }),
          ],
          totalResults: 12,
          fetchedAt: NOW,
        };
      },
    },
    {},
    { autoEnable: false },
  );
  const manager = new LayerLifecycle(null, { engine: h.engine });
  manager.register(h.layer);
  h.layer.attachDataManager(manager);
  try {
    const enabling = manager.setEnabled(h.layer.id, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0);
    h.time(NOW + 100);
    h.rectangle({ south: 48, west: -123, north: 48.4, east: -122.6 });
    h.moveEnd.emit();
    assert.equal(h.timers.size, 1, 'one camera settle timer');
    const [id, timer] = [...h.timers][0];
    h.timers.delete(id);
    h.time(NOW + 400);
    timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].boxes[0].south, 48);
    h.moveEnd.emit();
    assert.equal(requests[0].signal.aborted, false);
    h.time(NOW + 550); // Ordinary upstream response after 150 ms.
    finishObservations([row]);
    assert.equal(await enabling, true);
    assert.equal(h.badges()[0]?.id, 'wildlife:inat:1');
    assert.equal(requests.length, 1);
    assert.equal(gridSets, 1);
    assert.equal(
      h.timers.size,
      1,
      'only the bounded density fade is scheduled',
    );
    t.diagnostic(
      'Deterministic first badge: 550 ms (100 ms camera adjustment + 300 ms settle + 150 ms upstream); one observation set and one tile set, zero aborts.',
    );
  } finally {
    finishObservations?.([row]);
    await manager.destroyLayer(h.layer.id);
  }
});

test('the real manager does not report a refresh error when a pan supersedes periodic acquisition', async () => {
  let ready = true;
  let settle;
  const h = harness(
    {
      getSnapshot: async () => {
        if (ready) return [base];
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    },
    {},
    { autoEnable: false },
  );
  const manager = new LayerLifecycle(null, { engine: h.engine });
  manager.register(h.layer);
  h.layer.attachDataManager(manager);
  try {
    const enabling = manager.setEnabled(h.layer.id, true);
    await new Promise((resolve) => setImmediate(resolve));
    const [id, timer] = [...h.timers][0];
    h.timers.delete(id);
    h.time(NOW + timer.delay);
    timer.fn();
    assert.equal(await enabling, true);
    ready = false;
    const refreshing = manager.refreshLayer(h.layer.id);
    h.rectangle({ south: 48, west: -123, north: 48.4, east: -122.6 });
    h.moveEnd.emit();
    settle([base]);
    assert.equal(await refreshing, true);
    assert.equal(manager.isEnabled(h.layer.id), true);
    assert.equal(manager.layers.get(h.layer.id).managerRefreshError, null);
    assert.equal(h.layer.getStats().error, null);
  } finally {
    await manager.destroyLayer(h.layer.id);
  }
});

test('legend keeps semantic order, omits zero groups and puts one blurb first; stats expose only contract fields', async () => {
  const rows = [
    base,
    { ...base, stableId: 'inat:2', iconic: 'Fungi', lon: -122.3 },
    { ...base, stableId: 'inat:3', iconic: 'Unknown', lon: -122.2 },
  ];
  const h = harness({ getSnapshot: async () => rows });
  await h.update();
  const controls = h.layer.getRowControls();
  assert.equal(controls.chips.length, 7);
  assert.equal(controls.chips.filter((chip) => chip.label === 'ALL').length, 1);
  assert.deepEqual(
    controls.legend.map((entry) => entry.label),
    ['Birds', 'Fungi', 'Other or unknown'],
  );
  assert.deepEqual(
    ICONIC_LEGEND_ORDER.filter((group) =>
      ['Aves', 'Fungi', 'Unknown'].includes(group),
    ),
    ['Aves', 'Fungi', 'Unknown'],
  );
  assert.equal(controls.legend.filter((entry) => entry.blurb).length, 1);
  assert.match(controls.legend[0].blurb, /Not a census/);
  const allowed = new Set([
    'count',
    'lastUpdate',
    'error',
    'stale',
    'loading',
    'refreshing',
    'loadingLabel',
    'partial',
    'rawRowCount',
    'countLabel',
    'status',
    'statusMessage',
    'retryInSec',
  ]);
  assert.ok(Object.keys(h.layer.getStats()).every((key) => allowed.has(key)));
  h.layer.destroy();
});

test('filter chips keep failed desired params active, expose retry and activate normally after recovery', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw Error('iNaturalist HTTP 502');
      return [base];
    },
  });
  await h.update();
  h.layer.setParams({ taxa: 'whales', confirmed: true, ignored: 'x' });
  let chips = h.layer.getRowControls().chips;
  const whale = () => chips.find((chip) => chip.id === 'taxa-whales');
  assert.equal(whale().state, 'loading');
  assert.equal(whale().active, false);
  assert.equal(whale().disabled, true);
  fail = true;
  await h.update();
  chips = h.layer.getRowControls().chips;
  assert.equal(whale().state, 'error');
  assert.equal(whale().disabled, false);
  assert.deepEqual(h.layer.getParams(), { confirmed: true, taxa: 'whales' });
  assert.deepEqual(chips[0].params, { confirmed: true });
  fail = false;
  assert.equal(whale().active, true);
  h.layer.setParams(whale().params);
  h.time(NOW + 31_000);
  await h.update();
  chips = h.layer.getRowControls().chips;
  assert.equal(whale().state, 'active');
  assert.equal(chips[0].active, true);
  h.layer.destroy();
});

test('disjoint option edits retain every unresolved chip through revert, failure, retry and success', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw Error('iNaturalist HTTP 502');
      return [base];
    },
  });
  await h.update();
  const chip = (id) =>
    h.layer.getRowControls().chips.find((item) => item.id === id);
  h.layer.setParams({ confirmed: true });
  h.layer.setParams({ taxa: 'Aves' });
  for (const id of ['quality-confirmed', 'taxa-birds']) {
    assert.equal(chip(id).state, 'loading');
    assert.equal(chip(id).busy, true);
    assert.equal(chip(id).disabled, true);
    assert.equal(chip(id).active, false);
  }
  assert.equal(
    chip('taxa-all').active,
    true,
    'the last accepted taxa remains active',
  );
  h.layer.setParams({ confirmed: false });
  assert.equal(chip('quality-confirmed').state, 'idle');
  assert.equal(chip('quality-confirmed').busy, false);
  assert.equal(chip('taxa-birds').state, 'loading');
  h.layer.setParams({ confirmed: true });
  fail = true;
  await h.update();
  for (const id of ['quality-confirmed', 'taxa-birds']) {
    assert.equal(chip(id).state, 'error');
    assert.equal(chip(id).disabled, false);
    assert.equal(chip(id).active, true);
    assert.match(chip(id).title, /click to retry/);
  }
  assert.deepEqual(chip('quality-confirmed').params, { confirmed: true });
  h.layer.setParams(chip('taxa-birds').params);
  for (const id of ['quality-confirmed', 'taxa-birds'])
    assert.equal(
      chip(id).state,
      'loading',
      'unchanged desired params retry all unresolved options',
    );
  fail = false;
  h.time(NOW + 31_000);
  await h.update();
  for (const id of ['quality-confirmed', 'taxa-birds']) {
    assert.equal(chip(id).state, 'active');
    assert.equal(chip(id).active, true);
    assert.equal(chip(id).busy, false);
    assert.equal(chip(id).disabled, false);
  }
  assert.equal(chip('taxa-all').active, false);
  assert.deepEqual(h.layer.getParams(), { confirmed: true, taxa: 'Aves' });
  h.layer.destroy();
});

test('the initial load keeps ALL pending and the default-off CONFIRMED chip idle', async () => {
  let resolve;
  const h = harness({
    getSnapshot: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const pending = h.update();
  h.layer.setParams({ taxa: 'all', confirmed: false });
  let chips = h.layer.getRowControls().chips;
  assert.equal(chips.find((chip) => chip.id === 'taxa-all').state, 'loading');
  assert.equal(
    chips.find((chip) => chip.id === 'quality-confirmed').state,
    'idle',
  );
  resolve([base]);
  assert.equal(await pending, true);
  chips = h.layer.getRowControls().chips;
  assert.equal(chips.find((chip) => chip.id === 'taxa-all').state, 'active');
  assert.equal(
    chips.find((chip) => chip.id === 'quality-confirmed').state,
    'idle',
  );
  h.layer.destroy();
});

test('global fallback hides cards and upstream totals, and caps retained observations', async () => {
  let options;
  const h = harness({
    getSnapshot: async (value) => {
      options = value;
      return Array.from({ length: WILDLIFE_MAX_ROWS + 2 }, (_, index) => ({
        ...photographed,
        stableId: `inat:${index}`,
      }));
    },
  });
  h.height(5_000_000);
  await h.update();
  assert.equal(options.scope, 'global');
  assert.equal(options.boxes, null);
  assert.equal(h.layer.getStats().count, WILDLIFE_MAX_ROWS);
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
  assert.equal(h.layer.getStats().partial, undefined);
  assert.match(h.layer.getStats().countLabel, /sightings in view/);
  assert.equal(h.overlay.entries.get('wildlife-sightings').length, 0);
  h.layer.destroy();
});

test('a missing regional query does not claim zoom guidance at a local camera height', async () => {
  const h = harness({
    getSnapshot: () => assert.fail('wide regional view fetched'),
  });
  h.rectangle({ south: 20, west: -150, north: 60, east: -90 });
  assert.equal(await h.update(), true);
  assert.equal(h.layer.getStats().status, undefined);
  assert.equal(h.layer.getStats().statusMessage, undefined);
  h.layer.destroy();
});

test('a successful empty page keeps the selected observation until explicit deselection', async () => {
  let rows = [base];
  const h = harness({ getSnapshot: async () => rows });
  await h.update();
  h.layer.selectSighting(base.stableId);
  rows = [];
  await h.update();
  assert.equal(h.badges().length, 1);
  assert.equal(h.store.selectedEntityId, base.stableId);
  h.layer.clearSightingSelection();
  await h.update();
  assert.equal(h.badges().length, 0);
  assert.equal(h.store.selectedEntityId, null);
  h.layer.destroy();
});

test('provider credits sit in the layer row, never on the globe; Acartia failure still surfaces degradation', async () => {
  let healthy = true;
  const acartia = {
    ...base,
    stableId: 'acartia:1',
    origin: 'acartia',
    iconic: 'Mammalia',
    provider: { name: 'Synthetic Provider', entity: null },
  };
  const h = harness({
    getSnapshot: async () => [],
    getSnapshotDetail: async () => ({
      rows: healthy ? [base, acartia] : [base],
      sources: { acartia: { ok: healthy } },
    }),
  });
  await h.update();
  const onGlobe = () =>
    h.engine.fake.credits.filter((credit) => credit.onScreen).length;
  assert.equal(h.credits(), 1, 'the Acartia credit joins the attribution');
  assert.equal(onGlobe(), 0, 'no credit on the globe credit line');
  assert.equal(
    h.layer.getRowControls().info,
    'iNaturalist contributors · Acartia 1 (Salish Sea) · licences per record',
  );
  healthy = false;
  await h.update();
  assert.equal(h.layer.getStats().error, 'Acartia feed unavailable');
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
  assert.equal(
    h.layer.getRowControls().info,
    'iNaturalist contributors · licences per record',
  );
  assert.equal(onGlobe(), 0);
  h.layer.disable();
  assert.equal(onGlobe(), 0);
  h.layer.destroy();
});

test('an iNaturalist failure beside a good Acartia reply keeps both and reports degraded', async () => {
  let inatHealthy = true;
  const acartia = {
    ...base,
    stableId: 'acartia:1',
    origin: 'acartia',
    iconic: 'Mammalia',
    lon: -122.3,
    provider: { name: 'Synthetic Provider', entity: null },
  };
  const failure = Object.assign(new Error('iNaturalist HTTP 502'), {
    status: 502,
    retryAfterSec: 30,
  });
  const h = harness({
    getSnapshot: async () => [],
    getSnapshotDetail: async ({ boxes }) => ({
      rows: inatHealthy ? [base, acartia] : [acartia],
      sources: {
        inaturalist: inatHealthy
          ? { ok: true }
          : { ok: false, error: failure, failedBoxes: boxes },
        acartia: { ok: true },
      },
    }),
  });
  await h.update();
  assert.equal(h.layer.getStats().count, 2);
  inatHealthy = false;
  await h.update();
  // The failed iNaturalist area keeps its last rows; Acartia still refreshes.
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getStats().error, 'iNaturalist HTTP 502');
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
  assert.equal(
    h.layer.getRowControls().info,
    'iNaturalist contributors · Acartia 1 (Salish Sea) · licences per record',
  );
  h.layer.destroy();
});

test('ambient cards prefilter the horizon, spread over screen regions and retain visible slots', async () => {
  const rows = Array.from({ length: 32 }, (_, i) => ({
    ...photographed,
    stableId: `inat:${String(i + 1).padStart(2, '0')}`,
    lon: -122.5 + i * 0.01,
    favesCount: 1000 - i,
  }));
  const screens = new Map(
    rows.map((row, i) => [
      row.stableId,
      {
        x: 130 + (i % 8) * 150,
        y: 130 + Math.floor(i / 8) * 150,
      },
    ]),
  );
  rows.push(
    {
      ...photographed,
      stableId: 'inat:overlap',
      lon: -122.17,
      favesCount: 999.5,
    },
    {
      ...photographed,
      stableId: 'inat:edge',
      lon: -122.16,
      favesCount: 999.25,
    },
  );
  screens.set('inat:overlap', { x: 241, y: 130 }); // Same occupied region.
  screens.set('inat:edge', { x: 130, y: 242 }); // Spacing alone cannot admit a second card in that region.
  rows.unshift({
    ...photographed,
    stableId: 'inat:far',
    lon: -122.6,
    favesCount: 100000,
  });
  const h = harness(
    { getSnapshot: async () => rows },
    {
      occluderFactory: () => ({
        isPointVisible: (position) =>
          toDegrees(cartographicOf(position).longitude) > -122.55,
      }),
      project: (_scene, position) =>
        screens.get(
          rows.find(
            (row) =>
              Math.abs(
                row.lon - toDegrees(cartographicOf(position).longitude),
              ) < 1e-7,
          )?.stableId,
        ),
    },
  );
  await h.update();
  const entries = h.overlay.entries.get('wildlife-sightings');
  assert.equal(entries.length, 6);
  const expected = [
    'inat:01',
    'inat:04',
    'inat:07',
    'inat:17',
    'inat:20',
    'inat:23',
  ];
  const assertCohort = (cohort) => {
    assert.deepEqual(
      cohort.map((entry) => entry.id),
      expected.map((id) => `sighting:${id}`),
    );
    for (let i = 0; i < cohort.length; i++) {
      const a = screens.get(cohort[i].id.slice('sighting:'.length));
      for (let j = i + 1; j < cohort.length; j++) {
        const b = screens.get(cohort[j].id.slice('sighting:'.length));
        assert.ok(
          Math.hypot(a.x - b.x, a.y - b.y) >= 112,
          `${cohort[i].id} overlaps ${cohort[j].id}`,
        );
      }
    }
  };
  assertCohort(entries);
  const farDot = h.badges().find((point) => point.id === 'wildlife:inat:far');
  assert.ok(!farDot || farDot.show === false);
  assert.equal(h.frameWork(), 0);
  h.layer.selectSighting('inat:01');
  const selected = h.overlay.entries.get('wildlife-sightings-selected');
  h.moveEnd.emit();
  assert.equal(
    h.overlay.entries.get('wildlife-sightings-selected'),
    selected,
    'moveEnd never republishes selected cards',
  );
  assert.equal(h.overlay.entries.get('wildlife-sightings').length, 6);
  assertCohort(h.overlay.entries.get('wildlife-sightings'));
  h.layer.destroy();
});

function gridCell(z, extra = {}) {
  return {
    id: wildlifeGridCellId(base.lat, base.lon, z),
    lat: base.lat,
    lon: base.lon,
    cellCount: 12,
    ...extra,
  };
}

// Keep request/selection fixtures compact enough for the six-tile budget.
function gridHarness(source, extra) {
  return harness(source, extra, { width: 896, height: 896 });
}

test('observations publish real badges while grid acquisition is still pending', async () => {
  let finishGrid;
  const h = gridHarness({
    getSnapshot: async () => [base],
    getGridSnapshot: () =>
      new Promise((resolve) => {
        finishGrid = resolve;
      }),
  });
  h.time(NOW + 500);
  const updating = h.layer.update();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.badges()[0]?.id, 'wildlife:inat:1');
    assert.equal(h.layer.getStats().count, 1);
    assert.equal(h.frameWork(), 0, 'acquisition adds no frame work');
  } finally {
    finishGrid({ cells: [], totalResults: 0, fetchedAt: NOW });
    await updating;
    await new Promise((resolve) => setImmediate(resolve));
    h.layer.destroy();
  }
});

test('each arriving tile extends the density glow before the remaining tiles finish', async () => {
  let publishTile;
  let finishGrid;
  let cells;
  let tiles;
  const h = gridHarness({
    getSnapshot: async () => [],
    getGridSnapshot(options) {
      publishTile = options.onTile;
      tiles = options.tiles;
      cells = [
        gridCell(tiles[0].z),
        gridCell(tiles[0].z, {
          id: wildlifeGridCellId(base.lat, base.lon + 0.2, tiles[0].z),
          lon: base.lon + 0.2,
          cellCount: 9,
        }),
      ];
      return new Promise((resolve) => {
        finishGrid = resolve;
      });
    },
  });
  h.time(NOW + 500);
  const updating = h.layer.update();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    publishTile?.(
      { cells: [cells[0]], totalResults: 12, fetchedAt: NOW },
      { tile: tiles[0] },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.badges().length, 0);
    assert.equal(h.glow().options.pickable, false);
    assert.equal(h.glow().store.count, 1);
    assert.equal(h.layer.getStats().countLabel, '12 sightings in view');
    publishTile?.(
      { cells: [cells[1]], totalResults: 9, fetchedAt: NOW },
      { tile: tiles[1] || tiles[0] },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.badges().length, 0);
    assert.equal(h.glow().store.count, 2);
    assert.equal(h.layer.getStats().countLabel, '21 sightings in view');
    assert.equal(h.frameWork(), 1, 'only the glow follows the camera');
  } finally {
    finishGrid({ cells, totalResults: 21, fetchedAt: NOW });
    await updating;
    await new Promise((resolve) => setImmediate(resolve));
    h.layer.destroy();
  }
});

test('grid-only views draw nonpickable glow without observation badges, labels or cards', async () => {
  const h = gridHarness({
    getSnapshot: async () => [],
    getGridSnapshot: async ({ tiles }) => ({
      cells: [gridCell(tiles[0].z)],
      totalResults: 12,
      fetchedAt: NOW,
    }),
  });
  h.height(1_500_000);
  await h.update();
  assert.equal(h.badges().length, 0);
  const glow = h.glow();
  assert.ok(glow);
  assert.equal(glow.options.pickable, false);
  assert.equal(glow.store.count, 1);
  assert.equal(
    glow.store.pickIds[0],
    undefined,
    'density has no pick identity',
  );
  assert.equal(h.layer.getStats().countLabel, '12 sightings in view');
  assert.deepEqual(h.overlay.entries.get('wildlife-sightings-labels'), []);
  assert.deepEqual(h.overlay.entries.get('wildlife-sightings-selected'), []);
  assert.equal(h.focus.length, 0);
  assert.equal(h.frameWork(), 1, 'only the glow follows the camera');
  h.layer.disable();
  assert.equal(h.glow(), undefined);
  assert.equal(h.frameWork(), 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.engine.movers.list(), [], 'no glow remains');
  h.layer.enable();
  await h.update();
  assert.ok(h.glow());
  h.layer.destroy();
  assert.equal(h.glow(), undefined);
  assert.deepEqual(h.engine.movers.list(), []);
  assert.equal(h.timers.size, 0);
});

test('height and upstream sample totals retain the same loaded sighting and grid count', async () => {
  let partialSample = false;
  let gridRequests = 0;
  const h = gridHarness({
    getSnapshot: async () => [base],
    getSnapshotDetail: async () => ({
      rows: [base],
      totalResults: partialSample ? 100 : 1,
      partial: partialSample,
    }),
    async getGridSnapshot({ tiles }) {
      gridRequests++;
      return {
        cells: [gridCell(tiles[0].z)],
        totalResults: 12,
        fetchedAt: NOW,
      };
    },
  });
  await h.update();
  assert.equal(h.badges()[0].id, 'wildlife:inat:1');
  h.height(450_000);
  await h.update();
  assert.equal(h.badges()[0].id, 'wildlife:inat:1');
  h.height(410_000);
  h.moveEnd.emit();
  assert.equal(h.badges()[0].id, 'wildlife:inat:1');
  h.height(350_000);
  await h.update();
  assert.equal(h.badges()[0].id, 'wildlife:inat:1');
  h.height(30_000);
  partialSample = true;
  await h.update();
  assert.equal(h.badges()[0].id, 'wildlife:inat:1');
  assert.equal(gridRequests, 4);
  assert.equal(h.layer.getStats().countLabel, '12 sightings in view');
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
  h.layer.destroy();
});

test('close and wide views wait for loaded common-name labels without unnamed label candidates or frame work', async (t) => {
  for (const heightM of [30_000, 7_000_000]) {
    let rows = [{ ...base, commonName: null }];
    let projections = 0;
    const h = gridHarness(
      {
        getSnapshot: async () => rows,
        getGridSnapshot: async ({ tiles }) => ({
          cells: [gridCell(tiles[0].z)],
          fetchedAt: NOW,
        }),
      },
      {
        project() {
          projections++;
          return { x: 400, y: 400 };
        },
      },
    );
    t.after(() => h.layer.destroy());
    h.height(heightM);
    await h.update();
    const point = h.badges()[0];
    assert.ok(point, `${heightM}m: unnamed contacts still have icons`);
    assert.deepEqual(h.overlay.entries.get('wildlife-sightings-labels'), []);
    // Only observation icons require screen projections; unnamed contacts
    // never add the separate label candidate pass.
    assert.equal(
      projections,
      1,
      'only the real observation is projected; unnamed rows add no label pass',
    );

    rows = [{ ...base, commonName: 'Red-tailed Hawk' }];
    await h.update();
    assert.equal(
      h.badges()[0].id,
      point.id,
      `${heightM}m: a newly known name reuses the icon`,
    );
    const labels = h.overlay.entries.get('wildlife-sightings-labels');
    assert.equal(labels.length, 1);
    assert.equal(labels[0].title, 'RED-TAILED HAWK');
    assert.equal(labels[0].collisionGroup, 'ambient-label');
    assert.equal(labels[0].protected, undefined);
    assert.equal(labels[0].selected, undefined);
    const settled = projections;
    h.engine.fake.frames(10);
    assert.equal(
      projections,
      settled,
      `${heightM}m: parked frames never rebuild label candidates`,
    );

    rows = [{ ...base, commonName: '  ' }];
    await h.update();
    assert.deepEqual(h.overlay.entries.get('wildlife-sightings-labels'), []);
    h.layer.destroy();
  }
});

test('selecting an unnamed observation preserves the selection without inventing a category label', async (t) => {
  const h = harness({
    getSnapshot: async () => [{ ...base, commonName: null }],
  });
  t.after(() => h.layer.destroy());
  const selections = [];
  h.layer.subscribeSelection((row) => selections.push(row));
  await h.update();
  h.pick({ id: h.badges()[0].id });
  h.click({ position: { x: 400, y: 400 } });
  assert.equal(selections.at(-1).stableId, base.stableId);
  assert.deepEqual(h.overlay.entries.get('wildlife-sightings-selected'), []);
  assert.deepEqual(h.overlay.entries.get('wildlife-sightings-labels'), []);
});

test('unavailable grids fail closed to visible sampled sprites without a global newest-total claim', async () => {
  const h = gridHarness({
    getSnapshot: async () => [base],
    getSnapshotDetail: async () => ({
      rows: [base],
      totalResults: 160645,
      partial: true,
    }),
    getGridSnapshot: async () => {
      throw Error('Malformed iNaturalist grid response');
    },
  });
  h.height(5_000_000);
  await h.update();
  assert.equal(h.badges()[0].id, 'wildlife:inat:1');
  assert.ok(h.badgeSet().options.sprite.sizePx * 0.5 >= 8);
  assert.equal(h.layer.getStats().count, 1);
  assert.match(h.layer.getStats().countLabel, /sightings in view/);
  assert.equal(h.layer.getStats().partial, undefined);
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
  assert.match(h.layer.getStats().error, /Malformed iNaturalist grid response/);
  assert.equal(
    h.layer.getStats().retryInSec,
    undefined,
    'schema errors do not start upstream cooldown',
  );
  assert.equal(
    h.overlay.entries.get('wildlife-sightings-labels')[0].title,
    'SYNTHETIC BIRD',
  );
  h.layer.destroy();
});

test('an oversized view coarsens to a complete grid within the six-tile cap', async () => {
  const h = harness(
    {
      getSnapshot: async () => [base],
      getGridSnapshot: async ({ tiles }) => {
        assert.ok(tiles.length > 0 && tiles.length <= 6);
        return {
          cells: [gridCell(tiles[0].z)],
          totalResults: 12,
          fetchedAt: NOW,
        };
      },
    },
    { project: () => ({ x: 400, y: 400 }) },
    { width: 4000, height: 4000 },
  );
  h.rectangle({ south: -85, west: -180, north: 85, east: 180 });
  h.height(7_000_000);
  await h.update();
  assert.equal(h.badges().length, 1);
  assert.equal(h.badges()[0].id, 'wildlife:inat:1');
  assert.match(h.layer.getStats().countLabel, /sightings in view/);
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
  h.layer.destroy();
});

test('label candidates are bounded after on-screen and horizon filtering, with names only', async () => {
  const rows = Array.from({ length: 220 }, (_, index) => ({
    ...base,
    stableId: `inat:${index}`,
    commonName: `Synthetic bird ${index}`,
    lat: 47.5 + index / 2000,
    lon: -122.5 + index / 2000,
  }));
  const h = harness(
    { getSnapshot: async () => rows },
    {
      project: (_scene, position) => ({
        x:
          cartographicOf(position).latitude > toRadians(47.6)
            ? 3000
            : 30 +
              (Math.round(
                (toDegrees(cartographicOf(position).latitude) - 47.5) * 2000,
              ) %
                50) *
                28,
        y:
          30 +
          Math.floor(
            Math.round(
              (toDegrees(cartographicOf(position).latitude) - 47.5) * 2000,
            ) / 50,
          ) *
            28,
      }),
      occluderFactory: () => ({
        isPointVisible: (position) =>
          cartographicOf(position).latitude < toRadians(47.59),
      }),
    },
  );
  await h.update();
  const labels = h.overlay.entries.get('wildlife-sightings-labels');
  assert.equal(labels.length, 150);
  assert.ok(
    labels.every(
      (entry) =>
        entry.title.startsWith('SYNTHETIC BIRD ') &&
        entry.details === undefined,
    ),
  );
  assert.ok(
    labels.every(
      (entry) => cartographicOf(entry.position).latitude < toRadians(47.59),
    ),
  );
  assert.equal(h.frameWork(), 0);
  h.layer.destroy();
});

test('accepted observation refreshes publish immediately and disable clears their badges', async () => {
  let rows = [base];
  const h = harness({ getSnapshot: async () => rows });
  await h.update();
  const point = h.badges()[0];
  for (const lon of [-122.35, -122.3, -122.25]) {
    rows = [{ ...base, lon }];
    await h.layer.update();
    assert.equal(h.badges()[0].id, point.id);
    assert.ok(
      Math.abs(cartographicOf(point.position).longitude - toRadians(lon)) <
        1e-12,
    );
    assert.equal(h.timers.size, 0, 'observation rendering adds no batch delay');
  }
  h.layer.disable();
  assert.equal(h.timers.size, 0);
  assert.equal(h.badges().length, 0);
  h.layer.destroy();
});

test('a grid result for the previous global view cannot mark new camera tiles loaded', async () => {
  let settle;
  let requests = 0;
  const h = gridHarness({
    getSnapshot: async () => [base],
    getGridSnapshot: ({ tiles }) => {
      requests++;
      return new Promise((resolve) => {
        settle = () =>
          resolve({
            cells: [gridCell(tiles[0].z)],
            totalResults: 12,
            fetchedAt: NOW,
          });
      });
    },
  });
  h.height(5_000_000);
  h.time(NOW + 500);
  const updating = h.layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  h.rectangle({ south: -30, west: 60, north: 20, east: 120 });
  settle();
  await updating;
  assert.equal(
    h.badges().filter((point) => point.id.startsWith('wildlife:grid:')).length,
    0,
    'old tile result is rejected before moveEnd',
  );
  h.moveEnd.emit();
  assert.equal(h.timers.size, 1, 'new camera view remains due for acquisition');
  assert.equal(requests, 1);
  h.layer.destroy();
});

test('clearing a selected contact restores its cached ambient label without projecting candidates again', async () => {
  let projects = 0;
  const h = harness(undefined, {
    project: () => {
      projects++;
      return { x: 400, y: 400 };
    },
  });
  await h.update();
  const baseline = projects;
  assert.equal(h.overlay.entries.get('wildlife-sightings-labels').length, 1);
  h.pick({ id: 'wildlife:inat:1' });
  const renders = h.renders.length;
  h.click({ position: { x: 1, y: 1 } });
  assert.equal(h.renders.length - renders, 1);
  assert.equal(h.overlay.entries.get('wildlife-sightings-labels').length, 0);
  assert.equal(h.overlay.entries.get('wildlife-sightings-selected').length, 1);
  h.layer.clearSightingSelection();
  assert.equal(h.overlay.entries.get('wildlife-sightings-labels').length, 1);
  assert.equal(h.overlay.entries.get('wildlife-sightings-selected').length, 0);
  assert.equal(projects, baseline);
  h.layer.destroy();
});

test('visible photo cards survive a pan into the same icon bucket and a different random sample', async () => {
  let rows = [
    photographed,
    { ...photographed, stableId: 'inat:2', lon: -122.2 },
  ];
  let collapsed = false;
  const h = harness(
    { getSnapshot: async () => rows },
    {
      project: (_scene, position) => ({
        x:
          collapsed || toDegrees(cartographicOf(position).longitude) < -122.3
            ? 400
            : 700,
        y: 400,
      }),
    },
  );
  await h.update();
  for (const image of h.images) image.onload?.();
  const ids = () =>
    h.overlay.entries
      .get('wildlife-sightings')
      .map((entry) => entry.id)
      .sort();
  const initial = ids();
  assert.equal(initial.length, 2);
  collapsed = true;
  h.moveEnd.emit();
  assert.equal(h.badges().length, 1, 'one icon in the shared bucket');
  assert.deepEqual(
    ids(),
    initial,
    'both visible incumbent photo cards keep their anchors',
  );
  rows = [];
  await h.update();
  assert.deepEqual(
    ids(),
    initial,
    'a fresh random sample cannot evict visible cards',
  );
  assert.equal(
    h.layer.selectSighting('inat:2'),
    true,
    'retained card remains selectable',
  );
  h.layer.destroy();
});

test('cold ground cells start on the ellipsoid and one bounded resolve per batch lifts them, without scene sampling', async () => {
  const h = harness(undefined, {}, { autoEnable: false });
  let warm = false;
  let reads = 0;
  h.ground.sample = () => {
    reads++;
    return warm ? 250 : null;
  };
  h.init();
  h.layer.enable();
  await h.update();
  const point = h.badges()[0];
  const pointHeight = () => heightOf(point.position);
  assert.ok(
    Math.abs(pointHeight()) < 0.01,
    'cold cell anchors on the ellipsoid',
  );
  assert.equal(h.ground.resolves, 1, 'one bounded resolve for the batch');
  warm = true;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    Math.abs(pointHeight() - 250) < 0.01,
    'resolved cell lifts in place',
  );
  assert.equal(h.badges()[0].id, point.id);
  const before = reads;
  h.moveEnd.emit();
  assert.ok(reads - before <= h.badges().length);
  assert.equal(h.ground.resolves, 1, 'warm cells do not resolve again');
  h.layer.destroy();
});

test('an engine switch keeps the data and selection and redraws the same badges and glow on the next engine', async () => {
  let requests = 0;
  const rows = [
    photographed,
    { ...base, stableId: 'inat:2', lon: -122.3, iconic: 'Mammalia' },
    {
      ...base,
      stableId: 'inat:3',
      lon: -122.2,
      obscured: true,
      cell: { south: 47.5, west: -122.3, north: 47.7, east: -122.1 },
    },
  ];
  const h = harness({
    getSnapshot: async () => {
      requests++;
      return rows;
    },
    getGridSnapshot: async ({ tiles }) => ({
      cells: [gridCell(tiles[0].z)],
      totalResults: 12,
      fetchedAt: NOW,
    }),
  });
  const firstCells = watchCells(h.engine);
  await h.update();
  assert.equal(h.layer.selectSighting('inat:1'), true);
  const drawn = (engine) =>
    h.badges(engine).map((badge) => ({
      id: badge.id,
      position: badge.position,
      cell: badge.cell,
      show: badge.show,
      scale: badge.scale,
      color: badge.color,
    }));
  const style = (engine) => {
    const { options } = h.badgeSet(engine);
    return {
      order: options.order,
      depthTest: options.depthTest,
      pickable: options.pickable,
      sizePx: options.sprite.sizePx,
      scaleByDistance: [...options.sprite.scaleByDistance],
      cells: options.sprite.atlas.cells,
    };
  };
  const glow = (engine) => {
    const set = engine.fake.moverSet(WILDLIFE_DENSITY_SET_ID);
    return {
      count: set.store.count,
      pickable: set.options.pickable,
      positions: [...set.store.positions.subarray(0, set.store.count * 3)],
    };
  };
  const first = h.engine;
  const before = drawn(first);
  assert.equal(before.length, 3);
  const beforeStyle = style(first);
  const beforeGlow = glow(first);
  assert.equal(beforeGlow.count, 1);
  const cell = firstCells();
  const stats = h.layer.getStats();

  h.layer.detachRenderer();
  assert.deepEqual(first.movers.list(), [], 'nothing stays drawn');
  assert.deepEqual(first.lines.list(), []);
  assert.deepEqual(first.ground.list(), []);
  assert.equal(first.camera.moveEnd.numberOfListeners, 0);
  assert.equal(first.frames.preRender.numberOfListeners, 0);
  assert.equal(first.frames.postRender.numberOfListeners, 0);
  assert.equal(h.inputs(), 0, 'no click listener on the old engine');
  assert.equal(h.owners.size, 0);
  assert.equal(h.overlay.visible.get('wildlife-sightings-selected'), false);

  const other = ENGINE_KINDS.find((kind) => kind !== h.engine.kind);
  const next = h.globe(other);
  const nextCells = watchCells(next);
  assert.equal(h.layer.attachRenderer({ engine: next }), true);
  h.flushIdle();
  assert.deepEqual(drawn(next), before, 'the same badges, drawn the same');
  assert.deepEqual(style(next), beforeStyle);
  assert.deepEqual(glow(next), beforeGlow);
  assert.deepEqual(
    nextCells().items,
    cell.items,
    'same draped cell colours and bounds',
  );
  assert.equal(requests, 1, 'the retained view needs no new request');
  assert.equal(h.layer.getStats().count, stats.count);
  assert.equal(
    h.overlay.entries.get('wildlife-sightings-selected')[0].id,
    'wildlife-sightings-label:inat:1',
    'the selection carries over',
  );
  assert.equal(h.overlay.visible.get('wildlife-sightings-selected'), true);
  assert.equal(h.owners.size, 1);
  assert.equal(h.inputs(), 1);

  h.pick({ id: 'wildlife:inat:2' });
  next.fake.input('click', { position: { x: 1, y: 1 } });
  assert.equal(
    h.store.selectedEntityId,
    'inat:2',
    'clicks reach the new engine',
  );
  // The camera debounce is the one timer of 600 ms or more.
  const debounces = () =>
    [...h.timers.values()].filter(({ delay }) => delay >= 600).length;
  h.rectangle({ south: 48, west: -123, north: 48.4, east: -122.6 });
  first.fake.emit('camera.moveEnd');
  assert.equal(debounces(), 0, 'the old camera is no longer followed');
  next.fake.emit('camera.moveEnd');
  assert.equal(debounces(), 1, 'the new camera schedules acquisition');
  h.layer.destroy();
  assert.deepEqual(next.movers.list(), []);
  assert.deepEqual(next.lines.list(), []);
});
