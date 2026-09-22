import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createWorldNewsLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';
import { WORLD_NEWS_OVERLAY_SOURCE_ID } from './policy.js';

const ROTTERDAM = 'wn-place:51.920:4.480';
const TOKYO = 'wn-place:35.680:139.690';

function fakeViewer() {
  const sources = [];
  return {
    sources,
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        const index = sources.indexOf(value);
        if (index >= 0) sources.splice(index, 1);
        return index >= 0;
      },
    },
    scene: {
      canvas: {
        disableRootEvents: true,
        onwheel: null,
        addEventListener() {},
        removeEventListener() {},
      },
      pick: () => null,
    },
    camera: {},
    creditDisplay: { addStaticCredit() {} },
  };
}

/**
 * A camera framing a city, so "NEWS IN VIEW" has a circle to ask for. Without
 * one the default fake viewer reports no view rectangle at all, which is a
 * global-band view and leaves the chip correctly disabled.
 */
function framedCamera({ lat = 55.75, lon = 37.62, spanDeg = 0.5 } = {}) {
  const listeners = new Set();
  return {
    listeners,
    settle: () => {
      for (const fn of [...listeners]) fn();
    },
    camera: {
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(
          lon - spanDeg / 2,
          lat - spanDeg / 2,
          lon + spanDeg / 2,
          lat + spanDeg / 2,
        ),
      positionCartographic: Cesium.Cartographic.fromDegrees(lon, lat, 60_000),
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(lon, lat),
      moveEnd: {
        addEventListener: (fn) => listeners.add(fn),
        removeEventListener: (fn) => listeners.delete(fn),
      },
    },
  };
}

function fakeServices() {
  const calls = [];
  const store = { entities: new Map(), selectedId: null };
  const owners = new Map();
  return {
    calls,
    store,
    owners,
    render: {
      governorRequestRender(reason) {
        calls.push(['render', reason]);
      },
    },
    picking: {
      registerPickOwner(layerId, predicate) {
        owners.set(layerId, predicate);
        calls.push(['registerPickOwner', layerId]);
      },
      unregisterPickOwner(layerId) {
        owners.delete(layerId);
        calls.push(['unregisterPickOwner', layerId]);
      },
      resolvePickId(picked) {
        const id = picked?.id;
        if (typeof id === 'string') return id;
        return typeof id?.id === 'string' ? id.id : null;
      },
      isOwnedByOtherLayer(layerId, pickedId) {
        for (const [owner, predicate] of owners)
          if (owner !== layerId && predicate(pickedId)) return true;
        return false;
      },
    },
    context: {
      registerEntityContext(entity, metadata) {
        entity.__gevContextId = metadata.id;
        store.entities.set(metadata.id, { ...metadata, entity });
        calls.push(['register', metadata.id]);
      },
      selectEntityContext(entity) {
        const id = entity?.__gevContextId;
        if (!id || !store.entities.has(id)) return null;
        store.selectedId = id;
        calls.push(['select', id]);
        return store.entities.get(id);
      },
      getSelectedEntityContext() {
        return store.selectedId
          ? store.entities.get(store.selectedId) || null
          : null;
      },
      clearSelectedEntityContextForLayer(layerId, { evicted = false } = {}) {
        const record = store.selectedId
          ? store.entities.get(store.selectedId)
          : null;
        if (record?.layerId === layerId) {
          store.selectedId = null;
          calls.push(['clear', layerId, evicted]);
        }
      },
      removeEntityContextsForLayer(layerId, { retainIds } = {}) {
        for (const [id, record] of store.entities)
          if (record.layerId === layerId && !retainIds?.has(id))
            store.entities.delete(id);
        if (store.selectedId && !store.entities.has(store.selectedId))
          store.selectedId = null;
      },
    },
    overlays: {
      refreshReadout(entity) {
        calls.push(['refreshReadout', entity.id]);
      },
    },
    credits: {
      register(viewer, credit) {
        calls.push(['credit', credit.key]);
        return true;
      },
    },
  };
}

function fakeOverlayHost() {
  const events = [];
  return {
    events,
    setEntries(...args) {
      events.push(['set', ...args]);
    },
    setVisible(...args) {
      events.push(['visible', ...args]);
    },
    clearSource(...args) {
      events.push(['clear', ...args]);
    },
  };
}

function fakeHandlerFactory() {
  const handlers = [];
  return {
    handlers,
    factory: () => {
      const handler = {
        actions: new Map(),
        destroyed: false,
        setInputAction(callback, type) {
          handler.actions.set(type, callback);
        },
        destroy() {
          handler.destroyed = true;
        },
        click(position = { x: 1, y: 1 }) {
          handler.actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
            position,
          });
        },
      };
      handlers.push(handler);
      return handler;
    },
  };
}

function row(overrides = {}) {
  const publishedAt = overrides.publishedAt ?? '2026-09-15T06:00:00Z';
  return {
    id: 'wn-a',
    title: 'Port strike halts shipping in Rotterdam',
    url: 'https://a.example/1',
    domain: 'a.example',
    publishedAt,
    publishedMs: publishedAt ? Date.parse(publishedAt) : null,
    sentiment: -0.5,
    category: 'business',
    language: 'en',
    sourceCountry: 'nl',
    lat: 51.92,
    lon: 4.48,
    place: 'Rotterdam',
    placeFoundIn: 'title',
    placeMentions: 1,
    ...overrides,
  };
}
const ROW_A = row();
const ROW_B = row({
  id: 'wn-b',
  title: 'Rotterdam museum reopens after renovation',
  url: 'https://b.example/2',
  domain: 'b.example',
  publishedAt: '2026-09-15T05:00:00Z',
  sentiment: 0.6,
  lat: 51.9201,
  lon: 4.4801,
});
const ROW_C = row({
  id: 'wn-c',
  title: 'Heat advisory extended across Tokyo',
  url: 'https://c.example/3',
  domain: 'c.example',
  publishedAt: '2026-09-15T07:00:00Z',
  sentiment: null,
  lat: 35.68,
  lon: 139.69,
  place: 'Tokyo',
});

function snapshot(rows, overrides = {}) {
  return {
    rows,
    fetchedAt: 1_757_916_000_000,
    stale: false,
    blocked: null,
    budget: { spent: 4, limit: 50, date: '2026-09-15' },
    quota: { left: 90, used: 10 },
    requested: 20,
    unplacedCount: 20 - rows.length,
    morePagesLeft: 2,
    costPerRequest: 2,
    costMeasured: true,
    ...overrides,
  };
}

function harness(
  source,
  { credit = { key: 'test-credit', html: 'x' }, framed = null, clock } = {},
) {
  const viewer = fakeViewer();
  if (framed) viewer.camera = framed.camera;
  const services = fakeServices();
  const overlayHost = fakeOverlayHost();
  const handlers = fakeHandlerFactory();
  const opened = [];
  const layer = createWorldNewsLayer({
    source,
    services,
    overlayHost,
    credit,
    openArticle: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: handlers.factory,
    ...(clock ? { clock } : {}),
  });
  layer.init(viewer);
  layer.enable(viewer);
  return {
    layer,
    viewer,
    services,
    overlayHost,
    opened,
    handler: handlers.handlers[0],
    entities: () => viewer.sources[0]?.entities.values ?? [],
    chips: () => layer.getRowControls().chips,
    chip: (id) => layer.getRowControls().chips.find((chip) => chip.id === id),
    setEvents: () =>
      overlayHost.events.filter(
        ([op, sourceId]) =>
          op === 'set' && sourceId === WORLD_NEWS_OVERLAY_SOURCE_ID,
      ),
  };
}

test('construction validates its collaborators before touching a scene', () => {
  const services = fakeServices();
  const overlayHost = fakeOverlayHost();
  const source = { getSnapshot: async () => snapshot([]) };
  assert.throws(
    () => createWorldNewsLayer({ services, overlayHost }),
    /snapshot source/,
  );
  assert.throws(
    () => createWorldNewsLayer({ source, services }),
    /overlay host/,
  );
  assert.throws(
    () =>
      createWorldNewsLayer({
        source,
        overlayHost,
        services: { render: services.render },
      }),
    /context, picking and render/,
  );
  const layer = createWorldNewsLayer({ source, services, overlayHost });
  assert.equal(layer.id, 'world-news');
  assert.equal(layer.requiresKeyId, 'world-news');
  assert.equal(layer.updateInterval, 600_000);
  const viewer = fakeViewer();
  layer.init(viewer);
  assert.throws(() => layer.init(viewer), /already initialized/);
  layer.destroy(viewer);
});

test('lifecycle: pins, contexts, ambient labels and readout hooks follow enable/update/disable/destroy', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([ROW_A, ROW_B, ROW_C]),
  });
  assert.equal(
    h.services.owners.has('world-news'),
    true,
    'pick owner registered on enable',
  );
  assert.equal(await h.layer.update(h.viewer), true);

  const stats = h.layer.getStats();
  assert.equal(stats.count, 2, 'one pin per place');
  assert.equal(stats.countLabel, '3 pinned');
  assert.equal(
    stats.lastUpdate,
    1_757_916_000_000,
    'data age, not response age',
  );
  assert.equal(stats.keyRequired, false);
  assert.equal(stats.error, null);
  assert.equal(stats.status, undefined);
  assert.match(
    stats.loadingLabel,
    /^3 of 20 latest headlines place-tagged · updated /,
  );
  assert.equal(layerFeedState(stats), 'nominal');

  assert.equal(h.services.owners.get('world-news')(ROTTERDAM), true);
  assert.equal(
    h.services.owners.get('world-news')('wn-a'),
    false,
    'stories are not pick targets, places are',
  );

  const entities = h.entities();
  assert.deepEqual(
    entities.map((entity) => entity.id).sort(),
    [TOKYO, ROTTERDAM].sort(),
  );
  const rotterdam = entities.find((entity) => entity.id === ROTTERDAM);
  assert.equal(rotterdam.gevTrackedId, ROTTERDAM);
  assert.equal(
    typeof rotterdam.gevDisplayPosition,
    'function',
    'the readout card requires a function',
  );
  const anchor = rotterdam.gevDisplayPosition();
  assert.ok(anchor instanceof Cesium.Cartesian3 && Number.isFinite(anchor.x));
  assert.equal(
    rotterdam.point.pixelSize.getValue(),
    11,
    '8 + 2*sqrt(2) rounded',
  );
  assert.equal(
    rotterdam.gevLabelModel.title,
    ROW_A.title,
    'newest story first',
  );
  assert.deepEqual(rotterdam.gevLabelModel.details.slice(1), [
    'Rotterdam · 1/2 stories here · click the pin for the next',
    'TONE NEGATIVE (-0.50)',
    // A story with a link says so: the card itself opens the publisher.
    'Click this card to open · World News API',
  ]);
  assert.equal(rotterdam.gevLabelModel.interactive, true);
  assert.equal(rotterdam.gevLabelModel.url, ROW_A.url);
  assert.equal(rotterdam.gevLabelModel.accent, '#ff5c8a');

  const context = h.services.store.entities.get(ROTTERDAM);
  assert.equal(context.layerId, 'world-news');
  assert.equal(context.layerName, 'World News');
  assert.equal(context.label, 'Headline place');
  assert.deepEqual(context.properties, {
    place: 'Rotterdam',
    count: 2,
    newestPublishedAt: ROW_A.publishedAt,
    headline: ROW_A.title,
    domain: 'a.example',
    url: 'https://a.example/1',
  });
  const forbidden =
    /author|person|organi[sz]ation|\bper\b|\borg\b|entities|summary|text|image/i;
  for (const key of [
    ...Object.keys(context),
    ...Object.keys(context.properties),
  ])
    assert.doesNotMatch(key, forbidden, `context leaks ${key}`);

  const sets = h.setEvents();
  assert.equal(sets.length, 1);
  const [, , entries, options] = sets[0];
  assert.deepEqual(options, {
    cohortLimit: 48,
    collisionCapacity: 24,
    moving: false,
  });
  assert.deepEqual(
    entries.map((entry) => entry.title),
    ['Rotterdam · 2', 'Tokyo'],
    'busier places outrank fresher single stories',
  );
  assert.equal(
    entries[0].position,
    rotterdam.gevNewsPosition,
    'label and pin share one anchor',
  );

  h.layer.disable(h.viewer);
  assert.equal(
    h.services.owners.has('world-news'),
    false,
    'pick owner released on disable',
  );
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.layer.getStats().countLabel, '');
  assert.equal(h.entities().length, 0);
  assert.equal(h.services.store.entities.size, 0, 'contexts pruned');
  assert.ok(
    h.overlayHost.events.some(
      ([op, id]) => op === 'clear' && id === WORLD_NEWS_OVERLAY_SOURCE_ID,
    ),
  );
  assert.deepEqual(h.overlayHost.events.at(-1), [
    'visible',
    WORLD_NEWS_OVERLAY_SOURCE_ID,
    false,
  ]);

  h.layer.destroy(h.viewer);
  assert.equal(h.viewer.sources.length, 0, 'data source removed');
  assert.equal(h.handler.destroyed, true);
});

test('a keyless proxy keeps the toggle on and reports KEY REQUIRED', async () => {
  let keyed = false;
  const h = harness({
    getSnapshot: async () =>
      keyed ? snapshot([ROW_C]) : { keyRequired: true },
  });
  assert.equal(
    await h.layer.update(h.viewer),
    true,
    'false would revert the enable',
  );
  const stats = h.layer.getStats();
  assert.equal(stats.keyRequired, true);
  assert.equal(stats.error, 'KEY REQUIRED');
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.loadingLabel, 'KEY REQUIRED');
  assert.equal(stats.count, 0);
  assert.equal(layerFeedState(stats), 'unavailable');
  assert.equal(h.chip('load-more').disabled, true);
  assert.match(h.chip('load-more').title, /key/i);

  keyed = true;
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.layer.getStats().keyRequired, false);
  assert.equal(h.layer.getStats().count, 1);
  h.layer.destroy(h.viewer);
});

test('an upstream fault degrades the row but keeps the previous headlines', async () => {
  let fail = null;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw fail;
      return snapshot([ROW_A, ROW_B]);
    },
  });
  assert.equal(await h.layer.update(h.viewer), true);
  fail = Object.assign(new Error('World News HTTP 502'), { code: 'upstream' });
  assert.equal(
    await h.layer.update(h.viewer),
    true,
    'a refresh failure is not a rejection',
  );
  let stats = h.layer.getStats();
  assert.equal(stats.error, 'World News HTTP 502');
  assert.equal(stats.count, 1, 'last good pins stay');
  assert.equal(stats.loadingLabel, 'World News HTTP 502');
  assert.equal(layerFeedState(stats), 'degraded');

  fail = Object.assign(new Error('World News quota exhausted'), {
    code: 'quota',
  });
  assert.equal(await h.layer.update(h.viewer), true);
  stats = h.layer.getStats();
  assert.equal(stats.blocked, 'quota');
  assert.equal(
    stats.loadingLabel,
    'PROVIDER QUOTA EXHAUSTED · resets 00:00 UTC',
  );
  assert.equal(
    stats.error,
    'PROVIDER QUOTA EXHAUSTED · resets 00:00 UTC',
    'with data the row names the block and when it lifts',
  );
  assert.equal(layerFeedState(stats), 'degraded');
  assert.equal(h.chip('load-more').disabled, true);

  const empty = harness({
    getSnapshot: async () => {
      throw Object.assign(new Error('daily news budget exhausted'), {
        code: 'budget',
      });
    },
  });
  assert.equal(await empty.layer.update(empty.viewer), true);
  stats = empty.layer.getStats();
  // The local cap is not the provider's quota, so the row must say which one
  // stopped it and which knob lifts it. With no payload to quote there are no
  // numbers, only the cause.
  assert.equal(
    stats.error,
    'LOCAL DAILY CAP REACHED · raise WORLD_NEWS_DAILY_POINT_BUDGET',
  );
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.stale, true);
  assert.equal(layerFeedState(stats), 'unavailable');
  h.layer.destroy(h.viewer);
  empty.layer.destroy(empty.viewer);
});

test('stale, budget-limited and empty batches read honestly on the chip', async () => {
  let reply = snapshot([ROW_A], { stale: true });
  const h = harness({ getSnapshot: async () => reply });
  await h.layer.update(h.viewer);
  let stats = h.layer.getStats();
  assert.equal(stats.stale, true);
  assert.match(stats.loadingLabel, /^STALE · cached /);
  assert.equal(layerFeedState(stats), 'stale');

  reply = snapshot([ROW_A], { blocked: 'budget', morePagesLeft: 0 });
  await h.layer.update(h.viewer);
  stats = h.layer.getStats();
  assert.equal(
    stats.stale,
    true,
    'a budget-frozen cache ages like a stale one',
  );
  assert.match(
    stats.loadingLabel,
    /^LOCAL DAILY CAP REACHED 4\/50 points · provider quota still has 90 · raise WORLD_NEWS_DAILY_POINT_BUDGET · cached /,
  );
  assert.equal(
    stats.error,
    stats.loadingLabel,
    'the row names the block and the age of the pins it still shows',
  );
  assert.equal(
    layerFeedState(stats),
    'stale',
    'with data on the map the row is stale, not broken',
  );
  assert.equal(h.chip('load-more').disabled, true);

  // The map accumulates, so an empty batch on top of pinned rows is not an
  // empty map. Clear first, then let a batch come back with nothing.
  h.layer.clearPins();
  reply = snapshot([]);
  await h.layer.update(h.viewer);
  stats = h.layer.getStats();
  assert.equal(stats.status, 'empty');
  assert.equal(
    stats.statusMessage,
    'No place-tagged headlines in the latest batch',
  );
  assert.equal(stats.error, null);
  assert.equal(layerFeedState(stats), 'nominal', 'guidance, not a fault');
  h.layer.destroy(h.viewer);
});

test('a superseded request yields to the newer one', async () => {
  const pending = [];
  const h = harness({
    getSnapshot: () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  });
  const first = h.layer.update(h.viewer);
  const second = h.layer.update(h.viewer);
  pending[0](snapshot([ROW_A]));
  pending[1](snapshot([ROW_C]));
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(
    h.entities().map((entity) => entity.id),
    [TOKYO],
  );
  h.layer.destroy(h.viewer);
});

test('late refresh cannot publish after disable, re-enable, or destroy', async () => {
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
    resolve(snapshot([ROW_A]));
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.setEvents().length, 0);
    assert.equal(h.services.store.entities.size, 0);
    h.layer.destroy(h.viewer);
  }
});

test('the manager abort signal cancels an in-flight refresh', async () => {
  let signal;
  const h = harness({
    getSnapshot(options) {
      signal = options.signal;
      // Like fetch: settle only by rejecting once the request is aborted.
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const external = new AbortController();
  const pending = h.layer.update(h.viewer, { signal: external.signal });
  external.abort();
  assert.equal(signal.aborted, true);
  assert.equal(await pending, false);
  h.layer.destroy(h.viewer);
});

test('selection: chips, story paging, readout refresh and the injected opener', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([ROW_A, ROW_B, ROW_C]),
  });
  await h.layer.update(h.viewer);
  assert.equal(h.chip('open-article').disabled, true);
  assert.equal(
    h.chip('next-story'),
    undefined,
    'no paging chips without a selection',
  );
  assert.equal(h.chip('load-more').disabled, false);
  assert.match(
    h.chip('load-more').title,
    /1 request ≈ 2 points of today's budget \(4\/50 used\)/,
  );

  assert.equal(h.layer.selectPlace('missing'), false);
  assert.equal(h.layer.selectPlace(ROTTERDAM), true);
  assert.deepEqual(
    h.chips().map((chip) => chip.id),
    [
      'open-article',
      'load-more',
      'news-in-view',
      'global-news',
      'clear-pins',
      'prev-story',
      'next-story',
    ],
    'always-present chips precede the paging chips the panel appends',
  );
  assert.equal(h.services.store.selectedId, ROTTERDAM);
  const rotterdam = h.entities().find((entity) => entity.id === ROTTERDAM);
  assert.equal(
    rotterdam.point.color.getValue().equals(Cesium.Color.WHITE),
    true,
  );
  assert.equal(rotterdam.point.pixelSize.getValue(), 15, 'max(12, 11 + 4)');
  assert.equal(h.chip('open-article').disabled, false);
  assert.ok(h.chip('prev-story') && h.chip('next-story'), 'two stories here');
  h.chip('open-article').onClick();
  assert.deepEqual(h.opened, ['https://a.example/1']);

  h.chip('next-story').onClick();
  assert.equal(rotterdam.gevLabelModel.title, ROW_B.title);
  assert.equal(
    rotterdam.gevLabelModel.details[1],
    'Rotterdam · 2/2 stories here · click the pin for the next',
  );
  assert.equal(rotterdam.gevLabelModel.details[2], 'TONE POSITIVE (0.60)');
  assert.equal(rotterdam.gevLabelModel.accent, '#4fd1a5');
  assert.ok(
    h.services.calls.some(
      ([op, id]) => op === 'refreshReadout' && id === ROTTERDAM,
    ),
  );
  h.chip('open-article').onClick();
  assert.equal(
    h.opened.at(-1),
    'https://b.example/2',
    'opens the story being read',
  );
  h.chip('next-story').onClick();
  assert.equal(rotterdam.gevLabelModel.title, ROW_A.title, 'wraps around');
  h.chip('prev-story').onClick();
  assert.equal(rotterdam.gevLabelModel.title, ROW_B.title);

  assert.equal(h.layer.selectPlace(TOKYO), true);
  assert.equal(
    h.chip('next-story'),
    undefined,
    'a single story has nothing to page',
  );
  assert.equal(
    rotterdam.point.color.getValue().equals(Cesium.Color.WHITE),
    false,
    'previous pin restored',
  );
  const tokyo = h.entities().find((entity) => entity.id === TOKYO);
  assert.equal(tokyo.gevLabelModel.details[2], 'TONE UNKNOWN');

  h.layer.clearSelection();
  assert.equal(h.services.store.selectedId, null);
  assert.deepEqual(h.services.calls.filter(([op]) => op === 'clear').at(-1), [
    'clear',
    'world-news',
    false,
  ]);
  assert.equal(h.chip('open-article').disabled, true);
  h.layer.destroy(h.viewer);
});

test('clicks select our pins, yield to sibling-owned picks, and clear on empty space', async () => {
  const h = harness({ getSnapshot: async () => snapshot([ROW_A, ROW_C]) });
  await h.layer.update(h.viewer);
  h.services.owners.set('flights', (id) => id === 'plane-1');
  let picked = null;
  h.viewer.scene.pick = () => picked;

  picked = { id: h.entities().find((entity) => entity.id === ROTTERDAM) };
  h.handler.click();
  assert.equal(h.services.store.selectedId, ROTTERDAM);

  picked = { id: 'plane-1' };
  h.handler.click();
  assert.equal(
    h.services.store.selectedId,
    ROTTERDAM,
    'a sibling pick is not empty space',
  );

  picked = null;
  h.handler.click();
  assert.equal(h.services.store.selectedId, null);

  h.layer.disable(h.viewer);
  picked = { id: ROTTERDAM };
  h.handler.click();
  assert.equal(
    h.services.store.selectedId,
    null,
    'a disabled layer ignores clicks',
  );
  h.layer.destroy(h.viewer);
});

test('losing the selected place evicts rather than deselects', async () => {
  let rows = [ROW_A, ROW_C];
  const h = harness({ getSnapshot: async () => snapshot(rows) });
  await h.layer.update(h.viewer);
  h.layer.selectPlace(ROTTERDAM);
  // A refresh can no longer take a place away — the map accumulates — so the
  // way a selected place goes is CLEAR PINS, and the contract is the same:
  // the context is evicted, not quietly deselected.
  rows = [ROW_C];
  await h.layer.update(h.viewer);
  assert.equal(
    h.services.store.selectedId,
    ROTTERDAM,
    'a refresh keeps every pin, so the selection survives it',
  );
  assert.equal(h.layer.clearPins(), true);
  assert.deepEqual(h.services.calls.filter(([op]) => op === 'clear').at(-1), [
    'clear',
    'world-news',
    true,
  ]);
  assert.equal(h.chip('open-article').disabled, true);
  assert.deepEqual(
    h.entities().map((entity) => entity.id),
    [],
  );
  await h.layer.update(h.viewer);
  assert.deepEqual(
    h.entities().map((entity) => entity.id),
    [TOKYO],
    'and the live feed repopulates on the next tick',
  );

  // A retained selection survives the refresh and republishes its card.
  h.layer.selectPlace(TOKYO);
  const before = h.services.calls.filter(
    ([op]) => op === 'refreshReadout',
  ).length;
  await h.layer.update(h.viewer);
  assert.equal(h.services.store.selectedId, TOKYO);
  assert.ok(
    h.services.calls.filter(([op]) => op === 'refreshReadout').length > before,
  );
  h.layer.destroy(h.viewer);
});

test('LOAD MORE merges the extra page and explains its own failures without degrading the feed', async () => {
  let moreReply = () => snapshot([ROW_A, ROW_B, ROW_C], { morePagesLeft: 1 });
  const calls = [];
  const h = harness({
    getSnapshot: async () => snapshot([ROW_A]),
    loadMore: async ({ signal }) => {
      calls.push(signal);
      return moreReply();
    },
  });
  assert.equal(await h.layer.loadMore(), false, 'nothing loaded yet');
  await h.layer.update(h.viewer);
  assert.equal(await h.layer.loadMore(), true);
  assert.equal(calls.length, 1);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getStats().countLabel, '3 pinned');
  assert.match(h.chip('load-more').title, /1 left this hour/);

  moreReply = () => {
    throw Object.assign(new Error('extra pages exhausted'), { code: 'pages' });
  };
  assert.equal(await h.layer.loadMore(), true);
  assert.equal(h.layer.getStats().error, null, 'the base feed is intact');
  assert.equal(h.chip('load-more').disabled, true);
  assert.match(h.chip('load-more').title, /extra pages exhausted/);
  assert.equal(await h.layer.loadMore(), false, 'no pages left');
  h.layer.destroy(h.viewer);
});

test('the provider credit registers once, on the first non-empty batch', async () => {
  let rows = [];
  const h = harness({ getSnapshot: async () => snapshot(rows) });
  await h.layer.update(h.viewer);
  const credits = () => h.services.calls.filter(([op]) => op === 'credit');
  assert.equal(credits().length, 0, 'an empty batch shows nothing to credit');
  rows = [ROW_A];
  await h.layer.update(h.viewer);
  await h.layer.update(h.viewer);
  assert.deepEqual(credits(), [['credit', 'test-credit']]);
  h.layer.destroy(h.viewer);
});

test('legend tallies every story by tone and the analyst seam mirrors the rows', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([ROW_A, ROW_B, ROW_C]),
  });
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  await h.layer.update(h.viewer);
  const { legend } = h.layer.getRowControls();
  assert.deepEqual(
    legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['Negative tone', '#ff5c8a', 1],
      ['Neutral tone', '#8b8cf8', 0],
      ['Positive tone', '#4fd1a5', 1],
      ['No tone score', '#b8c4d0', 1],
    ],
  );
  assert.ok(legend.every((item) => /named in the headline/.test(item.blurb)));
  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => record.id),
    ['wn-c', 'wn-a', 'wn-b'],
    'merged batches are newest first, whatever order each arrived in',
  );
  assert.deepEqual(
    records.find((record) => record.id === 'wn-a'),
    {
      id: 'wn-a',
      title: ROW_A.title,
      domain: 'a.example',
      url: 'https://a.example/1',
      publishedAt: ROW_A.publishedAt,
      sentiment: -0.5,
      category: 'business',
      place: 'Rotterdam',
      sourceCountry: 'nl',
      lat: 51.92,
      lon: 4.48,
    },
  );
  assert.equal(records[0].sentiment, null, 'wn-c carries no tone score');
  assert.equal(h.layer.getAnalystRecords(2).length, 2);
  h.layer.disable(h.viewer);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.destroy(h.viewer);
});

test('row-control listeners hear every async state change and survive throwing', async () => {
  let resolve;
  const h = harness({
    getSnapshot: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  let notified = 0;
  h.layer.setRowControlsListener(() => {
    notified++;
    throw new Error('listener bug');
  });
  const pending = h.layer.update(h.viewer);
  assert.ok(notified >= 1, 'loading disables the chip immediately');
  assert.equal(h.chip('load-more').disabled, true);
  resolve(snapshot([ROW_A]));
  await pending;
  assert.ok(notified >= 2, 'completion re-enables it');
  assert.equal(h.chip('load-more').disabled, false);
  h.layer.setRowControlsListener(null);
  h.layer.destroy(h.viewer);
});

test('an unmeasured request cost is labelled as the documented estimate', async () => {
  let reply = snapshot([ROW_A], { costPerRequest: 1.03, costMeasured: false });
  const h = harness({ getSnapshot: async () => reply });
  await h.layer.update(h.viewer);
  assert.match(
    h.chip('load-more').title,
    /1 request ≈ 1\.03 points \(estimate\) of today's budget/,
  );
  reply = snapshot([ROW_A], { costPerRequest: null, costMeasured: false });
  await h.layer.update(h.viewer);
  assert.match(h.chip('load-more').title, /≈ 2 points \(estimate\) of/);
  reply = snapshot([ROW_A]);
  await h.layer.update(h.viewer);
  assert.match(h.chip('load-more').title, /≈ 2 points of today's budget/);
  h.layer.destroy(h.viewer);
});

const MOSCOW_CIRCLE = Object.freeze({
  band: 'local',
  key: 'l:en:56:37.5:50',
  center: { lat: 56, lon: 37.5 },
  radiusKm: 50,
});

/** A region batch as the proxy answers it: one page, no second page to walk. */
function regionSnapshot(rows, overrides = {}) {
  return snapshot(rows, {
    morePagesLeft: 0,
    region: MOSCOW_CIRCLE,
    regionFetchesLeft: 5,
    ...overrides,
  });
}

/** A source that records which feed was asked for, in order. */
function regionSource({ global: globalReply, region: regionReply }) {
  const asked = [];
  return {
    asked,
    getSnapshot: async () => {
      asked.push('global');
      return typeof globalReply === 'function' ? globalReply() : globalReply;
    },
    getRegionSnapshot: async ({ region }) => {
      asked.push(region);
      return typeof regionReply === 'function' ? regionReply() : regionReply;
    },
  };
}

test('NEWS IN VIEW has nothing to ask for until the camera frames a city', async () => {
  const wide = harness(regionSource({ global: snapshot([ROW_A]) }));
  await wide.layer.update(wide.viewer);
  assert.equal(wide.chip('news-in-view').disabled, true);
  assert.match(
    wide.chip('news-in-view').title,
    /Zoom in to a city first — a news circle is capped at 100 km/,
  );
  assert.equal(await wide.layer.fetchViewRegion(), false, 'nothing is spent');
  wide.layer.destroy(wide.viewer);

  const close = harness(regionSource({ global: snapshot([ROW_A]) }), {
    framed: framedCamera(),
  });
  await close.layer.update(close.viewer);
  assert.equal(close.chip('news-in-view').disabled, false);
  assert.match(
    close.chip('news-in-view').title,
    /Fetch the headlines within 50 km of 56.0, 37.5/,
  );
  close.layer.destroy(close.viewer);
});
test('fetching a view ADDS its headlines and keeps what is already pinned', async () => {
  const source = regionSource({
    global: snapshot([ROW_A, ROW_C]),
    region: regionSnapshot([ROW_B]),
  });
  const h = harness(source, { framed: framedCamera() });
  await h.layer.update(h.viewer);
  assert.deepEqual(source.asked, ['global']);
  assert.match(h.layer.getStats().loadingLabel, /latest headlines/);
  assert.equal(h.chip('clear-pins').disabled, false);

  assert.equal(await h.chip('news-in-view').onClick(), true);
  assert.deepEqual(
    source.asked[1],
    {
      band: 'local',
      key: 'l:en:56:37.5:50',
      center: { lat: 56, lon: 37.5 },
      radiusKm: 50,
    },
    'the circle the camera frames is what gets asked for',
  );
  assert.deepEqual(
    h.layer
      .getAnalystRecords()
      .map((record) => record.id)
      .sort(),
    ['wn-a', 'wn-b', 'wn-c'],
    'the view joins the worldwide batch instead of replacing it',
  );
  assert.match(
    h.layer.getStats().loadingLabel,
    /3 headlines from the worldwide feed and 1 view place-tagged/,
  );
  h.layer.destroy(h.viewer);
});

test('a second view adds to the first — asking about Tokyo keeps Moscow', async () => {
  const batches = [
    regionSnapshot([ROW_B]),
    regionSnapshot([ROW_C], {
      region: {
        band: 'local',
        key: 'l:en:35.5:139.5:25',
        center: { lat: 35.5, lon: 139.5 },
        radiusKm: 25,
      },
    }),
  ];
  let next = 0;
  const source = {
    asked: [],
    getSnapshot: async () => {
      source.asked.push('global');
      return snapshot([ROW_A]);
    },
    getRegionSnapshot: async ({ region }) => {
      source.asked.push(region.key);
      return batches[next++];
    },
  };
  const framed = framedCamera();
  const h = harness(source, { framed });
  await h.layer.fetchViewRegion();
  assert.deepEqual(
    h.layer.getAnalystRecords().map((record) => record.id),
    ['wn-b'],
  );
  // Fly to Tokyo and ask again.
  h.viewer.camera = framedCamera({
    lat: 35.68,
    lon: 139.69,
    spanDeg: 0.25,
  }).camera;
  await h.layer.fetchViewRegion();
  assert.deepEqual(
    h.layer
      .getAnalystRecords()
      .map((record) => record.id)
      .sort(),
    ['wn-b', 'wn-c'],
    'the first circle stays on the map',
  );
  assert.match(
    h.layer.getStats().loadingLabel,
    /2 headlines from 2 views place-tagged/,
  );
  h.layer.destroy(h.viewer);
});

test('a refresh re-asks for the pinned circle instead of reverting to the world', async () => {
  const source = regionSource({
    global: snapshot([ROW_A]),
    region: regionSnapshot([ROW_B]),
  });
  const h = harness(source, { framed: framedCamera() });
  await h.layer.update(h.viewer);
  await h.layer.fetchViewRegion();
  await h.layer.update(h.viewer);
  assert.deepEqual(
    source.asked.map((entry) => (entry === 'global' ? 'global' : entry.key)),
    ['global', 'l:en:56:37.5:50', 'l:en:56:37.5:50'],
    'the pinned circle survives the ten-minute tick',
  );
  h.layer.destroy(h.viewer);
});

test('a pinned refresh re-asks for the PINNED circle, not wherever the camera went', async () => {
  const source = regionSource({
    global: snapshot([ROW_A]),
    region: regionSnapshot([ROW_B]),
  });
  const framed = framedCamera();
  const h = harness(source, { framed });
  await h.layer.update(h.viewer);
  await h.layer.fetchViewRegion();
  // The operator flies to Tokyo without touching the chip.
  h.viewer.camera = framedCamera({ lat: 35.68, lon: 139.69 }).camera;
  await h.layer.update(h.viewer);
  assert.equal(
    source.asked.at(-1).key,
    'l:en:56:37.5:50',
    'a drifting camera must not spend budget the operator did not ask to spend',
  );
  assert.equal(framed.listeners.size, 1, 'the camera watch is installed once');
  h.layer.destroy(h.viewer);
});

test('GLOBAL FEED adds the worldwide feed without taking the views away', async () => {
  const source = regionSource({
    global: snapshot([ROW_A, ROW_C]),
    region: regionSnapshot([ROW_B]),
  });
  const h = harness(source, { framed: framedCamera() });
  await h.layer.fetchViewRegion();
  assert.equal(h.chip('global-news').disabled, false, 'always available');
  assert.match(h.chip('global-news').title, /Add the latest worldwide/);
  assert.equal(await h.chip('global-news').onClick(), true);
  assert.deepEqual(
    h.layer
      .getAnalystRecords()
      .map((record) => record.id)
      .sort(),
    ['wn-a', 'wn-b', 'wn-c'],
    'the circle stays pinned under the worldwide feed',
  );
  // And the refresh now follows the worldwide feed again.
  await h.layer.update(h.viewer);
  assert.equal(source.asked.at(-1), 'global');
  h.layer.destroy(h.viewer);
});

test('CLEAR PINS is the only control that takes pins off the map', async () => {
  const source = regionSource({
    global: snapshot([ROW_A, ROW_C]),
    region: regionSnapshot([ROW_B]),
  });
  const h = harness(source, { framed: framedCamera() });
  assert.equal(h.chip('clear-pins').disabled, true, 'nothing to clear yet');
  assert.match(h.chip('clear-pins').title, /No headline pins to clear/);
  await h.layer.update(h.viewer);
  await h.layer.fetchViewRegion();
  assert.equal(h.entities().length, 2, 'Rotterdam and Tokyo');
  assert.match(
    h.chip('clear-pins').title,
    /Remove all 3 headline pins from the map\. The layer is live, so the next refresh adds the headlines within 50 km of 56\.0, 37\.5 again\./,
  );

  assert.equal(h.chip('clear-pins').onClick(), true);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  assert.deepEqual(
    h.entities().map((entity) => entity.id),
    [],
  );
  assert.equal(h.chip('clear-pins').disabled, true);
  const stats = h.layer.getStats();
  assert.equal(stats.lastUpdate, null, 'an emptied map is not a stale one');
  assert.equal(stats.loadingLabel, '');
  assert.equal(h.layer.clearPins(), false, 'and it is idempotent');
  h.layer.destroy(h.viewer);
});

test('a batch leaves the map once the provider retention window passes', async () => {
  let now = 1_000_000;
  const source = regionSource({
    global: snapshot([ROW_A]),
    region: regionSnapshot([ROW_B]),
  });
  const h = harness(source, { framed: framedCamera(), clock: () => now });
  await h.layer.update(h.viewer);
  await h.layer.fetchViewRegion();
  assert.deepEqual(
    h.layer
      .getAnalystRecords()
      .map((record) => record.id)
      .sort(),
    ['wn-a', 'wn-b'],
    'the worldwide batch and the circle are both on the map',
  );
  // An hour and a minute later neither of those may be held any longer: the
  // provider's terms cap caching at an hour and the proxy obeys it, so a
  // browser accumulating pins has to obey it too.
  now += 61 * 60_000;
  await h.layer.update(h.viewer);
  assert.deepEqual(
    h.layer.getAnalystRecords().map((record) => record.id),
    ['wn-b'],
    'only the batch just fetched is still inside the window',
  );
  h.layer.destroy(h.viewer);
});

test('an exhausted hourly cap stays on the chip and leaves the world feed alone', async () => {
  const failure = Object.assign(new Error('view fetches exhausted this hour'), {
    code: 'region_rate',
  });
  const h = harness(
    {
      getSnapshot: async () => snapshot([ROW_A]),
      getRegionSnapshot: async () => {
        throw failure;
      },
    },
    { framed: framedCamera() },
  );
  await h.layer.update(h.viewer);
  assert.equal(
    await h.layer.fetchViewRegion(),
    true,
    'a failure is not a revert',
  );
  const stats = h.layer.getStats();
  assert.equal(stats.error, null, 'the worldwide feed is not degraded');
  assert.equal(stats.blocked, null);
  assert.deepEqual(
    h.layer.getAnalystRecords().map((record) => record.id),
    ['wn-a'],
    'the rows already on the map stay',
  );
  assert.match(h.chip('news-in-view').title, /exhausted this hour/);
  h.layer.destroy(h.viewer);
});

test('a server with view fetching off stops re-asking for the circle', async () => {
  let regionReply = () => regionSnapshot([ROW_B]);
  const source = {
    asked: [],
    getSnapshot: async () => {
      source.asked.push('global');
      return snapshot([ROW_A]);
    },
    getRegionSnapshot: async ({ region }) => {
      source.asked.push(region.key);
      return regionReply();
    },
  };
  const h = harness(source, { framed: framedCamera() });
  await h.layer.update(h.viewer);
  await h.layer.fetchViewRegion();
  regionReply = () => {
    throw Object.assign(new Error('view fetching is off on this server'), {
      code: 'region_off',
    });
  };
  await h.layer.update(h.viewer);
  await h.layer.update(h.viewer);
  assert.deepEqual(
    source.asked,
    ['global', 'l:en:56:37.5:50', 'l:en:56:37.5:50', 'global'],
    'the next tick returns to the worldwide feed rather than re-failing',
  );
  assert.deepEqual(
    h.layer.getAnalystRecords().map((record) => record.id),
    ['wn-a', 'wn-b'],
    'and the circle it did fetch stays on the map',
  );
  h.layer.destroy(h.viewer);
});

test('an empty circle says it is empty HERE, not that the world has no news', async () => {
  const h = harness(
    regionSource({
      global: snapshot([ROW_A]),
      region: regionSnapshot([], { requested: 0, unplacedCount: 0 }),
    }),
    { framed: framedCamera() },
  );
  await h.layer.fetchViewRegion();
  const stats = h.layer.getStats();
  assert.equal(stats.status, 'empty');
  assert.equal(
    stats.statusMessage,
    'No place-tagged headlines within 50 km of 56.0, 37.5',
  );
  h.layer.destroy(h.viewer);
});

test('the chip repaints when the camera settles, not only on a layer status change', async () => {
  const framed = framedCamera();
  const h = harness(regionSource({ global: snapshot([ROW_A]) }), { framed });
  await h.layer.update(h.viewer);
  let notified = 0;
  h.layer.setRowControlsListener(() => notified++);
  framed.settle();
  assert.equal(notified, 1, 'a settled camera may have changed the circle');
  h.layer.disable(h.viewer);
  notified = 0;
  framed.settle();
  assert.equal(notified, 0, 'a disabled layer stays quiet');
  h.layer.destroy(h.viewer);
  assert.equal(framed.listeners.size, 0, 'destroy detaches the camera watch');
});

test('LOAD MORE explains a pinned view rather than blaming a spent hour', async () => {
  const h = harness(
    regionSource({
      global: snapshot([ROW_A]),
      region: regionSnapshot([ROW_B]),
    }),
    { framed: framedCamera() },
  );
  await h.layer.update(h.viewer);
  assert.match(h.chip('load-more').title, /2 left this hour/);
  await h.layer.fetchViewRegion();
  // The proxy sends morePagesLeft 0 for every region, so the chip is off; the
  // reason is the shape of a view batch, not an exhausted allowance.
  assert.equal(h.chip('load-more').disabled, true);
  assert.match(
    h.chip('load-more').title,
    /A view is a single page — fetch the worldwide feed to page further/,
  );
  assert.equal(await h.layer.loadMore(), false, 'and it cannot be clicked');
  h.layer.destroy(h.viewer);
});

test('only a chip with a request in flight reads busy; the rest read unavailable', async () => {
  let resolve;
  const h = harness(
    {
      getSnapshot: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    // No framed camera: NEWS IN VIEW is disabled because the view is too wide.
  );
  const pending = h.layer.update(h.viewer);
  for (const id of ['load-more', 'global-news']) {
    assert.equal(h.chip(id).disabled, true, `${id} is disabled while loading`);
    assert.equal(h.chip(id).busy, true, `${id} is genuinely waiting`);
  }
  resolve(snapshot([ROW_A]));
  await pending;
  // Idle: a chip that is merely unavailable must never claim to be waiting.
  assert.equal(h.chip('news-in-view').disabled, true);
  assert.equal(h.chip('news-in-view').busy, false);
  assert.match(h.chip('news-in-view').title, /Zoom in to a city first/);
  assert.equal(h.chip('global-news').disabled, false);
  assert.equal(h.chip('global-news').busy, false);
  h.layer.destroy(h.viewer);
});

test('clicking a selected pin again walks its stories, and wraps', async () => {
  // ROW_A and ROW_B share the Rotterdam pin; ROW_C is Tokyo on its own.
  const h = harness({
    getSnapshot: async () => snapshot([ROW_A, ROW_B, ROW_C]),
  });
  await h.layer.update(h.viewer);
  let picked = null;
  h.viewer.scene.pick = () => picked;
  const card = () =>
    h
      .setEvents()
      .at(-1)?.[2]
      ?.find((entry) => entry.id === h.services.store.selectedId);
  const counter = () =>
    h.layer
      .getRowControls()
      .chips.find((chip) => chip.id === 'open-article')
      ?.title?.match(/at (.+?) in a new tab/)?.[1];

  picked = { id: h.entities().find((entity) => entity.id === ROTTERDAM) };
  h.handler.click();
  assert.equal(h.services.store.selectedId, ROTTERDAM, 'first click selects');
  assert.equal(counter(), 'a.example', 'story 1 of 2');

  // Second click on the same pin: no re-selection, just the next story.
  const selectsBefore = h.services.calls.filter(
    ([op]) => op === 'select',
  ).length;
  h.handler.click();
  assert.equal(
    h.services.calls.filter(([op]) => op === 'select').length,
    selectsBefore,
    'paging is not a re-selection',
  );
  assert.equal(counter(), 'b.example', 'story 2 of 2');

  // And it wraps rather than sticking at the end.
  h.handler.click();
  assert.equal(counter(), 'a.example', 'back to story 1');

  // A place with a single story has nothing to walk, so a second click is
  // still a no-op rather than a flicker.
  picked = { id: h.entities().find((entity) => entity.id === TOKYO) };
  h.handler.click();
  assert.equal(h.services.store.selectedId, TOKYO);
  assert.equal(counter(), 'c.example');
  h.handler.click();
  assert.equal(counter(), 'c.example', 'one story stays put');
  h.layer.destroy(h.viewer);
});

test('the card opens the story; only the pin under it pages', async () => {
  const h = harness({ getSnapshot: async () => snapshot([ROW_A, ROW_B]) });
  await h.layer.update(h.viewer);
  let picked = null;
  h.viewer.scene.pick = () => picked;
  const shown = () =>
    h.layer.getRowControls().chips.find((chip) => chip.id === 'open-article')
      ?.title;

  picked = { id: h.entities().find((entity) => entity.id === ROTTERDAM) };
  h.handler.click();
  assert.match(shown(), /a\.example/, 'story 1 of 2');

  // The card sits ON TOP of the pin, so it gets first refusal: a click that
  // lands on it opens the publisher and must NOT also advance the story.
  h.services.overlays.hitTest = () => ({ entryId: ROTTERDAM });
  h.handler.click();
  assert.deepEqual(h.opened, [ROW_A.url], 'the card opened its own story');
  assert.match(shown(), /a\.example/, 'and the card did not page past it');

  // A card hit for some other layer's entry is not ours: fall through.
  h.services.overlays.hitTest = () => ({ entryId: 'someone-elses-entry' });
  h.handler.click();
  assert.match(shown(), /b\.example/, 'the pin under it still pages');
  assert.deepEqual(h.opened, [ROW_A.url], 'and nothing else was opened');
  h.layer.destroy(h.viewer);
});
